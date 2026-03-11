const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

const rooms = {};
const COLOR_ORDER = { 'red': 1, 'blue': 2, 'green': 3, 'yellow': 4, 'black': 5 };

// --- CORE LOGIC: DECK GENERATION ---
// Purpose: Creates a standard UNO deck with correct card counts.
function createDeck() {
    const colors = ['red', 'blue', 'green', 'yellow'];
    const types = ['0','1','2','3','4','5','6','7','8','9','Skip','Reverse','+2'];
    let deck = [];
    colors.forEach(c => types.forEach(t => {
        let count = (t === '0') ? 1 : 2;
        for(let i=0; i<count; i++) deck.push({color: c, type: t});
    }));
    for(let i=0; i<4; i++) {
        deck.push({color: 'black', type: 'Wild'}, {color: 'black', type: '+4'});
    }
    return deck.sort(() => Math.random() - 0.5);
}

// Purpose: Organizes hands by color then type for a cleaner UI.
function sortHand(hand) {
    return hand.sort((a, b) => {
        if (COLOR_ORDER[a.color] !== COLOR_ORDER[b.color]) {
            return COLOR_ORDER[a.color] - COLOR_ORDER[b.color];
        }
        return a.type.localeCompare(b.type, undefined, {numeric: true});
    });
}

// --- CORE LOGIC: THE BROADCASTER ---
// Purpose: Sends the state of the game to every player. 
// This is the most important function for keeping the UI in sync.
function updateRoom(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    const topCard = room.discardPile[room.discardPile.length - 1];
    const currentPlayer = room.players[room.currentPlayerIndex];

    // BUG FIX: REAPER CALCULATION
    // Purpose: Prevents the "Stuck at 4s" visual bug by providing a fresh countdown.
    let reaperTime = null;
    if (room.reaperEnd) {
        const diff = room.reaperEnd - Date.now();
        reaperTime = diff > 0 ? Math.ceil(diff / 1000) : 0;
    }

    room.players.forEach((p) => {
        // GOD MODE: Winners (Spectators) see everyone's hands
        const isSpectator = room.finishOrder.includes(p.sessionId);
        
        const payload = {
            roomCode: roomId,
            players: room.players.map(player => ({
                username: player.username,
                sessionId: player.sessionId,
                cardCount: player.hand.length,
                isOffline: !player.socketId // Connects to the red/green dots in sidebar
            })),
            topCard: topCard,
            turnId: currentPlayer.sessionId,
            stack: room.stackCount, // Used to trigger Gold Glow/Red Tracker
            waitingForPass: p.lastDrawnCard, // Used to trigger White Glow
            hand: p.hand,
            finishOrder: room.finishOrder,
            results: room.results,
            reaperTimeLeft: reaperTime,
            isSpectator: isSpectator,
            deckCount: room.deck.length
        };

        io.to(p.sessionId).emit('init', payload);
    });
}

// --- CORE LOGIC: TURN ROTATION ---
// Purpose: Moves the turn to the next valid player, skipping finished players.
function nextTurn(roomId, skip = 1) {
    const room = rooms[roomId];
    if (!room) return;
    let playersCount = room.players.length;

    for (let i = 0; i < skip; i++) {
        room.currentPlayerIndex = (room.currentPlayerIndex + room.direction + playersCount) % playersCount;
        
        // THE SPECTATOR BRIDGE: Skips over anyone in the finishOrder.
        let safety = 0;
        while (room.finishOrder.includes(room.players[room.currentPlayerIndex].sessionId) && safety < playersCount) {
            room.currentPlayerIndex = (room.currentPlayerIndex + room.direction + playersCount) % playersCount;
            safety++;
        }
    }
}

// --- CORE LOGIC: ROUND INITIALIZATION ---
function startRound(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    
    room.finishOrder = [];
    room.stackCount = 0;
    room.direction = 1;
    room.currentPlayerIndex = 0;
    room.deck = createDeck();

    room.players.forEach(p => { 
        p.hand = sortHand(room.deck.splice(0, 10));
        p.lastDrawnCard = null; 
    });

    let firstCard = room.deck.shift();
    const powerCards = ['Skip', 'Reverse', '+2', '+4', 'Wild'];
    let safety = 0;
    while (powerCards.includes(firstCard.type) && safety < 50) {
        room.deck.push(firstCard);
        firstCard = room.deck.shift();
        safety++;
    }
    
    room.discardPile = [firstCard];
    updateRoom(roomId);
}

io.on('connection', (socket) => {
    let myRoomId = null;
    let mySessionId = null;
    let lastClickTime = 0;

    socket.on('joinRoom', (data) => {
        const { roomId, sessionId, playerLimit } = data;
        myRoomId = roomId; mySessionId = sessionId;

        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [], deck: [], discardPile: [], currentPlayerIndex: 0,
                direction: 1, gameStarted: false, stackCount: 0,
                scores: {}, finishOrder: [], maxPlayers: playerLimit || 4,
                unoWindowActive: false, unoTarget: null,
                reaperTimer: null, reaperEnd: null, hostId: sessionId
            };
        }
        const room = rooms[roomId];
        let p = room.players.find(p => p.sessionId === sessionId);

        if (p) {
            p.socketId = socket.id;
            socket.join(roomId);
            // BUG FIX: Clear reaper if player reconnects
            if (room.reaperTimer) {
                clearInterval(room.reaperTimer);
                room.reaperTimer = null;
                room.reaperEnd = null;
            }
            socket.emit('roomJoined', roomId);
            updateRoom(roomId);
        } else if (room.players.length < room.maxPlayers && !room.gameStarted) {
            socket.join(roomId);
            room.players.push({ sessionId, socketId: socket.id, hand: [], lastDrawnCard: null });
            room.scores[sessionId] = room.scores[sessionId] || 0;
            socket.emit('roomJoined', roomId);
            if (room.players.length === room.maxPlayers) {
                room.gameStarted = true;
                startRound(roomId);
            }
        }
    });

    // --- CORE LOGIC: PLAY CARD ---
    socket.on('playCard', (data) => {
        const room = rooms[myRoomId];
        const now = Date.now();
        if (now - lastClickTime < 500) return; // Cooldown anti-spam
        lastClickTime = now;

        if (!room || room.gameStarted === false) return;
        const player = room.players[room.currentPlayerIndex];
        if (player.sessionId !== mySessionId) return;

        const card = player.hand[data.index];
        const top = room.discardPile[room.discardPile.length - 1];

        // RULE: Tactical Draw Enforcement - Must play the drawn card or pass.
        if (player.lastDrawnCard && card !== player.lastDrawnCard) return;

        // RULE: Escalating Stacking Logic
        if (room.stackCount > 0) {
            const canStack = (card.type === '+4') || (top.type === '+2' && card.type === '+2');
            if (!canStack) return;
        }

        const isWild = (card.color === 'black');
        const matchesTop = (card.color === top.color || card.type === top.type);

        if (matchesTop || isWild) {
            if (isWild && !data.chosenColor) return; 
            if (isWild) card.color = data.chosenColor;

            // Update stack counts
            if (card.type === '+2') room.stackCount += 2;
            if (card.type === '+4') room.stackCount += 4;

            let skipCount = 1;
            const activePlayers = room.players.filter(p => !room.finishOrder.includes(p.sessionId));

            if (card.type === 'Skip') {
                skipCount = 2;
            } else if (card.type === 'Reverse') {
                if (activePlayers.length === 2) {
                    skipCount = 2; // Reverse acts as skip in 1v1
                } else {
                    room.direction *= -1;
                }
            }

            player.hand.splice(data.index, 1);
            room.discardPile.push(card);
            player.lastDrawnCard = null;

            // BUG FIX: 5-PLAYER FINISH LOGIC
            // Purpose: Automatically ends the round when only 1 loser is left.
            if (player.hand.length === 0) {
                if (!room.finishOrder.includes(mySessionId)) room.finishOrder.push(mySessionId);
                const stillPlaying = room.players.filter(p => !room.finishOrder.includes(p.sessionId));

                if (stillPlaying.length <= 1) {
                    if (stillPlaying.length === 1) room.finishOrder.push(stillPlaying[0].sessionId);

                    // Add points to persistent scores
                    room.finishOrder.forEach((sid, idx) => {
                        room.scores[sid] += (room.players.length - 1 - idx);
                    });

                    // KILL REAPER
                    if (room.reaperTimer) clearInterval(room.reaperTimer);
                    room.reaperEnd = null;
                    room.gameStarted = false;

                    io.to(myRoomId).emit('results', { order: room.finishOrder, scores: room.scores });
                    updateRoom(myRoomId);
                    return; 
                }
                // Winner is skipped, turn goes to next active player
                nextTurn(myRoomId, skipCount);
                updateRoom(myRoomId);
                return;
            }

            nextTurn(myRoomId, skipCount);
            updateRoom(myRoomId);
        }
    });

    // --- CORE LOGIC: DRAW CARD & INFINITE DECK ---
    socket.on('draw', () => {
        const room = rooms[myRoomId];
        if (!room || room.players[room.currentPlayerIndex].sessionId !== mySessionId) return;
        const player = room.players[room.currentPlayerIndex];
        
        // Purpose: Reshuffles discard pile if deck is empty.
        const checkDeck = () => {
            if (room.deck.length < 1) {
                const top = room.discardPile.pop();
                room.deck = [...room.discardPile].sort(() => Math.random() - 0.5);
                room.discardPile = [top];
            }
        };

        if (room.stackCount > 0) {
            // Player forced to eat the stack
            for(let i=0; i<room.stackCount; i++) {
                checkDeck();
                player.hand.push(room.deck.shift());
            }
            room.stackCount = 0;
            sortHand(player.hand);
            nextTurn(myRoomId);
        } else {
            if (player.lastDrawnCard) return;
            checkDeck();
            const drawn = room.deck.shift();
            player.hand.push(drawn);
            player.lastDrawnCard = drawn; // Stores drawn card for Tactical Play (White Glow)
            sortHand(player.hand);
        }
        updateRoom(myRoomId);
    });

    socket.on('pass', () => {
        const room = rooms[myRoomId];
        if (!room) return;
        const p = room.players[room.currentPlayerIndex];
        if (p && p.sessionId === mySessionId && p.lastDrawnCard) {
            p.lastDrawnCard = null; 
            nextTurn(myRoomId); 
            updateRoom(myRoomId);
        }
    });

    // --- SYSTEM: DISCONNECT / REAPER ---
    socket.on('disconnect', () => {
        const room = rooms[myRoomId];
        if (room) {
            const p = room.players.find(pl => pl.sessionId === mySessionId);
            if (p) p.socketId = null;
            const onlineCount = room.players.filter(pl => pl.socketId).length;
            
            if (onlineCount < room.maxPlayers && !room.reaperTimer) {
                room.reaperEnd = Date.now() + 60000; // 60s timeout
                room.reaperTimer = setInterval(() => {
                    if (Date.now() >= room.reaperEnd) {
                        io.to(myRoomId).emit('roomDestroyed', "Room expired: Inactivity.");
                        clearInterval(room.reaperTimer);
                        delete rooms[myRoomId];
                    } else {
                        updateRoom(myRoomId);
                    }
                }, 1000);
            }
            updateRoom(myRoomId);
        }
    });

    socket.on('requestRestart', () => {
        const room = rooms[myRoomId];
        if (room && mySessionId === room.hostId) {
            room.gameStarted = true;
            startRound(myRoomId);
        }
    });
});

server.listen(process.env.PORT || 3000);
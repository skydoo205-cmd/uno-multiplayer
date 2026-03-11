const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

const rooms = {};
const COLOR_ORDER = { 'red': 1, 'blue': 2, 'green': 3, 'yellow': 4, 'black': 5 };

// --- BLOCK: DECK GENERATION ---
// Purpose: Creates and shuffles a standard UNO deck.
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

// --- BLOCK: HAND SORTING ---
// Purpose: Groups cards by color then type for player UI.
function sortHand(hand) {
    return hand.sort((a, b) => {
        if (COLOR_ORDER[a.color] !== COLOR_ORDER[b.color]) {
            return COLOR_ORDER[a.color] - COLOR_ORDER[b.color];
        }
        return a.type.localeCompare(b.type, undefined, {numeric: true});
    });
}

// --- BLOCK: ROOM BROADCASTER ---
// Purpose: Syncs game state to all clients. Included God-Mode for Spectators.
function updateRoom(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    const currentPlayer = room.players[room.currentPlayerIndex];
    
    // NEW: God-Mode Spectating (Spectators see counts, but client script handles card transparency)
    const counts = room.players.map(p => ({ 
        sessionId: p.sessionId, 
        cardCount: p.hand.length, 
        isOffline: !p.socketId 
    }));

    let reaperTime = null;
    if (room.reaperTimer && room.reaperEnd) {
        reaperTime = Math.max(0, Math.ceil((room.reaperEnd - Date.now()) / 1000));
    }

    room.players.forEach(p => {
        if (p.socketId) {
            io.to(p.socketId).emit('init', {
                hand: p.hand,
                topCard: room.discardPile[room.discardPile.length - 1],
                turnId: currentPlayer.sessionId,
                players: counts, // Modified to match new naming convention
                scores: room.scores,
                deckCount: room.deck.length,
                unoTarget: room.unoTarget,
                windowActive: room.unoWindowActive,
                stack: room.stackCount,
                waitingForPass: currentPlayer.lastDrawnCard, // Sending the actual card for White Glow
                reaperTimeLeft: reaperTime,
                finishOrder: room.finishOrder,
                isSpectator: room.finishOrder.includes(p.sessionId)
            });
        }
    });
}

// --- BLOCK: TURN MANAGEMENT ---
// Purpose: Handles skips, reverse, and jumping over finished players.
function nextTurn(roomId, skip = 1) {
    const room = rooms[roomId];
    if (!room) return;
    let playersCount = room.players.length;

    // RULE: Reverse logic for 1v1 (Reverse acts as Skip)
    let activeCount = room.players.filter(p => !room.finishOrder.includes(p.sessionId)).length;
    let actualSkip = (activeCount === 2 && skip === 1 && room.lastCardType === 'Reverse') ? 2 : skip;

    room.currentPlayerIndex = (room.currentPlayerIndex + (room.direction * actualSkip) + playersCount) % playersCount;
    
    let safety = 0;
    while (room.finishOrder.includes(room.players[room.currentPlayerIndex].sessionId) && safety < 20) {
        room.currentPlayerIndex = (room.currentPlayerIndex + room.direction + playersCount) % playersCount;
        safety++;
    }
}

// --- BLOCK: ROUND START ---
// Purpose: Resets state and ensures first card is not a Power Card.
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
    // RULE: No power card start
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

    socket.on('joinRoom', (data) => {
        const { roomId, sessionId, playerLimit } = data;
        myRoomId = roomId; mySessionId = sessionId;

        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [], deck: [], discardPile: [], currentPlayerIndex: 0,
                direction: 1, gameStarted: false, stackCount: 0,
                scores: {}, finishOrder: [], maxPlayers: playerLimit || 4,
                unoWindowActive: false, unoTarget: null, restartVotes: new Set(),
                reaperTimer: null, reaperEnd: null, hostId: sessionId
            };
        }
        const room = rooms[roomId];
        let p = room.players.find(p => p.sessionId === sessionId);

        if (p) {
            p.socketId = socket.id;
            socket.join(roomId);
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
            } else {
                // Fixed syntax error here
                io.to(roomId).emit('status', `Lobby: ${room.players.length}/${room.maxPlayers}`);
            }
        } else socket.emit('roomFull');
    });

    // --- BLOCK: PLAY CARD LOGIC ---
    // Purpose: Core gameplay, stacking hierarchy, and Win Logic.
    socket.on('playCard', (data) => {
        const room = rooms[myRoomId];
        if (!room || room.gameStarted === false) return;
        
        const player = room.players[room.currentPlayerIndex];
        if (player.sessionId !== mySessionId) return;

        const card = player.hand[data.index];
        const top = room.discardPile[room.discardPile.length - 1];

        if (player.lastDrawnCard && card !== player.lastDrawnCard) return;

        // RULE: Stacking Hierarchy (+2 on +2, +4 on +2/+4, but NO +2 on +4)
        if (room.stackCount > 0) {
            const canStack = (card.type === '+4') || (top.type === '+2' && card.type === '+2');
            if (!canStack) return;
        }

        const isWild = (card.color === 'black');
        const matchesTop = (card.color === top.color || card.type === top.type);

        if (matchesTop || isWild) {
            if (isWild && !data.chosenColor) return; 

            if (isWild) card.color = data.chosenColor;
            room.lastCardType = card.type; // Track for Reverse logic

            if (card.type === '+2') room.stackCount += 2;
            if (card.type === '+4') room.stackCount += 4;

            let skipCount = 1;
            const activePlayers = room.players.filter(p => !room.finishOrder.includes(p.sessionId));

            if (card.type === 'Skip') {
                skipCount = 2;
            } else if (card.type === 'Reverse') {
                if (activePlayers.length === 2) {
                    skipCount = 2;
                } else {
                    room.direction *= -1;
                    skipCount = 1;
                }
            }

            player.hand.splice(data.index, 1);
            room.discardPile.push(card);
            player.lastDrawnCard = null;

            // --- BLOCK: 5-PLAYER FINISH LOGIC (Lone Loser Fix) ---
            if (player.hand.length === 0) {
                if (!room.finishOrder.includes(mySessionId)) room.finishOrder.push(mySessionId);
                
                const stillPlaying = room.players.filter(p => !room.finishOrder.includes(p.sessionId));
                
                // If only 1 person left, the game is over.
                if (stillPlaying.length <= 1) {
                    if (stillPlaying.length === 1) room.finishOrder.push(stillPlaying[0].sessionId);
                    
                    room.finishOrder.forEach((sid, idx) => {
                        room.scores[sid] += (room.players.length - 1 - idx);
                    });

                    room.gameStarted = false;
                    io.to(myRoomId).emit('results', { order: room.finishOrder, scores: room.scores });
                    updateRoom(myRoomId);
                    return;
                }
            }

            nextTurn(myRoomId, skipCount);
            updateRoom(myRoomId);
        }
    });

    // --- BLOCK: DRAW PILE & INFINITE DECK ---
    socket.on('draw', () => {
        const room = rooms[myRoomId];
        if (!room || room.players[room.currentPlayerIndex].sessionId !== mySessionId) return;
        const player = room.players[room.currentPlayerIndex];
        
        // Purpose: Infinite Deck reshuffling
        const reshuffle = () => {
            if (room.deck.length < 1) {
                const top = room.discardPile.pop();
                room.deck = [...room.discardPile].sort(() => Math.random() - 0.5);
                room.discardPile = [top];
            }
        };

        if (room.stackCount > 0) {
            for(let i=0; i<room.stackCount; i++) {
                reshuffle();
                player.hand.push(room.deck.shift());
            }
            room.stackCount = 0;
            sortHand(player.hand);
            nextTurn(myRoomId);
        } else {
            if (player.lastDrawnCard) return;
            reshuffle();
            const drawn = room.deck.shift();
            player.hand.push(drawn);
            player.lastDrawnCard = drawn;
            sortHand(player.hand);
        }
        updateRoom(myRoomId);
    });

    // --- BLOCK: VOTE/BOOM SYSTEM ---
    socket.on('requestRestart', () => {
        const room = rooms[myRoomId];
        if (!room) return;
        room.restartVotes.add(mySessionId);
        // RULE: Unanimous vote
        if (room.restartVotes.size >= room.players.length) {
            room.restartVotes.clear();
            room.gameStarted = true;
            startRound(myRoomId);
        } else {
            io.to(myRoomId).emit('status', `Votes: ${room.restartVotes.size}/${room.players.length}`);
        }
    });

    socket.on('exitTournament', () => {
        if (myRoomId && rooms[myRoomId]) { 
            // RULE: Boom! Teleport everyone home
            io.to(myRoomId).emit('roomDestroyed', "A player left the tournament."); 
            delete rooms[myRoomId]; 
        }
    });

    socket.on('disconnect', () => {
        const room = rooms[myRoomId];
        if (room) {
            const p = room.players.find(pl => pl.sessionId === mySessionId);
            if (p) p.socketId = null;

            // Start Reaper
            if (!room.reaperTimer) {
                room.reaperEnd = Date.now() + 60000;
                room.reaperTimer = setInterval(() => {
                    if (Date.now() >= room.reaperEnd) {
                        io.to(myRoomId).emit('roomDestroyed', "Room expired.");
                        clearInterval(room.reaperTimer);
                        delete rooms[myRoomId];
                    } else {
                        updateRoom(myRoomId);
                    }
                }, 1000);
            }
        }
    });
});

server.listen(process.env.PORT || 3000);
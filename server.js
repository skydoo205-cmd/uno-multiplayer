const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

const rooms = {};
const COLOR_ORDER = { 'red': 1, 'blue': 2, 'green': 3, 'yellow': 4, 'black': 5 };

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

function sortHand(hand) {
    return hand.sort((a, b) => {
        if (COLOR_ORDER[a.color] !== COLOR_ORDER[b.color]) {
            return COLOR_ORDER[a.color] - COLOR_ORDER[b.color];
        }
        return a.type.localeCompare(b.type, undefined, {numeric: true});
    });
}

function updateRoom(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    const topCard = room.discardPile[room.discardPile.length - 1];
    const currentPlayer = room.players[room.currentPlayerIndex];

    // --- FIX: The Reaper Calculation ---
    let reaperTime = null;

    // Check if there is an active end-time set for this room
    if (room.reaperEnd) {
        const now = Date.now();
        const diff = room.reaperEnd - now;
        
        // Only show a number if there's time left
        if (diff > 0) {
            reaperTime = Math.ceil(diff / 1000);
        } else {
            // If time is up (0 or negative), stop showing it 
            // This prevents the "Stuck at 4s" visual bug
            reaperTime = 0; 
            
            // OPTIONAL: If time is up, the server should trigger a draw/skip here
            // if (room.reaperActive) { handleTimeout(roomId); }
        }
    }

    room.players.forEach((p) => {
        // Requirement: Spectator "God Mode" (Winners see everyone's cards)
        const isSpectator = room.finishOrder.includes(p.sessionId);
        
        const payload = {
            roomCode: roomId,
            players: room.players.map(player => ({
                username: player.username,
                sessionId: player.sessionId,
                cardCount: player.hand.length,
                isOffline: !player.socketId // Checks if player is disconnected
            })),
            topCard: topCard,
            currentPlayerIndex: room.currentPlayerIndex,
            turnId: currentPlayer.sessionId, // Helps client identify whose turn it is
            direction: room.direction,
            
            // --- Logic for V5.1 Smart Glows ---
            waitingForPass: p.lastDrawnCard, // Sends the card object for the White Glow
            stack: room.stackCount, // Sends stack count to block "Liar Glows"
            
            hand: p.hand,
            finishOrder: room.finishOrder,
            results: room.results,
            reaperTimeLeft: reaperTime,
            isSpectator: isSpectator,
            deckCount: room.deck.length
        };

        // Send to player via their specific session/socket
        io.to(p.sessionId).emit('init', payload);
    });
}

function nextTurn(roomId, skip = 1) {
    const room = rooms[roomId];
    if (!room) return;
    let playersCount = room.players.length;
    // Step 1: Execute the jump (1 for normal, 2 for Skip/1v1 Reverse)
    // We do this 'skip' times to ensure we properly jump over the right number of people
    for (let i = 0; i < skip; i++) {
        room.currentPlayerIndex = (room.currentPlayerIndex + room.direction + playersCount) % playersCount;
        
        // Step 2: The Spectator Bridge
        // If the person we landed on is already finished, we MUST keep moving 
        // until we find someone still playing. This doesn't count as a "skip".
        let safety = 0;
        while (room.finishOrder.includes(room.players[room.currentPlayerIndex].sessionId) && safety < playersCount) {
            room.currentPlayerIndex = (room.currentPlayerIndex + room.direction + playersCount) % playersCount;
            safety++;
        }
    }
}

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
                io.to(roomId).emit('status', `Lobby: ${room.players.length}/${room.maxPlayers}`);
            }
        } else socket.emit('roomFull');
    });

    socket.on('playCard', (data) => {
        const room = rooms[myRoomId];
        // Requirement: Action Locking (500ms cooldown)
        const now = Date.now();
        if (now - lastClickTime < 500) return;
        lastClickTime = now;

        if (!room || room.gameStarted === false) return;
        const player = room.players[room.currentPlayerIndex];
        if (player.sessionId !== mySessionId) return;

        const card = player.hand[data.index];
        const top = room.discardPile[room.discardPile.length - 1];

        if (player.lastDrawnCard && card !== player.lastDrawnCard) return;

        // Requirement: Escalating Stacking Logic
        if (room.stackCount > 0) {
            const canStack = (card.type === '+4') || (top.type === '+2' && card.type === '+2');
            if (!canStack) return;
        }

        const isWild = (card.color === 'black');
        const matchesTop = (card.color === top.color || card.type === top.type);

        if (matchesTop || isWild) {
            if (isWild && !data.chosenColor) return; 

            if (isWild) card.color = data.chosenColor;

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

            if (player.hand.length === 1) {
                room.unoWindowActive = true; 
                room.unoTarget = mySessionId;
                setTimeout(() => { 
                    if (rooms[myRoomId]) { 
                        rooms[myRoomId].unoWindowActive = false; 
                        updateRoom(myRoomId); 
                    } 
                }, 5000);
            }

            // --- FIND THIS LINE AROUND LINE 183 ---
           if (player.hand.length === 0) {
                if (!room.finishOrder.includes(mySessionId)) {
                    room.finishOrder.push(mySessionId);
                }

                const activePlayers = room.players.filter(p => !room.finishOrder.includes(p.sessionId));

                // SCENARIO A: The game is OVER (Only 1 or 0 players left)
                if (activePlayers.length <= 1) {
                    if (activePlayers.length === 1) {
                        room.finishOrder.push(activePlayers[0].sessionId);
                    }

                    room.finishOrder.forEach((sid, idx) => {
                        const points = (room.players.length - 1 - idx);
                        room.scores[sid] += points;
                    });

                    if (room.reaperTimer) {
                        clearInterval(room.reaperTimer);
                        room.reaperTimer = null;
                        room.reaperEnd = null;
                    }

                    room.gameStarted = false;
                    io.to(myRoomId).emit('results', { order: room.finishOrder, scores: room.scores });
                    updateRoom(myRoomId);
                    return; // Tournament ends here
                }
                
                // SCENARIO B: The game CONTINUES (More than 1 player left)
                // We must call nextTurn here so the game doesn't freeze on the winner!
                nextTurn(myRoomId, skipCount);
                updateRoom(myRoomId);
                return; 
            }

            // SCENARIO C: Normal play (Player still has cards)
            nextTurn(myRoomId, skipCount);
            updateRoom(myRoomId);
        }
    });
    
    socket.on('draw', () => {
        const room = rooms[myRoomId];
        if (!room || room.players[room.currentPlayerIndex].sessionId !== mySessionId) return;
        const player = room.players[room.currentPlayerIndex];
        
        // Requirement: Infinite Deck (Reshuffle)
        const checkDeck = () => {
            if (room.deck.length < 1) {
                const top = room.discardPile.pop();
                room.deck = [...room.discardPile].sort(() => Math.random() - 0.5);
                room.discardPile = [top];
            }
        };

        if (room.stackCount > 0) {
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
            player.lastDrawnCard = drawn;
            sortHand(player.hand);
        }
        updateRoom(myRoomId);
    });

    socket.on('chatMessage', (data) => {
        if (myRoomId && rooms[myRoomId]) {
            io.to(myRoomId).emit('newChatMessage', { 
                user: mySessionId.substring(0, 4), 
                msg: data.msg 
            });
        }
    });

    socket.on('disconnect', () => {
        const room = rooms[myRoomId];
        if (room) {
            const p = room.players.find(pl => pl.sessionId === mySessionId);
            if (p) p.socketId = null;
            const onlineCount = room.players.filter(pl => pl.socketId).length;
            
            if (onlineCount < room.maxPlayers && !room.reaperTimer) {
                room.reaperEnd = Date.now() + 120000;
                room.reaperTimer = setInterval(() => {
                    const timeLeft = Math.ceil((room.reaperEnd - Date.now()) / 1000);
                    if (timeLeft <= 0) {
                        io.to(myRoomId).emit('roomDestroyed', "Room expired: Timeout.");
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

    socket.on('pass', () => {
        const room = rooms[myRoomId];
        if (!room) return;
        const p = room.players[room.currentPlayerIndex];
        if (p && p.sessionId === mySessionId && p.lastDrawnCard) {
            p.lastDrawnCard = null; nextTurn(myRoomId); updateRoom(myRoomId);
        }
    });

    socket.on('unoAction', (type) => {
        const room = rooms[myRoomId];
        if (!room || !room.unoWindowActive) return;
        if (type === 'safe' && mySessionId === room.unoTarget) { room.unoWindowActive = false; }
        else if (type === 'penalty' && mySessionId !== room.unoTarget) {
            const victim = room.players.find(p => p.sessionId === room.unoTarget);
            for(let i=0; i<2; i++) { 
                if (room.deck.length < 1) {
                    const top = room.discardPile.pop();
                    room.deck = [...room.discardPile].sort(() => Math.random() - 0.5);
                    room.discardPile = [top];
                }
                victim.hand.push(room.deck.shift()); 
            }
            sortHand(victim.hand);
            room.unoWindowActive = false;
        }
        updateRoom(myRoomId);
    });

    socket.on('requestRestart', () => {
        const room = rooms[myRoomId];
        if (!room) return;
        // Requirement: Host Control (Only creator starts round)
        if (mySessionId !== room.hostId) return;
        
        room.gameStarted = true;
        startRound(myRoomId);
    });

    socket.on('exitTournament', () => {
        if (myRoomId && rooms[myRoomId]) { 
            io.to(myRoomId).emit('roomDestroyed', "A player left the tournament."); 
            if(rooms[myRoomId].reaperTimer) clearInterval(rooms[myRoomId].reaperTimer);
            delete rooms[myRoomId]; 
        }
    });

    // Requirement: Desync Shield (Heartbeat)
    const syncInterval = setInterval(() => {
        if (myRoomId && rooms[myRoomId]) updateRoom(myRoomId);
        else clearInterval(syncInterval);
    }, 5000);
});

server.listen(process.env.PORT || 3000);
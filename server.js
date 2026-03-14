const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

const rooms = {};
const COLOR_ORDER = { 'red': 1, 'blue': 2, 'green': 3, 'yellow': 4, 'black': 5 };

// --- BLOCK: DECK GENERATION (RETAINED 100%) ---
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

// --- BLOCK: HAND SORTING (RETAINED 100%) ---
function sortHand(hand) {
    return hand.sort((a, b) => {
        if (COLOR_ORDER[a.color] !== COLOR_ORDER[b.color]) {
            return COLOR_ORDER[a.color] - COLOR_ORDER[b.color];
        }
        return a.type.localeCompare(b.type, undefined, {numeric: true});
    });
}

// --- BLOCK: ROOM BROADCASTER (RE-EXPANDED WITH ALL ORIGINAL PROPERTIES) ---
function updateRoom(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    const currentPlayer = room.players[room.currentPlayerIndex];
    
    const counts = room.players.map(p => ({ 
        sessionId: p.sessionId, 
        name: p.name,
        cardCount: p.hand.length, 
        isOffline: !p.socketId,
        saidUno: p.saidUno 
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
                players: counts, 
                scores: room.scores,
                deckCount: room.deck.length,
                unoTarget: room.unoTarget,
                unoWindowActive: room.unoWindowActive,
                stack: room.stackCount,
                // MODIFIED: lastDrawnCard only sent to the active player for staging
                lastDrawnCard: (p.sessionId === currentPlayer.sessionId) ? currentPlayer.lastDrawnCard : null,
                reaperTimeLeft: reaperTime,
                finishOrder: room.finishOrder,
                isSpectator: room.finishOrder.includes(p.sessionId)
            });
        }
    });
}

// --- BLOCK: TURN MANAGEMENT (RETAINED 100% 1v1 REVERSE RULE) ---
function nextTurn(roomId, skip = 1) {
    const room = rooms[roomId];
    if (!room) return;
    let playersCount = room.players.length;
    let activeCount = room.players.filter(p => !room.finishOrder.includes(p.sessionId)).length;
    let actualSkip = (activeCount === 2 && skip === 1 && room.lastCardType === 'Reverse') ? 2 : skip;

    room.currentPlayerIndex = (room.currentPlayerIndex + (room.direction * actualSkip) + playersCount) % playersCount;
    
    let safety = 0;
    while (room.finishOrder.includes(room.players[room.currentPlayerIndex].sessionId) && safety < 20) {
        room.currentPlayerIndex = (room.currentPlayerIndex + room.direction + playersCount) % playersCount;
        safety++;
    }
}

// --- BLOCK: ROUND START (RETAINED 100% POWER-CARD-START PROTECTION) ---
function startRound(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    room.finishOrder = [];
    room.stackCount = 0;
    room.direction = 1;
    room.currentPlayerIndex = 0;
    room.deck = createDeck();

    room.players.forEach(p => { 
        p.hand = sortHand(room.deck.splice(0, 10)); // Back to your original 10-card start
        p.lastDrawnCard = null; 
        p.saidUno = false;
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

    socket.on('joinRoom', (data) => {
        const { roomId, sessionId, playerLimit, playerName } = data;
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
            p.name = playerName || p.name;
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
            room.players.push({ sessionId, name: playerName, socketId: socket.id, hand: [], lastDrawnCard: null, saidUno: false });
            room.scores[sessionId] = room.scores[sessionId] || 0;
            socket.emit('roomJoined', roomId);
            
            if (room.players.length === room.maxPlayers) {
                room.gameStarted = true;
                startRound(roomId);
            } else {
                io.to(roomId).emit('status', `Lobby: ${room.players.length}/${room.maxPlayers}`);
                updateRoom(roomId);
            }
        }
    });

    // --- BLOCK: PLAY CARD (RETAINED STACKING HIERARCHY + 5-PLAYER SCORING) ---
    socket.on('playCard', (data) => {
        const room = rooms[myRoomId];
        if (!room || room.gameStarted === false) return;
        const player = room.players[room.currentPlayerIndex];
        if (player.sessionId !== mySessionId) return;

        // FIXED: STAGING AREA SUPPORT
        let card;
        if (data.index === -1) {
            card = player.lastDrawnCard;
        } else {
            card = player.hand[data.index];
        }

        if (!card) return;
        const top = room.discardPile[room.discardPile.length - 1];

        // RETAINED: STACKING HIERARCHY
        if (room.stackCount > 0) {
            const canStack = (card.type === '+4') || (top.type === '+2' && card.type === '+2');
            if (!canStack) return;
        }

        const isWild = (card.color === 'black');
        const matchesTop = (card.color === top.color || card.type === top.type);

        if (matchesTop || isWild) {
            if (isWild && !data.chosenColor) return; 
            if (isWild) card.color = data.chosenColor;
            room.lastCardType = card.type;

            if (card.type === '+2') room.stackCount += 2;
            if (card.type === '+4') room.stackCount += 4;

            let skipCount = 1;
            if (card.type === 'Skip') { 
                skipCount = 2;
            } else if (card.type === 'Reverse') {
                const activePlayers = room.players.filter(p => !room.finishOrder.includes(p.sessionId));
                if (activePlayers.length === 2) {
                     skipCount = 2;
                } else {   
                    room.direction *= -1; skipCount = 1; 
                }
            }

            // Move card to House
            if (data.index === -1) { player.lastDrawnCard = null; } 
            else { player.hand.splice(data.index, 1); }
            room.discardPile.push(card);

            // RETAINED: 5-PLAYER FINISH LOGIC
            if (player.hand.length === 0) {
                if (!room.finishOrder.includes(mySessionId)) room.finishOrder.push(mySessionId);

                // Clear any staged cards so the UI doesn't glitch
                player.lastDrawnCard = null;

                const stillPlaying = room.players.filter(p => !room.finishOrder.includes(p.sessionId));

                if (stillPlaying.length <= 1) {
                    if (stillPlaying.length === 1) {
                        const loserId = stillPlaying[0].sessionId;
                        if (!room.finishOrder.includes(loserId)) room.finishOrder.push(loserId);
                    }

                    room.finishOrder.forEach((sid, idx) => {
                        room.scores[sid] += (room.players.length - 1 - idx);
                    });

                    room.gameStarted = false;

                    io.to(myRoomId).emit('results', { order: room.finishOrder, scores: room.scores });
                    updateRoom(myRoomId);
                    return;
                }
            }
            
            // Handle UNO window penalty flag
            if (player.hand.length === 1 && !player.saidUno) {
                room.unoWindowActive = true;
                room.unoTarget = player.sessionId;
                
                // ADD THIS: Auto-close the window after 2 seconds
                setTimeout(() => {
                    if (room.unoWindowActive && room.unoTarget === player.sessionId) {
                        room.unoWindowActive = false;
                        updateRoom(roomId); // Refresh UI to hide penalty button
                    }
                }, 2000); 
            }

            nextTurn(myRoomId, skipCount);
            updateRoom(myRoomId);
        }
    });

    // --- BLOCK: DRAW PILE (RETAINED INFINITE DECK + AUTO-SKIP STACK) ---
    socket.on('draw', () => {
        const room = rooms[myRoomId];
        if (!room) return;
        const player = room.players[room.currentPlayerIndex];
        if (player.sessionId !== mySessionId || player.lastDrawnCard) return;
        
        player.saidUno = false;

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
            const topCard = room.discardPile[room.discardPile.length - 1];
            if (topCard) topCard.isUsed = true;
            sortHand(player.hand);
            nextTurn(myRoomId);
        } else {
            reshuffle();
            player.lastDrawnCard = room.deck.shift();
            // Staging: Drawn card is NOT added to hand yet
        }
        updateRoom(myRoomId);
    });

    // --- NEW: CHAT/PASS/UNO SYSTEM ---
    socket.on('pass', () => {
        const room = rooms[myRoomId];
        if (!room) return;
        const player = room.players[room.currentPlayerIndex];
        if (player.sessionId !== mySessionId || !player.lastDrawnCard) return;
        
        player.hand.push(player.lastDrawnCard);
        player.lastDrawnCard = null;
        sortHand(player.hand);
        nextTurn(myRoomId);
        updateRoom(myRoomId);
    });

    socket.on('unoAction', (type) => {
        const room = rooms[myRoomId];
        if (!room) return;
        const p = room.players.find(pl => pl.sessionId === mySessionId);
        if (type === 'safe') {
            if (p.hand.length <= 2) p.saidUno = true;
        } else if (type === 'penalty' && room.unoWindowActive) {
            const target = room.players.find(pl => pl.sessionId === room.unoTarget);
            if (target) {
                for(let i=0; i<2; i++) {
                    if (room.deck.length < 1) {
                        const top = room.discardPile.pop();
                        room.deck = [...room.discardPile].sort(() => Math.random() - 0.5);
                        room.discardPile = [top];
                    }
                    target.hand.push(room.deck.shift());
                }
                room.unoWindowActive = false;
                target.saidUno = false;
                sortHand(target.hand);
            }
        }
        updateRoom(myRoomId);
    });

    socket.on('chatMessage', (data) => {
        const room = rooms[myRoomId];
        if (!room) return;
        const p = room.players.find(pl => pl.sessionId === mySessionId);
        if (p) io.to(myRoomId).emit('newChatMessage', { user: p.name, msg: data.msg });
    });

    socket.on('requestRestart', () => {
        const room = rooms[myRoomId];
        if (!room) return;
        room.restartVotes.add(mySessionId);
        if (room.restartVotes.size >= room.players.length) {
            room.restartVotes.clear();
            room.gameStarted = true;
            startRound(myRoomId);
        } else {
            io.to(myRoomId).emit('restartProgress', { current: room.restartVotes.size, total: room.players.length });
        }
    });

    socket.on('exitTournament', () => {
        if (myRoomId && rooms[myRoomId]) { 
            io.to(myRoomId).emit('roomDestroyed', "A player left the tournament."); 
            delete rooms[myRoomId]; 
        }
    });

    socket.on('disconnect', () => {
        const room = rooms[myRoomId];
        if (room) {
            const p = room.players.find(pl => pl.sessionId === mySessionId);
            if (p) p.socketId = null;
            if (!room.reaperTimer) {
                room.reaperEnd = Date.now() + 60000;
                room.reaperTimer = setInterval(() => {
                    if (Date.now() >= room.reaperEnd) {
                        io.to(myRoomId).emit('roomDestroyed', "Room expired.");
                        clearInterval(room.reaperTimer);
                        delete rooms[myRoomId];
                    } else { updateRoom(myRoomId); }
                }, 1000);
            }
        }
    });
});

server.listen(process.env.PORT || 3000);
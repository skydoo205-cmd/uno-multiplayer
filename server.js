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
    const currentPlayer = room.players[room.currentPlayerIndex];
    const counts = room.players.map(p => ({ 
        id: p.sessionId, count: p.hand.length, online: !!p.socketId 
    }));

    let reaperTime = null;
    if (room.reaperTimer && room.reaperEnd) {
        reaperTime = Math.max(0, Math.ceil((room.reaperEnd - Date.now()) / 1000));
    }

    room.players.forEach(p => {
        if (p.socketId) {
            // Requirement: Spectator "God Mode" (Winners see everyone's cards)
            const isSpectator = room.finishOrder.includes(p.sessionId);
            
            io.to(p.socketId).emit('init', {
                hand: p.hand,
                topCard: room.discardPile[room.discardPile.length - 1],
                turnId: currentPlayer.sessionId,
                cardCounts: counts,
                scores: room.scores,
                deckCount: room.deck.length,
                unoTarget: room.unoTarget,
                windowActive: room.unoWindowActive,
                stack: room.stackCount,
                waitingForPass: !!currentPlayer.lastDrawnCard,
                reaperTimeLeft: reaperTime,
                finishOrder: room.finishOrder,
                isSpectator: isSpectator
            });
        }
    });
}

function nextTurn(roomId, skip = 1) {
    const room = rooms[roomId];
    if (!room) return;
    let playersCount = room.players.length;
    let safety = 0;

    room.currentPlayerIndex = (room.currentPlayerIndex + (room.direction * skip) + playersCount) % playersCount;
    
    // Requirement: Turn-Skip Logic (Skip anyone in finishOrder)
    while (room.finishOrder.includes(room.players[room.currentPlayerIndex].sessionId) && safety < 20) {
        room.currentPlayerIndex = (room.currentPlayerIndex + room.direction + playersCount) % playersCount;
        safety++;
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

            if (player.hand.length === 0) {
                if (!room.finishOrder.includes(mySessionId)) room.finishOrder.push(mySessionId);
                
                // Requirement: Full Order Calculation & Persistent Scores
                if (room.finishOrder.length >= room.players.length - 1) {
                    const last = room.players.find(p => !room.finishOrder.includes(p.sessionId));
                    if(last) room.finishOrder.push(last.sessionId);

                    room.finishOrder.forEach((sid, idx) => {
                        const points = (room.players.length - 1 - idx);
                        room.scores[sid] += points;
                    });

                    io.to(myRoomId).emit('results', { order: room.finishOrder, scores: room.scores });
                    room.gameStarted = false;
                    return;
                }
            }

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
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

const rooms = {};

function createDeck() {
    const colors = ['red', 'blue', 'green', 'yellow'];
    const types = ['0','1','2','3','4','5','6','7','8','9','Skip','Reverse','+2'];
    let deck = [];
    colors.forEach(c => types.forEach(t => {
        let count = t === '0' ? 1 : 2;
        for(let i=0; i<count; i++) deck.push({color: c, type: t});
    }));
    for(let i=0; i<4; i++) {
        deck.push({color: 'black', type: 'Wild'}, {color: 'black', type: '+4'});
    }
    return deck.sort(() => Math.random() - 0.5);
}

function updateRoom(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    const counts = room.players.map(p => ({ 
        id: p.sessionId, count: p.hand.length, online: !!p.socketId 
    }));
    room.players.forEach(p => {
        if (p.socketId) {
            io.to(p.socketId).emit('init', {
                hand: p.hand,
                topCard: room.discardPile[room.discardPile.length - 1],
                turnId: room.players[room.currentPlayerIndex].sessionId,
                cardCounts: counts,
                scores: room.scores,
                deckCount: room.deck.length,
                unoTarget: room.unoTarget, // Who is in the "Hot Seat"
                windowActive: room.unoWindowActive
            });
        }
    });
}

function nextTurn(roomId, skip = 1) {
    const room = rooms[roomId];
    const active = room.players.filter(p => !room.finishOrder.includes(p.sessionId));
    
    // 2-Player Logic: Skip/Reverse = Go Again
    if (active.length === 2 && skip > 1) return; 

    let playersCount = room.players.length;
    room.currentPlayerIndex = (room.currentPlayerIndex + (room.direction * skip) + playersCount) % playersCount;
    while (room.finishOrder.includes(room.players[room.currentPlayerIndex].sessionId)) {
        room.currentPlayerIndex = (room.currentPlayerIndex + room.direction + playersCount) % playersCount;
    }
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
                scores: {}, finishOrder: [], restartVotes: new Set(),
                maxPlayers: playerLimit || 4, unoWindowActive: false, unoTarget: null
            };
        }
        const room = rooms[roomId];
        let p = room.players.find(p => p.sessionId === sessionId);

        if (p) {
            p.socketId = socket.id;
            socket.join(roomId);
            socket.emit('roomJoined', roomId);
            updateRoom(roomId);
        } else if (room.players.length < room.maxPlayers && !room.gameStarted) {
            socket.join(roomId);
            room.players.push({ sessionId, socketId: socket.id, hand: [], saidUno: false });
            room.scores[sessionId] = 0;
            socket.emit('roomJoined', roomId);
            if (room.players.length === room.maxPlayers) {
                room.gameStarted = true;
                resetRound(roomId);
            }
        } else socket.emit('roomFull');
    });

    socket.on('playCard', (data) => {
        const room = rooms[myRoomId];
        if (!room || room.players[room.currentPlayerIndex].sessionId !== mySessionId) return;

        let player = room.players[room.currentPlayerIndex];
        let card = player.hand[data.index];
        let top = room.discardPile[room.discardPile.length - 1];

        // Stacking Logic
        if (room.stackCount > 0) {
            const canStack = (card.type === '+4') || (top.type !== '+4' && card.type === '+2');
            if (!canStack) return;
        }

        const isMatch = card.color === top.color || card.type === top.type || card.color === 'black';
        if (isMatch) {
            if (card.color === 'black') card.color = data.chosenColor;
            if (card.type === '+2') room.stackCount += 2;
            if (card.type === '+4') room.stackCount += 4;
            if (card.type === 'Reverse' && room.players.length > 2) room.direction *= -1;

            player.hand.splice(data.index, 1);
            room.discardPile.push(card);

            // UNO CALL-OUT WINDOW
            if (player.hand.length === 1) {
                room.unoWindowActive = true;
                room.unoTarget = mySessionId;
                player.saidUno = false;
                setTimeout(() => {
                    if (room && room.unoWindowActive && room.unoTarget === mySessionId) {
                        room.unoWindowActive = false;
                        updateRoom(myRoomId);
                    }
                }, 5000);
            }

            // Win Logic
            if (player.hand.length === 0) {
                room.finishOrder.push(mySessionId);
                if (room.finishOrder.length >= room.players.length - 1) {
                    const last = room.players.find(p => !room.finishOrder.includes(p.sessionId));
                    if (last) room.finishOrder.push(last.sessionId);
                    room.finishOrder.forEach((sid, idx) => {
                        // Dynamic Scoring: (Players - Rank)
                        room.scores[sid] += (room.maxPlayers - idx - 1);
                    });
                    io.to(myRoomId).emit('tournamentResults', { order: room.finishOrder, totalScores: room.scores });
                    room.gameStarted = false;
                    return;
                }
            }
            nextTurn(myRoomId, card.type === 'Skip' ? 2 : 1);
            updateRoom(myRoomId);
        }
    });

    socket.on('handleUno', (type) => {
        const room = rooms[myRoomId];
        if (!room || !room.unoWindowActive) return;
        
        if (type === 'safe' && mySessionId === room.unoTarget) {
            room.unoWindowActive = false;
            io.to(myRoomId).emit('status', `Player ${mySessionId.substring(0,4)} is SAFE!`);
        } else if (type === 'penalty' && mySessionId !== room.unoTarget) {
            const target = room.players.find(p => p.sessionId === room.unoTarget);
            for(let i=0; i<2; i++) if(room.deck.length > 0) target.hand.push(room.deck.shift());
            room.unoWindowActive = false;
            io.to(myRoomId).emit('status', `CAUGHT! Penalty applied to ${room.unoTarget.substring(0,4)}`);
        }
        updateRoom(myRoomId);
    });

    socket.on('draw', () => {
        const room = rooms[myRoomId];
        if (!room || room.players[room.currentPlayerIndex].sessionId !== mySessionId) return;
        if (room.stackCount > 0) {
            for(let i=0; i<room.stackCount; i++) room.players[room.currentPlayerIndex].hand.push(room.deck.shift());
            room.stackCount = 0;
            nextTurn(myRoomId);
        } else {
            room.players[room.currentPlayerIndex].hand.push(room.deck.shift());
        }
        updateRoom(myRoomId);
    });

    socket.on('disconnect', () => {
        if (rooms[myRoomId]) {
            const p = rooms[myRoomId].players.find(p => p.sessionId === mySessionId);
            if (p) p.socketId = null;
            setTimeout(() => {
                if (rooms[myRoomId] && rooms[myRoomId].players.every(pl => !pl.socketId)) delete rooms[myRoomId];
            }, 60000);
            updateRoom(myRoomId);
        }
    });
});

function resetRound(roomId) {
    const room = rooms[roomId];
    room.deck = createDeck();
    room.discardPile = [room.deck.shift()];
    room.players.forEach(p => p.hand = room.deck.splice(0, 10));
    updateRoom(roomId);
}
server.listen(3000);
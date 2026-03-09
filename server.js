const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

const rooms = {};

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

function updateRoom(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    const currentPlayer = room.players[room.currentPlayerIndex];
    const counts = room.players.map(p => ({ 
        id: p.sessionId, count: p.hand.length, online: !!p.socketId 
    }));

    room.players.forEach(p => {
        if (p.socketId) {
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
                waitingForPass: !!currentPlayer.lastDrawnCard
            });
        }
    });
}

function nextTurn(roomId, skip = 1) {
    const room = rooms[roomId];
    const active = room.players.filter(p => !room.finishOrder.includes(p.sessionId));
    if (active.length === 2 && skip > 1) return; 

    let playersCount = room.players.length;
    room.currentPlayerIndex = (room.currentPlayerIndex + (room.direction * skip) + playersCount) % playersCount;
    while (room.finishOrder.includes(room.players[room.currentPlayerIndex].sessionId)) {
        room.currentPlayerIndex = (room.currentPlayerIndex + room.direction + playersCount) % playersCount;
    }
}

function reshuffle(room) {
    const top = room.discardPile.pop();
    room.deck = [...room.deck, ...room.discardPile].sort(() => Math.random() - 0.5);
    room.discardPile = [top];
}

function startRound(roomId) {
    const room = rooms[roomId];
    room.deck = createDeck();
    room.players.forEach(p => { p.hand = room.deck.splice(0, 10); p.lastDrawnCard = null; });

    let firstCard = room.deck.shift();
    while (isNaN(firstCard.type)) { // STARTING CARD BUG FIX
        room.deck.push(firstCard);
        firstCard = room.deck.shift();
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
                unoWindowActive: false, unoTarget: null, restartVotes: new Set()
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
        if (!room || room.players[room.currentPlayerIndex].sessionId !== mySessionId) return;
        const player = room.players[room.currentPlayerIndex];
        const card = player.hand[data.index];
        const top = room.discardPile[room.discardPile.length - 1];

        if (player.lastDrawnCard && card !== player.lastDrawnCard) return;

        if (room.stackCount > 0) {
            const canStack = (card.type === '+4') || (top.type !== '+4' && card.type === '+2');
            if (!canStack) return;
        }

        if (card.color === top.color || card.type === top.type || card.color === 'black') {
            if (card.color === 'black') card.color = data.chosenColor;
            if (card.type === '+2') room.stackCount += 2;
            if (card.type === '+4') room.stackCount += 4;
            if (card.type === 'Reverse' && room.players.length > 2) room.direction *= -1;

            player.hand.splice(data.index, 1);
            room.discardPile.push(card);
            player.lastDrawnCard = null;

            if (player.hand.length === 1) {
                room.unoWindowActive = true; room.unoTarget = mySessionId;
                setTimeout(() => { if (rooms[myRoomId]) { rooms[myRoomId].unoWindowActive = false; updateRoom(myRoomId); } }, 5000);
            }

            if (player.hand.length === 0) {
                room.finishOrder.push(mySessionId);
                if (room.finishOrder.length >= room.players.length - 1) {
                    const last = room.players.find(p => !room.finishOrder.includes(p.sessionId));
                    if (last) room.finishOrder.push(last.sessionId);
                    room.finishOrder.forEach((sid, idx) => { room.scores[sid] += (room.maxPlayers - idx - 1); });
                    io.to(myRoomId).emit('results', { order: room.finishOrder, scores: room.scores });
                    room.gameStarted = false; return;
                }
            }
            nextTurn(myRoomId, card.type === 'Skip' ? 2 : 1);
            updateRoom(myRoomId);
        }
    });

    socket.on('draw', () => {
        const room = rooms[myRoomId];
        if (!room || room.players[room.currentPlayerIndex].sessionId !== mySessionId) return;
        const player = room.players[room.currentPlayerIndex];
        if (room.stackCount > 0) {
            for(let i=0; i<room.stackCount; i++) { if (room.deck.length < 1) reshuffle(room); player.hand.push(room.deck.shift()); }
            room.stackCount = 0; nextTurn(myRoomId);
        } else {
            if (player.lastDrawnCard) return;
            if (room.deck.length < 1) reshuffle(room);
            const drawn = room.deck.shift();
            player.hand.push(drawn); player.lastDrawnCard = drawn;
        }
        updateRoom(myRoomId);
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
            for(let i=0; i<2; i++) { if (room.deck.length < 1) reshuffle(room); victim.hand.push(room.deck.shift()); }
            room.unoWindowActive = false;
        }
        updateRoom(myRoomId);
    });

    socket.on('requestRestart', () => {
        const room = rooms[myRoomId];
        if (!room) return;
        room.restartVotes.add(mySessionId);
        if (room.restartVotes.size >= room.players.length) {
            room.restartVotes.clear(); room.finishOrder = []; room.gameStarted = true;
            room.direction = 1; room.currentPlayerIndex = 0; room.stackCount = 0;
            room.unoTarget = null; room.unoWindowActive = false;
            startRound(myRoomId);
        } else {
            io.to(myRoomId).emit('restartProgress', { current: room.restartVotes.size, total: room.players.length });
        }
    });

    socket.on('exitTournament', () => {
        if (myRoomId && rooms[myRoomId]) { io.to(myRoomId).emit('roomDestroyed'); delete rooms[myRoomId]; }
    });

    socket.on('disconnect', () => {
        if (rooms[myRoomId]) {
            const p = rooms[myRoomId].players.find(p => p.sessionId === mySessionId);
            if (p) p.socketId = null;
            setTimeout(() => { if (rooms[myRoomId] && rooms[myRoomId].players.every(pl => !pl.socketId)) delete rooms[myRoomId]; }, 60000);
            updateRoom(myRoomId);
        }
    });
});

server.listen(process.env.PORT || 3000);
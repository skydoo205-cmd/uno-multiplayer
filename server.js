const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

// --- GLOBAL ROOMS DATA ---
const rooms = {}; // Holds all active game states

function createDeck() {
    const colors = ['red', 'blue', 'green', 'yellow'];
    const types = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'Skip', 'Reverse', '+2'];
    let newDeck = [];
    colors.forEach(c => {
        types.forEach(t => {
            let count = t === '0' ? 1 : 2;
            for(let i=0; i<count; i++) newDeck.push({color: c, type: t});
        });
    });
    for(let i=0; i<4; i++) {
        newDeck.push({color: 'black', type: 'Wild'});
        newDeck.push({color: 'black', type: '+4'});
    }
    return newDeck;
}

function shuffle(arr) { return arr.sort(() => Math.random() - 0.5); }

// Logic specialized for individual rooms
function nextTurn(roomId, skip = 1) {
    const room = rooms[roomId];
    let playersCount = room.players.length;
    let attempts = 0;
    const activePlayers = room.players.filter(p => !room.finishOrder.includes(p.id));

    if (activePlayers.length === 2 && skip > 1) {
        console.log(`Room ${roomId}: Turn stays.`);
    } else {
        room.currentPlayerIndex = (room.currentPlayerIndex + (room.direction * skip) + playersCount) % playersCount;
        while (room.finishOrder.includes(room.players[room.currentPlayerIndex].id) && attempts < playersCount) {
            room.currentPlayerIndex = (room.currentPlayerIndex + room.direction + playersCount) % playersCount;
            attempts++;
        }
    }
}

// 1. FIX: Updated resetGame to handle 10 cards
function resetGame(roomId) {
    const room = rooms[roomId];
    room.finishOrder = [];
    room.restartVotes.clear();
    room.gameStarted = true;
    room.stackCount = 0;
    room.currentPlayerIndex = 0;
    room.direction = 1;

    let validStartFound = false;
    while (!validStartFound) {
        room.deck = shuffle(createDeck());
        const powerTypes = ['Skip', 'Reverse', '+2', '+4', 'Wild'];
        let idx = room.deck.findIndex(card => !powerTypes.includes(card.type) && card.color !== 'black');
        
        if (idx !== -1) {
            room.players.forEach(p => {
                // FORCE 10 CARDS HERE
                p.hand = room.deck.splice(0, 10); 
                p.lastDrawnCard = null;
                p.saidUno = false;
            });
            room.discardPile = [room.deck.splice(idx, 1)[0]];
            validStartFound = true;
        }
    }
    updateRoom(roomId);
}

// 2. FIX: Ensure updateRoom uses 'init' and transmits to all room members
function updateRoom(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    
    // Track who is online/offline based on sessionId
    const counts = room.players.map(p => ({ 
        id: p.sessionId, 
        count: p.hand.length, 
        online: !!p.socketId 
    }));

    room.players.forEach(p => {
        if (p.socketId) {
            // Emitting 'init' to match your script.js listener
            io.to(p.socketId).emit('init', { 
                hand: p.hand, 
                topCard: room.discardPile[room.discardPile.length - 1], 
                turnId: room.players[room.currentPlayerIndex].sessionId,
                cardCounts: counts,
                scores: room.scores,
                deckCount: room.deck.length
            });
        }
    });
}

function checkDeck(roomId) {
    const room = rooms[roomId];
    if (room.deck.length < 5) {
        const top = room.discardPile.pop();
        room.deck = shuffle([...room.deck, ...room.discardPile]);
        room.discardPile = [top];
        console.log(`Room ${roomId}: Deck reshuffled.`);
    }
}

io.on('connection', (socket) => {
    let currentRoomId = null;

    socket.on('joinRoom', (data) => {
        const { roomId, sessionId } = data; // Destructure from the object
    
        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [], deck: [], discardPile: [], currentPlayerIndex: 0,
                direction: 1, gameStarted: false, stackCount: 0,
                scores: {}, finishOrder: [], restartVotes: new Set()
            };
        }

        const room = rooms[roomId];
        myRoomId = roomId;
        mySessionId = sessionId;

        // Check for reconnection
        let existingPlayer = room.players.find(p => p.sessionId === sessionId);
        if (existingPlayer) {
            existingPlayer.socketId = socket.id;
            socket.join(roomId);
            socket.emit('roomJoined', roomId);
            updateRoom(roomId);
            return;
        }

        if (room.players.length < 4 && !room.gameStarted) {
            socket.join(roomId);
            // Store sessionId for persistent turns
            room.players.push({ 
                sessionId: sessionId, 
                socketId: socket.id, 
                hand: [], 
                lastDrawnCard: null, 
                saidUno: false 
            });
            room.scores[sessionId] = room.scores[sessionId] || 0;
            
            socket.emit('roomJoined', roomId);
            io.to(roomId).emit('status', `Waiting (${room.players.length}/4)...`);

            if (room.players.length === 4) resetGame(roomId);
        } else {
            socket.emit('roomFull');
        }
    });

    socket.on('playCard', (data) => {
        const room = rooms[currentRoomId];
        if (!room) return;

        const pIdx = room.players.findIndex(p => p.id === socket.id);
        if (pIdx !== room.currentPlayerIndex) return;
        
        let player = room.players[pIdx];
        let card = player.hand[data.index];
        let top = room.discardPile[room.discardPile.length - 1];

        if (player.lastDrawnCard && card !== player.lastDrawnCard) return;

        if (room.stackCount > 0) {
            const isStackable = (card.type === '+4') || (top.type !== '+4' && card.type === '+2');
            if (!isStackable) return;
        }

        const isMatch = card.color === top.color || card.type === top.type || card.color === 'black';

        if (isMatch) {
            if (card.color === 'black') card.color = data.chosenColor;
            if (card.type === '+2') room.stackCount += 2;
            if (card.type === '+4') room.stackCount += 4;

            player.hand.splice(data.index, 1);
            room.discardPile.push(card);
            player.lastDrawnCard = null; 

            if (player.hand.length === 1) {
                player.saidUno = false;
                setTimeout(() => {
                    const pCheck = room.players.find(p => p.id === player.id);
                    if (pCheck && pCheck.hand.length === 1 && !pCheck.saidUno) {
                        checkDeck(currentRoomId);
                        for (let i = 0; i < 2; i++) {
                            if (room.deck.length > 0) pCheck.hand.push(room.deck.shift());
                        }
                        io.to(pCheck.id).emit('status', "PENALTY: +2 for not saying UNO!");
                        updateRoom(currentRoomId);
                    }
                }, 5000); 
            }

            if (player.hand.length === 0 && !room.finishOrder.includes(player.id)) {
                room.finishOrder.push(player.id);
                if (room.finishOrder.length >= room.players.length - 1) {
                    const lastPlayer = room.players.find(p => !room.finishOrder.includes(p.id));
                    if (lastPlayer) room.finishOrder.push(lastPlayer.id);
                    
                    room.finishOrder.forEach((id, index) => {
                        room.scores[id] += [3, 2, 1, 0][index]; 
                    });

                    io.to(currentRoomId).emit('tournamentResults', { order: room.finishOrder, totalScores: room.scores });
                    room.gameStarted = false; 
                    return; 
                }
            }

            if (card.type === 'Reverse') {
                if (room.players.filter(p => !room.finishOrder.includes(p.id)).length === 2) {
                    nextTurn(currentRoomId, 2);
                } else {
                    room.direction *= -1;
                    nextTurn(currentRoomId, 1);
                }
            } else {
                nextTurn(currentRoomId, card.type === 'Skip' ? 2 : 1);
            }
            updateRoom(currentRoomId);
        }
    });

    socket.on('draw', () => {
        const room = rooms[currentRoomId];
        if (!room) return;
        const pIdx = room.players.findIndex(p => p.id === socket.id);
        if (pIdx !== room.currentPlayerIndex) return;

        checkDeck(currentRoomId);
        let player = room.players[pIdx];

        if (room.stackCount > 0) {
            for (let i = 0; i < room.stackCount; i++) {
                if (room.deck.length > 0) player.hand.push(room.deck.shift());
            }
            room.stackCount = 0;
            nextTurn(currentRoomId);
        } else {
            if (player.lastDrawnCard) return;
            const drawn = room.deck.shift();
            if (drawn) {
                player.hand.push(drawn);
                player.lastDrawnCard = drawn; 
            }
        }
        updateRoom(currentRoomId);
    });

    socket.on('pass', () => {
        const room = rooms[currentRoomId];
        if (room && room.players[room.currentPlayerIndex].id === socket.id) {
            room.players[room.currentPlayerIndex].lastDrawnCard = null;
            nextTurn(currentRoomId);
            updateRoom(currentRoomId);
        }
    });

    socket.on('requestRestart', () => {
        const room = rooms[currentRoomId];
        if (room) {
            room.restartVotes.add(socket.id);
            if (room.restartVotes.size === room.players.length) resetGame(currentRoomId);
        }
    });

    socket.on('disconnect', () => {
        if (currentRoomId && rooms[currentRoomId]) {
            const room = rooms[currentRoomId];
            room.players = room.players.filter(p => p.id !== socket.id);
            if (room.players.length === 0) {
                delete rooms[currentRoomId]; // Cleanup empty rooms
            } else {
                room.gameStarted = false;
                io.to(currentRoomId).emit('status', "Player left. Game reset.");
            }
        }
    });
});

server.listen(process.env.PORT || 3000);
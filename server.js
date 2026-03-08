const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let deck = [];
let players = [];
let discardPile = [];
let currentPlayerIndex = 0;
let direction = 1; 
let gameStarted = false;
let stackCount = 0;
let scores = {}; 
let finishOrder = [];
let restartVotes = new Set();

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

function nextTurn(skip = 1) {
    let attempts = 0;
    do {
        currentPlayerIndex = (currentPlayerIndex + (direction * skip) + players.length) % players.length;
        skip = 1; 
        attempts++;
    } while (finishOrder.includes(players[currentPlayerIndex].id) && attempts < players.length);
}

function resetGame() {
    finishOrder = [];
    restartVotes.clear();
    gameStarted = true;
    stackCount = 0;
    currentPlayerIndex = 0;
    direction = 1;
    deck = shuffle(createDeck());
    players.forEach(p => {
        p.hand = deck.splice(0, 10);
        p.lastDrawnCard = null;
    });
    let startIdx = deck.findIndex(c => c.color !== 'black' && !isNaN(c.type));
    discardPile = [deck.splice(startIdx, 1)[0]];
    updateAll();
}

function updateAll() {
    const counts = players.map(p => ({ id: p.id, count: p.hand.length }));
    players.forEach(p => {
        io.to(p.id).emit('init', { 
            hand: p.hand, 
            topCard: discardPile[discardPile.length - 1], 
            turnId: players[currentPlayerIndex].id,
            cardCounts: counts,
            scores: scores
        });
    });
}

io.on('connection', (socket) => {
    if (players.length < 4) {
        players.push({ id: socket.id, hand: [], lastDrawnCard: null });
        scores[socket.id] = scores[socket.id] || 0;
        io.emit('status', `Waiting for players (${players.length}/4)...`);
    }
    if (players.length === 4 && !gameStarted) resetGame();

    socket.on('playCard', (data) => {
        const pIdx = players.findIndex(p => p.id === socket.id);
        if (pIdx !== currentPlayerIndex) return;
        let player = players[pIdx];
        let card = player.hand[data.index];
        let top = discardPile[discardPile.length - 1];

        if (player.lastDrawnCard && card !== player.lastDrawnCard) return;

        if (card.color === top.color || card.type === top.type || card.color === 'black') {
            if (stackCount > 0 && top.type === '+4' && card.type === '+2') return;

            if (card.color === 'black') card.color = data.chosenColor;
            if (card.type === '+2') stackCount += 2;
            if (card.type === '+4') stackCount += 4;

            player.hand.splice(data.index, 1);
            discardPile.push(card);
            player.lastDrawnCard = null;

            if (player.hand.length === 0) {
                finishOrder.push(socket.id);
                scores[socket.id] += [3, 2, 1, 0][finishOrder.length - 1];
                if (finishOrder.length === 3) {
                    gameStarted = false;
                    const last = players.find(p => !finishOrder.includes(p.id));
                    finishOrder.push(last.id);
                    return io.emit('tournamentResults', { order: finishOrder, allScores: scores });
                }
            }
            if (card.type === 'Reverse') direction *= -1;
            nextTurn(card.type === 'Skip' ? 2 : 1);
            updateAll();
        }
    });

    socket.on('draw', () => {
        const pIdx = players.findIndex(p => p.id === socket.id);
        if (pIdx !== currentPlayerIndex) return;
        if (stackCount > 0) {
            for (let i = 0; i < stackCount; i++) players[pIdx].hand.push(deck.shift());
            stackCount = 0;
            nextTurn();
        } else {
            const drawn = deck.shift();
            players[pIdx].hand.push(drawn);
            players[pIdx].lastDrawnCard = drawn;
            socket.emit('canPass');
        }
        updateAll();
    });

    socket.on('pass', () => {
        const pIdx = players.findIndex(p => p.id === socket.id);
        if (pIdx === currentPlayerIndex) {
            players[pIdx].lastDrawnCard = null;
            nextTurn();
            updateAll();
        }
    });

    socket.on('requestRestart', () => {
        restartVotes.add(socket.id);
        if (restartVotes.size === 4) resetGame();
    });

    socket.on('disconnect', () => {
        players = players.filter(p => p.id !== socket.id);
        gameStarted = false;
        io.emit('status', `Player left. (${players.length}/4)`);
    });
});

server.listen(process.env.PORT || 3000);
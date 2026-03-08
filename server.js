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

// Tournament & State Tracking
let scores = {}; 
let finishOrder = [];
let restartVotes = new Set();
let unoTimers = {}; // Tracks the 5-second UNO window

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

// Rule #8: Intelligent Reshuffle
function checkDeck() {
    if (deck.length <= 5) {
        const topCard = discardPile.pop();
        deck = shuffle([...discardPile]);
        discardPile = [topCard];
        io.emit('status', "Deck reshuffled!");
    }
}

// Rule #12: Skip finished players
function nextTurn(skip = 1) {
    let attempts = 0;
    do {
        currentPlayerIndex = (currentPlayerIndex + (direction * skip) + players.length) % players.length;
        skip = 1; 
        attempts++;
    } while (finishOrder.includes(players[currentPlayerIndex].id) && attempts < players.length);
}

// Rule #1, #2: Start with 10 cards and a number card
function resetGame() {
    finishOrder = [];
    restartVotes.clear();
    gameStarted = true;
    stackCount = 0;
    currentPlayerIndex = 0;
    direction = 1;
    deck = shuffle(createDeck());
    
    players.forEach(p => {
        p.hand = deck.splice(0, 10); // Rule #1
        p.lastDrawnCard = null;
        p.saidUno = false;
    });
    
    // Rule #2: Find a starting number card
    let startIdx = deck.findIndex(c => c.color !== 'black' && !isNaN(c.type));
    discardPile = [deck.splice(startIdx, 1)[0]];

    updateAll();
}

function updateAll() {
    const playerCardCounts = players.map(p => ({ id: p.id, count: p.hand.length })); // Rule #10
    players.forEach(p => {
        io.to(p.id).emit('init', { 
            hand: p.hand, 
            topCard: discardPile[discardPile.length - 1], 
            turnId: players[currentPlayerIndex].id,
            cardCounts: playerCardCounts,
            scores: scores
        });
    });
}

io.on('connection', (socket) => {
    if (players.length < 4) {
        players.push({ id: socket.id, hand: [], lastDrawnCard: null, saidUno: false });
        scores[socket.id] = scores[socket.id] || 0;
        io.emit('status', `Players: ${players.length}/4`);
    }

    if (players.length === 4 && !gameStarted) resetGame();

    socket.on('playCard', (data) => {
        const pIdx = players.findIndex(p => p.id === socket.id);
        if (pIdx !== currentPlayerIndex || finishOrder.includes(socket.id)) return;

        let player = players[pIdx];
        let card = player.hand[data.index];
        let top = discardPile[discardPile.length - 1];

        // Rule #7: Draw-to-play restriction
        if (player.lastDrawnCard && card !== player.lastDrawnCard) return;

        // Rule #4: Stacking logic (+2 can't go on +4)
        if (stackCount > 0 && top.type === '+4' && card.type === '+2') {
            return socket.emit('status', "Cannot play +2 on a +4 stack!");
        }

        const isMatch = card.color === top.color || card.type === top.type || card.color === 'black';

        if (isMatch) {
            if (card.color === 'black') card.color = data.chosenColor; // Rule #5
            if (card.type === '+2') stackCount += 2;
            if (card.type === '+4') stackCount += 4;

            player.hand.splice(data.index, 1);
            discardPile.push(card);
            player.lastDrawnCard = null;

            // Rule #9: UNO Penalty Logic
            if (player.hand.length === 1 && !player.saidUno) {
                unoTimers[socket.id] = setTimeout(() => {
                    if (!player.saidUno) {
                        player.hand.push(deck.shift(), deck.shift());
                        socket.emit('status', "UNO Penalty! +2 cards");
                        updateAll();
                    }
                }, 5000);
            }

            // Rule #11: Continue until 3 players finish
            if (player.hand.length === 0) {
                finishOrder.push(socket.id);
                scores[socket.id] += [3, 2, 1, 0][finishOrder.length - 1]; // Rule #13
                if (finishOrder.length === 3) {
                    const last = players.find(p => !finishOrder.includes(p.id));
                    finishOrder.push(last.id);
                    gameStarted = false;
                    return io.emit('tournamentResults', { order: finishOrder, allScores: scores });
                }
            }

            if (card.type === 'Reverse') direction *= -1;
            nextTurn(card.type === 'Skip' ? 2 : 1);
            checkDeck(); // Rule #8
            updateAll();
        }
    });

    socket.on('sayUno', () => {
        const pIdx = players.findIndex(p => p.id === socket.id);
        if (pIdx !== -1) {
            players[pIdx].saidUno = true;
            io.emit('status', `Player ${socket.id.substring(0,4)} said UNO!`);
        }
    });

    // Rule #6: Choose to draw or stack
    socket.on('draw', () => {
        const pIdx = players.findIndex(p => p.id === socket.id);
        if (pIdx !== currentPlayerIndex) return;
        let player = players[pIdx];

        if (stackCount > 0) {
            for (let i = 0; i < stackCount; i++) player.hand.push(deck.shift());
            stackCount = 0;
            player.lastDrawnCard = null;
            nextTurn();
        } else {
            const drawn = deck.shift();
            player.hand.push(drawn);
            player.lastDrawnCard = drawn; // Rule #7
            socket.emit('canPass');
        }
        checkDeck();
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
        io.emit('status', `Restart Votes: ${restartVotes.size}/4`);
        if (restartVotes.size === 4) resetGame();
    });

    socket.on('exitGame', () => {
        io.emit('terminated', "A player has exited.");
        players = []; scores = {}; gameStarted = false;
    });
});
socket.on('disconnect', () => {
        // Find if the person who left was in the game
        const playerIndex = players.findIndex(p => p.id === socket.id);
        
        if (playerIndex !== -1) {
            console.log(`Player ${socket.id} left. Clearing slot.`);
            players.splice(playerIndex, 1); // Remove them from the array
            
            // If someone leaves mid-game, we must reset the tournament
            gameStarted = false;
            scores = {}; 
            restartVotes.clear();
            finishOrder = [];
            
            io.emit('status', `A player left. Waiting for players (${players.length}/4)...`);
            io.emit('terminated', "Game interrupted because a player disconnected.");
        }
    });
server.listen(process.env.PORT || 3000);
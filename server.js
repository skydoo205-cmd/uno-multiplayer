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
    currentPlayerIndex = (currentPlayerIndex + (direction * skip) + players.length) % players.length;
}

io.on('connection', (socket) => {
    console.log("A player connected:", socket.id);

    if (players.length < 4) {
        players.push({ id: socket.id, hand: [] });
        io.emit('status', `Players: ${players.length}/4`);
    }

    if (players.length === 4 && !gameStarted) {
        gameStarted = true;
        deck = shuffle(createDeck());
        players.forEach(p => p.hand = deck.splice(0, 10));
        
        let startIdx = deck.findIndex(c => c.color !== 'black' && !isNaN(c.type));
        discardPile.push(deck.splice(startIdx, 1)[0]);

        players.forEach(p => {
            io.to(p.id).emit('init', { 
                hand: p.hand, 
                topCard: discardPile[0], 
                turnId: players[0].id 
            });
        });
    }

   socket.on('playCard', (data) => {
        const pIdx = players.findIndex(p => p.id === socket.id);
        if (pIdx !== currentPlayerIndex) return;

        let player = players[pIdx];
        let card = player.hand[data.index];
        let top = discardPile[discardPile.length - 1];

        // NEW RULE: If they just drew a card, they can ONLY play that specific card
        if (player.lastDrawnCard && card !== player.lastDrawnCard) {
            return socket.emit('status', "You must play the card you just drew or pass!");
        }

// Valid Move Logic
        if (card.color === top.color || card.type === top.type || card.color === 'black') {
            
            // --- NEW STACKING RESTRICTION ---
            // If a +4 is currently being stacked, you can ONLY play another +4
            if (stackCount > 0 && top.type === '+4' && card.type !== '+4') {
                return socket.emit('status', "You can only play a +4 on top of a +4!");
            }
            // --------------------------------

            if (card.color === 'black') card.color = data.chosenColor;
            
            // Stacking Logic
            if (card.type === '+2') stackCount += 2;
            if (card.type === '+4') stackCount += 4;

            player.hand.splice(data.index, 1);
            discardPile.push(card);

            // Special Cards
            if (card.type === 'Reverse') direction *= -1;
            let skip = (card.type === 'Skip') ? 2 : 1;
            
            nextTurn(skip);
            io.emit('update', { 
                topCard: card, 
                turnId: players[currentPlayerIndex].id,
                stack: stackCount
            });
            socket.emit('hand', player.hand);
        }
    });

   socket.on('draw', () => {
        const pIdx = players.findIndex(p => p.id === socket.id);
        if (pIdx !== currentPlayerIndex) return;
        let player = players[pIdx];

        if (stackCount > 0) {
            // Penalty Draw (Stacking)
            for (let i = 0; i < stackCount; i++) {
                if (deck.length === 0) {
                    const top = discardPile.pop();
                    deck = shuffle([...discardPile]);
                    discardPile = [top];
                }
                player.hand.push(deck.shift());
            }
            stackCount = 0;
            player.lastDrawnCard = null; // Reset restriction after penalty
            nextTurn();
            // ... (rest of your existing update emit)
        } else {
            // Normal Draw
            const drawnCard = deck.shift();
            player.hand.push(drawnCard);
            
            // NEW RULE: Remember the card they just drew
            player.lastDrawnCard = drawnCard; 
            
            socket.emit('canPass');
        }
        socket.emit('hand', player.hand);
    });

   socket.on('pass', () => {
        const pIdx = players.findIndex(p => p.id === socket.id);
        if (pIdx !== currentPlayerIndex) return;
        
        // NEW RULE: Reset the drawn card restriction when passing
        players[pIdx].lastDrawnCard = null; 
        
        nextTurn();
        io.emit('update', { 
            topCard: discardPile[discardPile.length-1], 
            turnId: players[currentPlayerIndex].id,
            stack: 0
        });
    });

    socket.on('disconnect', () => {
        players = players.filter(p => p.id !== socket.id);
        if (players.length === 0) {
            gameStarted = false;
            stackCount = 0;
            currentPlayerIndex = 0;
            direction = 1;
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`UNO Server is live on port ${PORT}`);
});
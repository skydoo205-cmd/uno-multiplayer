const socket = io();
let myTurn = false;
let hasDrawn = false;
let pendingIndex = null;

// Handle Game Start and Updates
socket.on('init', data => {
    document.getElementById('scoreboard-overlay').style.display = 'none';
    renderHand(data.hand);
    renderTop(data.topCard);
    setTurn(data.turnId);
    updateStats(data.cardCounts);
});

socket.on('status', msg => {
    const statusDiv = document.getElementById('status');
    statusDiv.innerText = msg;
    
    // Feedback: Turn status red if a penalty occurs
    if (msg.includes("PENALTY") || msg.includes("TOO SLOW") || msg.includes("reshuffled")) {
        statusDiv.style.color = "#e74c3c";
        setTimeout(() => { statusDiv.style.color = "white"; }, 3000);
    }
});

// Sidebar Stats
function updateStats(counts, deckCount) { // Add deckCount parameter
    const list = document.getElementById('stats-list');
    
    // Create the player rows
    let html = counts.map(p => `
        <div class="stat-row">
            Player ${p.id.substring(0,4)}<br>
            <strong>${p.count} Cards</strong>
        </div>
    `).join('');

    // ADD THIS: A special row for the Deck status
    html += `
        <div class="deck-info">
            Draw Pile: ${deckCount}
        </div>
    `;
    
    list.innerHTML = html;
}

// Also update the 'init' listener to pass the new value
socket.on('init', data => {
    document.getElementById('scoreboard-overlay').style.display = 'none';
    renderHand(data.hand);
    renderTop(data.topCard);
    setTurn(data.turnId);
    updateStats(data.cardCounts, data.deckCount); // Pass deckCount here
});

// Card Management
function renderHand(hand) {
    const cont = document.getElementById('my-hand');
    cont.innerHTML = '';
    hand.forEach((c, i) => {
        const div = document.createElement('div');
        div.className = `card ${c.color}`;
        div.innerHTML = `<span>${c.type}</span>`;
        div.onclick = () => {
            if (!myTurn) return;
            if (c.color === 'black') {
                pendingIndex = i;
                document.getElementById('color-picker').style.display = 'flex';
            } else {
                socket.emit('playCard', { index: i });
            }
        };
        cont.appendChild(div);
    });
}

window.chooseColor = (color) => {
    document.getElementById('color-picker').style.display = 'none';
    socket.emit('playCard', { index: pendingIndex, chosenColor: color });
};

// --- TURN ACTIONS ---

window.passTurn = () => {
    if (!myTurn) return;
    socket.emit('pass'); 
};

window.sayUno = () => {
    socket.emit('sayUno'); 
    const btn = document.getElementById('uno-btn');
    btn.style.background = "#27ae60"; 
    setTimeout(() => { btn.style.background = "#c0392b"; }, 1000);
};

// Handle clicks on the deck
document.getElementById('draw-pile').onclick = () => { 
    // FIXED: Removed local hasDrawn block to allow reshuffle retries
    if(myTurn) {
        socket.emit('draw'); 
    }
};

// Fixed turn-setting logic
function setTurn(id) {
    const wasMyTurn = myTurn;
    myTurn = (socket.id === id);
    const status = document.getElementById('status');
    status.innerText = myTurn ? "YOUR TURN!" : "Waiting...";
    
    if (myTurn) {
        // Reset local draw flag whenever it becomes your turn
        hasDrawn = false; 
        document.getElementById('pass-btn').style.display = 'inline-block';
    } else {
        document.getElementById('pass-btn').style.display = 'none';
    }
}

// UI Helpers
function renderTop(c) {
    const el = document.getElementById('top-card');
    el.className = `card ${c.color}`;
    el.innerHTML = `<span>${c.type}</span>`;
}

// Updated for Cumulative Scoring
socket.on('tournamentResults', data => {
    const list = document.getElementById('score-list');
    
    // data.order is the rank of the current round
    // data.totalScores is the running total from the server
    list.innerHTML = data.order.map((id, i) => {
        const roundPoints = [3, 2, 1, 0][i];
        const total = data.totalScores[id] || 0;
        
        return `
            <div class="score-row" style="display: flex; justify-content: space-between; border-bottom: 1px solid #444; padding: 5px 0;">
                <span>${i+1}. Player ${id.substring(0,4)}</span>
                <span style="color: #27ae60;">+${roundPoints} (Total: ${total})</span>
            </div>
        `;
    }).join('');
    
    document.getElementById('scoreboard-overlay').style.display = 'flex';
});

window.requestRestart = () => socket.emit('requestRestart');
window.exitGame = () => { if(confirm("Exit?")) socket.emit('exitGame'); };
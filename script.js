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
    document.getElementById('status').innerText = msg;
});

// Update Sidebar (Rule #10)
function updateStats(counts) {
    const list = document.getElementById('stats-list');
    list.innerHTML = counts.map(p => `
        <div class="stat-row">
            Player ${p.id.substring(0,4)}<br>
            <strong>${p.count} Cards</strong>
        </div>
    `).join('');
}

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

// --- REPLACE YOUR TURN ACTIONS WITH THIS ---

// Function for the Pass Button (Rule #7)
window.passTurn = () => {
    if (!myTurn) return;
    socket.emit('pass');
    document.getElementById('pass-btn').style.display = 'none'; // Hide after click
};

// Function for the Uno Button (Rule #9)
window.sayUno = () => {
    socket.emit('sayUno');
    const btn = document.getElementById('uno-btn');
    btn.style.background = "#27ae60"; // Flash green for feedback
    setTimeout(() => { btn.style.background = "#c0392b"; }, 1000);
};

// Handle clicks on the deck
document.getElementById('draw-pile').onclick = () => { 
    if(myTurn && !hasDrawn) socket.emit('draw'); 
};

// Server signal to show the Pass button
socket.on('canPass', () => {
    hasDrawn = true;
    document.getElementById('pass-btn').style.display = 'block';
});

// UI Helpers
function renderTop(c) {
    const el = document.getElementById('top-card');
    el.className = `card ${c.color}`;
    el.innerHTML = `<span>${c.type}</span>`;
}

function setTurn(id) {
    myTurn = (socket.id === id);
    const status = document.getElementById('status');
    status.innerText = myTurn ? "YOUR TURN!" : "Waiting...";
    
    if (myTurn) {
        hasDrawn = false;
        // Hide only the pass button at start of turn, keep UNO visible
        document.getElementById('pass-btn').style.display = 'none';
    }
}

// Tournament Results (Rule #13)
socket.on('tournamentResults', data => {
    const list = document.getElementById('score-list');
    list.innerHTML = data.order.map((id, i) => `
        <div class="score-row">
            <span>${i+1}. Player ${id.substring(0,4)}</span>
            <span>+${[3,2,1,0][i]} Points</span>
        </div>
    `).join('');
    document.getElementById('scoreboard-overlay').style.display = 'flex';
});

window.requestRestart = () => socket.emit('requestRestart');
window.exitGame = () => { if(confirm("Exit?")) socket.emit('exitGame'); };
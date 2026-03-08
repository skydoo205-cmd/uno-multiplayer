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

// --- TURN ACTIONS ---

// Function for the Pass Button (Rule #7)
window.passTurn = () => {
    if (!myTurn) return;
    socket.emit('pass');
    // Hide the button after use
    document.getElementById('pass-btn').style.display = 'none';
    document.getElementById('pass-btn').removeAttribute('style'); // Clear force-style
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

// Listen for Pass Signal from Server
socket.on('canPass', () => {
    hasDrawn = true;
    const passBtn = document.getElementById('pass-btn');
    if (passBtn) {
        // FORCE visibility to center screen to ensure it's not hidden
        passBtn.setAttribute('style', 'display: block !important; position: fixed; top: 100px; left: 50%; transform: translateX(-50%); z-index: 10002;');
        console.log("PASS BUTTON FORCED TO SCREEN CENTER");
    } else {
        alert("ERROR: HTML element 'pass-btn' not found!");
    }
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
        // Reset pass button visibility at start of turn
        const passBtn = document.getElementById('pass-btn');
        passBtn.style.display = 'none';
        passBtn.removeAttribute('style'); 
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
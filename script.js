const socket = io();
let myTurn = false;
let hasDrawn = false;
let pendingIndex = null;

// --- Updates & Initialization ---
socket.on('init', data => {
    document.getElementById('scoreboard-overlay').style.display = 'none';
    renderHand(data.hand);
    renderTop(data.topCard);
    setTurn(data.turnId);
    updateStats(data.cardCounts);
});

socket.on('status', msg => {
    document.getElementById('status').innerText = msg;
    if (msg.includes("Restart Votes")) document.getElementById('vote-count').innerText = msg;
});

// Rule #10: Real-time Card Counts
function updateStats(counts) {
    const list = document.getElementById('stats-list');
    list.innerHTML = counts.map(p => `
        <div class="stat-row">
            Player ${p.id.substring(0,4)}: <strong>${p.count} cards</strong>
        </div>
    `).join('');
}

// --- Player Actions ---
function renderHand(hand) {
    const cont = document.getElementById('my-hand');
    cont.innerHTML = '';
    hand.forEach((c, i) => {
        const div = document.createElement('div');
        div.className = `card ${c.color}`;
        div.innerHTML = `<span>${c.type}</span>`;
        div.onclick = () => play(i, c.color);
        cont.appendChild(div);
    });
}

function play(i, color) {
    if (!myTurn) return;
    if (color === 'black') {
        pendingIndex = i;
        document.getElementById('color-picker').style.display = 'block';
    } else {
        socket.emit('playCard', { index: i });
    }
}

window.chooseColor = (c) => {
    document.getElementById('color-picker').style.display = 'none';
    socket.emit('playCard', { index: pendingIndex, chosenColor: c });
};

// Rule #6: Choose to Draw or Stack
document.getElementById('draw-pile').onclick = () => {
    if (myTurn && !hasDrawn) socket.emit('draw');
};

// Rule #9: Say UNO
window.sayUno = () => {
    socket.emit('sayUno');
    document.getElementById('status').innerText = "YOU SAID UNO!";
};

function passTurn() { socket.emit('pass'); }
socket.on('canPass', () => {
    hasDrawn = true;
    document.getElementById('pass-btn').style.display = 'block';
});

// --- Tournament Logic ---
socket.on('tournamentResults', data => {
    const scoreList = document.getElementById('score-list');
    scoreList.innerHTML = data.order.map((id, index) => {
        const pts = [3, 2, 1, 0][index];
        return `<div class="score-row"><span>${index+1}. Player ${id.substring(0,4)}</span><span>+${pts} pts (Total: ${data.allScores[id]})</span></div>`;
    }).join('');
    document.getElementById('scoreboard-overlay').style.display = 'flex';
});

window.requestRestart = () => socket.emit('requestRestart');
window.exitGame = () => { if(confirm("End tournament?")) socket.emit('exitGame'); };

function renderTop(c) {
    const el = document.getElementById('top-card');
    el.className = `card ${c.color}`;
    el.innerHTML = `<span>${c.type}</span>`;
}

function setTurn(id) {
    myTurn = (socket.id === id);
    const status = document.getElementById('status');
    status.innerText = myTurn ? "YOUR TURN!" : "Waiting...";
    status.style.color = myTurn ? "#2ecc71" : "white";
    if (myTurn) hasDrawn = false;
}
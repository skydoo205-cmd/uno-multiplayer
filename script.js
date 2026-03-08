const socket = io();
let myTurn = false;
let hasDrawn = false;
let pendingIndex = null;

// --- 1. GAME SETUP & UPDATES ---
socket.on('init', data => {
    // Hide scoreboard when a new round starts
    document.getElementById('scoreboard-overlay').style.display = 'none';
    renderHand(data.hand);
    renderTop(data.topCard);
    setTurn(data.turnId);
});

socket.on('update', data => {
    renderTop(data.topCard);
    setTurn(data.turnId);
    hasDrawn = false;
    document.getElementById('pass-btn').style.display = 'none';
});

socket.on('hand', hand => renderHand(hand));

socket.on('canPass', () => {
    hasDrawn = true;
    document.getElementById('pass-btn').style.display = 'block';
});

socket.on('status', msg => {
    // If the server sends a "Restart Votes" update, show it on the overlay
    const voteText = document.getElementById('vote-count');
    if (voteText && msg.includes("Restart Votes")) {
        voteText.innerText = msg;
    }
});

// --- 2. TOURNAMENT & WIN LOGIC ---
socket.on('tournamentResults', data => {
    const scoreList = document.getElementById('score-list');
    const overlay = document.getElementById('scoreboard-overlay');
    
    // Create the leaderboard rows
    scoreList.innerHTML = data.order.map((id, index) => {
        const points = [3, 2, 1, 0][index];
        const isMe = id === socket.id ? " (YOU)" : "";
        return `
            <div class="score-row">
                <span>${index + 1}. Player ${id.substring(0,5)}${isMe}</span>
                <span>+${points} pts (Total: ${data.allScores[id]})</span>
            </div>
        `;
    }).join('');

    overlay.style.display = 'flex';
});

socket.on('terminated', msg => {
    alert(msg);
    window.location.reload();
});

// --- 3. PLAYER ACTIONS ---
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

document.getElementById('draw-pile').onclick = () => {
    if (myTurn && !hasDrawn) socket.emit('draw');
};

document.getElementById('pass-btn').onclick = () => {
    socket.emit('pass');
};

// --- 4. TOURNAMENT ACTIONS ---
window.requestRestart = () => {
    socket.emit('requestRestart');
};

window.exitGame = () => {
    if (confirm("End the tournament for everyone?")) {
        socket.emit('exitGame');
    }
};

// --- 5. UI HELPERS ---
function renderTop(c) {
    const el = document.getElementById('top-card');
    el.className = `card ${c.color}`;
    el.innerHTML = `<span>${c.type}</span>`;
}

function setTurn(id) {
    myTurn = (socket.id === id);
    const status = document.getElementById('status');
    status.innerText = myTurn ? "YOUR TURN!" : `Waiting for Player ${id.substring(0,5)}...`;
    status.style.color = myTurn ? "#2ecc71" : "white";
}
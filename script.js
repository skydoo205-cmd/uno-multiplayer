const socket = io();

// --- SESSION MANAGEMENT ---
// Generate or retrieve a persistent ID so the server remembers you
let sessionId = localStorage.getItem('uno_session_id');
if (!sessionId) {
    sessionId = Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
    localStorage.setItem('uno_session_id', sessionId);
}

let myTurn = false;
let hasDrawn = false;
let pendingIndex = null;
let currentRoom = null;

// --- LOBBY LOGIC ---

window.createRoom = () => {
    // Generate a random 4-digit code and request room creation
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    joinRoom(code);
};

window.joinRoom = (manualCode) => {
    const code = manualCode || document.getElementById('room-input').value;
    if (code.length !== 4) return alert("Please enter a 4-digit code.");
    
    currentRoom = code;
    // Send both Room ID and Session ID to the server
    socket.emit('joinRoom', { roomId: code, sessionId: sessionId });
};

// Listen for successful room entry or reconnection
socket.on('roomJoined', (roomId) => {
    document.getElementById('lobby-overlay').style.display = 'none';
    document.getElementById('game-container').style.display = 'flex';
    document.getElementById('room-display').innerText = `ROOM: ${roomId}`;
});

socket.on('roomFull', () => {
    alert("This room is full or already in progress!");
    currentRoom = null;
});

// If the server terminates the room due to inactivity or disconnection
socket.on('forceExit', (reason) => {
    if (reason) alert(reason);
    window.location.reload();
});

// --- GAME LOGIC ---

socket.on('init', data => {
    // Hide scoreboard when a new round starts
    document.getElementById('scoreboard-overlay').style.display = 'none';
    document.body.classList.remove('results-open');
    
    renderHand(data.hand);
    renderTop(data.topCard);
    setTurn(data.turnId);
    updateStats(data.cardCounts, data.deckCount);
});

socket.on('status', msg => {
    const statusDiv = document.getElementById('status');
    statusDiv.innerText = msg;
    
    if (msg.includes("PENALTY") || msg.includes("TOO SLOW") || msg.includes("reshuffled")) {
        statusDiv.style.color = "#e74c3c";
        setTimeout(() => { statusDiv.style.color = "white"; }, 3000);
    }
});

function updateStats(counts, deckCount) {
    const list = document.getElementById('stats-list');
    let html = counts.map(p => `
        <div class="stat-row ${!p.online ? 'offline' : ''}">
            Player ${p.id.substring(0,4)} ${!p.online ? '(OFFLINE)' : ''}<br>
            <strong>${p.count} Cards</strong>
        </div>
    `).join('');

    const deckInfo = document.getElementById('deck-info');
    if (deckInfo) deckInfo.innerText = `Draw Pile: ${deckCount}`;
    list.innerHTML = html;
}

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

window.passTurn = () => { if (myTurn) socket.emit('pass'); };

window.sayUno = () => {
    socket.emit('sayUno'); 
    const btn = document.getElementById('uno-btn');
    btn.style.background = "#27ae60"; 
    setTimeout(() => { btn.style.background = "#c0392b"; }, 1000);
};

document.getElementById('draw-pile').onclick = () => { 
    if(myTurn) socket.emit('draw'); 
};

function setTurn(id) {
    // Compare turn ID to Session ID instead of Socket ID
    myTurn = (sessionId === id);
    const status = document.getElementById('status');
    status.innerText = myTurn ? "YOUR TURN!" : "Waiting...";
    
    if (myTurn) {
        hasDrawn = false; 
        document.getElementById('pass-btn').style.display = 'inline-block';
    } else {
        document.getElementById('pass-btn').style.display = 'none';
    }
}

function renderTop(c) {
    const el = document.getElementById('top-card');
    el.className = `card ${c.color}`;
    el.innerHTML = `<span>${c.type}</span>`;
}

socket.on('tournamentResults', data => {
    // Prevent the UNO button from clipping through the scoreboard
    document.body.classList.add('results-open');
    const list = document.getElementById('score-list');
    
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
window.exitGame = () => { 
    if(confirm("Exit this lobby? Progress will be lost.")) {
        localStorage.removeItem('uno_session_id'); // Clear session to join fresh later
        window.location.reload(); 
    }
};
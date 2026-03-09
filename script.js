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

// 3. FIX: Standardize the 'init' listener
socket.on('init', data => {
    // Close scoreboard if a new round starts
    document.getElementById('scoreboard-overlay').style.display = 'none';
    document.body.classList.remove('results-open');
    
    renderHand(data.hand);
    renderTop(data.topCard);
    setTurn(data.turnId); // Now passes the Session ID
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

// 2. FIX: Ensure updateStats handles the 'online' flag
function updateStats(counts, deckCount) {
    const list = document.getElementById('stats-list');
    
    let html = counts.map(p => {
        // Visual indicator if a player is currently disconnected
        const statusText = p.online ? '' : ' <span style="color:#e74c3c;">(OFFLINE)</span>';
        const isMe = p.id === sessionId ? ' <span style="color:gold;">(YOU)</span>' : '';
        
        return `
            <div class="stat-row" style="${!p.online ? 'opacity: 0.5; border-left: 4px solid #e74c3c;' : ''}">
                Player ${p.id.substring(0,4)}${isMe}${statusText}<br>
                <strong>${p.count} Cards</strong>
            </div>
        `;
    }).join('');

    // Update the Draw Pile counter
    const deckInfo = document.getElementById('deck-info');
    if (deckInfo) {
        deckInfo.innerText = `Draw Pile: ${deckCount}`;
    } else {
        // Fallback if the specific div isn't there
        html += `<div class="deck-info">Draw Pile: ${deckCount}</div>`;
    }
    
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

// 1. FIX: Use sessionId for Turn Logic
function setTurn(id) {
    // We compare the turn ID from the server to our persistent sessionId
    myTurn = (sessionId === id); 
    
    const status = document.getElementById('status');
    const passBtn = document.getElementById('pass-btn');

    if (myTurn) {
        status.innerText = "YOUR TURN!";
        status.style.color = "#2ecc71"; // Green for active turn
        hasDrawn = false; 
        if (passBtn) passBtn.style.display = 'inline-block';
    } else {
        // Show exactly which session ID the server is waiting for
        status.innerText = "Waiting for Player " + id.substring(0,4) + "...";
        status.style.color = "white";
        if (passBtn) passBtn.style.display = 'none';
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
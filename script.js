const socket = io();
let sessionId = localStorage.getItem('uno_v3_session') || Math.random().toString(36).substring(2);
localStorage.setItem('uno_v3_session', sessionId);

let myTurn = false, currentRoom = null, pendingIdx = null;

// --- LOBBY LOGIC ---
window.createRoom = () => {
    const limit = document.getElementById('player-limit').value;
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    socket.emit('joinRoom', { roomId: code, sessionId, playerLimit: parseInt(limit) });
};

window.joinRoom = () => {
    const code = document.getElementById('room-input').value;
    if(code.length === 4) socket.emit('joinRoom', { roomId: code, sessionId });
};

socket.on('roomJoined', (id) => {
    currentRoom = id;
    document.getElementById('lobby-overlay').style.display = 'none'; // Turn off lobby
    document.getElementById('scoreboard-overlay').style.display = 'none'; // Ensure scoreboard is off
    document.getElementById('game-container').style.display = 'grid';

    // FORCE UPDATE the Room Display immediately
    const roomEl = document.getElementById('room-display');
    if (roomEl) roomEl.innerText = `ROOM: ${id}`;
});

// --- CORE GAME UPDATES ---
socket.on('init', data => {
    document.getElementById('scoreboard-overlay').style.display = 'none';
    
    // Clear the "Lobby: X/X" text by updating the status div
    const status = document.getElementById('status');
    if (data.gameStarted || data.hand.length > 0) {
        // Hand is rendered, so game is active
        updateUI(data); 
    }

    renderHand(data.hand);
    renderTop(data.topCard);
});

function updateUI(data) {
    // 1. Core Logic Variables
    myTurn = (sessionId === data.turnId);
    const isTarget = (data.windowActive && data.unoTarget === sessionId);
    const canPenalize = (data.windowActive && data.unoTarget !== sessionId);

    // 2. Status & Reaper Timer
    const status = document.getElementById('status');
    status.innerText = myTurn ? (data.waitingForPass ? "PLAY DRAWN CARD OR PASS" : "YOUR TURN!") : "Waiting...";
    status.style.color = myTurn ? "#2ecc71" : "white";

    const reaperEl = document.getElementById('reaper-status');
    if (data.reaperTimeLeft && data.reaperTimeLeft > 0) {
        reaperEl.style.display = 'block';
        reaperEl.innerText = `⚠️ Connection Timeout: ${data.reaperTimeLeft}s`;
    } else {
        reaperEl.style.display = 'none';
    }

    // 3. Controls (Buttons)
    // IMPORTANT: These must be INSIDE the function to work!
    document.getElementById('uno-btn').style.display = isTarget ? 'block' : 'none';
    document.getElementById('penalty-btn').style.display = canPenalize ? 'block' : 'none';
    document.getElementById('pass-btn').style.display = (myTurn && data.waitingForPass) ? 'block' : 'none';

    // 4. Sidebar Stats (Player Names & Online Status)
    const statsList = document.getElementById('stats-list');
    if (statsList && data.cardCounts) {
        statsList.innerHTML = data.cardCounts.map(p => `
            <div class="stat-row ${!p.online ? 'offline' : ''}" style="padding: 10px; margin-bottom: 5px; background: rgba(255,255,255,0.05); border-radius: 5px;">
                <span style="color: ${p.online ? '#2ecc71' : '#e74c3c'}">●</span> 
                Player ${p.id.substring(0,4)} ${p.id === sessionId ? '<strong>(YOU)</strong>' : ''}<br>
                <small>${p.count} Cards</small>
            </div>
        `).join('');
    }

    // 5. Bottom Scoreboard (Live Standings)
    const liveScores = document.getElementById('live-scores-container');
    if (liveScores && data.cardCounts) {
        liveScores.innerHTML = data.cardCounts.map(p => `
            <div class="live-score-item">
                <span class="p-name">${p.id.substring(0,4)}</span>: 
                <span class="p-score">${data.scores[p.id] || 0}</span>
            </div>
        `).join('');
    }

    // 6. Deck & Stack Info
    const deckInfo = document.getElementById('deck-info');
    if (deckInfo) {
        deckInfo.innerText = `Deck: ${data.deckCount} | Stack: ${data.stack || 0}`;
    }
} // <--- THIS IS THE ONLY CLOSING BRACE NEEDED


// --- RENDERING ---
function renderHand(hand) {
    const cont = document.getElementById('my-hand');
    cont.innerHTML = '';
    // Hand comes pre-sorted from the server [Requirement 5]
    hand.forEach((c, i) => {
        const div = document.createElement('div');
        div.className = `card ${c.color}`;
        div.innerHTML = `<span>${c.type}</span>`;
        div.onclick = () => {
            if(!myTurn) return;
            if(c.color === 'black') {
                pendingIdx = i;
                document.getElementById('color-picker').style.display = 'flex';
            } else socket.emit('playCard', { index: i });
        };
        cont.appendChild(div);
    });
}

function renderTop(card) {
    const el = document.getElementById('top-card');
    el.className = `card ${card.color}`;
    el.innerHTML = `<span>${card.type}</span>`;
}

// --- CHAT LOGIC ---
// Fix: Chat Send Button Logic
window.sendChatMessage = () => {
    const input = document.getElementById('chat-input');
    const msg = input.value.trim();
    if (msg && currentRoom) {
        socket.emit('chatMessage', { msg: msg }); // Send to server
        input.value = ''; // Clear input immediately
    }
};

// Listen for Enter key in chat
document.getElementById('chat-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendChatMessage();
});

socket.on('newChatMessage', data => {
    const box = document.getElementById('chat-messages');
    if (box) {
        const msgDiv = document.createElement('div');
        msgDiv.className = 'chat-line';
        msgDiv.innerHTML = `<span style="color: gold; font-weight: bold;">${data.user}:</span> <span style="color: white;">${data.msg}</span>`;
        box.appendChild(msgDiv);
        box.scrollTop = box.scrollHeight; // Auto-scroll to newest message
    }
});

// --- EMITTERS ---
// Fix: Color Picker Deadlock
window.chooseColor = (color) => {
    // 1. Hide the UI immediately
    document.getElementById('color-picker').style.display = 'none';
    
    // 2. Tell the server: "I picked this color for the card at this index"
    socket.emit('playCard', { 
        index: pendingIdx, 
        chosenColor: color 
    });
};

window.emitUno = () => socket.emit('unoAction', 'safe');
window.emitPenalty = () => socket.emit('unoAction', 'penalty');
window.emitPass = () => socket.emit('pass');
window.emitDraw = () => { if(myTurn) socket.emit('draw'); };

// --- TOURNAMENT RESULTS ---
socket.on('results', data => {
    // 1. Update the Post-Game Overlay (The Pop-up)
    document.getElementById('score-list').innerHTML = data.order.map((id, i) => `
        <div class="score-row" style="display:flex; justify-content:space-between; padding:10px; background:#333; margin:5px; border-left:3px solid gold;">
            <span>${i+1}. ${id.substring(0,4)} ${id === sessionId ? '<strong>(YOU)</strong>' : ''}</span>
            <span>Total: ${data.scores[id]}</span>
        </div>
    `).join('');
    
    // 2. Sync the Live Scoreboard (The red area at the bottom)
    // This ensures that even behind the pop-up, the standings are updated
    const liveContainer = document.getElementById('live-scores-container');
    if (liveContainer) {
        liveContainer.innerHTML = Object.keys(data.scores).map(id => `
            <div class="live-score-item">
                <span class="p-name">${id.substring(0,4)}</span>: 
                <span class="p-score">${data.scores[id]}</span>
            </div>
        `).join('');
    }

    // 3. Reset the Next Round Button
    const btn = document.getElementById('next-round-btn');
    if (btn) {
        btn.disabled = false; 
        btn.innerText = "Next Round"; 
        btn.style.opacity = "1";
    }

    // 4. Clear old statuses and SHOW the overlay
    document.getElementById('restart-status').innerText = "";
    document.getElementById('scoreboard-overlay').style.display = 'flex';
});

window.requestRestart = () => {
    const btn = document.getElementById('next-round-btn');
    btn.disabled = true; btn.innerText = "Waiting..."; btn.style.opacity = "0.5";
    socket.emit('requestRestart');
};

window.exitToLobby = () => { if (confirm("Exit tournament?")) socket.emit('exitTournament'); };

// --- SYSTEM EVENTS ---
socket.on('restartProgress', data => { 
    document.getElementById('restart-status').innerText = `Ready: ${data.current}/${data.total}`; 
});

// Add or Update this listener in script.js
socket.on('roomDestroyed', (reason) => { 
    // Show an alert so the player knows why they were kicked
    alert(reason || "Connection timed out. Returning to lobby."); 
    
    // This command reloads the entire page, bringing them back to the 'Create Room' screen
    window.location.reload(); 
});

socket.on('status', msg => { document.getElementById('status').innerText = msg; });
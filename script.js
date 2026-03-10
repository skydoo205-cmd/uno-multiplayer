const socket = io();
let sessionId = localStorage.getItem('uno_v3_session') || Math.random().toString(36).substring(2);
localStorage.setItem('uno_v3_session', sessionId);

let myTurn = false, currentRoom = null, pendingIdx = null;
let isSpectator = false;
let lastHandSize = 0;

// --- AUDIO UNLOCK ---
function initAudio() {
    const bgm = document.getElementById('bgm');
    bgm.volume = 0.2; 
    bgm.play().catch(() => console.log("Audio waiting for user click"));
}

// --- LOBBY LOGIC ---
window.createRoom = () => {
    initAudio();
    const limit = document.getElementById('player-limit').value;
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    socket.emit('joinRoom', { roomId: code, sessionId, playerLimit: parseInt(limit) });
};

window.joinRoom = () => {
    initAudio();
    const code = document.getElementById('room-input').value;
    if(code.length === 4) socket.emit('joinRoom', { roomId: code, sessionId });
};

socket.on('roomJoined', (id) => {
    currentRoom = id;
    document.getElementById('lobby-overlay').style.display = 'none';
    document.getElementById('scoreboard-overlay').style.display = 'none';
    document.getElementById('game-container').style.display = 'grid';
    const roomEl = document.getElementById('room-display');
    if (roomEl) roomEl.innerText = `ROOM: ${id}`;
});

// --- CORE GAME UPDATES ---
socket.on('init', data => {
    document.getElementById('scoreboard-overlay').style.display = 'none';
    
    // Check if I am a Spectator (Winner)
    isSpectator = data.finishOrder && data.finishOrder.includes(sessionId);
    document.getElementById('spectator-ui').style.display = isSpectator ? 'block' : 'none';

    // Play sound if hand size increased (Requirement: New Card Pulse)
    if (data.hand.length > lastHandSize) document.getElementById('sfx-draw').play();
    lastHandSize = data.hand.length;

    updateUI(data); 
    renderHand(data.hand, data.topCard);
    renderTop(data.topCard);
});

function updateUI(data) {
    myTurn = (sessionId === data.turnId) && !isSpectator;
    const isTarget = (data.windowActive && data.unoTarget === sessionId);
    const canPenalize = (data.windowActive && data.unoTarget !== sessionId);

    // 1. Status & Reaper
    const status = document.getElementById('status');
    if (isSpectator) {
        status.innerText = "SPECTATING...";
        status.style.color = "gold";
    } else {
        status.innerText = myTurn ? (data.waitingForPass ? "PLAY DRAWN CARD OR PASS" : "YOUR TURN!") : "Waiting...";
        status.style.color = myTurn ? "#2ecc71" : "white";
    }

    const reaperEl = document.getElementById('reaper-status');
    if (data.reaperTimeLeft && data.reaperTimeLeft > 0) {
        reaperEl.style.display = 'block';
        reaperEl.innerText = `⚠️ Connection Timeout: ${data.reaperTimeLeft}s`;
    } else {
        reaperEl.style.display = 'none';
    }

    // 2. Controls (Hidden for Spectators)
    document.getElementById('uno-btn').style.display = (isTarget && !isSpectator) ? 'block' : 'none';
    document.getElementById('penalty-btn').style.display = (canPenalize && !isSpectator) ? 'block' : 'none';
    document.getElementById('pass-btn').style.display = (myTurn && data.waitingForPass) ? 'block' : 'none';

    // 3. Sidebar Stats (Requirement: Active Turn Glow & Winner Crown)
    const statsList = document.getElementById('stats-list');
    if (statsList && data.cardCounts) {
        statsList.innerHTML = data.cardCounts.map(p => {
            const isActive = (p.id === data.turnId);
            const isWinner = data.finishOrder && data.finishOrder.includes(p.id);
            return `
                <div class="stat-row ${!p.online ? 'offline' : ''} ${isActive ? 'active-turn' : ''}" 
                     style="padding: 10px; margin-bottom: 5px; background: rgba(255,255,255,0.05); border-radius: 5px; position:relative;">
                    <span style="color: ${p.online ? '#2ecc71' : '#e74c3c'}">●</span> 
                    Player ${p.id.substring(0,4)} ${p.id === sessionId ? '<strong>(YOU)</strong>' : ''}
                    <div style="font-weight:bold;">
                        ${isWinner ? '👑 FINISHED' : p.count + ' Cards'}
                    </div>
                </div>
            `;
        }).join('');
    }

    // 4. Live Scoreboard
    const liveScores = document.getElementById('live-scores-container');
    if (liveScores && data.cardCounts) {
        liveScores.innerHTML = data.cardCounts.map(p => `
            <div class="live-score-item">
                <span class="p-name">${p.id.substring(0,4)}</span>: 
                <span class="p-score">${data.scores[p.id] || 0}</span>
            </div>
        `).join('');
    }

    // 5. Stack Tracker (Requirement: Live Stack Counter)
    const stackTracker = document.getElementById('stack-tracker');
    if (data.stack > 0) {
        stackTracker.style.display = 'block';
        stackTracker.innerText = `🔥 STACK: +${data.stack}`;
    } else {
        stackTracker.style.display = 'none';
    }

    const deckInfo = document.getElementById('deck-info');
    if (deckInfo) deckInfo.innerText = `Deck: ${data.deckCount}`;
}

// --- RENDERING ---
function renderHand(hand, topCard) {
    const cont = document.getElementById('my-hand');
    cont.innerHTML = '';
    
    hand.forEach((c, i) => {
        const div = document.createElement('div');
        // Requirement: Playable Card Aura
        const isPlayable = myTurn && (c.color === topCard.color || c.type === topCard.type || c.color === 'black');
        
        div.className = `card ${c.color} ${isPlayable ? 'playable-glow' : ''}`;
        div.innerHTML = `<span>${c.type}</span>`;
        
        div.onclick = () => {
            if(!myTurn || isSpectator) return;
            if(c.color === 'black') {
                pendingIdx = i;
                document.getElementById('color-picker').style.display = 'flex';
            } else {
                socket.emit('playCard', { index: i });
                document.getElementById('sfx-play').play();
            }
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
window.sendChatMessage = () => {
    const input = document.getElementById('chat-input');
    const msg = input.value.trim();
    if (msg && currentRoom) {
        socket.emit('chatMessage', { msg: msg });
        input.value = '';
    }
};

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
        box.scrollTop = box.scrollHeight;
    }
});

// --- EMITTERS ---
window.chooseColor = (color) => {
    document.getElementById('color-picker').style.display = 'none';
    socket.emit('playCard', { index: pendingIdx, chosenColor: color });
    document.getElementById('sfx-play').play();
};

window.emitUno = () => socket.emit('unoAction', 'safe');
window.emitPenalty = () => socket.emit('unoAction', 'penalty');
window.emitPass = () => socket.emit('pass');
window.emitDraw = () => { if(myTurn) socket.emit('draw'); };

// --- TOURNAMENT RESULTS ---
socket.on('results', data => {
    document.getElementById('sfx-win').play();
    document.getElementById('score-list').innerHTML = data.order.map((id, i) => `
        <div class="score-row" style="display:flex; justify-content:space-between; padding:10px; background:#333; margin:5px; border-left:3px solid gold;">
            <span>${i+1}. ${id.substring(0,4)} ${id === sessionId ? '<strong>(YOU)</strong>' : ''}</span>
            <span>Total: ${data.scores[id]}</span>
        </div>
    `).join('');
    
    document.getElementById('scoreboard-overlay').style.display = 'flex';
});

window.requestRestart = () => {
    const btn = document.getElementById('next-round-btn');
    btn.disabled = true; btn.innerText = "Waiting..."; 
    socket.emit('requestRestart');
};

window.exitToLobby = () => { if (confirm("Exit tournament?")) window.location.reload(); };

socket.on('roomDestroyed', (reason) => { 
    alert(reason || "Connection timed out."); 
    window.location.reload(); 
});
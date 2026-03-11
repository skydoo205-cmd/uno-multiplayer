const socket = io();

// --- PERSISTENCE ---
// Purpose: Remembers who you are if you refresh the page.
let sessionId = localStorage.getItem('uno_v3_session') || Math.random().toString(36).substring(2);
localStorage.setItem('uno_v3_session', sessionId);

let myTurn = false, currentRoom = null, pendingIdx = null;
let isSpectator = false; // Requirement 5: Track if we are just watching
let lastHandSize = 0;

// --- LOBBY LOGIC ---
// Purpose: Handles creating or joining a tournament room.
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
    document.getElementById('lobby-overlay').style.display = 'none';
    document.getElementById('scoreboard-overlay').style.display = 'none';
    document.getElementById('game-container').style.display = 'grid';

    const roomEl = document.getElementById('room-display');
    if (roomEl) roomEl.innerText = `ROOM: ${id}`;
});

// --- CORE GAME UPDATES ---
// Purpose: Receives game state from the server and triggers UI refresh.
socket.on('init', data => {
    document.getElementById('scoreboard-overlay').style.display = 'none';
    
    // Requirement 5: Check if I am a spectator (Winner watching the remaining game)
    isSpectator = data.isSpectator;
    const specUI = document.getElementById('spectator-ui');
    if (specUI) specUI.style.display = isSpectator ? 'block' : 'none';

    // TRIGGER: Draw Sound if hand grew
    if (data.hand && data.hand.length > lastHandSize) {
        const drawSfx = document.getElementById('sfx-draw');
        if (drawSfx && drawSfx.play) drawSfx.play().catch(()=>{});
    }
    lastHandSize = data.hand ? data.hand.length : 0;

    // Refresh everything
    updateUI(data); 
    if (data.hand) {
        renderHand(data.hand, data.topCard, data.lastDrawnCard, data.stack);
    }
});

// --- UI UPDATER ---
// Purpose: Manages all text elements, buttons, and the sidebar list.
function updateUI(data) {
    // 1. Core Turn Logic
    myTurn = (sessionId === data.turnId) && !isSpectator;
    const isTarget = (data.windowActive && data.unoTarget === sessionId);
    const canPenalize = (data.windowActive && data.unoTarget !== sessionId);

    // 2. Status & Reaper Timer (Problem 6 Fix)
    const status = document.getElementById('status');
    if (isSpectator) {
        status.innerText = "SPECTATING...";
        status.style.color = "gold";
    } else {
        const waitingText = status.innerText.includes("Lobby") ? status.innerText : "Waiting...";
        status.innerText = myTurn ? (data.waitingForPass ? "PLAY DRAWN CARD OR PASS" : "YOUR TURN!") : waitingText;
        status.style.color = myTurn ? "#2ecc71" : "white";
    }

    const reaperEl = document.getElementById('reaper-status');
    if (data.reaperTimeLeft && data.reaperTimeLeft > 0) {
        reaperEl.style.display = 'block';
        reaperEl.innerText = `⚠️ Connection Timeout: ${data.reaperTimeLeft}s`;
    } else {
        reaperEl.style.display = 'none';
    }

    // 3. Controls (Buttons)
   // 1. Reset all buttons to hidden first (Prevents "Ghost" buttons)
    document.getElementById('pass-btn').style.display = 'none';
    document.getElementById('uno-btn').style.display = 'none';
    document.getElementById('penalty-btn').style.display = 'none';

    // 2. Pass Button: Only if it's your turn AND the server says you can pass
    if (myTurn && data.waitingForPass) {
        const passBtn = document.getElementById('pass-btn');
        passBtn.style.display = 'block';
        passBtn.style.zIndex = "5000"; // Force it above the hand container
    }

    // 3. UNO Button: Only if you have exactly 2 cards (about to play 1) OR 1 card (just played)
    // AND you haven't said it yet.
    const myPlayer = data.players.find(p => p.sessionId === mySessionId);
    if (myTurn && myPlayer && myPlayer.hand.length <= 2 && !myPlayer.saidUno) {
        document.getElementById('uno-btn').style.display = 'block';
    }

    // 4. Penalty Button: Show for everyone if someone forgot to say UNO
    if (data.unoWindowActive) {
        document.getElementById('penalty-btn').style.display = 'block';
    }

    // 4. Sidebar Stats (Requirement: Active Turn Glow & Winner Crown)
    const statsList = document.getElementById('stats-list');
    if (statsList && data.players) {
        statsList.innerHTML = data.players.map(p => {
            const isActive = (p.sessionId === data.turnId);
            const isWinner = data.finishOrder && data.finishOrder.includes(p.sessionId);
            return `
                <div class="stat-row ${p.isOffline ? 'offline' : ''} ${isActive ? 'active-turn' : ''}" 
                     style="padding: 10px; margin-bottom: 5px; background: rgba(255,255,255,0.05); border-radius: 5px; position:relative;">
                    <span style="color: ${!p.isOffline ? '#2ecc71' : '#e74c3c'}">●</span> 
                    Player ${p.sessionId.substring(0,4)} ${p.sessionId === sessionId ? '<strong>(YOU)</strong>' : ''}
                    <div style="font-weight:bold;">
                        ${isWinner ? '👑 FINISHED' : p.cardCount + ' Cards'}
                    </div>
                </div>
            `;
        }).join('');
    }

    // 5. Live Scoreboard
    const liveScores = document.getElementById('live-scores-container');
    if (liveScores && data.players) {
        liveScores.innerHTML = data.players.map(p => `
            <div class="live-score-item">
                <span class="p-name">${p.sessionId.substring(0,4)}</span>: 
                <span class="p-score">${(data.results && data.results.scores ? data.results.scores[p.sessionId] : 0)}</span>
            </div>
        `).join('');
    }

    // 6. Stack Tracker (Requirement: Live Stack Counter)
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

// --- CARD RENDERING ---
// Purpose: Draws your cards and applies the Smart Glow Logic.
function renderHand(hand, topCard, lastDrawn, currentStack) {
    const cont = document.getElementById('my-hand');
    cont.innerHTML = '';
    
    hand.forEach((c, i) => {
        const div = document.createElement('div');
        div.className = `card ${c.color}`;
        
        // LOGIC: Tactical Draw Highlight (White Glow)
        const isNew = lastDrawn && c.type === lastDrawn.type && c.color === lastDrawn.color;

        // LOGIC: Smart Stacking Glow (Requirement 2)
        let canPlay = false;
        if (currentStack > 0) {
            // Under attack: Only +4 or matching +2 glow.
            canPlay = (c.type === '+4') || (topCard.type === '+2' && c.type === '+2');
        } else {
            // Normal play rules
            canPlay = (c.color === topCard.color || c.type === topCard.type || c.color === 'black');
        }

        // Apply visual glows
        if (isNew) {
            div.classList.add('recently-drawn'); // CSS handle for White Glow
        } else if (myTurn && canPlay && !lastDrawn) {
            div.classList.add('playable-glow'); // CSS handle for Gold Glow
        }

        div.innerHTML = `<span>${c.type}</span>`;
        
        div.onclick = () => {
            if(!myTurn || isSpectator) return;
            
            // FIX: Consistent variable naming for Tactical Draw check
            const isRecentlyDrawn = lastDrawn && c.type === lastDrawn.type && c.color === lastDrawn.color;
            if (lastDrawn && !isRecentlyDrawn) return; 

            // FIX: Standardize check for Black/Wild cards to trigger picker
            if (c.color === 'black' || c.type === 'Wild' || c.type === '+4') {
                pendingIdx = i; 
                const picker = document.getElementById('color-picker');
                if (picker) {
                    picker.style.display = 'flex';
                }
            } else {
                socket.emit('playCard', { index: i });
                const playSfx = document.getElementById('sfx-play');
                if (playSfx) playSfx.play();
            }
        };
        cont.appendChild(div);
    });

    // Sync Top Card
    const el = document.getElementById('top-card');
    if (el && topCard) {
        el.className = `card ${topCard.color}`;
        el.innerHTML = `<span>${topCard.type}</span>`;
    }
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
    // 1. Hide the picker immediately
    const picker = document.getElementById('color-picker');
    if (picker) picker.style.display = 'none';
    
    // 2. Emit payload using the confirmed pendingIdx
    socket.emit('playCard', { 
        index: pendingIdx, 
        chosenColor: color 
    });
    
    const playSfx = document.getElementById('sfx-play');
    if (playSfx) playSfx.play();
};

window.emitUno = () => socket.emit('unoAction', 'safe');
window.emitPenalty = () => socket.emit('unoAction', 'penalty');
window.emitPass = () => socket.emit('pass');
window.emitDraw = () => { if(myTurn) socket.emit('draw'); };

// --- TOURNAMENT RESULTS ---
socket.on('results', data => {
    document.getElementById('score-list').innerHTML = data.order.map((id, i) => `
        <div class="score-row" style="display:flex; justify-content:space-between; padding:10px; background:#333; margin:5px; border-left:3px solid gold;">
            <span>${i+1}. ${id.substring(0,4)} ${id === sessionId ? '<strong>(YOU)</strong>' : ''}</span>
            <span>Total: ${data.scores[id]}</span>
        </div>
    `).join('');
    
    document.getElementById('restart-status').innerText = "";
    document.getElementById('scoreboard-overlay').style.display = 'flex';
});

window.requestRestart = () => {
    socket.emit('requestRestart');
};

window.exitToLobby = () => { if (confirm("Exit tournament?")) socket.emit('exitTournament'); };

// --- SYSTEM EVENTS ---
socket.on('restartProgress', data => { 
    document.getElementById('restart-status').innerText = `Ready: ${data.current}/${data.total}`; 
});

socket.on('roomDestroyed', (reason) => { 
    alert(reason || "Tournament dissolved."); 
    window.location.reload(); 
});

/* --- LOBBY STATUS LISTENER --- */
socket.on('status', (msg) => {
    const statusDiv = document.getElementById('status');
    if (statusDiv) {
        statusDiv.innerText = msg;
        
        // If it's the lobby, add the pulse animation you made!
        if (msg.includes("Lobby")) {
            statusDiv.classList.add('lobby-pulse');
            statusDiv.style.color = "#2ecc71"; // Keep it Green
        } else {
            // Remove pulse when the game actually starts
            statusDiv.classList.remove('lobby-pulse');
        }
    }
});
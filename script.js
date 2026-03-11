const socket = io();

// --- PERSISTENCE LOGIC ---
// Purpose: Remembers the player even if they refresh the page.
let sessionId = localStorage.getItem('uno_v3_session') || Math.random().toString(36).substring(2);
localStorage.setItem('uno_v3_session', sessionId);

let myTurn = false, currentRoom = null, pendingIdx = null;
let isSpectator = false;
let lastHandSize = 0;

// --- BUG FIX: AUDIO UNLOCK (V5.2 Optimized) ---
// Purpose: Browsers block sound until a user clicks. 
// This function "unlocks" all audio channels on the very first tap/click.
function startAudioEngine() {
    const sounds = ['bgm', 'sfx-play', 'sfx-draw', 'sfx-uno'];
    sounds.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            // Play and immediately pause to "prime" the audio for later
            el.play().then(() => { el.pause(); el.currentTime = 0; }).catch(() => {});
        }
    });
    // Start the background music loop
    const bgm = document.getElementById('bgm');
    if (bgm) { bgm.volume = 0.2; bgm.play(); }

    // Remove listeners so this only runs once
    document.removeEventListener('click', startAudioEngine);
    document.removeEventListener('touchstart', startAudioEngine);
}
document.addEventListener('click', startAudioEngine);
document.addEventListener('touchstart', startAudioEngine);

// --- LOBBY & JOINING ---
// Purpose: Handles creating and joining rooms.
window.createRoom = () => {
    const limit = document.getElementById('player-limit').value;
    // Generate a random 4-digit room code
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    socket.emit('joinRoom', { roomId: code, sessionId, playerLimit: parseInt(limit) });
};

window.joinRoom = () => {
    const code = document.getElementById('room-input').value;
    if(code.length === 4) socket.emit('joinRoom', { roomId: code, sessionId });
};

// Purpose: Triggered when the server confirms you are in a room.
socket.on('roomJoined', (id) => {
    currentRoom = id;
    document.getElementById('lobby-overlay').style.display = 'none';
    document.getElementById('game-container').style.display = 'grid';
    document.getElementById('room-display').innerText = `ROOM: ${id}`;
});

// --- BUG FIX: "CONNECTING" FREEZE & CORE UPDATES ---
// Purpose: This is the Master Sync function. 
// It clears the lobby screen and triggers the UI refresh.
socket.on('init', data => {
    // CRITICAL: Hides the "Connecting..." lobby screen
    document.getElementById('lobby-overlay').style.display = 'none';
    document.getElementById('scoreboard-overlay').style.display = 'none';
    document.getElementById('game-container').style.display = 'grid';
    
    // Sync spectator state with the server flag
    isSpectator = data.isSpectator;
    document.getElementById('spectator-ui').style.display = isSpectator ? 'block' : 'none';

    // TRIGGER: Draw Sound (Only if your hand actually got bigger)
    if (data.hand && data.hand.length > lastHandSize) {
        const drawSfx = document.getElementById('sfx-draw');
        if (drawSfx) drawSfx.play();
    }
    lastHandSize = data.hand ? data.hand.length : 0;

    // Refresh UI Components
    updateUI(data); 
    renderHand(data.hand, data.topCard, data.waitingForPass, data.stack);
});

// --- UI UPDATER ---
// Purpose: Updates text, timers, and button visibility.
function updateUI(data) {
    // Determine if it is my turn (and I'm not just spectating)
    myTurn = (sessionId === data.turnId) && !isSpectator;

    // 1. STATUS BAR & REAPER TIMER
    const status = document.getElementById('status');
    if (isSpectator) {
        status.innerText = "SPECTATING MODE";
        status.style.color = "gold";
    } else {
        // BUG FIX: Inform player if they MUST play their drawn card or pass
        status.innerText = myTurn ? (data.waitingForPass ? "PLAY DRAWN CARD OR PASS" : "YOUR TURN!") : "Waiting for Turn...";
        status.style.color = myTurn ? "#2ecc71" : "white";
    }

    // BUG FIX: Reaper Timer logic (Prevents "Stuck at 4s" visual)
    const reaperEl = document.getElementById('reaper-status');
    if (data.reaperTimeLeft && data.reaperTimeLeft > 0) {
        reaperEl.style.display = 'block';
        reaperEl.innerText = `⚠️ Connection Timeout: ${data.reaperTimeLeft}s`;
    } else {
        reaperEl.style.display = 'none';
    }

    // 2. BUTTON CONTROLS
    // Only show buttons if the specific game event (UNO/Penalty/Pass) is active
    document.getElementById('uno-btn').style.display = (data.windowActive && data.unoTarget === sessionId && !isSpectator) ? 'block' : 'none';
    document.getElementById('penalty-btn').style.display = (data.windowActive && data.unoTarget !== sessionId && !isSpectator) ? 'block' : 'none';
    document.getElementById('pass-btn').style.display = (myTurn && data.waitingForPass) ? 'block' : 'none';

    // 3. SIDEBAR STATS (5-Player Compatible)
    const statsList = document.getElementById('stats-list');
    if (statsList && data.players) {
        statsList.innerHTML = data.players.map(p => {
            const isActive = (p.sessionId === data.turnId);
            const finished = data.finishOrder && data.finishOrder.includes(p.sessionId);
            return `
                <div class="stat-row ${p.isOffline ? 'offline' : ''} ${isActive ? 'active-turn' : ''}">
                    <span style="color: ${!p.isOffline ? '#2ecc71' : '#e74c3c'}">●</span> 
                    ${p.sessionId.substring(0,4)} ${p.sessionId === sessionId ? '(YOU)' : ''}
                    <div style="font-weight:bold;">${finished ? '👑 FINISHED' : p.cardCount + ' Cards'}</div>
                </div>`;
        }).join('');
    }

    // 4. LIVE TOURNAMENT STANDINGS
    const liveScores = document.getElementById('live-scores-container');
    if (liveScores && data.players) {
        liveScores.innerHTML = data.players.map(p => `
            <div class="live-score-item">
                <span>${p.sessionId.substring(0,4)}</span>: 
                <span class="p-score">${(data.results && data.results.scores ? data.results.scores[p.sessionId] : 0)}</span>
            </div>`).join('');
    }

    // 5. STACK TRACKER
    const stackTracker = document.getElementById('stack-tracker');
    if (data.stack > 0) {
        stackTracker.style.display = 'block';
        stackTracker.innerText = `🔥 STACK: +${data.stack}`;
        stackTracker.classList.add('stack-active'); // CSS Red Pulse
    } else {
        stackTracker.style.display = 'none';
    }

    document.getElementById('deck-info').innerText = `Deck: ${data.deckCount || 0}`;
}

// --- CARD RENDERING ---
// Purpose: Handles the visuals for your hand, including Glows.
function renderHand(hand, topCard, lastDrawn, currentStack) {
    const cont = document.getElementById('my-hand');
    cont.innerHTML = '';
    
    hand.forEach((c, i) => {
        const div = document.createElement('div');
        div.className = `card ${c.color}`;
        
        // BUG FIX: THE WHITE GLOW (Tactical Draw)
        // Checks if this card matches the one just drawn from the server
        const isRecentlyDrawn = lastDrawn && c.type === lastDrawn.type && c.color === lastDrawn.color;

        // BUG FIX: SMART STACKING (Gold Glow)
        let isPlayable = false;
        if (currentStack > 0) {
            // Under attack: Only glow cards that can stack (+4 or matching +2)
            if (c.type === '+4') isPlayable = true;
            if (topCard.type === '+2' && c.type === '+2') isPlayable = true;
        } else {
            // Normal play rules
            isPlayable = (c.color === topCard.color || c.type === topCard.type || c.color === 'black');
        }

        // Apply visual classes based on state
        if (isRecentlyDrawn) {
            div.classList.add('recently-drawn'); // White Glow (defined in CSS)
        } else if (myTurn && isPlayable && !lastDrawn) {
            div.classList.add('playable-glow'); // Gold Glow
        }

        div.innerHTML = `<span>${c.type}</span>`;
        
        div.onclick = () => {
            if(!myTurn || isSpectator) return;
            // IMPORTANT: If you just drew a card, you can ONLY click that specific card
            if (lastDrawn && !isRecentlyDrawn) return; 

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

// --- EVENT EMITTERS ---
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
// Purpose: Triggers when the server determines the round is over.
socket.on('results', data => {
    // Clear any stuck reaper UI
    document.getElementById('reaper-status').style.display = 'none';
    
    const scoreList = document.getElementById('score-list');
    scoreList.innerHTML = data.order.map((id, i) => `
        <div class="score-row">
            <span>${i+1}. ${id.substring(0,4)} ${id === sessionId ? '<strong>(YOU)</strong>' : ''}</span>
            <span>Total: ${data.scores[id]}</span>
        </div>`).join('');
    
    document.getElementById('scoreboard-overlay').style.display = 'flex';
});

// --- SYSTEM RESET ---
window.requestRestart = () => { socket.emit('requestRestart'); };
window.exitToLobby = () => { if (confirm("Exit tournament?")) window.location.reload(); };

socket.on('roomDestroyed', (reason) => { 
    alert(reason || "Connection timed out."); 
    window.location.reload(); 
});
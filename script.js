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
    const name = document.getElementById('display-name')?.value || "Player";
    const limit = document.getElementById('player-limit').value;
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    socket.emit('joinRoom', { 
        roomId: code, 
        sessionId, 
        playerName: name,
        playerLimit: parseInt(limit) 
    });
};

window.joinRoom = () => {
    const name = document.getElementById('display-name')?.value || "Player";
    const code = document.getElementById('room-input').value;
    if(code.length === 4) {
        socket.emit('joinRoom', { 
            roomId: code, 
            sessionId,
            playerName: name 
            // NOTE: We don't send playerLimit here so we don't overwrite the host's setting
        });
    } else {
        alert("Please enter a 4-digit code");
    }
};

socket.on('roomJoined', (id) => {
    currentRoom = id;
    document.getElementById('lobby-overlay').style.display = 'none';
    document.getElementById('game-container').style.display = 'grid';

    const roomEl = document.getElementById('room-display');
    if (roomEl) roomEl.innerText = `ROOM: ${id}`;
    
    // Safety: Ensure status shows "Waiting for players" immediately
    const status = document.getElementById('status');
    if (status && !status.innerText.includes("LOBBY")) {
        status.innerText = "CONNECTING TO LOBBY...";
    }
});

// --- CORE GAME UPDATES ---
// Purpose: Receives game state from the server and triggers UI refresh.
socket.on('init', data => {
    document.getElementById('scoreboard-overlay').style.display = 'none';
    
    // 1. Spectator Logic
    isSpectator = data.isSpectator;
    const specUI = document.getElementById('spectator-ui');
    if (specUI) specUI.style.display = isSpectator ? 'block' : 'none';

    // 2. Draw Sound Logic
    if (data.hand && data.hand.length > lastHandSize) {
        const drawSfx = document.getElementById('sfx-draw');
        if (drawSfx && drawSfx.play) drawSfx.play().catch(()=>{});
    }
    lastHandSize = data.hand ? data.hand.length : 0;

    // 3. REFRESH EVERYTHING
    updateUI(data); 

    // 4. RENDER HAND (Safe Check Added)
    if (data.hand && data.topCard) {
        renderHand(data.hand, data.topCard, data.lastDrawnCard, data.stack);
    }

    // 5. MUSIC AUTO-START (Safe Check Added)
    const bgMusic = document.getElementById('bg-music');
    if (bgMusic && bgMusic.paused) {
        bgMusic.play().catch(() => { console.log("Music waiting for interaction"); });
    }
});

function updateUI(data) {
    if (!data) return; // Top-level safety

    // 1. Core Turn Logic
    myTurn = (sessionId === data.turnId) && !isSpectator;

    // 2. Status & Reaper Timer
    const status = document.getElementById('status');
    if (status) {
        if (isSpectator) {
            status.innerText = "SPECTATING...";
            status.style.color = "gold";
        } else {
            // Protect Lobby count text
            const waitingText = status.innerText.includes("LOBBY") ? status.innerText : "WAITING...";
            status.innerText = myTurn ? (data.waitingForPass ? "PLAY DRAWN CARD OR PASS" : "YOUR TURN!") : waitingText;
            status.style.color = myTurn ? "#2ecc71" : "white";
        }
    }

    const reaperEl = document.getElementById('reaper-status');
    if (reaperEl) {
        if (data.reaperTimeLeft && data.reaperTimeLeft > 0) {
            reaperEl.style.display = 'block';
            reaperEl.innerText = `⚠️ Connection Timeout: ${data.reaperTimeLeft}s`;
        } else {
            reaperEl.style.display = 'none';
        }
    }

    // 3. Controls (Buttons)
    const passBtn = document.getElementById('pass-btn');
    const unoBtn = document.getElementById('uno-btn');
    const penaltyBtn = document.getElementById('penalty-btn');

    if (passBtn) passBtn.style.display = (myTurn && data.waitingForPass) ? 'block' : 'none';
    
    const myPlayer = data.players ? data.players.find(p => p.sessionId === sessionId) : null;
    if (unoBtn) {
        const showUno = myTurn && myPlayer && myPlayer.cardCount <= 2 && !myPlayer.saidUno;
        unoBtn.style.display = showUno ? 'block' : 'none';
    }

    if (penaltyBtn) penaltyBtn.style.display = data.unoWindowActive ? 'block' : 'none';

    // 4. Sidebar Stats
    const statsList = document.getElementById('stats-list');
    if (statsList && data.players) {
        statsList.innerHTML = data.players.map(p => {
            const isActive = (p.sessionId === data.turnId);
            const isWinner = data.finishOrder && data.finishOrder.includes(p.sessionId);
            return `
                <div class="stat-row ${p.isOffline ? 'offline' : ''} ${isActive ? 'active-turn' : ''}" 
                     style="padding: 10px; margin-bottom: 5px; background: rgba(255,255,255,0.05); border-radius: 5px; position:relative;">
                    <span style="color: ${!p.isOffline ? '#2ecc71' : '#e74c3c'}">●</span> 
                    ${p.name || "Player"} ${p.sessionId === sessionId ? '<strong>(YOU)</strong>' : ''}
                    <div style="font-weight:bold;">
                        ${isWinner ? '👑 FINISHED' : (p.cardCount || 0) + ' Cards'}
                    </div>
                </div>`;
        }).join('');
    }

    // 5. Deck & Stack
    const deckInfo = document.getElementById('deck-info');
    if (deckInfo) deckInfo.innerText = `DECK: ${data.deckCount || '--'}`;

    const stackTracker = document.getElementById('stack-tracker');
    if (stackTracker) {
        stackTracker.style.display = data.stack > 0 ? 'block' : 'none';
        stackTracker.innerText = `🔥 STACK: +${data.stack}`;
    }
}

function renderHand(hand, topCard, lastDrawn, currentStack) {
    const cont = document.getElementById('my-hand');
    if (!cont || !hand) return;
    cont.innerHTML = '';
    
    hand.forEach((c, i) => {
        const div = document.createElement('div');
        div.className = `card ${c.color}`;
        
        // SAFE CHECK: Use ?. to prevent crash if lastDrawn is null
        const isNew = lastDrawn && c.type === lastDrawn?.type && c.color === lastDrawn?.color;

        let canPlay = false;
        if (currentStack > 0) {
            canPlay = (c.type === '+4') || (topCard?.type === '+2' && c.type === '+2');
        } else {
            canPlay = (c.color === topCard?.color || c.type === topCard?.type || c.color === 'black');
        }

        if (isNew) {
            div.classList.add('recently-drawn'); 
        } else if (myTurn && canPlay && !lastDrawn) {
            div.classList.add('playable-glow'); 
        }

        div.innerHTML = `<span>${c.type}</span>`;
        
        div.onclick = () => {
            if(!myTurn || isSpectator) return;
            const isRecentlyDrawn = lastDrawn && c.type === lastDrawn?.type && c.color === lastDrawn?.color;
            if (lastDrawn && !isRecentlyDrawn) return; 

            if (c.color === 'black' || c.type === 'Wild' || c.type === '+4') {
                pendingIdx = i; 
                const picker = document.getElementById('color-picker');
                if (picker) picker.style.display = 'flex';
            } else {
                socket.emit('playCard', { index: i });
                const playSfx = document.getElementById('sfx-play');
                if (playSfx) playSfx.play().catch(()=>{});
            }
        };
        cont.appendChild(div);
    });

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
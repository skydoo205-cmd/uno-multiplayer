const socket = io();

// --- PERSISTENCE (RETAINED 100%) ---
let sessionId = localStorage.getItem('uno_v3_session') || Math.random().toString(36).substring(2);
localStorage.setItem('uno_v3_session', sessionId);

let myTurn = false, currentRoom = null, pendingIdx = null;
let isSpectator = false; 
let lastHandSize = 0;

// --- LOBBY LOGIC (RETAINED 100%) ---
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
        socket.emit('joinRoom', { roomId: code, sessionId, playerName: name });
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
    
    const status = document.getElementById('status');
    if (status && !status.innerText.includes("LOBBY")) {
        status.innerText = "CONNECTING TO LOBBY...";
    }
});

// --- CORE GAME UPDATES (RESTORED SPECTATOR & SOUND LOGIC) ---
socket.on('init', data => {
    document.getElementById('scoreboard-overlay').style.display = 'none';
    
    // 1. Spectator Logic (Retained)
    isSpectator = data.isSpectator;
    const specUI = document.getElementById('spectator-ui');
    if (specUI) specUI.style.display = isSpectator ? 'block' : 'none';

    // 2. Draw Sound Logic (Retained)
    if (data.hand && data.hand.length > lastHandSize) {
        const drawSfx = document.getElementById('sfx-draw');
        if (drawSfx) drawSfx.play().catch(()=>{});
    }
    lastHandSize = data.hand ? data.hand.length : 0;

    // 3. Refresh UI & Hand
    updateUI(data); 
    if (data.hand && data.topCard) {
        renderHand(data.hand, data.topCard, data.lastDrawnCard, data.stack);
    }

    // 4. Music Auto-Start (Fixed ID to 'bgm')
    const bgMusic = document.getElementById('bgm');
    if (bgMusic && bgMusic.paused) {
        bgMusic.play().catch(() => {});
    }
});

function updateUI(data) {
    if (!data) return;
    myTurn = (sessionId === data.turnId) && !isSpectator;

    // Status Rendering (Retained your styling)
    const status = document.getElementById('status');
    if (status) {
        if (isSpectator) {
            status.innerText = "SPECTATING...";
            status.style.color = "gold";
        } else {
            const waitingText = status.innerText.includes("LOBBY") ? status.innerText : "WAITING...";
            status.innerText = myTurn ? (data.lastDrawnCard ? "PLAY STAGED CARD OR PASS" : "YOUR TURN!") : waitingText;
            status.style.color = myTurn ? "#2ecc71" : "white";
        }
    }

    // Reaper Status (Retained 100%)
    const reaperEl = document.getElementById('reaper-status');
    if (reaperEl) {
        if (data.reaperTimeLeft && data.reaperTimeLeft > 0) {
            reaperEl.style.display = 'block';
            reaperEl.innerText = `⚠️ Connection Timeout: ${data.reaperTimeLeft}s`;
        } else {
            reaperEl.style.display = 'none';
        }
    }

    // Controls (Fixed Emitters)
    const passBtn = document.getElementById('pass-btn');
    const unoBtn = document.getElementById('uno-btn');
    const penaltyBtn = document.getElementById('penalty-btn');

    if (passBtn) passBtn.style.display = (myTurn && data.lastDrawnCard) ? 'block' : 'none';
    
    const myPlayer = data.players ? data.players.find(p => p.sessionId === sessionId) : null;
    if (unoBtn) {
        const showUno = myTurn && myPlayer && myPlayer.cardCount <= 2 && !myPlayer.saidUno;
        unoBtn.style.display = showUno ? 'block' : 'none';
    }
    if (penaltyBtn) penaltyBtn.style.display = data.unoWindowActive ? 'block' : 'none';

    // Sidebar Stats (Retained your complex template literal)
    const statsList = document.getElementById('stats-list');
    if (statsList && data.players) {
        statsList.innerHTML = data.players.map(p => {
            const isActive = (p.sessionId === data.turnId);
            const isWinner = data.finishOrder && data.finishOrder.includes(p.sessionId);
            return `
                <div class="stat-row ${p.isOffline ? 'offline' : ''} ${isActive ? 'active-turn' : ''}" 
                     style="padding: 10px; margin-bottom: 5px; background: rgba(255,255,255,0.05); border-radius: 5px;">
                    <span style="color: ${!p.isOffline ? '#2ecc71' : '#e74c3c'}">●</span> 
                    ${p.name || "Player"} ${p.sessionId === sessionId ? '<strong>(YOU)</strong>' : ''}
                    <div style="font-weight:bold;">
                        ${isWinner ? '👑 FINISHED' : (p.cardCount || 0) + ' Cards'} ${p.saidUno ? '<span style="color:red; font-size:0.7rem;">UNO!</span>' : ''}
                    </div>
                </div>`;
        }).join('');
    }

    // Deck & Stack Tracking (Retained)
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
    const drawPile = document.getElementById('draw-pile');
    if (!cont || !hand) return;
    cont.innerHTML = '';
    
    // --- STAGING AREA LOGIC (NEW: DECK CHANGES TO DRAWN CARD) ---
    if (lastDrawn) {
        drawPile.className = `card ${lastDrawn.color} staging-pulse`;
        drawPile.innerHTML = `<span>${lastDrawn.type}</span>`;
        drawPile.onclick = () => {
            if (!myTurn || isSpectator) return;
            if (lastDrawn.color === 'black' || lastDrawn.type === 'Wild' || lastDrawn.type === '+4') {
                pendingIdx = -1; // -1 triggers staging play on chooseColor
                document.getElementById('color-picker').style.display = 'flex';
            } else {
                socket.emit('playCard', { index: -1 });
                document.getElementById('sfx-play')?.play().catch(()=>{});
            }
        };
    } else {
        drawPile.className = 'card back';
        drawPile.innerHTML = 'DECK';
        drawPile.onclick = () => { if(myTurn) socket.emit('draw'); };
    }

    // --- HAND RENDERING (RETAINED PLAYABLE LOGIC + ADDED PULSE) ---
    hand.forEach((c, i) => {
        const div = document.createElement('div');
        div.className = `card ${c.color}`;
        
        let canPlay = false;
        if (currentStack > 0) {
            canPlay = (c.type === '+4') || (topCard?.type === '+2' && c.type === '+2');
        } else {
            canPlay = (c.color === topCard?.color || c.type === topCard?.type || c.color === 'black');
        }

        // Add Pulse to playable cards ONLY if not staging a drawn card
        if (myTurn && canPlay && !lastDrawn) {
            div.classList.add('pulse'); 
        }

        div.innerHTML = `<span>${c.type}</span>`;
        
        div.onclick = () => {
            if(!myTurn || isSpectator || lastDrawn) return;
            if (c.color === 'black' || c.type === 'Wild' || c.type === '+4') {
                pendingIdx = i; 
                document.getElementById('color-picker').style.display = 'flex';
            } else if (canPlay) {
                socket.emit('playCard', { index: i });
                document.getElementById('sfx-play')?.play().catch(()=>{});
            }
        };
        cont.appendChild(div);
    });

    const topEl = document.getElementById('top-card');
    if (topEl && topCard) {
        topEl.className = `card ${topCard.color}`;
        topEl.innerHTML = `<span>${topCard.type}</span>`;
    }
}

// --- EMITTERS (RETAINED & FIXED) ---
window.chooseColor = (color) => {
    document.getElementById('color-picker').style.display = 'none';
    socket.emit('playCard', { index: pendingIdx, chosenColor: color });
    document.getElementById('sfx-play')?.play().catch(()=>{});
};

window.emitUno = () => socket.emit('unoAction', 'safe');
window.emitPenalty = () => socket.emit('unoAction', 'penalty');
window.emitPass = () => socket.emit('pass');

// --- CHAT LOGIC (RETAINED 100%) ---
window.sendChatMessage = () => {
    const input = document.getElementById('chat-input');
    if (input.value.trim() && currentRoom) {
        socket.emit('chatMessage', { msg: input.value.trim() });
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

// --- TOURNAMENT RESULTS (RETAINED 100%) ---
socket.on('results', data => {
    const scoreList = document.getElementById('score-list');
    scoreList.innerHTML = data.order.map((id, i) => `
        <div class="score-row" style="display:flex; justify-content:space-between; padding:10px; background:#333; margin:5px; border-left:3px solid gold;">
            <span>${i+1}. ${id.substring(0,4)} ${id === sessionId ? '<strong>(YOU)</strong>' : ''}</span>
            <span>Total: ${data.scores[id]}</span>
        </div>`).join('');
    document.getElementById('scoreboard-overlay').style.display = 'flex';
});

window.requestRestart = () => socket.emit('requestRestart');
window.exitToLobby = () => { if (confirm("Exit tournament?")) socket.emit('exitTournament'); };

// --- SYSTEM EVENTS (RETAINED 100%) ---
socket.on('restartProgress', data => { 
    document.getElementById('restart-status').innerText = `Ready: ${data.current}/${data.total}`; 
});

socket.on('roomDestroyed', (reason) => { 
    alert(reason || "Tournament dissolved."); 
    window.location.reload(); 
});

socket.on('status', (msg) => {
    const statusDiv = document.getElementById('status');
    if (statusDiv) {
        statusDiv.innerText = msg;
        if (msg.includes("Lobby")) {
            statusDiv.classList.add('lobby-pulse');
            statusDiv.style.color = "#2ecc71";
        } else {
            statusDiv.classList.remove('lobby-pulse');
        }
    }
});
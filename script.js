const socket = io();
let sessionId = localStorage.getItem('uno_v3_session') || Math.random().toString(36).substring(2);
localStorage.setItem('uno_v3_session', sessionId);

let myTurn = false, currentRoom = null, pendingIdx = null;

// --- LOBBY ---
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
    document.getElementById('game-container').style.display = 'flex';
    document.getElementById('room-display').innerText = `ROOM: ${id}`;
});

// --- GAMEPLAY ---
socket.on('init', data => {
    document.getElementById('scoreboard-overlay').style.display = 'none';
    renderHand(data.hand);
    renderTop(data.topCard);
    updateUI(data);
});

function updateUI(data) {
    myTurn = (sessionId === data.turnId);
    const isTarget = (data.windowActive && data.unoTarget === sessionId);
    const canPenalize = (data.windowActive && data.unoTarget !== sessionId);

    document.getElementById('status').innerText = myTurn ? "YOUR TURN!" : "Waiting...";
    document.getElementById('uno-btn').style.display = isTarget ? 'block' : 'none';
    document.getElementById('penalty-btn').style.display = canPenalize ? 'block' : 'none';
    document.getElementById('pass-btn').style.display = (myTurn && !data.windowActive) ? 'block' : 'none';

    document.getElementById('stats-list').innerHTML = data.cardCounts.map(p => `
        <div class="stat-row ${!p.online ? 'offline' : ''}">
            Player ${p.id.substring(0,4)} ${p.id === sessionId ? '(YOU)' : ''}<br>
            <strong>${p.count} Cards</strong>
        </div>
    `).join('');
    document.getElementById('deck-info').innerText = `Deck: ${data.deckCount} | Stack: ${data.stack}`;
}

function renderHand(hand) {
    const cont = document.getElementById('my-hand');
    cont.innerHTML = '';
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

window.chooseColor = (c) => {
    document.getElementById('color-picker').style.display = 'none';
    socket.emit('playCard', { index: pendingIdx, chosenColor: c });
};

window.emitUno = () => socket.emit('unoAction', 'safe');
window.emitPenalty = () => socket.emit('unoAction', 'penalty');
window.emitPass = () => socket.emit('pass');
document.getElementById('draw-pile').onclick = () => { if(myTurn) socket.emit('draw'); };

socket.on('results', data => {
    document.getElementById('score-list').innerHTML = data.order.map((id, i) => `
        <div class="score-row">
            <span>${i+1}. ${id.substring(0,4)}</span>
            <span>Total: ${data.scores[id]}</span>
        </div>
    `).join('');
    document.getElementById('scoreboard-overlay').style.display = 'flex';
});
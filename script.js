const socket = io();
let myTurn = false;
let hasDrawn = false;
let pendingIndex = null;

socket.on('init', data => {
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

socket.on('updateTurn', id => setTurn(id));

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

document.getElementById('pass-btn').onclick = () => socket.emit('pass');

function renderTop(c) {
    const el = document.getElementById('top-card');
    el.className = `card ${c.color}`;
    el.innerHTML = `<span>${c.type}</span>`;
}

function setTurn(id) {
    myTurn = (socket.id === id);
    document.getElementById('status').innerText = myTurn ? "YOUR TURN!" : "Waiting...";
    document.getElementById('status').style.color = myTurn ? "#2ecc71" : "white";
}
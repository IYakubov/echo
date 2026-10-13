const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const SLOTS = ['A', 'B', 'C', 'D'];   // up to 4 phones
const START_DELAY = 2500;             // ms after everyone is Ready before the game starts

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/controller', (req, res) => res.sendFile(path.join(__dirname, 'public', 'controller.html')));

// ── LAN address ──
// Phones can't reach "localhost", so when the host page was opened via
// localhost/127.0.0.1 the QR code uses this machine's LAN IPv4 instead.
function lanIp() {
  const nets = os.networkInterfaces();
  const found = [];
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if ((n.family === 'IPv4' || n.family === 4) && !n.internal) found.push(n.address);
    }
  }
  const pref = found.find(a => /^192\.168\./.test(a)) ||
               found.find(a => /^10\./.test(a)) ||
               found.find(a => /^172\.(1[6-9]|2\d|3[01])\./.test(a)) ||
               found[0];
  return pref || 'localhost';
}

// Public address of this game, e.g. https://sharedcouch.online/echo
// (the Shared Couch front door sends X-Forwarded-Proto / -Host / -Prefix).
function publicPrefix(h) {
  return String(h['x-forwarded-prefix'] || '').split(',')[0].trim().replace(/\/+$/, '');
}
function publicProto(h) {
  return String(h['x-forwarded-proto'] || 'http').split(',')[0].trim();
}
function joinBase(headers) {
  const h = String(headers['x-forwarded-host'] || headers.host || '').split(',')[0].trim().toLowerCase();
  const hostname = h.replace(/:\d+$/, '');
  if (!h || hostname === 'localhost' || hostname.startsWith('127.') || hostname === '[::1]') {
    return `http://${lanIp()}:${PORT}`;
  }
  return `${publicProto(headers)}://${h}${publicPrefix(headers)}`;
}

async function qrSvgFor(url) {
  return QRCode.toString(url, {
    type: 'svg',
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#1b1b1a', light: '#ecebe6' }
  });
}

// ── Rooms ──
// rooms[code] = {
//   hostSocketId,
//   players:   { A..D: socketId|null },
//   clientIds: { A..D: string|null },   // which phone owns the slot
//   ready:     { A..D: bool },
//   started:   bool,                     // a game is running (phones on the pads)
//   active:    ['A','C',…] | null,       // who is in the running game
//   startTimer, startsAt,                // "everyone is ready" grace period
//   ui:        last host_ui payload (re-sent to phones that reconnect)
// }
const rooms = {};
const emptySlots = v => Object.fromEntries(SLOTS.map(s => [s, v]));

function genCode() {
  let code;
  do { code = Math.floor(100000 + Math.random() * 900000).toString(); } while (rooms[code]);
  return code;
}

// A slot is "in the room" while its phone is connected.
const inRoom = room => SLOTS.filter(s => room.players[s]);

function lobbyPayload(room) {
  const slots = {};
  SLOTS.forEach(s => { slots[s] = { on: !!room.players[s], ready: !!room.players[s] && room.ready[s] }; });
  return { slots, starting: !!room.startTimer, startsAt: room.startsAt || null, started: room.started };
}
function broadcastLobby(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit('game_event', { event: 'lobby_ready_update', data: lobbyPayload(room) });
}

function cancelStart(room) {
  if (room.startTimer) { clearTimeout(room.startTimer); room.startTimer = null; room.startsAt = null; }
}

// Everyone in the room is Ready (1–4 phones) → start after a short grace period,
// so a friend still scanning the QR can jump in (a new phone cancels it).
function checkStart(code) {
  const room = rooms[code];
  if (!room || room.started) return;
  const here = inRoom(room);
  const allReady = here.length > 0 && here.every(s => room.ready[s]);
  if (!allReady) { cancelStart(room); broadcastLobby(code); return; }
  if (room.startTimer) return;
  room.startsAt = Date.now() + START_DELAY;
  room.startTimer = setTimeout(() => {
    room.startTimer = null; room.startsAt = null;
    const now = inRoom(room);
    if (room.started || !now.length || !now.every(s => room.ready[s])) { broadcastLobby(code); return; }
    room.started = true;
    room.active = now;
    console.log(`[${code}] game start: ${now.join(',')}`);
    broadcastLobby(code);
    io.to(code).emit('game_start', { players: room.active });
  }, START_DELAY);
  broadcastLobby(code);
}

function shortUA(socket) {
  const ua = socket.handshake.headers['user-agent'] || '?';
  return ua.length > 90 ? ua.slice(0, 90) + '…' : ua;
}

// Bind a phone to a slot. One phone (clientId) = one slot, one socket = one slot.
function bindPhone(socket, code, clientId, hintSlot) {
  const room = rooms[code];
  if (!room) { socket.emit('join_error', 'Room not found'); return; }
  clientId = typeof clientId === 'string' && clientId ? clientId.slice(0, 64) : null;

  // This socket already holds a slot here → just confirm it.
  if (socket.data.code === code && socket.data.slot && room.players[socket.data.slot] === socket.id) {
    sendJoined(socket, room, socket.data.slot);
    return;
  }

  let slot = null;
  // 1) Same phone re-opening the link keeps its slot.
  if (clientId) slot = SLOTS.find(s => room.clientIds[s] === clientId) || null;
  // While a game runs, only its players may come back.
  if (!slot && room.started) { socket.emit('join_error', 'A game is running — join when it ends'); return; }
  // 2) Reconnect hint — only if the slot is free and not owned by another phone.
  if (!slot && SLOTS.includes(hintSlot) && !room.players[hintSlot] && !room.clientIds[hintSlot]) slot = hintSlot;
  // 3) A never-claimed slot.
  if (!slot) slot = SLOTS.find(s => !room.players[s] && !room.clientIds[s]) || null;
  // 4) A slot whose phone has gone away.
  if (!slot) slot = SLOTS.find(s => !room.players[s]) || null;
  if (!slot) { socket.emit('join_error', 'Room is full'); return; }

  // Kick the previous tab of the same phone off this slot.
  const prev = room.players[slot];
  if (prev && prev !== socket.id) {
    const old = io.sockets.sockets.get(prev);
    if (old) {
      old.data.slot = null;
      old.data.code = null;
      old.leave(code);
      old.emit('replaced');
    }
  }
  // A socket never holds two slots.
  SLOTS.forEach(s => { if (s !== slot && room.players[s] === socket.id) room.players[s] = null; });

  if (room.clientIds[slot] !== clientId) room.ready[slot] = false;
  room.players[slot] = socket.id;
  room.clientIds[slot] = clientId;
  socket.data.code = code;
  socket.data.slot = slot;
  socket.join(code);

  console.log(`[${code}] phone → ${slot}  (${shortUA(socket)})`);
  sendJoined(socket, room, slot);
  io.to(code).emit('player_joined', { slot, players: Object.fromEntries(SLOTS.map(s => [s, !!room.players[s]])) });
  checkStart(code);
  broadcastLobby(code);
}

function sendJoined(socket, room, slot) {
  socket.emit('joined', { slot, code: socket.data.code, started: room.started, ready: room.ready[slot] });
  if (room.started) {
    socket.emit('game_start', { players: room.active || [slot] });
    if (room.ui) socket.emit('host_ui', room.ui);
  }
}

function phoneOk(socket) {
  const room = rooms[socket.data.code];
  const slot = socket.data.slot;
  if (!room || !slot || room.players[slot] !== socket.id) return null;
  return { room, slot };
}

io.on('connection', (socket) => {
  socket.data.code = null;
  socket.data.slot = null;
  socket.data.isHost = false;

  // ── HOST ──
  socket.on('create_game', async () => {
    const code = genCode();
    rooms[code] = {
      hostSocketId: socket.id,
      players: emptySlots(null),
      clientIds: emptySlots(null),
      ready: emptySlots(false),
      started: false,
      active: null,
      startTimer: null,
      startsAt: null,
      ui: null
    };
    socket.data.code = code;
    socket.data.isHost = true;
    socket.join(code);
    const joinUrl = `${joinBase(socket.handshake.headers)}/controller?code=${code}`;
    let qrSvg = '';
    try { qrSvg = await qrSvgFor(joinUrl); } catch (e) { console.warn('QR failed', e.message); }
    console.log(`[${code}] room created — join: ${joinUrl}`);
    socket.emit('game_created', { code, joinUrl, qrSvg });
  });

  // Host mirrors its menu / per-player status to the phones.
  socket.on('host_ui', (ui) => {
    const room = rooms[socket.data.code];
    if (!room || room.hostSocketId !== socket.id) return;
    room.ui = ui;
    socket.to(socket.data.code).emit('host_ui', ui);
  });

  // Host → one phone (tap feedback: ok / wrong / done).
  socket.on('to_player', ({ slot, msg } = {}) => {
    const room = rooms[socket.data.code];
    if (!room || room.hostSocketId !== socket.id || !SLOTS.includes(slot)) return;
    const sid = room.players[slot];
    if (sid) io.to(sid).emit('player_msg', msg);
  });

  socket.on('host_back_to_lobby', () => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.hostSocketId !== socket.id) return;
    cancelStart(room);
    room.started = false;
    room.active = null;
    room.ready = emptySlots(false);
    room.ui = null;
    // Slots of phones that left during the game become free again.
    SLOTS.forEach(s => { if (!room.players[s]) room.clientIds[s] = null; });
    io.to(code).emit('back_to_lobby');
    broadcastLobby(code);
  });

  // Host is leaving for the game catalog.
  socket.on('host_exit', () => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.hostSocketId !== socket.id) return;
    socket.to(code).emit('host_exit');
  });

  // ── PHONE ──
  socket.on('join_game', ({ code, clientId } = {}) => bindPhone(socket, String(code || ''), clientId, null));
  socket.on('rejoin_game', ({ code, slot, clientId } = {}) => bindPhone(socket, String(code || ''), clientId, slot));

  socket.on('player_ready', () => {
    const p = phoneOk(socket);
    if (!p || p.room.started) return;
    p.room.ready[p.slot] = true;
    checkStart(socket.data.code);
    broadcastLobby(socket.data.code);
  });

  socket.on('player_unready', () => {
    const p = phoneOk(socket);
    if (!p || p.room.started) return;
    p.room.ready[p.slot] = false;
    checkStart(socket.data.code);
  });

  // A pad tap during the "your turn" phase.
  socket.on('ctrl_pad', ({ pad } = {}) => {
    const p = phoneOk(socket);
    if (!p) return;
    pad = Number(pad);
    if (!(pad >= 0 && pad <= 3)) return;
    io.to(p.room.hostSocketId).emit('ctrl_pad', { slot: p.slot, pad });
  });

  // Phone tapped a row of the mirrored menu.
  socket.on('ctrl_pick', ({ index } = {}) => {
    const p = phoneOk(socket);
    if (!p) return;
    io.to(p.room.hostSocketId).emit('ctrl_pick', { slot: p.slot, index: Number(index) | 0 });
  });

  // Phone's menu button → host toggles its pause menu.
  socket.on('ctrl_menu', () => {
    const p = phoneOk(socket);
    if (!p) return;
    io.to(p.room.hostSocketId).emit('ctrl_menu', { slot: p.slot });
  });

  socket.on('disconnect', () => {
    const code = socket.data.code;
    const room = code && rooms[code];
    if (!room) return;

    if (socket.data.isHost && room.hostSocketId === socket.id) {
      cancelStart(room);
      io.to(code).emit('host_disconnected');
      delete rooms[code];
      return;
    }
    const slot = socket.data.slot;
    if (slot && room.players[slot] === socket.id) {
      room.players[slot] = null;
      if (!room.started) { room.ready[slot] = false; room.clientIds[slot] = null; }
      io.to(code).emit('player_left', { slot });
      checkStart(code);
      broadcastLobby(code);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Echo server: http://localhost:${PORT}`);
  console.log(`Phones join via: http://${lanIp()}:${PORT}`);
});

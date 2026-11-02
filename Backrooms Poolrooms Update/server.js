// The Yellow Halls - game server (no dependencies).
// Serves index.html and relays messages between players in a room (WebSocket on /ws).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  if (req.url === '/' || req.url.startsWith('/index.html')) {
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  }
  res.writeHead(404); res.end('Not found');
});

/* ---------- minimal WebSocket ---------- */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function frame(op, data) {
  const p = Buffer.from(data), n = p.length; let h;
  if (n < 126) h = Buffer.from([0x80 | op, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, p]);
}
const send = (c, o) => { if (c.socket.writable) c.socket.write(frame(1, JSON.stringify(o))); };

function parse(c) {
  for (;;) {
    const b = c.buf; if (b.length < 2) return;
    const op = b[0] & 15, masked = b[1] & 128; let len = b[1] & 127, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (len > (1 << 20)) return c.socket.destroy();
    const hdr = off + (masked ? 4 : 0), need = hdr + len;
    if (b.length < need) return;
    const payload = Buffer.from(b.subarray(hdr, need));
    if (masked) for (let i = 0; i < len; i++) payload[i] ^= b[off + (i & 3)];
    c.buf = b.subarray(need);
    if (op === 8) { c.socket.end(frame(8, '')); return; }
    if (op === 9) c.socket.write(frame(10, payload));
    else if (op === 1) handle(c, payload.toString());
  }
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (req.url !== '/ws' || !key) return socket.destroy();
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  const c = {socket, id: nextId++, room: null, name: 'Player', buf: Buffer.alloc(0)};
  socket.on('data', d => { c.buf = Buffer.concat([c.buf, d]); parse(c); });
  socket.on('close', () => leave(c));
  socket.on('error', () => socket.destroy());
});

/* ---------- rooms ---------- */
let nextId = 1;
const rooms = new Map(), ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', MAX_PLAYERS = 6;
function newCode() {
  let c; do { c = Array.from({length: 4}, () => ALPHA[Math.random() * ALPHA.length | 0]).join(''); } while (rooms.has(c));
  return c;
}
function relay(c, m) { for (const p of c.room.players.values()) if (p !== c) send(p, m); }

function handle(c, text) {
  let m; try { m = JSON.parse(text); } catch (e) { return; }
  if (m.t === 'create' || m.t === 'join') {
    if (c.room) return;
    let room;
    if (m.t === 'create') {
      room = {code: newCode(), seed: Math.random() * 2147483647 | 0, level: 1, players: new Map(), host: null};
      rooms.set(room.code, room);
    } else {
      room = rooms.get(String(m.code || '').toUpperCase());
      if (!room) return send(c, {t: 'error', msg: 'Room not found'});
      if (room.players.size >= MAX_PLAYERS) return send(c, {t: 'error', msg: 'Room is full'});
    }
    c.room = room; c.name = String(m.name || 'Player').slice(0, 16);
    room.players.set(c.id, c); if (!room.host) room.host = c.id;
    send(c, {t: 'joined', code: room.code, id: c.id, seed: room.seed, level: room.level, host: room.host === c.id,
      players: [...room.players.values()].filter(p => p !== c).map(p => ({id: p.id, name: p.name}))});
    relay(c, {t: 'peer', id: c.id, name: c.name});
    return;
  }
  if (!c.room || m.t === 'ping') return;
  if (m.t === 'level' && typeof m.n === 'number') c.room.level = m.n;
  if (m.t === 'chat') { m.text = String(m.text || '').slice(0, 120); if (!m.text.trim()) return; }
  m.id = c.id;
  if (m.to) { const to = c.room.players.get(m.to); if (to) send(to, m); } else relay(c, m);
}

function leave(c) {
  const r = c.room; if (!r) return;
  r.players.delete(c.id); c.room = null;
  if (!r.players.size) { rooms.delete(r.code); return; }
  for (const p of r.players.values()) send(p, {t: 'left', id: c.id});
  if (r.host === c.id) { r.host = r.players.keys().next().value; for (const p of r.players.values()) send(p, {t: 'host', id: r.host}); }
}

server.listen(PORT, () => console.log('The Yellow Halls running on port ' + PORT));

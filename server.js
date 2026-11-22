// Phone Pad relay server — zero dependencies.
// Serves the iPhone controller page and relays its input (WebSocket)
// to the Chrome extension running on xbox.com/play.
//
//   node server.js            (default port 8765)
//   PORT=9000 node server.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = Number(process.env.PORT) || 8765;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

const pads = new Set();   // phones
const games = new Set();  // browser tabs (extension)

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

// ---------- Minimal WebSocket (RFC 6455) ----------
server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws' || !req.headers['sec-websocket-key']) return socket.destroy();
  const role = url.searchParams.get('role') === 'game' ? 'game' : 'pad';

  const accept = crypto.createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true); // lowest latency

  const client = { socket, role, send: (msg) => sendFrame(socket, msg) };
  (role === 'game' ? games : pads).add(client);
  log(`${role === 'game' ? 'Browser' : 'Phone'} connected (${socket.remoteAddress})`);
  broadcastStatus();

  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let frame;
    while ((frame = readFrame(buf))) {
      buf = buf.subarray(frame.length);
      if (frame.opcode === 0x8) return socket.end();
      if (frame.opcode === 0x9) { socket.write(Buffer.from([0x8a, 0])); continue; } // pong
      if (frame.opcode === 0x1) onMessage(client, frame.payload.toString('utf8'));
    }
  });
  const drop = () => {
    if (!(pads.delete(client) || games.delete(client))) return;
    log(`${role === 'game' ? 'Browser' : 'Phone'} disconnected`);
    if (role === 'pad') for (const g of games) g.send('{"t":"padgone"}');
    broadcastStatus();
  };
  socket.on('close', drop);
  socket.on('error', drop);
});

function readFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = buf[1] & 0x80;
  let len = buf[1] & 0x7f, off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  const maskOff = off; if (masked) off += 4;
  if (buf.length < off + len) return null;
  const payload = Buffer.from(buf.subarray(off, off + len));
  if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[maskOff + (i & 3)];
  return { opcode, payload, length: off + len };
}

function sendFrame(socket, str) {
  if (socket.destroyed) return;
  const data = Buffer.from(str);
  const len = data.length;
  const head = len < 126 ? Buffer.from([0x81, len])
    : len < 65536 ? Buffer.from([0x81, 126, len >> 8, len & 255])
    : (() => { const h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); return h; })();
  socket.write(Buffer.concat([head, data]));
}

// ---------- Relay ----------
function onMessage(client, msg) {
  if (client.role === 'pad' && msg.startsWith('{"t":"ping"')) {
    client.send(msg.replace('"ping"', '"pong"'));   // latency check: answer the phone directly
    return;
  }
  if (client.role === 'pad' && msg.startsWith('{"t":"hello"')) {
    try {
      const ua = JSON.parse(msg).ua || '';
      const safari = (ua.match(/Version\/([\d.]+)/) || [])[1];
      log(`Phone browser: ${safari ? 'Safari ' + safari : ua.slice(0, 80)}`);
    } catch {}
    return;
  }
  if (client.role === 'pad') {
    for (const g of games) g.send(msg);          // controller state -> browser
  } else {
    for (const p of pads) p.send(msg);           // rumble etc. -> phone
  }
}

function broadcastStatus() {
  const s = JSON.stringify({ t: 'status', pads: pads.size, games: games.size });
  for (const c of [...pads, ...games]) c.send(s);
}

function log(m) { console.log(`[${new Date().toLocaleTimeString()}] ${m}`); }

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`\n  Port ${PORT} is already in use — Phone Pad is probably already running in another terminal.`);
    console.log(`  Use that one, or stop it with:  lsof -ti :${PORT} | xargs kill\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log('\n  Phone Pad relay running\n');
  console.log('  Phone Pad iPhone app: finds this Mac automatically.');
  for (const ip of ips) console.log(`  In Safari on your iPhone:  http://${ip}:${PORT}`);
  console.log(`\n  The Chrome extension connects to ws://localhost:${PORT}/ws automatically.\n`);
  advertise(ips);
});

// Announce the server on the local network (Bonjour) so the iPhone app can find it.
// macOS ships `dns-sd`; the TXT record carries this Mac's IPs and port.
let advertiser = null;
function advertise(ips) {
  try {
    const name = `Phone Pad on ${os.hostname().replace(/\.local$/, '')}`;
    const host = os.hostname().endsWith('.local') ? os.hostname() : `${os.hostname()}.local`;
    advertiser = require('child_process').spawn('dns-sd',
      ['-R', name, '_phonepad._tcp', 'local', String(PORT), `ip=${ips.join(',')}`, `port=${PORT}`, `host=${host}`],
      { stdio: 'ignore' });
    advertiser.on('error', () => { advertiser = null; });
  } catch { advertiser = null; }
}
function stopAdvertising() { if (advertiser) { advertiser.kill(); advertiser = null; } }
process.on('exit', stopAdvertising);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { stopAdvertising(); process.exit(0); });

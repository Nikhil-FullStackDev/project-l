// HTTP static server + WebSocket game rooms. Single process, in-memory state.
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { serveStatic } from './static.js';
import { Rooms } from './rooms.js';

const PORT = Number(process.env.PORT) || 3000;
const rooms = new Rooms();

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    return res.end('ok');
  }
  serveStatic(req, res);
});

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 16 * 1024,
  // Game states are repetitive JSON; deflate shrinks them ~5-8x. Skip tiny frames.
  perMessageDeflate: { threshold: 512, zlibDeflateOptions: { level: 6 }, concurrencyLimit: 10 },
});

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.tokens = 30; // simple token-bucket rate limit
  ws.lastRefill = Date.now();
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data, isBinary) => {
    const now = Date.now();
    ws.tokens = Math.min(30, ws.tokens + ((now - ws.lastRefill) / 1000) * 15);
    ws.lastRefill = now;
    if (--ws.tokens < 0) return ws.send('{"t":"error","msg":"Slow down"}');
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    try {
      rooms.handle(ws, msg);
    } catch (e) {
      ws.send(JSON.stringify({ t: 'error', msg: e.expose ? e.message : 'Server error' }));
      if (!e.expose) console.error(e);
    }
  });
  ws.on('close', () => rooms.disconnect(ws));
});

// Drop dead connections (mobile networks often vanish without a FIN).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25_000);

const gc = setInterval(() => rooms.gc(), 60_000);

server.listen(PORT, () => console.log(`Project L listening on :${PORT}`));

function shutdown() {
  clearInterval(heartbeat);
  clearInterval(gc);
  for (const ws of wss.clients) ws.close(1012, 'Server restarting');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

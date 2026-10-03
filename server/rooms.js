import crypto from 'node:crypto';
import { createGame, applyAction, publicView, GameError } from '../shared/engine.js';
import { chooseAction } from '../shared/bot.js';

const MAX_ROOMS = 1000;
const MAX_PLAYERS = 4;
const BOT_DELAY = 650; // ms between bot actions so humans can follow along
const DISCONNECT_GRACE = 30_000; // a bot plays for a disconnected player after this
const IDLE_TTL = 30 * 60_000;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const BOT_NAMES = ['Ada', 'Turing', 'Lovelace', 'Hopper', 'Knuth', 'Dijkstra', 'Liskov', 'Hamilton'];

class ClientError extends Error { expose = true; }
const fail = (m) => { throw new ClientError(m); };

const cleanName = (n) => String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16) || 'Player';
const send = (ws, obj) => ws && ws.readyState === 1 && ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));

class Room {
  constructor(code) {
    this.code = code;
    this.players = []; // { id, name, bot, token, ws, connected, discAt }
    this.spectators = new Set();
    this.hostId = null;
    this.game = null;
    this.timer = null;
    this.lastActive = Date.now();
  }

  info() {
    return {
      code: this.code,
      hostId: this.hostId,
      started: !!this.game,
      players: this.players.map((p) => ({ id: p.id, name: p.name, bot: p.bot, connected: p.bot || p.connected })),
      spectators: this.spectators.size,
    };
  }

  sockets() {
    const out = [...this.spectators];
    for (const p of this.players) if (p.ws) out.push(p.ws);
    return out;
  }

  // Serialize once, send to everyone.
  broadcast(obj) {
    const data = JSON.stringify(obj);
    for (const ws of this.sockets()) send(ws, data);
  }
  broadcastRoom() { this.broadcast({ t: 'room', room: this.info() }); }
  broadcastState() { if (this.game) this.broadcast({ t: 'state', game: publicView(this.game) }); }

  addPlayer(name, bot = false) {
    if (this.game) fail('Game already started');
    if (this.players.length >= MAX_PLAYERS) fail('Room is full');
    const p = { id: crypto.randomBytes(6).toString('base64url'), name, bot, token: bot ? null : crypto.randomBytes(18).toString('base64url'), ws: null, connected: false, discAt: 0 };
    this.players.push(p);
    if (!bot && !this.hostId) this.hostId = p.id;
    return p;
  }

  start() {
    this.game = createGame({ players: this.players.map(({ id, name, bot }) => ({ id, name, bot })) });
    this.broadcastRoom();
    this.broadcastState();
    this.schedule();
  }

  act(pid, action) {
    try {
      applyAction(this.game, pid, action);
    } catch (e) {
      if (e instanceof GameError) fail(e.message);
      throw e;
    }
    this.broadcastState();
    this.schedule();
  }

  // Who should the server move for, and when? Bots, plus humans who have been gone too long.
  schedule() {
    clearTimeout(this.timer);
    this.timer = null;
    const g = this.game;
    if (!g || g.phase === 'ended') return;
    const now = Date.now();
    const auto = (pid) => {
      const p = this.players.find((x) => x.id === pid);
      if (p.bot) return BOT_DELAY;
      if (p.connected) return null;
      return Math.max(BOT_DELAY, DISCONNECT_GRACE - (now - p.discAt));
    };
    let pid, delay = null;
    if (g.phase === 'play') {
      pid = g.players[g.current].id;
      delay = auto(pid);
    } else {
      for (const gp of g.players) {
        if (gp.done) continue;
        const d = auto(gp.id);
        if (d !== null && (delay === null || d < delay)) { delay = d; pid = gp.id; }
      }
    }
    if (delay === null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.game !== g) return;
      const p = this.players.find((x) => x.id === pid);
      // Disconnected humans in the final phase just stop; we don't spend their pieces.
      const a = !p.bot && g.phase === 'final' ? { type: 'finalDone' } : chooseAction(g, pid);
      if (!a) return;
      try { this.act(pid, a); } catch (e) { console.error('auto move failed', e); }
    }, delay);
  }

  dispose() { clearTimeout(this.timer); }
}

export class Rooms {
  constructor() { this.map = new Map(); }

  newCode() {
    for (;;) {
      let c = '';
      for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
      if (!this.map.has(c)) return c;
    }
  }

  get(code) {
    const r = this.map.get(String(code || '').toUpperCase().trim());
    if (!r) fail('Room not found');
    return r;
  }

  attach(ws, room, player) {
    this.detach(ws);
    if (player) {
      if (player.ws && player.ws !== ws) {
        send(player.ws, { t: 'kicked', msg: 'Opened in another tab' });
        player.ws.room = null;
        player.ws.close(4000, 'replaced');
      }
      player.ws = ws;
      player.connected = true;
    } else {
      room.spectators.add(ws);
    }
    ws.room = room;
    ws.pid = player ? player.id : null;
    send(ws, { t: 'welcome', code: room.code, pid: ws.pid, token: player ? player.token : null });
    room.broadcastRoom();
    if (room.game) send(ws, { t: 'state', game: publicView(room.game) });
    room.schedule();
  }

  // Socket gone, player keeps their seat (can resume with token).
  detach(ws) {
    const room = ws.room;
    if (!room) return;
    ws.room = null;
    room.spectators.delete(ws);
    const p = room.players.find((x) => x.id === ws.pid);
    if (p && p.ws === ws) {
      p.ws = null;
      p.connected = false;
      p.discAt = Date.now();
    }
    room.broadcastRoom();
    room.schedule();
  }

  disconnect(ws) { this.detach(ws); }

  handle(ws, msg) {
    const room = ws.room;
    if (room) room.lastActive = Date.now();
    switch (msg.t) {
      case 'create': {
        if (this.map.size >= MAX_ROOMS) fail('Server is busy, try again later');
        const r = new Room(this.newCode());
        this.map.set(r.code, r);
        return this.attach(ws, r, r.addPlayer(cleanName(msg.name)));
      }
      case 'join': {
        const r = this.get(msg.code);
        r.lastActive = Date.now();
        if (r.game || r.players.length >= MAX_PLAYERS) return this.attach(ws, r, null); // spectate
        return this.attach(ws, r, r.addPlayer(cleanName(msg.name)));
      }
      case 'resume': {
        const r = this.map.get(String(msg.code || '').toUpperCase());
        const p = r && msg.token && r.players.find((x) => x.token === msg.token);
        if (!p) return send(ws, { t: 'resumeFailed' });
        r.lastActive = Date.now();
        return this.attach(ws, r, p);
      }
      case 'ping': return send(ws, { t: 'pong' });
    }

    if (!room) fail('Not in a room');
    const isHost = ws.pid && ws.pid === room.hostId;
    switch (msg.t) {
      case 'leave': {
        const pid = ws.pid;
        this.detach(ws);
        if (!room.game && pid) this.removePlayer(room, pid);
        return;
      }
      case 'addBot': {
        if (!isHost) fail('Only the host can add bots');
        const used = new Set(room.players.map((p) => p.name));
        room.addPlayer(BOT_NAMES.find((n) => !used.has(n + ' (bot)')) + ' (bot)', true);
        return room.broadcastRoom();
      }
      case 'kick': {
        if (!isHost) fail('Only the host can remove players');
        if (room.game) fail('Game already started');
        if (msg.pid === room.hostId) fail("Can't remove the host");
        const p = room.players.find((x) => x.id === msg.pid);
        if (!p) return;
        if (p.ws) { send(p.ws, { t: 'kicked', msg: 'Removed by host' }); p.ws.room = null; }
        return this.removePlayer(room, p.id);
      }
      case 'start': {
        if (!isHost) fail('Only the host can start');
        if (room.game) fail('Already started');
        return room.start();
      }
      case 'restart': {
        if (!isHost) fail('Only the host can restart');
        if (!room.game || room.game.phase !== 'ended') fail('Game still running');
        return room.start();
      }
      case 'act': {
        if (!room.game) fail('Game has not started');
        if (!ws.pid) fail('Spectators cannot play');
        return room.act(ws.pid, msg.a);
      }
      case 'chat': {
        const text = String(msg.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
        const p = room.players.find((x) => x.id === ws.pid);
        if (!text) return;
        return room.broadcast({ t: 'chat', name: p ? p.name : 'Spectator', text });
      }
      default: fail('Unknown message');
    }
  }

  removePlayer(room, pid) {
    room.players = room.players.filter((p) => p.id !== pid);
    if (room.hostId === pid) room.hostId = (room.players.find((p) => !p.bot) || {}).id || null;
    if (!room.hostId) { room.dispose(); this.map.delete(room.code); return; }
    room.broadcastRoom();
  }

  gc() {
    const now = Date.now();
    for (const [code, r] of this.map) {
      const online = r.sockets().length > 0;
      if (!online && now - r.lastActive > (r.game ? IDLE_TTL : IDLE_TTL / 3)) {
        r.dispose();
        this.map.delete(code);
      }
    }
  }
}

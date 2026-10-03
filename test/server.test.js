import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 3900 + Math.floor(Math.random() * 90);
let proc;

before(async () => {
  proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe' });
  await new Promise((res, rej) => {
    proc.stdout.on('data', (d) => String(d).includes('listening') && res());
    proc.on('exit', rej);
  });
});
after(() => proc.kill());

function client() {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].res(m); else inbox.push(m);
  });
  return {
    ws,
    open: () => new Promise((r) => ws.once('open', r)),
    send: (m) => ws.send(JSON.stringify(m)),
    next(pred, ms = 3000) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((res, rej) => {
        waiters.push({ pred, res });
        setTimeout(() => rej(new Error('timeout')), ms);
      });
    },
  };
}

test('healthz and static files are served compressed', async () => {
  const h = await fetch(`http://localhost:${PORT}/healthz`);
  assert.equal(await h.text(), 'ok');
  const r = await fetch(`http://localhost:${PORT}/shared/engine.js`, { headers: { 'accept-encoding': 'br' } });
  assert.equal(r.status, 200);
  assert.ok(r.headers.get('etag'));
  const r2 = await fetch(`http://localhost:${PORT}/?room=ABCD`);
  assert.match(await r2.text(), /Project L/);
});

test('create, join, add bot, start, play and resume', async () => {
  const a = client(); await a.open();
  a.send({ t: 'create', name: 'Alice' });
  const wa = await a.next((m) => m.t === 'welcome');
  assert.equal(wa.code.length, 4);

  const b = client(); await b.open();
  b.send({ t: 'join', code: wa.code.toLowerCase(), name: 'Bob' });
  const wb = await b.next((m) => m.t === 'welcome');
  assert.ok(wb.token);

  b.send({ t: 'start' });
  assert.match((await b.next((m) => m.t === 'error')).msg, /host/);

  a.send({ t: 'addBot' });
  await a.next((m) => m.t === 'room' && m.room.players.length === 3);
  a.send({ t: 'start' });
  const st = await a.next((m) => m.t === 'state');
  assert.equal(st.game.players.length, 3);
  assert.equal(typeof st.game.decks.black, 'number', 'deck order must stay hidden');

  // Whoever is up takes a level-1 piece (bots move on their own).
  const turnOf = (g) => g.players[g.current].id;
  let g = st.game;
  while (turnOf(g) !== wa.pid && turnOf(g) !== wb.pid) g = (await a.next((m) => m.t === 'state', 5000)).game;
  const mover = turnOf(g) === wa.pid ? a : b;
  const other = mover === a ? b : a;
  other.send({ t: 'act', a: { type: 'takePiece' } });
  assert.match((await other.next((m) => m.t === 'error')).msg, /turn/);
  mover.send({ t: 'act', a: { type: 'takePiece' } });
  const after = await a.next((m) => m.t === 'state' && m.game.version === g.version + 1);
  assert.equal(after.game.actionsLeft, 2);

  // Bob drops and resumes with his token.
  b.ws.close();
  await a.next((m) => m.t === 'room' && m.room.players.some((p) => p.id === wb.pid && !p.connected));
  const b2 = client(); await b2.open();
  b2.send({ t: 'resume', code: wb.code, token: wb.token });
  assert.equal((await b2.next((m) => m.t === 'welcome')).pid, wb.pid);
  await b2.next((m) => m.t === 'state');

  // Late joiner becomes a spectator.
  const c = client(); await c.open();
  c.send({ t: 'join', code: wa.code, name: 'Carol' });
  assert.equal((await c.next((m) => m.t === 'welcome')).pid, null);

  for (const x of [a, b2, c]) x.ws.close();
});

test('bad resume token is rejected', async () => {
  const a = client(); await a.open();
  a.send({ t: 'resume', code: 'ZZZZ', token: 'nope' });
  await a.next((m) => m.t === 'resumeFailed');
  a.ws.close();
});

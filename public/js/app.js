import { createBoard } from './board.js';
import { createGame, applyAction, publicView } from '/shared/engine.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const screens = ['home', 'lobby', 'offline', 'play'];
function show(id) {
  for (const s of screens) $('#' + s).classList.toggle('hidden', s !== id);
  document.body.dataset.screen = id;
}

let toastTimer;
function toast(msg) {
  if (board) return board.toast(msg);
  const t = $('#home-toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3000);
}

const nameInput = $('#name');
nameInput.value = store.get('pl.name') || '';
const getName = () => {
  const n = nameInput.value.trim().slice(0, 16) || 'Player';
  store.set('pl.name', n);
  return n;
};

let board = null;
function mountBoard(api) {
  if (board) board.destroy();
  board = createBoard($('#play'), api);
  show('play');
  return board;
}
function unmountBoard() {
  if (board) board.destroy();
  board = null;
}

async function share(code) {
  const url = `${location.origin}/?room=${code}`;
  try {
    if (navigator.share) await navigator.share({ title: 'Project L', text: `Join my Project L game: ${code}`, url });
    else { await navigator.clipboard.writeText(url); toast('Invite link copied'); }
  } catch { /* user cancelled */ }
}

// ====================================================================== online

const net = {
  ws: null, queue: [], retry: 0, wanted: false, code: null, pid: null, room: null, game: null,

  connect() {
    this.wanted = true;
    if (this.ws && this.ws.readyState <= 1) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      $('#conn').classList.add('hidden');
      const sess = store.get('pl.session');
      if (sess && !this.queue.some((m) => m.t === 'create' || m.t === 'join')) ws.send(JSON.stringify({ t: 'resume', ...sess }));
      for (const m of this.queue.splice(0)) ws.send(JSON.stringify(m));
    };
    ws.onmessage = (e) => onNet(JSON.parse(e.data));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.wanted) return;
      // Render's free tier can take ~30s to wake; keep retrying with backoff.
      if (this.code) $('#conn').classList.remove('hidden');
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.wanted && this.connect(), delay);
    };
  },
  send(m) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m));
    else { this.queue.push(m); this.connect(); }
  },
  reset() {
    this.code = this.pid = this.room = this.game = null;
    store.set('pl.session', null);
  },
};

// Phones suspend background tabs; reconnect as soon as we come back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && net.wanted && (!net.ws || net.ws.readyState > 1)) { net.retry = 0; net.connect(); }
});

function onlineMeta() {
  return { online: true, code: net.code, players: net.room ? net.room.players : [] };
}

function onNet(m) {
  switch (m.t) {
    case 'welcome':
      net.code = m.code;
      net.pid = m.pid;
      if (m.token) store.set('pl.session', { code: m.code, token: m.token });
      history.replaceState(null, '', `/?room=${m.code}`);
      break;
    case 'resumeFailed':
      net.reset();
      if (document.body.dataset.screen !== 'home') { unmountBoard(); show('home'); toast('That game has ended'); }
      break;
    case 'room':
      net.room = m.room;
      if (!m.room.started) { unmountBoard(); renderLobby(); show('lobby'); }
      else if (board) board.setMeta(onlineMeta());
      break;
    case 'state':
      net.game = m.game;
      if (!board) {
        mountBoard({
          send: (a) => net.send({ t: 'act', a }),
          chat: (text) => net.send({ t: 'chat', text }),
          leave: leaveOnline,
          restart: () => net.send({ t: 'restart' }),
          canRestart: () => net.room && net.pid === net.room.hostId,
          share: () => share(net.code),
        });
      }
      board.update(m.game, net.pid, onlineMeta());
      break;
    case 'chat':
      if (board) board.chat(m.name, m.text);
      break;
    case 'error':
      toast(m.msg);
      break;
    case 'kicked':
      net.reset();
      unmountBoard();
      show('home');
      toast(m.msg);
      break;
  }
}

function leaveOnline() {
  net.send({ t: 'leave' });
  net.reset();
  unmountBoard();
  history.replaceState(null, '', '/');
  show('home');
}

function renderLobby() {
  const r = net.room;
  const host = net.pid === r.hostId;
  $('#lobby-code').textContent = r.code;
  $('#lobby-players').innerHTML = r.players.map((p) => `<li class="${p.connected ? '' : 'off'}">
      <span>${p.bot ? '🤖' : '👤'} ${esc(p.name)}${p.id === r.hostId ? ' <small>host</small>' : ''}${p.id === net.pid ? ' <small>you</small>' : ''}</span>
      ${host && p.id !== r.hostId ? `<button class="icon-btn" data-kick="${esc(p.id)}" aria-label="Remove">✕</button>` : ''}
    </li>`).join('') + (r.spectators ? `<li class="muted">${r.spectators} watching</li>` : '');
  $('#lobby-add').classList.toggle('hidden', !host || r.players.length >= 4);
  $('#lobby-start').classList.toggle('hidden', !host);
  $('#lobby-wait').classList.toggle('hidden', host);
  $('#lobby-hint').textContent = r.players.length < 2 ? 'Share the code with friends or add bots.' : `${r.players.length}/4 players`;
}

$('#create').addEventListener('click', () => { net.reset(); net.send({ t: 'create', name: getName() }); });
$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('#code').value.trim().toUpperCase();
  if (code.length !== 4) return toast('Enter the 4-letter room code');
  net.reset();
  net.send({ t: 'join', code, name: getName() });
});
$('#code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
$('#lobby-add').addEventListener('click', () => net.send({ t: 'addBot' }));
$('#lobby-start').addEventListener('click', () => net.send({ t: 'start' }));
$('#lobby-leave').addEventListener('click', leaveOnline);
$('#lobby-share').addEventListener('click', () => share(net.code));
$('#lobby-players').addEventListener('click', (e) => {
  const b = e.target.closest('[data-kick]');
  if (b) net.send({ t: 'kick', pid: b.dataset.kick });
});

// ====================================================================== offline

let seats = [];
function renderSeats() {
  $('#seats').innerHTML = seats.map((s, i) => `<li>
    <span>${s.bot ? '🤖' : '👤'} ${esc(s.name)}</span>
    ${i ? `<button class="icon-btn" data-seat="${i}" aria-label="Remove">✕</button>` : '<small>you</small>'}</li>`).join('');
  $('#add-bot').disabled = $('#add-human').disabled = seats.length >= 4;
}
$('#offline-btn').addEventListener('click', () => {
  seats = [{ name: getName(), bot: false }, { name: 'Ada (bot)', bot: true }];
  renderSeats();
  show('offline');
});
const BOTS = ['Ada', 'Turing', 'Hopper', 'Knuth'];
$('#add-bot').addEventListener('click', () => {
  seats.push({ name: BOTS.find((n) => !seats.some((s) => s.name.startsWith(n))) + ' (bot)', bot: true });
  renderSeats();
});
$('#add-human').addEventListener('click', () => {
  seats.push({ name: 'Player ' + (seats.filter((s) => !s.bot).length + 1), bot: false });
  renderSeats();
});
$('#seats').addEventListener('click', (e) => {
  const b = e.target.closest('[data-seat]');
  if (b) { seats.splice(+b.dataset.seat, 1); renderSeats(); }
});
$('#offline-back').addEventListener('click', () => show('home'));
$('#offline-start').addEventListener('click', () => {
  seats[0].name = getName();
  const players = seats.map((s, i) => ({ id: 'L' + i, name: s.name, bot: s.bot }));
  startLocal(createGame({ players }));
});
$('#resume-offline').addEventListener('click', () => {
  const saved = store.get('pl.offline');
  if (saved) startLocal(saved);
});

let local = null;
async function startLocal(game) {
  const { chooseAction } = await import('/shared/bot.js'); // only offline needs the bot in the browser
  if (local) clearTimeout(local.timer);
  local = { game, timer: null, viewer: null };
  const humans = () => local.game.players.filter((p) => !p.bot);
  const actor = () => {
    const g = local.game;
    if (g.phase === 'play') { const p = g.players[g.current]; return p.bot ? null : p; }
    if (g.phase === 'final') return humans().find((p) => !p.done) || null;
    return null;
  };

  const b = mountBoard({
    send(a) {
      const p = actor();
      if (!p) return;
      try { applyAction(local.game, p.id, a); } catch (e) { b.toast(e.message); }
      tick();
    },
    chat: null,
    leave() { clearTimeout(local.timer); local = null; unmountBoard(); show('home'); refreshHome(); },
    restart() {
      const players = local.game.players.map(({ id, name, bot }) => ({ id, name, bot }));
      local.game = createGame({ players });
      local.viewer = null;
      tick();
    },
    canRestart: () => true,
    share() {},
  });

  function botStep() {
    const g = local.game;
    const p = g.phase === 'play' ? g.players[g.current] : g.players.find((x) => x.bot && !x.done);
    if (!p || !p.bot) return;
    const a = chooseAction(g, p.id);
    if (a) applyAction(g, p.id, a);
    tick();
  }

  function tick() {
    const g = local.game;
    clearTimeout(local.timer);
    const a = actor();
    if (a) {
      if (local.viewer && local.viewer !== a.id && humans().length > 1) b.toast(`Pass the device to ${a.name}`);
      local.viewer = a.id;
    } else if (!local.viewer) local.viewer = (humans()[0] || g.players[0]).id;
    const botPending = (g.phase === 'play' && g.players[g.current].bot) || (g.phase === 'final' && g.players.some((p) => p.bot && !p.done));
    if (botPending) local.timer = setTimeout(botStep, g.phase === 'final' ? 250 : 600);
    // Clone like the network would, so the board sees a fresh object each time.
    b.update(JSON.parse(JSON.stringify(publicView(g))), local.viewer, { online: false });
    store.set('pl.offline', g.phase === 'ended' ? null : g);
  }
  tick();
}

function refreshHome() {
  $('#resume-offline').classList.toggle('hidden', !store.get('pl.offline'));
}

// ====================================================================== boot

const params = new URLSearchParams(location.search);
const roomParam = (params.get('room') || '').toUpperCase().slice(0, 4);
const sess = store.get('pl.session');
refreshHome();
if (sess && (!roomParam || roomParam === sess.code)) {
  // Rejoin the game we were in (refresh, phone killed the tab, etc.)
  show('home');
  net.connect();
} else {
  if (roomParam) {
    $('#code').value = roomParam;
    if (sess) store.set('pl.session', null);
    toast(`Enter your name and tap Join for room ${roomParam}`);
  }
  show('home');
}


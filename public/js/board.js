// Game board UI. Renders a public game view and turns taps/clicks into engine actions.
import { GRID, SHAPES, SHAPE_KEYS, level, rotate, flip, normalize, checkPlacement, canPass, MAX_PUZZLES } from '/shared/engine.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NORM = Object.fromEntries(SHAPE_KEYS.map((k) => [k, normalize(SHAPES[k])]));

export function pieceHTML(shape, cells = NORM[shape], extra = '') {
  let w = 0, h = 0;
  for (const [x, y] of cells) { if (x >= w) w = x + 1; if (y >= h) h = y + 1; }
  const on = new Set(cells.map(([x, y]) => y * w + x));
  let s = `<span class="pc ${extra}" style="--w:${w}">`;
  for (let i = 0; i < w * h; i++) s += on.has(i) ? `<i class="s-${shape}"></i>` : '<i></i>';
  return s + '</span>';
}

// Build cell markup for a puzzle. `extra` = pending placements drawn on top.
function gridHTML(pz, extra = []) {
  const fill = pz.fill.slice();
  const shapes = pz.placed.map((p) => p.shape);
  const pend = new Set();
  for (const pl of extra) {
    const k = shapes.push(pl.shape) - 1;
    pend.add(k);
    for (const [x, y] of pl.cells) fill[y * GRID + x] = k;
  }
  let s = '';
  for (let i = 0; i < GRID * GRID; i++) {
    if (pz.mask[i] !== '#') { s += '<i class="off"></i>'; continue; }
    const f = fill[i];
    if (f === null) { s += `<i class="e" data-i="${i}"></i>`; continue; }
    const x = i % GRID, y = (i / GRID) | 0;
    let c = `f s-${shapes[f]}`;
    if (y === 0 || fill[i - GRID] !== f) c += ' bt';
    if (x === GRID - 1 || fill[i + 1] !== f) c += ' br';
    if (y === GRID - 1 || fill[i + GRID] !== f) c += ' bb';
    if (x === 0 || fill[i - 1] !== f) c += ' bl';
    if (pend.has(f)) c += ' pend';
    s += `<i class="${c}" data-i="${i}"></i>`;
  }
  return s;
}

function puzzleHTML(pz, { cls = '', extra = [], attrs = '', after = '' } = {}) {
  return `<div class="pz ${pz.color} ${cls}" ${attrs}>
    <div class="pz-grid">${gridHTML(pz, extra)}</div>
    <div class="pz-meta"><b class="pts">${pz.points}</b>${pieceHTML(pz.reward, undefined, 'reward')}</div>${after}
  </div>`;
}

const RULES = `
<h3>Goal</h3><p>Score the most points by completing puzzles with your pieces.</p>
<h3>Your turn: 3 actions</h3>
<ul>
<li><b>Take a puzzle</b> from the market or a pile (max ${MAX_PUZZLES}).</li>
<li><b>Take a level-1 piece</b> (single square).</li>
<li><b>Upgrade</b>: return a piece, take one up to one level higher (or swap for one at the same or a lower level).</li>
<li><b>Place</b> a piece into one of your puzzles.</li>
<li><b>Master action</b> (once per turn): place one piece into <i>each</i> of your puzzles.</li>
</ul>
<p>The same action may be used several times in a turn (except Master).</p>
<h3>Completing a puzzle</h3><p>Score its points, get all its pieces back, plus the reward piece shown on the card.</p>
<h3>Game end</h3><p>When the black pile runs out, finish the round and play one more. Then everyone may place leftover pieces (−1 point each) to finish puzzles. Unfinished puzzles subtract their points.</p>
<h3>Controls</h3><p>Pick a piece, then tap your puzzle to preview and tap again (or ✓) to place. Rotate with ⟳ / <kbd>R</kbd> / right-click, flip with ⇋ / <kbd>F</kbd>. <kbd>Esc</kbd> cancels.</p>`;

export function createBoard(root, api) {
  root.innerHTML = `
  <div class="game">
    <header class="topbar">
      <button class="icon-btn" data-ui="menu" aria-label="Menu">☰</button>
      <div class="status"><div class="status-main"></div><div class="status-sub"></div></div>
      <button class="icon-btn" data-ui="side" aria-label="Log and chat">💬<span class="dot hidden"></span></button>
    </header>
    <main class="board">
      <section class="opps"></section>
      <section class="market"></section>
      <section class="mine"><div class="sec-h"><h2>Your puzzles</h2><span class="my-score"></span></div><div class="my-puzzles"></div></section>
    </main>
    <aside class="side">
      <div class="side-h"><b>Game</b><button class="icon-btn only-mobile" data-ui="side-close" aria-label="Close">✕</button></div>
      <div class="supply"></div>
      <div class="log" aria-live="polite"></div>
      <form class="chat hidden"><input maxlength="200" placeholder="Say something…" aria-label="Chat message"><button>Send</button></form>
    </aside>
    <footer class="dock">
      <div class="hint"></div>
      <div class="tray"></div>
      <div class="controls"></div>
    </footer>
    <div class="sheet-wrap hidden"><div class="sheet"><div class="sheet-body"></div></div></div>
    <div class="toast hidden"></div>
  </div>`;

  const $ = (sel) => root.querySelector(sel);
  const el = {
    game: $('.game'), statusMain: $('.status-main'), statusSub: $('.status-sub'),
    opps: $('.opps'), market: $('.market'), mine: $('.my-puzzles'), myScore: $('.my-score'),
    side: $('.side'), supply: $('.supply'), log: $('.log'), chat: $('.chat'), chatDot: $('[data-ui="side"] .dot'),
    hint: $('.hint'), tray: $('.tray'), controls: $('.controls'),
    sheetWrap: $('.sheet-wrap'), sheet: $('.sheet-body'), toast: $('.toast'),
  };

  let g = null, you = null, meta = {};
  let sel = null; // { shape, cells }
  let mode = 'idle'; // 'idle' | 'upgrade' | 'master'
  let pending = []; // master placements { puzzle, shape, cells }
  let preview = null; // { puzzle, cells, ok, hx, hy }
  let marketSel = null; // 'white:0' etc
  let sheetKind = null;
  let lastVersion = -1;
  let rafQueued = false;
  let toastTimer = null;
  let logKey = '';

  const me = () => g && g.players.find((p) => p.id === you);
  const myTurn = () => g && g.phase === 'play' && g.players[g.current].id === you;
  const placing = () => (g && g.phase === 'final' && me() && !me().done) || myTurn();
  const avail = (shape) => (me()?.pieces[shape] || 0) - pending.filter((p) => p.shape === shape).length;

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 2600);
  }

  function send(a) {
    resetSelection();
    api.send(a);
  }

  function resetSelection() {
    mode = 'idle'; pending = []; preview = null; marketSel = null;
    if (sel && avail(sel.shape) <= 0) sel = null;
  }

  // ------------------------------------------------------------ rendering

  function schedule() {
    if (rafQueued) return;
    rafQueued = true;
    requestAnimationFrame(() => { rafQueued = false; render(); });
  }

  function render() {
    if (!g) return;
    const m = me();
    const cur = g.players[g.current];
    // status
    if (g.phase === 'ended') {
      el.statusMain.textContent = 'Game over';
      el.statusSub.textContent = 'Winner: ' + g.players.find((p) => p.id === g.ranking[0]).name;
    } else if (g.phase === 'final') {
      el.statusMain.textContent = 'Final phase';
      el.statusSub.textContent = m && !m.done ? 'Finish puzzles (−1 per piece)' : 'Waiting for others…';
    } else {
      el.statusMain.innerHTML = myTurn()
        ? `Your turn <span class="pips">${'●'.repeat(g.actionsLeft)}${'○'.repeat(3 - g.actionsLeft)}</span>`
        : `${esc(cur.name)}'s turn <span class="pips">${'●'.repeat(g.actionsLeft)}${'○'.repeat(3 - g.actionsLeft)}</span>`;
      el.statusSub.textContent = `Round ${g.round}${g.endRound !== null ? (g.round > g.endRound ? ' · final round' : ' · last rounds') : ''} · ${g.decks.black} black left`;
    }
    el.game.classList.toggle('my-turn', myTurn());
    document.title = (myTurn() ? '● ' : '') + 'Project L';

    renderOpps();
    renderMarket();
    renderMine();
    renderDock();
    renderSide();
    if (g.phase === 'ended' && sheetKind !== 'results' && sheetKind !== 'dismissed-results') openResults();
  }

  function renderOpps() {
    const conn = new Map((meta.players || []).map((p) => [p.id, p.connected]));
    el.opps.innerHTML = g.players.map((p, i) => {
      const pieces = SHAPE_KEYS.reduce((a, k) => a + p.pieces[k], 0);
      const isCur = g.phase === 'play' && i === g.current;
      const off = meta.online && conn.get(p.id) === false;
      return `<button class="opp${isCur ? ' cur' : ''}${p.id === you ? ' me' : ''}${off ? ' off' : ''}" data-opp="${esc(p.id)}">
        <span class="opp-name">${esc(p.name)}${p.id === you ? ' (you)' : ''}</span>
        <span class="opp-stats"><b>★ ${g.phase === 'ended' ? p.final : p.score}</b> · ${p.puzzles.length}🧩 · ${pieces}◼${p.done && g.phase === 'final' ? ' · ✓' : ''}</span>
      </button>`;
    }).join('');
  }

  function renderMarket() {
    const canTake = myTurn() && me().puzzles.length < MAX_PUZZLES;
    let s = '';
    for (const color of ['white', 'black']) {
      s += `<div class="row ${color}"><div class="row-h">${color === 'white' ? 'White' : 'Black'} puzzles</div><div class="row-cards">`;
      const n = g.decks[color];
      const dk = color + ':deck';
      s += `<div class="pz deck ${color}${marketSel === dk ? ' sel' : ''}${n ? '' : ' empty'}" data-take="${dk}">
        <div class="deck-n">${n}</div><div class="deck-l">pile</div>
        ${marketSel === dk ? `<button class="take" data-confirm="${dk}" ${canTake ? '' : 'disabled'}>Take blind</button>` : ''}</div>`;
      g.market[color].forEach((pz, i) => {
        const k = color + ':' + i;
        s += puzzleHTML(pz, {
          cls: 'mk' + (marketSel === k ? ' sel' : ''),
          attrs: `data-take="${k}"`,
          after: marketSel === k ? `<button class="take" data-confirm="${k}" ${canTake ? '' : 'disabled'}>Take</button>` : '',
        });
      });
      s += '</div></div>';
    }
    el.market.innerHTML = s;
  }

  function renderMine() {
    const m = me();
    if (!m) {
      el.mine.innerHTML = '<p class="muted">You are spectating.</p>';
      el.myScore.textContent = '';
      return;
    }
    el.myScore.textContent = `★ ${m.score}${m.penalty ? ` (−${m.penalty})` : ''} · ${m.completed.length} done`;
    let s = '';
    for (let i = 0; i < MAX_PUZZLES; i++) {
      const pz = m.puzzles[i];
      if (!pz) { s += '<div class="pz slot"><span>Empty slot</span></div>'; continue; }
      s += puzzleHTML(pz, {
        cls: 'own' + (pending.some((p) => p.puzzle === i) ? ' has-pend' : ''),
        extra: pending.filter((p) => p.puzzle === i),
        attrs: `data-own="${i}"`,
      });
    }
    el.mine.innerHTML = s;
    el.mine.classList.toggle('targeting', !!sel && placing());
    if (preview) drawPreview();
  }

  function renderDock() {
    const m = me();
    if (!m) { el.tray.innerHTML = ''; el.controls.innerHTML = ''; el.hint.textContent = 'Spectating'; return; }
    // tray
    el.tray.innerHTML = SHAPE_KEYS.filter((k) => m.pieces[k] > 0).map((k) => {
      const n = avail(k);
      const isSel = sel && sel.shape === k;
      return `<button class="tp${isSel ? ' sel' : ''}${n <= 0 ? ' used' : ''}" data-piece="${k}" aria-label="Piece ${k}, ${n} available">
        ${pieceHTML(k, isSel ? sel.cells : undefined)}<span class="cnt">${n}</span></button>`;
    }).join('') || '<span class="muted">No pieces</span>';

    // controls + hint
    const b = (ui, label, { dis = false, cls = '' } = {}) => `<button class="btn ${cls}" data-ui="${ui}" ${dis ? 'disabled' : ''}>${label}</button>`;
    let c = '', hint = '';
    if (sel && placing()) {
      c += b('rot', '⟳', { cls: 'sq' }) + b('flip', '⇋', { cls: 'sq' }) + b('desel', '✕', { cls: 'sq' });
      if (preview && preview.ok && preview.touch) c += b('place', '✓ Place', { cls: 'primary' });
    }
    if (g.phase === 'ended') {
      hint = 'Game over';
      c = b('results', 'Results', { cls: 'primary' });
    } else if (g.phase === 'final') {
      if (m.done) hint = 'Waiting for the other players to finish…';
      else {
        hint = sel ? 'Place to finish a puzzle — each piece costs 1 point' : 'Final phase: pick a piece to finish a puzzle, or tap Done';
        c += b('finalDone', 'Done', { cls: 'primary' });
      }
    } else if (!myTurn()) {
      hint = `Waiting for ${g.players[g.current].name}…`;
    } else if (mode === 'master') {
      hint = 'Master: add one piece to each puzzle you like, then confirm';
      c += b('masterGo', `Confirm (${pending.length})`, { cls: 'primary', dis: !pending.length }) + b('cancel', 'Cancel');
    } else if (mode === 'upgrade') {
      hint = 'Upgrade: tap the piece you want to return';
      c += b('cancel', 'Cancel');
    } else {
      hint = sel ? 'Tap a spot in your puzzle to place' : m.puzzles.length ? 'Pick a piece, take a puzzle, or choose an action' : 'Start by taking a puzzle from the market';
      if (!sel) {
        c += b('take1', '+1 ' + pieceHTML('1'), { dis: !(g.supply['1'] > 0) });
        c += b('upgrade', '⇧ Upgrade');
        c += b('master', '★ Master', { dis: g.masterUsed || !m.puzzles.length });
        if (canPass(g)) c += b('pass', 'Pass');
      }
    }
    el.hint.textContent = hint;
    el.controls.innerHTML = c;
  }

  function renderSide() {
    el.supply.innerHTML = '<div class="sec-h"><h3>Supply</h3></div><div class="sup-grid">' +
      SHAPE_KEYS.map((k) => `<div class="sup">${pieceHTML(k)}<span>${g.supply[k]}</span></div>`).join('') + '</div>';
    const key = g.log.length + '|' + (g.log[g.log.length - 1] || {}).m;
    if (key !== logKey) { logKey = key; appendLog(null, true); }
    el.chat.classList.toggle('hidden', !api.chat);
  }

  let logEntries = [];
  function appendLog(entries, fromGame) {
    if (fromGame) logEntries = logEntries.filter((e) => e.chat).concat(g.log.map((e) => ({ m: e.m })));
    else logEntries.push(...entries);
    logEntries = logEntries.slice(-80);
    el.log.innerHTML = logEntries.map((e) => e.chat ? `<p class="chatline"><b>${esc(e.name)}:</b> ${esc(e.text)}</p>` : `<p>${esc(e.m)}</p>`).join('');
    el.log.scrollTop = el.log.scrollHeight;
  }

  // ------------------------------------------------------------ preview

  function anchorOrder(cells) {
    const cx = cells.reduce((a, c) => a + c[0], 0) / cells.length;
    const cy = cells.reduce((a, c) => a + c[1], 0) / cells.length;
    return cells.slice().sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
  }

  function computePreview(pi, hx, hy) {
    const pz = me().puzzles[pi];
    if (!pz || !sel) return null;
    if (mode === 'master' && pending.some((p) => p.puzzle === pi)) return { puzzle: pi, cells: [[hx, hy]], ok: false };
    let first = null;
    for (const [ax, ay] of anchorOrder(sel.cells)) {
      const cells = sel.cells.map(([x, y]) => [x - ax + hx, y - ay + hy]);
      if (!first) first = cells;
      if (!checkPlacement(pz, sel.shape, cells)) return { puzzle: pi, cells, ok: true, hx, hy };
    }
    return { puzzle: pi, cells: first, ok: false, hx, hy };
  }

  function clearPreviewCells() {
    for (const c of el.mine.querySelectorAll('.g-ok, .g-bad')) c.className = c.dataset.cls;
  }

  function drawPreview() {
    clearPreviewCells();
    if (!preview) return;
    const card = el.mine.querySelector(`[data-own="${preview.puzzle}"] .pz-grid`);
    if (!card) return;
    for (const [x, y] of preview.cells) {
      if (x < 0 || y < 0 || x >= GRID || y >= GRID) continue;
      const c = card.children[y * GRID + x];
      if (!c.dataset.cls) c.dataset.cls = c.className;
      c.className = c.dataset.cls + (preview.ok ? ` g-ok s-${sel.shape}` : ' g-bad');
    }
  }

  function setPreview(p, touch = false) {
    const had = preview && preview.ok && preview.touch;
    preview = p ? { ...p, touch } : null;
    drawPreview();
    if (had !== !!(preview && preview.ok && preview.touch)) renderDock();
  }

  function commitPreview() {
    if (!preview || !preview.ok || !sel) return;
    const pl = { puzzle: preview.puzzle, shape: sel.shape, cells: preview.cells };
    if (mode === 'master') {
      pending.push(pl);
      preview = null;
      if (avail(sel.shape) <= 0) sel = null;
      renderMine(); renderDock();
      return;
    }
    send({ type: g.phase === 'final' ? 'finalPlace' : 'place', ...pl });
  }

  function selectPiece(shape) {
    if (sel && sel.shape === shape) { sel = null; preview = null; }
    else if (avail(shape) > 0) sel = { shape, cells: NORM[shape] };
    preview = null;
    renderDock(); renderMine();
  }

  function transformSel(fn) {
    if (!sel) return;
    sel = { ...sel, cells: fn(sel.cells) };
    if (preview && preview.hx !== undefined) {
      const touch = preview.touch;
      preview = computePreview(preview.puzzle, preview.hx, preview.hy);
      if (preview) preview.touch = touch;
    }
    renderDock(); drawPreview();
  }

  // ------------------------------------------------------------ sheets

  function openSheet(kind, html) {
    sheetKind = kind;
    el.sheet.innerHTML = html;
    el.sheetWrap.classList.remove('hidden');
  }
  function closeSheet() {
    if (sheetKind === 'results') sheetKind = 'dismissed-results';
    else sheetKind = null;
    el.sheetWrap.classList.add('hidden');
    if (mode === 'upgrade') { mode = 'idle'; renderDock(); }
  }

  function openUpgrade(from) {
    const opts = SHAPE_KEYS.filter((k) => k !== from && level(k) <= level(from) + 1);
    openSheet('upgrade', `<h2>Upgrade ${pieceHTML(from)}</h2><p class="muted">Return it and take one of these:</p>
      <div class="choice-grid">${opts.map((k) => `<button class="choice" data-upto="${k}" data-from="${from}" ${g.supply[k] > 0 ? '' : 'disabled'}>
        ${pieceHTML(k)}<span>Lv ${level(k)} · ${g.supply[k]} left</span></button>`).join('')}</div>
      <div class="sheet-actions"><button class="btn" data-ui="close">Cancel</button></div>`);
  }

  function openPlayer(pid) {
    const p = g.players.find((x) => x.id === pid);
    if (!p) return;
    openSheet('player', `<h2>${esc(p.name)}</h2>
      <p class="muted">★ ${p.score} · ${p.completed.length} completed${p.penalty ? ` · −${p.penalty} final` : ''}</p>
      <div class="sec-h"><h3>Pieces</h3></div>
      <div class="sup-grid">${SHAPE_KEYS.filter((k) => p.pieces[k]).map((k) => `<div class="sup">${pieceHTML(k)}<span>×${p.pieces[k]}</span></div>`).join('') || '<span class="muted">None</span>'}</div>
      <div class="sec-h"><h3>Puzzles</h3></div>
      <div class="opp-puzzles">${p.puzzles.map((pz) => puzzleHTML(pz)).join('') || '<span class="muted">None</span>'}</div>
      <div class="sheet-actions"><button class="btn" data-ui="close">Close</button></div>`);
  }

  function openResults() {
    const rows = g.ranking.map((id, i) => {
      const p = g.players.find((x) => x.id === id);
      return `<tr class="${id === you ? 'me' : ''}"><td>${['🥇', '🥈', '🥉'][i] || i + 1}</td><td>${esc(p.name)}</td>
        <td>${p.score}</td><td>${p.penalty ? '−' + p.penalty : 0}</td><td>${p.unfinished ? '−' + p.unfinished : 0}</td><td><b>${p.final}</b></td></tr>`;
    }).join('');
    openSheet('results', `<h2>Results</h2>
      <table class="results"><thead><tr><th></th><th>Player</th><th>Points</th><th>Final</th><th>Unfin.</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="muted small">Ties go to the player with more completed puzzles.</p>
      <div class="sheet-actions">${api.canRestart() ? '<button class="btn primary" data-ui="restart">Play again</button>' : ''}
      <button class="btn" data-ui="leave">Leave</button><button class="btn" data-ui="close">View board</button></div>`);
  }

  function openMenu() {
    openSheet('menu', `<h2>Project L</h2>
      ${meta.code ? `<p>Room <b class="code">${esc(meta.code)}</b> <button class="btn small" data-ui="share">Share link</button></p>` : ''}
      <div class="rules">${RULES}</div>
      <div class="sheet-actions"><button class="btn danger" data-ui="leave">Leave game</button><button class="btn primary" data-ui="close">Back to game</button></div>`);
  }

  // ------------------------------------------------------------ events

  const isTouch = (e) => e.pointerType && e.pointerType !== 'mouse';

  el.mine.addEventListener('pointermove', (e) => {
    if (isTouch(e) || !sel || !placing()) return;
    const cell = e.target.closest('[data-i]');
    const card = e.target.closest('[data-own]');
    if (!cell || !card) return;
    const i = +cell.dataset.i;
    const pi = +card.dataset.own;
    if (preview && preview.puzzle === pi && preview.hx === i % GRID && preview.hy === ((i / GRID) | 0)) return;
    setPreview(computePreview(pi, i % GRID, (i / GRID) | 0));
  });
  el.mine.addEventListener('pointerleave', (e) => { if (!isTouch(e) && preview) setPreview(null); });

  el.mine.addEventListener('click', (e) => {
    const card = e.target.closest('[data-own]');
    if (!card) return;
    const pi = +card.dataset.own;
    const cell = e.target.closest('[data-i]');
    // Tap a pending master piece to take it back.
    if (mode === 'master' && cell && cell.classList.contains('pend')) {
      pending = pending.filter((p) => p.puzzle !== pi);
      renderMine(); renderDock();
      return;
    }
    if (!sel) {
      if (placing()) toast('Pick a piece from your tray first');
      return;
    }
    if (!placing() || !cell) return;
    const i = +cell.dataset.i;
    const hx = i % GRID, hy = (i / GRID) | 0;
    const touch = e.pointerType ? e.pointerType !== 'mouse' : matchMedia('(pointer: coarse)').matches;
    if (touch) {
      // First tap previews; tapping the preview again places it.
      const inPreview = preview && preview.puzzle === pi && preview.ok && preview.cells.some(([x, y]) => x === hx && y === hy);
      if (inPreview) return commitPreview();
      setPreview(computePreview(pi, hx, hy), true);
      if (preview && !preview.ok) toast("Doesn't fit there — try rotating");
    } else {
      if (!preview || preview.puzzle !== pi || preview.hx !== hx || preview.hy !== hy) setPreview(computePreview(pi, hx, hy));
      if (preview && preview.ok) commitPreview();
      else toast("Doesn't fit there");
    }
  });

  el.mine.addEventListener('contextmenu', (e) => { if (sel) { e.preventDefault(); transformSel(rotate); } });

  el.tray.addEventListener('click', (e) => {
    const b = e.target.closest('[data-piece]');
    if (!b) return;
    const shape = b.dataset.piece;
    if (mode === 'upgrade') return openUpgrade(shape);
    if (!placing()) return toast(g.phase === 'play' ? 'Wait for your turn' : 'You are done');
    selectPiece(shape);
  });

  el.market.addEventListener('click', (e) => {
    const conf = e.target.closest('[data-confirm]');
    if (conf) {
      const [color, idx] = conf.dataset.confirm.split(':');
      return send({ type: 'takePuzzle', color, index: idx === 'deck' ? 'deck' : +idx });
    }
    const card = e.target.closest('[data-take]');
    if (!card || card.classList.contains('empty')) return;
    const k = card.dataset.take;
    marketSel = marketSel === k ? null : k;
    if (marketSel && !myTurn()) toast('Wait for your turn to take puzzles');
    else if (marketSel && me().puzzles.length >= MAX_PUZZLES) toast(`You already hold ${MAX_PUZZLES} puzzles`);
    renderMarket();
  });

  el.opps.addEventListener('click', (e) => {
    const b = e.target.closest('[data-opp]');
    if (b) openPlayer(b.dataset.opp);
  });

  el.sheetWrap.addEventListener('click', (e) => {
    if (e.target === el.sheetWrap) return closeSheet();
    const up = e.target.closest('[data-upto]');
    if (up) { closeSheet(); return send({ type: 'upgrade', from: up.dataset.from, to: up.dataset.upto }); }
  });

  el.chat.addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = el.chat.querySelector('input');
    if (inp.value.trim() && api.chat) api.chat(inp.value.trim());
    inp.value = '';
  });

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ui]');
    if (!b || b.disabled) return;
    switch (b.dataset.ui) {
      case 'menu': return openMenu();
      case 'side': el.chatDot.classList.add('hidden'); return el.side.classList.toggle('open');
      case 'side-close': return el.side.classList.remove('open');
      case 'close': return closeSheet();
      case 'rot': return transformSel(rotate);
      case 'flip': return transformSel(flip);
      case 'desel': sel = null; preview = null; renderDock(); return renderMine();
      case 'place': return commitPreview();
      case 'take1': return send({ type: 'takePiece' });
      case 'pass': return send({ type: 'pass' });
      case 'upgrade': sel = null; preview = null; mode = 'upgrade'; renderDock(); return renderMine();
      case 'master': mode = 'master'; pending = []; renderDock(); return renderMine();
      case 'masterGo': return send({ type: 'master', placements: pending });
      case 'cancel': mode = 'idle'; pending = []; preview = null; renderDock(); return renderMine();
      case 'finalDone': return send({ type: 'finalDone' });
      case 'results': return openResults();
      case 'restart': closeSheet(); sheetKind = null; return api.restart();
      case 'leave': return api.leave();
      case 'share': return api.share();
    }
  });

  const onKey = (e) => {
    if (e.target.matches('input, textarea')) return;
    if (e.key === 'r' || e.key === 'R') transformSel(rotate);
    else if (e.key === 'f' || e.key === 'F') transformSel(flip);
    else if (e.key === 'Escape') {
      if (!el.sheetWrap.classList.contains('hidden')) return closeSheet();
      sel = null; preview = null; mode = 'idle'; pending = []; marketSel = null;
      schedule();
    }
  };
  document.addEventListener('keydown', onKey);

  return {
    update(game, youId, m = {}) {
      const turnChanged = !g || g.current !== game.current || g.phase !== game.phase;
      g = game; you = youId; meta = m;
      if (game.version !== lastVersion) {
        lastVersion = game.version;
        // Keep the selected piece across my own actions, drop transient modes.
        mode = 'idle'; pending = []; preview = null; marketSel = null;
        if (sel && avail(sel.shape) <= 0) sel = null;
        if (turnChanged && !placing()) sel = null;
        if (game.phase === 'play' && sheetKind === 'dismissed-results') sheetKind = null;
        if (game.phase === 'play' && sheetKind === 'results') closeSheet(), (sheetKind = null);
      }
      schedule();
    },
    setMeta(m) { meta = m; schedule(); },
    chat(name, text) {
      appendLog([{ chat: true, name, text }]);
      if (!el.side.classList.contains('open') && getComputedStyle(el.side).position === 'fixed') el.chatDot.classList.remove('hidden');
    },
    toast,
    destroy() { document.removeEventListener('keydown', onKey); root.innerHTML = ''; },
  };
}

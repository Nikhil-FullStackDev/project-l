// Project L game engine. Pure, dependency-free and shared by the server
// (authoritative) and the browser (offline mode + placement previews).

export const GRID = 5;

// Piece shapes as [x, y] cells. Level == number of squares.
export const SHAPES = {
  '1': [[0, 0]],
  '2': [[0, 0], [1, 0]],
  '3I': [[0, 0], [1, 0], [2, 0]],
  '3L': [[0, 0], [0, 1], [1, 1]],
  '4I': [[0, 0], [1, 0], [2, 0], [3, 0]],
  '4O': [[0, 0], [1, 0], [0, 1], [1, 1]],
  '4T': [[0, 0], [1, 0], [2, 0], [1, 1]],
  '4L': [[0, 0], [0, 1], [0, 2], [1, 2]],
  '4S': [[1, 0], [2, 0], [0, 1], [1, 1]],
};
export const SHAPE_KEYS = Object.keys(SHAPES);
export const level = (shape) => SHAPES[shape].length;

export const MAX_PUZZLES = 4;
export const ACTIONS_PER_TURN = 3;
export const MARKET_SIZE = 4;
// Safety net so a game can't run forever (e.g. nobody draws black puzzles).
export const ROUND_LIMIT = 50;

export class GameError extends Error {}
const fail = (msg) => { throw new GameError(msg); };

// ---------------------------------------------------------------- geometry

// Shift cells to the origin and sort row-major, so cells[0] is the top-left-most cell.
export function normalize(cells) {
  let minX = Infinity, minY = Infinity;
  for (const [x, y] of cells) { if (x < minX) minX = x; if (y < minY) minY = y; }
  return cells.map(([x, y]) => [x - minX, y - minY]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}
export const cellsKey = (cells) => cells.map((c) => c[0] + ',' + c[1]).join(' ');
export const rotate = (cells) => normalize(cells.map(([x, y]) => [-y, x]));
export const flip = (cells) => normalize(cells.map(([x, y]) => [-x, y]));

function computeOrients(cells) {
  const list = [];
  const keys = new Set();
  let cur = normalize(cells);
  for (let f = 0; f < 2; f++) {
    for (let r = 0; r < 4; r++) {
      const k = cellsKey(cur);
      if (!keys.has(k)) { keys.add(k); list.push(cur); }
      cur = rotate(cur);
    }
    cur = flip(cur);
  }
  return { list, keys };
}
// All distinct rotations/reflections per shape, precomputed once.
export const ORIENTS = Object.fromEntries(SHAPE_KEYS.map((k) => [k, computeOrients(SHAPES[k])]));

// ---------------------------------------------------------------- rng / decks

export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
function shuffle(rng, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Grow a random, fairly compact connected region inside the 5x5 frame, then center it.
function genMask(rng, area) {
  const inSet = new Array(GRID * GRID).fill(false);
  inSet[12] = true;
  for (let size = 1; size < area; size++) {
    const cand = [];
    let total = 0;
    for (let i = 0; i < GRID * GRID; i++) {
      if (inSet[i]) continue;
      const x = i % GRID, y = (i / GRID) | 0;
      let n = 0;
      if (x > 0 && inSet[i - 1]) n++;
      if (x < GRID - 1 && inSet[i + 1]) n++;
      if (y > 0 && inSet[i - GRID]) n++;
      if (y < GRID - 1 && inSet[i + GRID]) n++;
      if (n) { const w = n * n; cand.push([i, w]); total += w; }
    }
    let r = rng() * total;
    for (const [i, w] of cand) { r -= w; if (r <= 0) { inSet[i] = true; break; } }
  }
  const cells = [];
  inSet.forEach((v, i) => v && cells.push([i % GRID, (i / GRID) | 0]));
  const n = normalize(cells);
  const w = Math.max(...n.map((c) => c[0])) + 1;
  const h = Math.max(...n.map((c) => c[1])) + 1;
  const ox = (GRID - w) >> 1, oy = (GRID - h) >> 1;
  const mask = new Array(GRID * GRID).fill('.');
  for (const [x, y] of n) mask[(y + oy) * GRID + x + ox] = '#';
  return mask.join('');
}

const SHAPES_BY_LEVEL = [[], ['1'], ['2'], ['3I', '3L'], ['4I', '4O', '4T', '4L', '4S']];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function genPuzzle(rng, color, id) {
  let area, rl, points;
  if (color === 'white') {
    area = pick(rng, [3, 4, 4, 5, 5, 6, 6, 7]);
    rl = area <= 4 ? randInt(rng, 1, 2) : pick(rng, [1, 2, 2, 3]);
    points = clamp(Math.round((area - rl - 3) / 2), 0, 2);
  } else {
    area = randInt(rng, 9, 15);
    rl = pick(rng, [1, 2, 3, 3, 4, 4]);
    points = clamp(Math.round((area - rl - 4) / 2), 1, 5);
  }
  return {
    id, color, mask: genMask(rng, area), area, points,
    reward: pick(rng, SHAPES_BY_LEVEL[rl]),
    fill: new Array(GRID * GRID).fill(null), // index into `placed` or null
    placed: [], // [{ shape, cells: [[x,y]...] }]
  };
}

// ---------------------------------------------------------------- setup

export function createGame({ players, seed = (Math.random() * 2 ** 32) >>> 0 }) {
  const n = players.length;
  if (n < 1 || n > 4) fail('Project L needs 1-4 players');
  const rng = makeRng(seed);
  const whites = Array.from({ length: 24 }, (_, i) => genPuzzle(rng, 'white', 'W' + (i + 1)));
  const blackCount = MARKET_SIZE + (n <= 2 ? 12 : n === 3 ? 14 : 16);
  const blacks = Array.from({ length: blackCount }, (_, i) => genPuzzle(rng, 'black', 'B' + (i + 1)));

  const supply = {};
  for (const k of SHAPE_KEYS) supply[k] = level(k) <= 2 ? 4 + 3 * n : 2 + 2 * n;

  const order = shuffle(rng, players.slice());
  const ps = order.map((p) => {
    supply['1']--; supply['2']--;
    return {
      id: p.id, name: p.name, bot: !!p.bot,
      pieces: Object.fromEntries(SHAPE_KEYS.map((k) => [k, k === '1' || k === '2' ? 1 : 0])),
      puzzles: [], completed: [],
      score: 0, penalty: 0, done: false,
    };
  });

  return {
    seed, version: 0, phase: 'play',
    players: ps, current: 0, actionsLeft: ACTIONS_PER_TURN, masterUsed: false,
    round: 1, endRound: null,
    supply,
    market: { white: whites.splice(0, MARKET_SIZE), black: blacks.splice(0, MARKET_SIZE) },
    decks: { white: whites, black: blacks },
    log: [{ m: 'Game started. ' + ps[0].name + ' goes first.' }],
    ranking: null,
  };
}

// Strip hidden info (deck order) for clients. Safe to JSON.stringify directly.
export function publicView(s) {
  return { ...s, decks: { white: s.decks.white.length, black: s.decks.black.length } };
}

// ---------------------------------------------------------------- helpers

const deckCount = (d) => (typeof d === 'number' ? d : d.length);
export const remainingArea = (pz) => {
  let n = 0;
  for (let i = 0; i < GRID * GRID; i++) if (pz.mask[i] === '#' && pz.fill[i] === null) n++;
  return n;
};
export const handArea = (p) => SHAPE_KEYS.reduce((a, k) => a + p.pieces[k] * level(k), 0);

function log(s, m) {
  s.log.push({ r: s.round, m });
  if (s.log.length > 60) s.log.splice(0, s.log.length - 60);
}

// Returns null if valid, else an error message. `cells` are absolute puzzle coords.
export function checkPlacement(pz, shape, cells) {
  if (!SHAPES[shape]) return 'Unknown piece';
  if (!Array.isArray(cells) || cells.length !== level(shape)) return 'Bad piece cells';
  for (const c of cells) {
    if (!Array.isArray(c) || c.length !== 2) return 'Bad piece cells';
    const [x, y] = c;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= GRID || y >= GRID) return 'Piece is outside the puzzle';
    const i = y * GRID + x;
    if (pz.mask[i] !== '#') return 'Piece does not fit the puzzle';
    if (pz.fill[i] !== null) return 'That space is already filled';
  }
  if (!ORIENTS[shape].keys.has(cellsKey(normalize(cells)))) return 'Cells do not match the piece';
  return null;
}

function putPiece(pz, shape, cells) {
  const idx = pz.placed.length;
  pz.placed.push({ shape, cells: cells.map(([x, y]) => [x, y]) });
  for (const [x, y] of cells) pz.fill[y * GRID + x] = idx;
}

function takeFromSupply(s, p, shape) {
  // If the reward shape is gone, fall back to the best available piece of the same or lower level.
  let got = s.supply[shape] > 0 ? shape : null;
  if (!got) {
    for (let l = level(shape); l >= 1 && !got; l--) got = SHAPES_BY_LEVEL[l].find((k) => s.supply[k] > 0) || null;
  }
  if (got) { s.supply[got]--; p.pieces[got]++; }
  return got;
}

function completePuzzle(s, p, i, { final = false } = {}) {
  const pz = p.puzzles[i];
  p.puzzles.splice(i, 1);
  p.score += pz.points;
  p.completed.push({ id: pz.id, color: pz.color, points: pz.points });
  if (final) {
    log(s, `${p.name} finished a ${pz.color} puzzle in the final phase (+${pz.points})`);
    return;
  }
  for (const pl of pz.placed) p.pieces[pl.shape]++;
  const got = takeFromSupply(s, p, pz.reward);
  log(s, `${p.name} completed a ${pz.color} puzzle (+${pz.points}${got ? ', got ' + got : ''})`);
}

function validatePlace(p, a) {
  const pz = p.puzzles[a.puzzle];
  if (!Number.isInteger(a.puzzle) || !pz) fail('No such puzzle');
  if (!SHAPES[a.shape] || !(p.pieces[a.shape] > 0)) fail("You don't have that piece");
  const err = checkPlacement(pz, a.shape, a.cells);
  if (err) fail(err);
  return pz;
}

export function canPass(s) {
  return s.supply['1'] === 0;
}

// ---------------------------------------------------------------- actions

export function applyAction(s, pid, a) {
  if (!a || typeof a !== 'object') fail('Bad action');
  const pi = s.players.findIndex((p) => p.id === pid);
  if (pi < 0) fail('You are not in this game');
  const p = s.players[pi];
  if (s.phase === 'final') return finalAction(s, p, a);
  if (s.phase !== 'play') fail('The game is over');
  if (pi !== s.current) fail('Not your turn');

  switch (a.type) {
    case 'takePuzzle': {
      const color = a.color;
      if (color !== 'white' && color !== 'black') fail('Bad puzzle color');
      if (p.puzzles.length >= MAX_PUZZLES) fail(`You can hold at most ${MAX_PUZZLES} puzzles`);
      let pz;
      if (a.index === 'deck') {
        if (!s.decks[color].length) fail('That pile is empty');
        pz = s.decks[color].shift();
      } else {
        const row = s.market[color];
        if (!Number.isInteger(a.index) || !row[a.index]) fail('No such puzzle');
        pz = row.splice(a.index, 1)[0];
        if (s.decks[color].length) row.push(s.decks[color].shift());
      }
      p.puzzles.push(pz);
      log(s, `${p.name} took a ${color} puzzle`);
      if (color === 'black' && !s.decks.black.length && s.endRound === null) {
        s.endRound = s.round;
        log(s, 'The black pile is empty — finish this round, then one final round.');
      }
      break;
    }
    case 'takePiece': {
      if (!(s.supply['1'] > 0)) fail('No level-1 pieces left');
      s.supply['1']--; p.pieces['1']++;
      log(s, `${p.name} took a level-1 piece`);
      break;
    }
    case 'upgrade': {
      const { from, to } = a;
      if (!SHAPES[from] || !(p.pieces[from] > 0)) fail("You don't have that piece");
      if (!SHAPES[to]) fail('Unknown piece');
      if (to === from) fail('Pick a different piece');
      if (level(to) > level(from) + 1) fail('You can only upgrade one level at a time');
      if (!(s.supply[to] > 0)) fail('None of that piece left');
      p.pieces[from]--; s.supply[from]++;
      s.supply[to]--; p.pieces[to]++;
      log(s, `${p.name} ${level(to) > level(from) ? 'upgraded' : 'exchanged'} ${from} → ${to}`);
      break;
    }
    case 'place': {
      const pz = validatePlace(p, a);
      p.pieces[a.shape]--;
      putPiece(pz, a.shape, a.cells);
      log(s, `${p.name} placed ${a.shape}`);
      if (remainingArea(pz) === 0) completePuzzle(s, p, a.puzzle);
      break;
    }
    case 'master': {
      if (s.masterUsed) fail('Master action already used this turn');
      const list = a.placements;
      if (!Array.isArray(list) || !list.length || list.length > p.puzzles.length) fail('Bad master action');
      const used = new Set();
      const need = {};
      for (const pl of list) {
        if (!pl || used.has(pl.puzzle)) fail('One piece per puzzle in a master action');
        used.add(pl.puzzle);
        validatePlace(p, pl);
        need[pl.shape] = (need[pl.shape] || 0) + 1;
        if (need[pl.shape] > p.pieces[pl.shape]) fail("You don't have enough of those pieces");
      }
      for (const pl of list) { p.pieces[pl.shape]--; putPiece(p.puzzles[pl.puzzle], pl.shape, pl.cells); }
      s.masterUsed = true;
      log(s, `${p.name} used the master action (${list.length} piece${list.length > 1 ? 's' : ''})`);
      const done = list.map((pl) => pl.puzzle).filter((i) => remainingArea(p.puzzles[i]) === 0).sort((x, y) => y - x);
      for (const i of done) completePuzzle(s, p, i);
      break;
    }
    case 'pass': {
      if (!canPass(s)) fail('You can only pass when no level-1 pieces remain');
      log(s, `${p.name} passed`);
      break;
    }
    default: fail('Unknown action');
  }

  s.version++;
  if (--s.actionsLeft <= 0) endTurn(s);
}

function endTurn(s) {
  s.actionsLeft = ACTIONS_PER_TURN;
  s.masterUsed = false;
  s.current = (s.current + 1) % s.players.length;
  if (s.current === 0) {
    s.round++;
    if (s.endRound === null && s.round >= ROUND_LIMIT) {
      s.endRound = s.round - 1;
      log(s, 'Round limit reached — this is the final round!');
      return;
    }
    if (s.endRound !== null && s.round > s.endRound + 1) return startFinal(s);
    if (s.endRound !== null && s.round === s.endRound + 1) log(s, 'Final round!');
  }
}

function startFinal(s) {
  s.phase = 'final';
  log(s, 'Final phase: place leftover pieces (−1 each) to finish puzzles.');
  for (const p of s.players) p.done = p.puzzles.length === 0;
  maybeFinish(s);
}

function finalAction(s, p, a) {
  if (p.done) fail('You are already done');
  if (a.type === 'finalPlace') {
    const pz = validatePlace(p, a);
    p.pieces[a.shape]--;
    putPiece(pz, a.shape, a.cells);
    p.penalty++;
    if (remainingArea(pz) === 0) completePuzzle(s, p, a.puzzle, { final: true });
    if (!p.puzzles.length) p.done = true;
  } else if (a.type === 'finalDone') {
    p.done = true;
  } else {
    fail('Only final placements are allowed now');
  }
  s.version++;
  maybeFinish(s);
}

function maybeFinish(s) {
  if (!s.players.every((p) => p.done)) return;
  s.phase = 'ended';
  for (const p of s.players) {
    p.unfinished = p.puzzles.reduce((a, pz) => a + pz.points, 0);
    p.final = p.score - p.penalty - p.unfinished;
  }
  s.ranking = s.players.slice()
    .sort((a, b) => b.final - a.final || b.completed.length - a.completed.length || handArea(b) - handArea(a))
    .map((p) => p.id);
  const w = s.players.find((p) => p.id === s.ranking[0]);
  log(s, `Game over — ${w.name} wins with ${w.final} points!`);
}

// Utility for clients: does the deck still have cards? Works on full state and public view.
export const deckSize = (s, color) => deckCount(s.decks[color]);

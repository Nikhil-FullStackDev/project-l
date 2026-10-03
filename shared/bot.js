// Greedy Project L bot. Returns one action for the given player, or null if none.
import { GRID, SHAPE_KEYS, ORIENTS, level, remainingArea, handArea, canPass, MAX_PUZZLES } from './engine.js';

const BY_LEVEL_DESC = SHAPE_KEYS.slice().sort((a, b) => level(b) - level(a));

const freeCells = (pz) => Array.from({ length: GRID * GRID }, (_, i) => pz.mask[i] === '#' && pz.fill[i] === null);

// Find an exact tiling of the puzzle's empty cells with the given piece counts.
// Fills the first empty cell (row-major) each step, largest pieces first.
export function solve(pz, pieces, budget = 4000) {
  const free = freeCells(pz);
  const need = free.filter(Boolean).length;
  const counts = { ...pieces };
  let have = 0;
  for (const k of SHAPE_KEYS) have += (counts[k] || 0) * level(k);
  if (have < need) return null;
  const sol = [];
  let nodes = 0;
  const dfs = () => {
    if (++nodes > budget) return false;
    const i = free.indexOf(true);
    if (i < 0) return true;
    const x0 = i % GRID, y0 = (i / GRID) | 0;
    for (const s of BY_LEVEL_DESC) {
      if (!counts[s]) continue;
      for (const o of ORIENTS[s].list) {
        const dx = x0 - o[0][0], dy = y0 - o[0][1];
        const idx = [];
        for (const [cx, cy] of o) {
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= GRID || y >= GRID || !free[y * GRID + x]) break;
          idx.push(y * GRID + x);
        }
        if (idx.length !== o.length) continue;
        for (const j of idx) free[j] = false;
        counts[s]--;
        sol.push({ shape: s, cells: o.map(([cx, cy]) => [cx + dx, cy + dy]) });
        if (dfs()) return true;
        sol.pop();
        counts[s]++;
        for (const j of idx) free[j] = true;
      }
    }
    return false;
  };
  return dfs() ? sol : null;
}

// First position (any orientation) where the shape fits, as absolute cells, or null.
export function firstFit(pz, shape) {
  const free = freeCells(pz);
  for (const o of ORIENTS[shape].list) {
    for (let oy = 0; oy < GRID; oy++) {
      for (let ox = 0; ox < GRID; ox++) {
        if (o.every(([x, y]) => x + ox < GRID && y + oy < GRID && free[(y + oy) * GRID + x + ox])) {
          return o.map(([x, y]) => [x + ox, y + oy]);
        }
      }
    }
  }
  return null;
}
export const fitsAnywhere = (pz, shape) => firstFit(pz, shape) !== null;

function puzzleValue(s, p, pz) {
  const hand = handArea(p);
  let v = (pz.points * 1.6 + level(pz.reward)) / pz.area;
  if (pz.color === 'black' && hand < 6) v *= 0.5;
  if (s.endRound !== null && pz.area > hand + 4) v *= 0.2;
  return v;
}

function bestPuzzle(s, p) {
  let best = null;
  for (const color of ['white', 'black']) {
    s.market[color].forEach((pz, index) => {
      const v = puzzleValue(s, p, pz);
      if (!best || v > best.v) best = { v, color, index };
    });
  }
  return best && { type: 'takePuzzle', color: best.color, index: best.index };
}

function finalChoice(p) {
  for (let i = 0; i < p.puzzles.length; i++) {
    const pz = p.puzzles[i];
    const sol = solve(pz, p.pieces);
    if (sol && 2 * pz.points - sol.length > 0) return { type: 'finalPlace', puzzle: i, ...sol[0] };
  }
  return { type: 'finalDone' };
}

export function chooseAction(s, pid) {
  const p = s.players.find((x) => x.id === pid);
  if (!p) return null;
  if (s.phase === 'final') return p.done ? null : finalChoice(p);
  if (s.phase !== 'play' || s.players[s.current].id !== pid) return null;

  // Solve each puzzle with the whole hand; closest to completion first.
  const sols = p.puzzles
    .map((pz, i) => ({ i, rem: remainingArea(pz), sol: solve(pz, p.pieces) }))
    .sort((a, b) => a.rem - b.rem);

  // 1. Finish a puzzle in one placement.
  const one = sols.find((x) => x.sol && x.sol.length === 1);
  if (one) return { type: 'place', puzzle: one.i, ...one.sol[0] };

  // 2. Master action when it advances 2+ puzzles.
  if (!s.masterUsed) {
    const left = { ...p.pieces };
    const placements = [];
    for (const x of sols) {
      const sol = solve(p.puzzles[x.i], left);
      if (!sol) continue;
      left[sol[0].shape]--;
      placements.push({ puzzle: x.i, ...sol[0] });
    }
    if (placements.length >= 2) return { type: 'master', placements };
  }

  // 3. Always hold at least one puzzle (two early on).
  const want = p.puzzles.length < MAX_PUZZLES && (
    p.puzzles.length === 0 ||
    (p.puzzles.length < 2 && s.endRound === null) ||
    handArea(p) >= p.puzzles.reduce((a, pz) => a + remainingArea(pz), 0) + 2);
  if (p.puzzles.length === 0 && want) { const t = bestPuzzle(s, p); if (t) return t; }

  // 4. Progress a solvable puzzle.
  const solvable = sols.find((x) => x.sol);
  if (solvable) return { type: 'place', puzzle: solvable.i, ...solvable.sol[0] };

  if (want) { const t = bestPuzzle(s, p); if (t) return t; }

  // 5. Improve the hand: upgrade a piece into one that fits somewhere, else take a level-1 piece.
  const maxRem = Math.max(0, ...p.puzzles.map(remainingArea));
  for (const from of BY_LEVEL_DESC) {
    if (!p.pieces[from] || level(from) >= 4 || level(from) + 1 > maxRem) continue;
    const to = SHAPE_KEYS.find((k) => level(k) === level(from) + 1 && s.supply[k] > 0 &&
      p.puzzles.some((pz) => fitsAnywhere(pz, k)));
    if (to) return { type: 'upgrade', from, to };
  }
  // Swap a piece that fits nowhere for one (same or lower level) that does.
  for (const from of SHAPE_KEYS) {
    if (!p.pieces[from] || !p.puzzles.length || p.puzzles.some((pz) => fitsAnywhere(pz, from))) continue;
    const to = BY_LEVEL_DESC.find((k) => k !== from && level(k) <= level(from) && s.supply[k] > 0 &&
      p.puzzles.some((pz) => fitsAnywhere(pz, k)));
    if (to) return { type: 'upgrade', from, to };
  }
  if (s.supply['1'] > 0) return { type: 'takePiece' };

  // Supply is tight: make any progress we can rather than pass.
  for (const shape of BY_LEVEL_DESC) {
    if (!p.pieces[shape]) continue;
    for (let i = 0; i < p.puzzles.length; i++) {
      const cells = firstFit(p.puzzles[i], shape);
      if (cells) return { type: 'place', puzzle: i, shape, cells };
    }
  }
  if (p.puzzles.length < MAX_PUZZLES) { const t = bestPuzzle(s, p); if (t) return t; }
  if (canPass(s)) return { type: 'pass' };
  return null;
}

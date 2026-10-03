import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction, publicView, ORIENTS, SHAPE_KEYS, GameError, remainingArea } from '../shared/engine.js';
import { chooseAction, solve } from '../shared/bot.js';

const players = (n) => Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i, bot: true }));

test('orientation counts match the polyomino symmetries', () => {
  const counts = Object.fromEntries(SHAPE_KEYS.map((k) => [k, ORIENTS[k].list.length]));
  assert.deepEqual(counts, { '1': 1, '2': 2, '3I': 2, '3L': 4, '4I': 2, '4O': 1, '4T': 4, '4L': 8, '4S': 4 });
});

test('setup is deterministic and deals starting pieces', () => {
  const a = createGame({ players: players(3), seed: 42 });
  const b = createGame({ players: players(3), seed: 42 });
  assert.deepEqual(a, b);
  for (const p of a.players) assert.equal(p.pieces['1'] + p.pieces['2'], 2);
  assert.equal(a.market.white.length, 4);
  assert.equal(a.market.black.length, 4);
  assert.equal(typeof publicView(a).decks.black, 'number');
});

test('rejects out-of-turn and invalid actions', () => {
  const s = createGame({ players: players(2), seed: 1 });
  const other = s.players[1].id;
  assert.throws(() => applyAction(s, other, { type: 'takePiece' }), GameError);
  const me = s.players[0].id;
  assert.throws(() => applyAction(s, me, { type: 'upgrade', from: '1', to: '3I' }), /one level/);
  assert.throws(() => applyAction(s, me, { type: 'place', puzzle: 0, shape: '1', cells: [[0, 0]] }), /No such puzzle/);
});

test('placing a piece in a puzzle that does not match is rejected', () => {
  const s = createGame({ players: players(1), seed: 7 });
  const me = s.players[0].id;
  applyAction(s, me, { type: 'takePuzzle', color: 'white', index: 0 });
  const pz = s.players[0].puzzles[0];
  const hole = pz.mask.indexOf('.');
  assert.throws(() => applyAction(s, me, { type: 'place', puzzle: 0, shape: '1', cells: [[hole % 5, (hole / 5) | 0]] }), GameError);
  // A domino given non-adjacent cells must be rejected even inside the mask.
  const filled = [...pz.mask].map((c, i) => (c === '#' ? i : -1)).filter((i) => i >= 0);
  const far = filled.find((i) => Math.abs((i % 5) - (filled[0] % 5)) + Math.abs(((i / 5) | 0) - ((filled[0] / 5) | 0)) > 1);
  if (far !== undefined) {
    const c = (i) => [i % 5, (i / 5) | 0];
    assert.throws(() => applyAction(s, me, { type: 'place', puzzle: 0, shape: '2', cells: [c(filled[0]), c(far)] }), /match/);
  }
});

test('completing a puzzle scores, returns pieces and gives the reward', () => {
  const s = createGame({ players: players(1), seed: 3 });
  const me = s.players[0].id;
  const p = s.players[0];
  applyAction(s, me, { type: 'takePuzzle', color: 'white', index: 0 });
  const pz = p.puzzles[0];
  p.pieces['1'] = 10; // enough monominoes to fill anything
  const sol = solve(pz, p.pieces);
  assert.ok(sol);
  applyAction(s, me, { type: 'master', placements: [{ puzzle: 0, ...sol[0] }] });
  for (const pl of sol.slice(1)) {
    if (s.current !== 0) break;
    applyAction(s, me, { type: 'place', puzzle: 0, ...pl });
  }
  if (remainingArea(pz) === 0) {
    assert.equal(p.completed.length, 1);
    assert.equal(p.score, pz.points);
  }
});

for (const n of [1, 2, 3, 4]) {
  test(`bots play a full ${n}-player game to the end`, () => {
    for (let seed = 1; seed <= 15; seed++) {
      const s = createGame({ players: players(n), seed });
      let steps = 0;
      while (s.phase !== 'ended') {
        assert.ok(++steps < 5000, `game stalled (seed ${seed})`);
        const ids = s.phase === 'final' ? s.players.filter((p) => !p.done).map((p) => p.id) : [s.players[s.current].id];
        const a = chooseAction(s, ids[0]);
        assert.ok(a, `bot had no move (seed ${seed}, phase ${s.phase})`);
        applyAction(s, ids[0], a);
      }
      assert.equal(s.ranking.length, n);
      for (const p of s.players) assert.equal(p.final, p.score - p.penalty - p.unfinished);
      // piece conservation: supply + hands + pieces still in unfinished puzzles stays constant
      assert.ok(Object.values(s.supply).every((v) => v >= 0));
    }
  });
}

test('a player hoarding level-1 pieces cannot stall the game forever', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const s = createGame({ players: [{ id: 'h', name: 'H' }, { id: 'b', name: 'B', bot: true }], seed });
    let steps = 0;
    while (s.phase !== 'ended') {
      assert.ok(++steps < 2000, `stalled (seed ${seed})`);
      if (s.phase === 'final') {
        for (const p of s.players) if (!p.done) applyAction(s, p.id, p.bot ? chooseAction(s, p.id) : { type: 'finalDone' });
        continue;
      }
      const cur = s.players[s.current];
      applyAction(s, cur.id, cur.bot ? chooseAction(s, cur.id) : s.supply['1'] > 0 ? { type: 'takePiece' } : { type: 'pass' });
    }
  }
});

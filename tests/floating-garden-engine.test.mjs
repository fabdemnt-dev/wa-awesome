import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPlacement, cellName, createExampleGarden, createGarden, createTile, neighbors, placeStone, placeTile, scoreGarden, tilePorts, validateGarden } from '../lab/floating-garden/engine.js';
import { createSession, displayedGarden, updateSession } from '../lab/floating-garden/session.js';

function fill(entries) {
  return entries.reduce((garden, [index, terrain = 'cloud', shape = 'straight', rotation = 0]) => placeTile(garden, index, createTile(terrain, shape, rotation)), createGarden());
}
const stoneScore = (garden, stone) => scoreGarden(garden).stones.find((item) => item.stone === stone);
function freezeDeep(value) {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freezeDeep); }
  return value;
}
function step(session, action) {
  const result = updateSession(freezeDeep(session), action);
  assert.equal(result.error, undefined, result.message);
  return result.session;
}
const add = (session, index) => step(step(session, { type: 'preview', index }), { type: 'commit' });

test('empty 4x4 garden has a complete zero-point breakdown', () => {
  const garden = createGarden();
  assert.equal(garden.length, 16);
  assert.equal(scoreGarden(garden).total, 0);
  assert.equal(scoreGarden(garden).filled, 0);
  assert.deepEqual(scoreGarden(garden).connections, []);
  assert.deepEqual(scoreGarden(garden).stones, []);
  assert.equal(scoreGarden(garden).objective.achieved, false);
});

test('ports rotate clockwise, normalize negative/four turns, and close a cycle', () => {
  assert.deepEqual(tilePorts(createTile('lake', 'straight')), [0, 2]);
  assert.deepEqual(tilePorts(createTile('lake', 'straight', 1)), [1, 3]);
  assert.deepEqual(tilePorts(createTile('lake', 'bend', 0)), [0, 1]);
  assert.deepEqual(tilePorts(createTile('lake', 'bend', 1)), [1, 2]);
  assert.deepEqual(tilePorts(createTile('lake', 'bend', 2)), [2, 3]);
  assert.deepEqual(tilePorts(createTile('lake', 'bend', 3)), [3, 0]);
  assert.deepEqual(createTile('lake', 'bend', -1), createTile('lake', 'bend', 3));
  assert.deepEqual(createTile('lake', 'bend', 4), createTile('lake', 'bend', 0));
  const loop = fill([[0, 'cloud', 'bend', 1], [1, 'lake', 'bend', 2], [4, 'forest', 'bend', 0], [5, 'magic', 'bend', 3]]);
  assert.equal(scoreGarden(loop).connectionPoints, 4);
});

test('adjacency never wraps rows or includes diagonals', () => {
  assert.deepEqual(neighbors(0), [1, 4]);
  assert.deepEqual(neighbors(3), [7, 2]);
  assert.deepEqual(neighbors(5), [1, 6, 9, 4]);
  assert.deepEqual(neighbors(15), [11, 14]);
  assert.deepEqual([0, 3, 12, 15].map(cellName), ['A1', 'D1', 'A4', 'D4']);
});

test('connections count matching opposite ports once, even across different terrains', () => {
  const garden = fill([[0, 'cloud', 'straight', 1], [1, 'lake', 'straight', 1], [2, 'forest', 'straight', 1]]);
  assert.equal(scoreGarden(garden).connectionPoints, 2);
  assert.deepEqual(scoreGarden(garden).connections, [{ from: 0, to: 1, points: 1 }, { from: 1, to: 2, points: 1 }]);
});

test('one-sided ports, diagonal tiles, boundary ports, and row wrapping score nothing', () => {
  assert.equal(scoreGarden(fill([[0, 'cloud', 'straight', 1], [1, 'lake', 'straight', 0]])).total, 0);
  assert.equal(scoreGarden(fill([[0], [5]])).total, 0);
  assert.equal(scoreGarden(fill([[3, 'cloud', 'straight', 1], [4, 'lake', 'straight', 1]])).total, 0);
  assert.equal(scoreGarden(fill([[0]])).total, 0);
});

test('vertical flow counts once and a 4x4 vertical field has 12 edges', () => {
  const garden = fill(Array.from({ length: 16 }, (_, index) => [index]));
  assert.equal(scoreGarden(garden).connectionPoints, 12);
});

test('moon counts lakes in the same row, including its own tile, excluding other rows', () => {
  const garden = placeStone(fill([[4, 'lake'], [5, 'lake'], [6, 'forest'], [1, 'lake'], [9, 'lake']]), 5, 'moon');
  assert.deepEqual(stoneScore(garden, 'moon').matches, [4, 5]);
  assert.equal(stoneScore(garden, 'moon').points, 4);
});

test('moon caps four lakes at six with uncapped detail retained', () => {
  const result = stoneScore(placeStone(fill([0, 1, 2, 3].map((i) => [i, 'lake'])), 1, 'moon'), 'moon');
  assert.equal(result.count, 4);
  assert.equal(result.rawPoints, 8);
  assert.equal(result.points, 6);
  assert.equal(result.capped, true);
});

test('wind counts orthogonal clouds only, excluding its own tile and diagonals', () => {
  const garden = placeStone(fill([[5], [1], [6], [9, 'forest'], [4, 'lake'], [0], [2], [8], [10]]), 5, 'wind');
  assert.deepEqual(stoneScore(garden, 'wind').matches, [1, 6]);
  assert.equal(stoneScore(garden, 'wind').points, 4);
});

test('wind caps four adjacent clouds at six and does not wrap at an edge', () => {
  assert.equal(stoneScore(placeStone(fill([[5], [1], [6], [9], [4]]), 5, 'wind'), 'wind').points, 6);
  assert.deepEqual(stoneScore(placeStone(fill([[3], [4], [7], [2]]), 3, 'wind'), 'wind').matches, [7, 2]);
});

test('color counts distinct adjacent terrain, not tiles, its own type, or diagonals', () => {
  const garden = placeStone(fill([[5, 'magic'], [1, 'cloud'], [6, 'cloud'], [9, 'lake'], [4, 'lake'], [0, 'crystal'], [10, 'forest']]), 5, 'color');
  const result = stoneScore(garden, 'color');
  assert.equal(result.matches.length, 4);
  assert.equal(result.count, 2);
  assert.equal(result.points, 4);
});

test('color includes a neighboring type even when it equals its own terrain', () => {
  const garden = placeStone(fill([[5], [1]]), 5, 'color');
  assert.equal(stoneScore(garden, 'color').count, 1);
  assert.equal(stoneScore(garden, 'color').points, 2);
});

test('color caps four distinct neighbors at six; empty cells have no type', () => {
  const garden = placeStone(fill([[5, 'magic'], [1, 'cloud'], [6, 'lake'], [9, 'forest'], [4, 'crystal']]), 5, 'color');
  const result = stoneScore(garden, 'color');
  assert.equal(result.count, 4);
  assert.equal(result.rawPoints, 8);
  assert.equal(result.points, 6);
  assert.equal(result.capped, true);
  assert.equal(stoneScore(placeStone(fill([[5, 'magic']]), 5, 'color'), 'color').points, 0);
});

test('color on a corner counts only its two neighbors; row wrap is not adjacent', () => {
  const garden = placeStone(fill([[3, 'magic'], [2, 'lake'], [7, 'cloud'], [4, 'forest'], [6, 'crystal']]), 3, 'color');
  assert.equal(stoneScore(garden, 'color').count, 2);
  assert.equal(stoneScore(garden, 'color').points, 4);
});

test('echo counts other stones anywhere in same row or column, not self or diagonals', () => {
  let garden = fill([[5], [1], [7], [10]]);
  garden = placeStone(garden, 5, 'echo');
  assert.equal(stoneScore(garden, 'echo').points, 0);
  garden = placeStone(garden, 1, 'moon');
  garden = placeStone(garden, 7, 'wind');
  garden = placeStone(garden, 10, 'color');
  assert.deepEqual(stoneScore(garden, 'echo').matches, [1, 7]);
  assert.equal(stoneScore(garden, 'echo').points, 4);
});

test('echo reaches six with all three other stones aligned and counts each once', () => {
  let garden = fill([[0], [1], [2], [3]]);
  for (const [index, stone] of ['echo', 'moon', 'wind', 'color'].entries()) garden = placeStone(garden, index, stone);
  assert.equal(stoneScore(garden, 'echo').points, 6);
  assert.equal(stoneScore(garden, 'echo').count, 3);
});

test('objective requires every corner, four distinct types, and scores exactly four', () => {
  const incomplete = fill([[0], [3, 'lake'], [12, 'forest']]);
  assert.equal(scoreGarden(incomplete).objective.points, 0);
  assert.equal(scoreGarden(placeTile(incomplete, 15, createTile('cloud'))).objective.points, 0);
  assert.equal(scoreGarden(placeTile(incomplete, 15, createTile('magic'))).objective.points, 4);
});

test('placements and scoring are pure and cannot modify existing cells', () => {
  const original = freezeDeep(fill([[0, 'lake']]));
  const tile = freezeDeep(createTile('forest'));
  const next = placeTile(original, 1, tile);
  assert.equal(original[1], null);
  assert.notEqual(next[1], tile);
  const withStone = placeStone(freezeDeep(next), 0, 'moon');
  assert.equal(next[0].stone, null);
  assert.equal(withStone[0].stone, 'moon');
  assert.equal(scoreGarden(freezeDeep(withStone)).stones[0].points, 2);
  assert.throws(() => placeTile(withStone, 0, createTile('magic')), { code: 'occupied-cell' });
  assert.throws(() => applyPlacement(withStone, { type: 'rotate', index: 0 }), { code: 'invalid-command' });
});

test('stone inventory: occupied terrain only, one per tile, each type once, no moves', () => {
  const garden = placeStone(fill([[0], [1]]), 0, 'moon');
  assert.throws(() => placeStone(garden, 2, 'wind'), { code: 'empty-cell' });
  assert.throws(() => placeStone(garden, 0, 'wind'), { code: 'occupied-stone' });
  assert.throws(() => placeStone(garden, 1, 'moon'), { code: 'used-stone' });
  assert.throws(() => placeStone(garden, 1, 'sun'), { code: 'invalid-stone' });
  assert.throws(() => placeTile(createGarden(), 0, garden[0]), { code: 'invalid-tile' });
});

test('engine rejects malformed gardens, sparse arrays, bad cells, and bad rotations', () => {
  for (const garden of [null, [], Array(16), Array(16).fill(undefined)]) assert.throws(() => validateGarden(garden));
  for (const index of [-1, 16, 1.2, '0', NaN]) assert.throws(() => placeTile(createGarden(), index, createTile('cloud')), { code: 'invalid-cell' });
  for (const terrain of ['__proto__', 'constructor', 'sun', null]) assert.throws(() => createTile(terrain), { code: 'invalid-terrain' });
  for (const shape of ['cross', null]) assert.throws(() => createTile('cloud', shape), { code: 'invalid-shape' });
  assert.throws(() => createTile('cloud', 'straight', 1.5), { code: 'invalid-rotation' });
  const garden = fill([[0], [1]]);
  garden[0].stone = 'moon'; garden[1].stone = 'moon';
  assert.throws(() => validateGarden(garden), { code: 'duplicate-stone' });
  const invalid = fill([[0]]); invalid[0].rotation = 4;
  assert.throws(() => validateGarden(invalid), { code: 'invalid-rotation' });
  invalid[0].rotation = 0; delete invalid[0].shape;
  assert.throws(() => validateGarden(invalid), { code: 'invalid-shape' });
});

test('example is reproducible and has independently calculated 31-point breakdown', () => {
  const garden = createExampleGarden();
  const score = scoreGarden(garden);
  assert.deepEqual(createExampleGarden(), garden);
  assert.equal(score.filled, 16);
  assert.equal(score.connectionPoints, 9);
  assert.deepEqual(score.stones.map(({ stone, points }) => [stone, points]), [['moon', 4], ['wind', 4], ['color', 6], ['echo', 4]]);
  assert.equal(score.objective.points, 4);
  assert.equal(score.total, 31);
});

test('preview, rotate, cancel and confirm separate temporary from committed state', () => {
  let session = createSession();
  session = step(session, { type: 'select-tile', terrain: 'lake', shape: 'bend', rotation: 0 });
  session = step(session, { type: 'preview', index: 5 });
  assert.equal(session.garden[5], null);
  assert.equal(displayedGarden(session)[5].terrain, 'lake');
  session = step(session, { type: 'rotate' });
  assert.equal(session.pending.tile.rotation, 1);
  session = step(session, { type: 'cancel' });
  assert.equal(session.pending, null);
  assert.equal(session.garden[5], null);
  session = add(session, 6);
  assert.equal(session.garden[6].rotation, 1);
  assert.equal(session.history.length, 1);
  assert.equal(session.pending, null);
  const repeated = updateSession(session, { type: 'commit' });
  assert.ok(repeated.error);
  assert.equal(repeated.session, session);
});

test('new selection clears stale preview, destination can change, failed action is a no-op', () => {
  let session = add(createSession(), 0);
  session = step(session, { type: 'preview', index: 1 });
  const rejected = updateSession(session, { type: 'preview', index: 0 });
  assert.equal(rejected.session, session);
  assert.equal(rejected.session.pending.index, 1);
  session = step(session, { type: 'preview', index: 2 });
  assert.equal(displayedGarden(session)[1], null);
  session = step(session, { type: 'select-stone', stone: 'moon' });
  assert.equal(session.pending, null);
  session = step(session, { type: 'preview', index: 0 });
  assert.equal(session.garden[0].stone, null);
  session = step(session, { type: 'commit' });
  assert.equal(session.garden[0].stone, 'moon');
  assert.equal(session.selection.type, 'tile');
  assert.ok(updateSession(session, { type: 'select-stone', stone: 'moon' }).error);
});

test('undo is explicit, restores stone stock, and cannot accidentally confirm a preview', () => {
  let session = add(createSession(), 0);
  session = step(session, { type: 'select-stone', stone: 'moon' });
  session = add(session, 0);
  session = step(session, { type: 'undo' });
  assert.equal(session.garden[0].stone, null);
  assert.equal(session.history.length, 1);
  session = step(session, { type: 'select-stone', stone: 'moon' });
  session = step(session, { type: 'preview', index: 0 });
  const result = updateSession(session, { type: 'undo' });
  assert.ok(result.error);
  assert.equal(result.session, session);
  session = step(session, { type: 'cancel' });
  session = step(session, { type: 'undo' });
  assert.equal(session.garden[0], null);
  assert.ok(updateSession(session, { type: 'undo' }).error);
});

test('a full garden rejects a 17th tile, still accepts stones, and supports repeatable reset', () => {
  let session = createSession();
  for (let index = 0; index < 16; index += 1) session = add(session, index);
  assert.equal(scoreGarden(session.garden).filled, 16);
  assert.ok(updateSession(session, { type: 'preview', index: 0 }).error);
  session = step(session, { type: 'select-stone', stone: 'color' });
  session = add(session, 5);
  assert.equal(stoneScore(session.garden, 'color').points, 2);
  assert.deepEqual(createSession(), createSession());
});

test('deterministic exhaustive terrain neighborhoods obey caps, distinctness and scoring purity', () => {
  const terrains = ['cloud', 'lake', 'forest', 'crystal', 'magic'];
  // All 5^4 orthogonal neighborhoods, including every duplicate distribution.
  for (let code = 0; code < 625; code += 1) {
    let value = code;
    const types = Array.from({ length: 4 }, () => { const terrain = terrains[value % 5]; value = Math.floor(value / 5); return terrain; });
    const garden = placeStone(fill([[5, 'magic'], ...[1, 6, 9, 4].map((index, i) => [index, types[i]])]), 5, 'color');
    assert.equal(stoneScore(garden, 'color').points, Math.min(6, new Set(types).size * 2));
    assert.deepEqual(scoreGarden(garden), scoreGarden(garden));
  }
});

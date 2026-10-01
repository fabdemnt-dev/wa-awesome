import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatch, applyMatchAction, legalActions, getDecision, publicMatch, rankMatch, assertMatchInvariants, POWER } from '../lab/floating-garden/match-engine.js';
import { remainingTileCounts } from '../lab/floating-garden/match-assist.js';
import { chooseCpuAction, bestTilePlacement } from '../lab/floating-garden/cpu.js';
import { createTile, placeTile, scoreGarden } from '../lab/floating-garden/engine.js';
const act = (state, type, fields = {}) => {
  const command = legalActions(state).find((action) => action.type === type && Object.entries(fields).every(([key, value]) => action[key] === value));
  assert.ok(command, `${type} must be legal in ${state.step}: ${JSON.stringify(fields)}`);
  return applyMatchAction(state, command);
};
const drawn = (count = 4) => act(createMatch({ playerCount: count }), 'draw');
const requests = (state, seats = []) => {
  while (state.step === 'invite-response') state = act(state, seats.includes(getDecision(state).seat) ? 'request-invite' : 'pass-invite');
  return state;
};
const ownPlacement = (state) => act(requests(act(state, 'self')), 'place');
const fill = (state, seat, count = 16) => {
  for (let index = 0; index < count; index += 1) {
    const tile = state.deck[state.deckCursor++];
    state.players[seat].garden = placeTile(state.players[seat].garden, index, tile);
    state.players[seat].tileIds[index] = tile.id;
  }
  return state;
};
const freeze = (object) => { Object.freeze(object); Object.values(object).forEach((value) => { if (value && typeof value === 'object') freeze(value); }); return object; };
function play(state, policy) {
  let steps = 0;
  const history = [];
  while (state.phase !== 'finished') {
    assert.ok(++steps < 700, 'bounded legal match terminates');
    const legal = legalActions(state);
    const action = policy(state, legal, steps);
    history.push(action.type);
    const before = state.players.map((player) => player.garden);
    state = applyMatchAction(state, action);
    before.forEach((garden, seat) => garden.forEach((tile, index) => {
      if (!tile) return;
      const next = state.players[seat].garden[index];
      assert.equal(next.terrain, tile.terrain); assert.equal(next.shape, tile.shape); assert.equal(next.rotation, tile.rotation);
      if (tile.stone) assert.equal(next.stone, tile.stone);
    }));
    assertMatchInvariants(state);
  }
  assert.ok(state.players.every((player) => player.garden.every(Boolean)));
  assert.equal(new Set(state.players.map((player) => player.careCount)).size, 1);
  assert.ok(state.round <= 16); assert.ok(state.deck.length - state.deckCursor >= state.players.length * 3);
  return { state, history };
}

test('seeded deck is balanced, reproducible, unique, and never present in the CPU public view', () => {
  for (const playerCount of [2, 3, 4]) {
    const state = createMatch({ playerCount, seed: 'same' });
    assert.deepEqual(state, createMatch({ playerCount, seed: 'same' }));
    assert.notDeepEqual(state.deck, createMatch({ playerCount, seed: 'different' }).deck);
    assert.equal(state.deck.length, playerCount * 20);
    assert.equal(new Set(state.deck.map((tile) => tile.id)).size, state.deck.length);
    for (const terrain of ['cloud', 'lake', 'crystal', 'forest', 'magic']) for (const shape of ['straight', 'bend']) assert.equal(state.deck.filter((tile) => tile.terrain === terrain && tile.shape === shape).length, playerCount * 2);
    const visible = publicMatch(act(state, 'draw'));
    for (const key of ['deck', 'deckCursor', 'seed']) assert.ok(!Object.hasOwn(visible, key));
    assert.equal(visible.deckRemaining, playerCount * 20 - 1);
    visible.players[0].power = 0; assert.equal(state.players[0].power, 4);
  }
});

test('invalid setup, malformed/out-of-turn/stale/extra commands are rejected without changes', () => {
  for (const playerCount of [0, 1, 5, 2.5, '4']) assert.throws(() => createMatch({ playerCount }));
  for (const humanSeat of [-2, 4, 0.5]) assert.throws(() => createMatch({ humanSeat }));
  for (const seed of [null, NaN, {}, []]) assert.throws(() => createMatch({ seed }));
  const state = freeze(createMatch());
  const command = legalActions(state)[0];
  for (const bad of [null, [], {}, { ...command, seat: 1 }, { ...command, revision: 9 }, { ...command, extra: true }, { ...command, type: 'undo' }]) assert.throws(() => applyMatchAction(state, bad));
  const next = applyMatchAction(state, command);
  assert.equal(state.deckCursor, 0); assert.equal(next.deckCursor, 1);
  assert.throws(() => applyMatchAction(next, command), { code: 'stale-action' });
});

test('own tile, clockwise rotations, fixed placements and exactly one care', () => {
  let state = requests(act(drawn(), 'self'));
  state = act(state, 'place', { index: 0, rotation: 3 });
  assert.equal(state.players[0].garden[0].rotation, 3);
  assert.equal(state.step, 'care');
  assert.ok(!legalActions(state).some((action) => ['place', 'store', 'offer', 'draw'].includes(action.type)));
  state = act(state, 'meditate');
  assert.equal(state.players[0].careCount, 1); assert.equal(state.players[0].power, 5); assert.equal(state.activeSeat, 1);
});

test('accepted gift gives +2 capped, immediate receiver placement, then protected donor replacement', () => {
  let state = drawn(); state.players[0].power = 5;
  const id = state.drawn.tile.id;
  state = act(state, 'offer', { target: 2 });
  assert.equal(getDecision(state).seat, 2);
  state = act(state, 'accept');
  assert.equal(state.players[0].power, POWER.max); assert.equal(state.placementSeat, 2); assert.equal(state.drawn.protected, true);
  assert.ok(legalActions(state).every((action) => action.type === 'place'));
  state = act(state, 'place');
  assert.equal(state.players[2].tileIds[0], id); assert.equal(state.placementSeat, 0); assert.equal(state.drawn.source, 'replacement'); assert.equal(state.drawn.protected, true);
  assert.ok(legalActions(state).every((action) => action.type === 'place'));
  state = act(state, 'place'); assert.equal(state.step, 'care'); assert.equal(state.players[2].careCount, 0);
});

test('declined gift has no reward and cannot be offered again; self or storage remain', () => {
  let state = act(act(drawn(), 'offer', { target: 1 }), 'decline');
  assert.equal(state.players[0].power, 4);
  assert.deepEqual(legalActions(state).map((action) => action.type), ['self', 'store']);
  state = act(state, 'store'); assert.equal(state.drawn.source, 'replacement');
});

test('empty storage keeps exactly one tile and forces a protected replacement', () => {
  let state = drawn(); const id = state.drawn.tile.id;
  state = act(state, 'store'); assert.equal(state.players[0].storage.id, id); assert.equal(state.deckCursor, 2);
  assert.equal(state.placementSeat, 0); assert.equal(state.drawn.protected, true);
  assert.ok(legalActions(state).every((action) => action.type === 'place'));
  state = act(state, 'place'); assertMatchInvariants(state);
});

test('full storage swaps new for old, old cannot be restored or offered and can face invitation', () => {
  let state = createMatch(); state.players[0].storage = state.deck[state.deckCursor++];
  const old = state.players[0].storage.id;
  state = act(state, 'draw'); const fresh = state.drawn.tile.id;
  state = act(state, 'store');
  assert.equal(state.players[0].storage.id, fresh); assert.equal(state.drawn.tile.id, old);
  assert.equal(state.step, 'invite-response'); assert.equal(state.drawn.canStore, false); assert.equal(state.drawn.canOffer, false);
  state = requests(state); state = act(state, 'place'); assert.equal(state.players[0].tileIds[0], old); assertMatchInvariants(state);
});

test('stored source never returns to storage even after a declined offer', () => {
  let state = createMatch(); state.players[0].storage = state.deck[state.deckCursor++];
  state = act(state, 'use-storage'); assert.equal(state.players[0].storage, null);
  assert.ok(!legalActions(state).some((action) => action.type === 'store'));
  state = act(act(state, 'offer', { target: 1 }), 'decline');
  assert.deepEqual(legalActions(state).map((action) => action.type), ['self']);
});

test('multiple irrevocable invitation requests resolve public priority, only winner pays and marker advances', () => {
  let state = drawn(); state.prioritySeat = 2;
  state = act(state, 'self'); assert.deepEqual(state.inviteSeats, [2, 3, 1]);
  state = requests(state, [1, 2, 3]); assert.deepEqual(state.requests, [2, 3, 1]);
  assert.equal(state.step, 'welcome');
  assert.ok(!legalActions(state).some((action) => action.type.includes('invite')));
  state = act(state, 'yield');
  assert.equal(state.placementSeat, 2); assert.equal(state.players[2].power, 1); assert.equal(state.players[1].power, 4); assert.equal(state.players[3].power, 4); assert.equal(state.prioritySeat, 3);
  state = act(state, 'place'); assert.equal(state.drawn.protected, true); assert.equal(state.placementSeat, 0);
  state = act(state, 'place'); assert.equal(state.players[0].garden.filter(Boolean).length, 1); assert.equal(state.step, 'care');
});

test('welcoming costs owner 2, protects own placement, charges no requester and keeps marker', () => {
  let state = requests(act(drawn(), 'self'), [1, 3]);
  state = act(state, 'welcome');
  assert.equal(state.players[0].power, 2); assert.equal(state.players[1].power, 4); assert.equal(state.players[3].power, 4); assert.equal(state.prioritySeat, 1);
  assert.equal(state.placementSeat, 0); assert.equal(state.drawn.protected, true);
  assert.ok(legalActions(state).every((action) => action.type === 'place'));
});

test('insufficient owner power explicitly makes welcome illegal; insufficient and completed requesters excluded', () => {
  let state = createMatch(); state.players[0].power = 1; state.players[1].power = 2; fill(state, 2);
  state = act(act(state, 'draw'), 'self'); assert.deepEqual(state.inviteSeats, [3]);
  state = requests(state, [3]); assert.deepEqual(legalActions(state).map((action) => action.type), ['yield']);
  state = act(state, 'yield'); assert.equal(state.players[0].power, 1);
});

test('complete gardens cannot receive offers and skip drawing but retain one care per round', () => {
  let state = createMatch(); fill(state, 1);
  state = act(state, 'draw'); assert.ok(!legalActions(state).some((action) => action.target === 1));
  state = act(ownPlacement(state), 'meditate');
  assert.equal(state.activeSeat, 1); assert.equal(state.step, 'care');
  const cursor = state.deckCursor; state = act(state, 'meditate');
  assert.equal(state.deckCursor, cursor); assert.equal(state.players[1].careCount, 1);
});

test('stone care costs 3, inventory is one per type, empty/occupied targets and repeat care rejected', () => {
  let state = ownPlacement(drawn());
  assert.ok(!legalActions(state).some((action) => action.type === 'stone' && action.index === 1));
  state = act(state, 'stone', { index: 0, stone: 'moon' });
  assert.equal(state.players[0].power, 1); assert.equal(state.players[0].garden[0].stone, 'moon'); assert.equal(state.players[0].careCount, 1);
  assert.equal(state.activeSeat, 1);
  state.activeSeat = 0; state.step = 'care'; state.players[0].power = 6;
  assert.ok(!legalActions(state).some((action) => action.type === 'stone'));
});

test('normal12 switches to mandatory finishing, storage first, final stone or pass, max16 rounds', () => {
  let finishing = false;
  const { state, history } = play(createMatch({ playerCount: 2 }), (current, legal) => {
    if (current.phase === 'finishing') {
      finishing = true; assert.ok(current.round >= 13);
      assert.ok(legal.every((action) => ['place', 'meditate', 'stone'].includes(action.type)));
    }
    return legal.find((action) => action.type === 'draw') || legal.find((action) => action.type === 'self') || legal.find((action) => action.type === 'pass-invite') || legal.find((action) => action.type === 'meditate') || legal.find((action) => action.type === 'pass-final') || legal[0];
  });
  assert.equal(finishing, true); assert.equal(state.round, 16); assert.equal(state.players[0].careCount, 16); assert.ok(history.includes('pass-final'));
  assert.equal(state.players[0].power, 6);
});

test('finishing consumes storage first, with no invitation of the stored tile', () => {
  let state = createMatch({ playerCount: 2 }); fill(state, 0, 12); fill(state, 1, 12);
  state.players.forEach((player) => { player.careCount = 11; });
  state.players[0].careCount = 12; state.activeSeat = 1; state.round = 12; state.step = 'care';
  state.players[0].storage = state.deck[state.deckCursor++]; const id = state.players[0].storage.id; const cursor = state.deckCursor;
  state = act(state, 'meditate');
  assert.equal(state.phase, 'finishing'); assert.equal(state.round, 13); assert.equal(state.drawn.tile.id, id); assert.equal(state.players[0].storage, null); assert.equal(state.deckCursor, cursor);
  assert.equal(state.drawn.protected, true); assert.ok(legalActions(state).every((action) => action.type === 'place'));
});

test('all-filled round still finishes equal care, then at most one final stone per seat; ties share rank', () => {
  let state = createMatch({ playerCount: 3 });
  state.players.forEach((player) => fill(state, player.seat));
  state.step = 'care'; const before = state.players.map((player) => structuredClone(player.garden));
  state = act(state, 'meditate'); assert.equal(state.phase, 'normal');
  state = act(state, 'meditate'); assert.equal(state.phase, 'normal');
  state = act(state, 'meditate'); assert.equal(state.phase, 'final-stone'); assert.equal(state.finalSeat, 0);
  state = act(state, 'stone', { stone: 'color', index: 5 }); assert.equal(state.finalSeat, 1); assert.equal(state.players[0].power, 2);
  state = act(state, 'pass-final'); state = act(state, 'stone', { stone: 'moon', index: 0 });
  assert.equal(state.phase, 'finished'); assert.equal(legalActions(state).length, 0); assert.equal(getDecision(state), null);
  assert.deepEqual(state.players.map((player) => player.careCount), [1, 1, 1]);
  before.forEach((garden, seat) => garden.forEach((tile, index) => assert.equal(state.players[seat].garden[index].terrain, tile.terrain)));
  const tied = createMatch({ playerCount: 4 }); assert.deepEqual(rankMatch(tied).map((item) => item.rank), [1, 1, 1, 1]);
});

test('final stone never grants free power and skips unavailable stones', () => {
  let state = createMatch({ playerCount: 2 });
  state.players.forEach((player) => { fill(state, player.seat); player.power = 1; });
  state.step = 'care'; state = act(state, 'meditate'); state = act(state, 'meditate');
  assert.equal(state.phase, 'final-stone'); assert.equal(state.players[0].power, 2);
  assert.deepEqual(legalActions(state).map((action) => action.type), ['pass-final']);
  state = act(state, 'pass-final'); state = act(state, 'pass-final');
  assert.equal(state.phase, 'finished'); assert.equal(state.players[0].power, 2);
});

test('conservation detects duplicate/lost physical tiles and invalid resource caps', () => {
  const state = drawn();
  for (const change of [(copy) => { copy.players[0].storage = copy.drawn.tile; }, (copy) => { copy.drawn = null; }, (copy) => { copy.players[0].power = 7; }, (copy) => { copy.deckCursor = 99; }, (copy) => { copy.drawn.tile.terrain = copy.drawn.tile.terrain === 'lake' ? 'cloud' : 'lake'; }]) {
    const copy = structuredClone(state); change(copy); assert.throws(() => assertMatchInvariants(copy));
  }
});

test('CPU placement seeks real connections and uses only the public state', () => {
  let garden = Array(16).fill(null); garden = placeTile(garden, 0, createTile('lake', 'straight', 1));
  const tile = createTile('lake', 'straight'); const best = bestTilePlacement(garden, tile);
  assert.ok(scoreGarden(placeTile(garden, best.index, { ...tile, rotation: best.rotation })).total >= 1);
  const state = requests(act(drawn(2), 'self'));
  const visible = publicMatch(state); const command = chooseCpuAction(visible, legalActions(state));
  const alternate = structuredClone(state); alternate.deck.reverse(); alternate.seed = 'other';
  assert.deepEqual(chooseCpuAction(publicMatch(alternate), legalActions(alternate)), command);
});

test('90 seeded CPU matches terminate with equal care, fixed gardens, bounded power and conserved stock (2/3/4 seats)', () => {
  const seen = new Set();
  for (const playerCount of [2, 3, 4]) for (let seed = 0; seed < 30; seed += 1) {
    const { state, history } = play(createMatch({ playerCount, seed, humanSeat: -1 }), (current, legal) => chooseCpuAction(publicMatch(current), legal));
    history.forEach((type) => seen.add(type));
    assert.deepEqual(rankMatch(state).map((entry) => entry.score), rankMatch(state).map((entry) => scoreGarden(state.players[entry.seat].garden).total));
  }
  for (const type of ['draw', 'store', 'use-storage', 'offer', 'accept', 'request-invite', 'welcome', 'yield', 'stone']) assert.ok(seen.has(type), `CPU simulations cover ${type}`);
});

test('150 seeded randomized legal matches terminate and replay identically, including refused gifts and invitation passes', () => {
  const seen = new Set();
  for (const playerCount of [2, 3, 4]) for (let seed = 1; seed <= 50; seed += 1) {
    let rng = seed; const commands = [];
    const { state, history } = play(createMatch({ playerCount, seed }), (current, legal) => {
      rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
      const action = legal[rng % legal.length]; commands.push(action); return action;
    });
    history.forEach((type) => seen.add(type));
    let replay = createMatch({ playerCount, seed }); for (const command of commands) replay = applyMatchAction(replay, command);
    assert.deepEqual(replay, state);
  }
  for (const type of ['decline', 'pass-invite', 'pass-final']) assert.ok(seen.has(type));
});

function assertRemainingInventory(state) {
  const before = structuredClone(state);
  const visible = publicMatch(state);
  const inventory = remainingTileCounts(visible);
  assert.deepEqual(Object.keys(inventory), ['total', 'kinds']);
  assert.equal(inventory.total, state.deck.length - state.deckCursor);
  assert.equal(inventory.kinds.length, 10);
  for (const kind of inventory.kinds) {
    assert.deepEqual(Object.keys(kind), ['terrain', 'shape', 'count']);
    assert.ok(Number.isInteger(kind.count) && kind.count >= 0);
    assert.equal(kind.count, state.deck.slice(state.deckCursor).filter((tile) => tile.terrain === kind.terrain && tile.shape === kind.shape).length);
  }
  assert.deepEqual(state, before, 'counting cannot change the match');
  return inventory;
}

test('assist counts all ten fixed kinds using only public inventory, with no order or identity output', () => {
  for (const playerCount of [2, 3, 4]) {
    const state = createMatch({ playerCount });
    const inventory = assertRemainingInventory(state);
    assert.equal(inventory.total, playerCount * 20);
    assert.ok(inventory.kinds.every((kind) => kind.count === playerCount * 2));
    const visible = publicMatch(state);
    const guarded = new Proxy(visible, { get(target, key) { assert.ok(!['seed', 'deck', 'deckCursor', 'tileIds', 'nextTile'].includes(key)); return target[key]; } });
    assert.deepEqual(remainingTileCounts(guarded), inventory);
    assert.doesNotMatch(JSON.stringify(inventory), /tile-\d|rotation|seed|deck|nextTile/);
    freeze(visible); assert.deepEqual(remainingTileCounts(visible), inventory);
  }
});

test('assist excludes placed, stored and currently public tiles, and reports zero remaining for an exhausted kind', () => {
  const state = createMatch({ playerCount: 2 });
  state.deck.sort((a, b) => Number(b.terrain === 'cloud' && b.shape === 'straight') - Number(a.terrain === 'cloud' && a.shape === 'straight'));
  fill(state, 0, 2);
  state.players[1].storage = state.deck[state.deckCursor++];
  const current = act(state, 'draw');
  assert.equal(current.drawn.tile.terrain, 'cloud'); assert.equal(current.drawn.tile.shape, 'straight');
  const inventory = assertRemainingInventory(current);
  assert.equal(inventory.total, 36);
  assert.equal(inventory.kinds.find((kind) => kind.terrain === 'cloud' && kind.shape === 'straight').count, 0);
  assert.ok(inventory.kinds.filter((kind) => kind.terrain !== 'cloud' || kind.shape !== 'straight').every((kind) => kind.count === 4));
});

test('assist updates exactly once for draws and replacements, without recounting storage swaps or gifts', () => {
  let state = drawn(2); const afterDraw = assertRemainingInventory(state);
  state = act(state, 'store');
  assert.equal(assertRemainingInventory(state).total, afterDraw.total - 1, 'empty storage draws one replacement');
  state = act(state, 'place'); assert.equal(assertRemainingInventory(state).total, afterDraw.total - 1);
  state = createMatch({ playerCount: 2 }); state.players[0].storage = state.deck[state.deckCursor++];
  state = act(state, 'draw'); const beforeSwap = assertRemainingInventory(state);
  state = act(state, 'store'); assert.deepEqual(assertRemainingInventory(state), beforeSwap, 'full storage swaps two already public tiles');
  state = requests(state); state = act(state, 'place'); assert.deepEqual(assertRemainingInventory(state), beforeSwap);
  state = createMatch({ playerCount: 2 }); state.players[0].storage = state.deck[state.deckCursor++];
  const beforeUse = assertRemainingInventory(state);
  state = act(state, 'use-storage'); assert.deepEqual(assertRemainingInventory(state), beforeUse);
  state = act(state, 'offer', { target: 1 }); assert.deepEqual(assertRemainingInventory(state), beforeUse);
  state = act(state, 'accept'); assert.deepEqual(assertRemainingInventory(state), beforeUse);
  state = act(state, 'place'); assert.equal(assertRemainingInventory(state).total, beforeUse.total - 1);
  const replacement = assertRemainingInventory(state);
  state = act(state, 'place'); assert.deepEqual(assertRemainingInventory(state), replacement);
});

test('assist inventory stays correct through invitation/yield and complete 2/3/4-player matches', () => {
  let state = requests(act(drawn(), 'self'), [1, 2, 3]);
  const beforeYield = assertRemainingInventory(state);
  state = act(state, 'yield'); assert.deepEqual(assertRemainingInventory(state), beforeYield);
  state = act(state, 'place'); assert.equal(assertRemainingInventory(state).total, beforeYield.total - 1);
  state = act(state, 'place'); assertRemainingInventory(state);
  for (const playerCount of [2, 3, 4]) {
    const { state: completed } = play(createMatch({ playerCount, seed: `inventory-${playerCount}`, humanSeat: -1 }), (current, legal) => {
      assertRemainingInventory(current);
      return chooseCpuAction(publicMatch(current), legal);
    });
    assertRemainingInventory(completed);
    const snapshot = publicMatch(completed);
    for (const field of ['seed', 'deck', 'deckCursor', 'assist', 'inventory', 'remainingTileCounts']) assert.ok(!Object.hasOwn(snapshot, field));
  }
});

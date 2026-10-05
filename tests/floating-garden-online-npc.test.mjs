import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createMemoryStore } from './helpers/floating-garden-store.mjs';
import * as core from '../lab/floating-garden/match-engine.js';
import { chooseCpuAction } from '../lab/floating-garden/cpu.js';
const require = createRequire(import.meta.url);
const { createHandlers, loadCpu, advanceNpcTurns, RATE_LIMITS, MAX_NPC_ACTIONS_PER_OPERATION } = require('../functions/floating-garden-online/handlers.js');
const contract = require('../functions/floating-garden-online/contract.js');
const KEY = 'fixture-floating-garden-npc-hmac-key-for-local-tests-only';
const START = 1700000000000;
const generousRates = Object.fromEntries(Object.entries(RATE_LIMITS).map(([type, value]) => [type, {
  ...value, limit: 10000, ...(value.ipLimit ? { ipLimit: 10000 } : {}),
}]));
const reject = (promise, code, reason) => assert.rejects(promise, (error) => error.code === code && (!reason || error.details?.reason === reason));
function random(seed) { let value = seed; return (max) => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value % max; }; }
function fixture(options = {}) {
  const db = createMemoryStore(); let time = START; let serial = 0;
  const handlers = createHandlers({ db, now: () => time, inviteSecret: () => KEY, rateLimits: generousRates, randomInt: random(1), ...options });
  const id = () => `npc-request-${++serial}`;
  const request = (uid, data) => ({ auth: { uid }, rawRequest: { ip: '127.0.0.1' }, data });
  const roomPath = (room) => `floatingGardenRooms/${room.roomId}`;
  const gamePath = (room) => `${roomPath(room)}/serverGames/${db.peek(roomPath(room)).gameId}`;
  async function create(npcCount, requestId = id()) {
    return handlers.floatingGardenCreateRoom(request('host', { displayName: '星の庭', requestId, ...(npcCount === undefined ? {} : { npcCount }) }));
  }
  async function join(room, uid = 'guest', requestId = id()) {
    return handlers.floatingGardenJoinRoom(request(uid, { inviteCode: room.inviteCode, displayName: '月の庭', requestId }));
  }
  async function get(room, uid = 'host') { return handlers.floatingGardenGetSnapshot(request(uid, { roomId: room.roomId })); }
  async function ready(npcCount) {
    const room = await create(npcCount); await join(room);
    const snapshot = await handlers.floatingGardenStartMatch(request('host', { roomId: room.roomId, expectedRevision: 2, requestId: id() }));
    return { ...room, snapshot };
  }
  function actionData(room, action, requestId = id()) {
    const saved = db.peek(roomPath(room)); const { seat, revision, ...command } = action;
    return { roomId: room.roomId, gameId: saved.gameId, rulesVersion: contract.RULES_VERSION, expectedRevision: saved.match.revision, command, requestId };
  }
  async function act(room, action, uid = action.seat === 0 ? 'host' : 'guest', requestId) {
    return handlers.floatingGardenSubmitAction(request(uid, actionData(room, action, requestId)));
  }
  async function draw(room) {
    const snapshot = await get(room);
    return act(room, core.legalActions(snapshot.room.match).find((action) => action.type === 'draw'));
  }
  return { db, handlers, id, request, roomPath, gamePath, create, join, get, ready, actionData, act, draw, advance: (millis) => { time += millis; } };
}
function assertPublic(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!['deck', 'deckCursor', 'seed', 'uid', 'private', 'secret', 'commands', 'initialState'].includes(key), `private field ${key}`);
    assertPublic(child);
  }
}
function assertReplays(game) {
  assert.equal(game.commands.length, game.state.revision);
  let state = game.initialState;
  for (const command of game.commands) state = core.applyMatchAction(state, command);
  assert.deepEqual(state, game.state);
}

test('server stages byte-identical public-only CPU and loads it as ESM', async () => {
  assert.deepEqual(await readFile(new URL('../functions/floating-garden-online/core/cpu.js', import.meta.url)), await readFile(new URL('../lab/floating-garden/cpu.js', import.meta.url)));
  assert.equal(typeof (await loadCpu()).chooseCpuAction, 'function');
});
for (const npcCount of [0, 1, 2]) test(`create/start preserves two human memberships with ${npcCount} NPC seats`, async () => {
  const f = fixture(); const room = await f.create(npcCount);
  let saved = f.db.peek(f.roomPath(room));
  assert.equal(saved.playerCount, 2 + npcCount); assert.equal(saved.npcCount ?? 0, npcCount);
  assert.deepEqual(saved.players, [{ seat: 0, name: '星の庭' }]);
  const start = () => f.handlers.floatingGardenStartMatch(f.request('host', { roomId: room.roomId, expectedRevision: saved.revision, requestId: f.id() }));
  await reject(start(), 'failed-precondition', 'room-not-ready');
  await f.join(room); saved = f.db.peek(f.roomPath(room));
  assert.equal(saved.players.length, 2);
  await reject(f.join(room, 'third-human'), 'failed-precondition', 'room-full');
  const snapshot = await start();
  assert.equal(snapshot.room.players.length, 2 + npcCount);
  assert.deepEqual(snapshot.room.match.players.map((p) => p.isHuman), [true, true, ...Array(npcCount).fill(false)]);
  assert.deepEqual(snapshot.room.players.slice(2), ['森の庭', '結晶の庭'].slice(0, npcCount).map((name, index) => ({ seat: 2 + index, name, isHuman: false })));
  assert.equal(snapshot.room.match.deckRemaining, (2 + npcCount) * 20);
  assert.equal(f.db.paths().filter((path) => path.includes('/members/')).length, 2);
  assert.equal(f.db.peek(f.gamePath(room)).commands.length, 0);
  assertPublic(snapshot.room);
});

test('missing and explicit zero npcCount keep the legacy public room shape', async () => {
  const f = fixture(); const old = await f.ready(); const zero = await f.ready(0);
  for (const snapshot of [old.snapshot, zero.snapshot]) {
    assert.equal(Object.hasOwn(snapshot.room, 'npcCount'), false);
    assert.equal(snapshot.room.playerCount, 2);
    assert.deepEqual(snapshot.room.players, [{ seat: 0, name: '星の庭' }, { seat: 1, name: '月の庭' }]);
    const next = await f.act(snapshot === old.snapshot ? old : zero, core.legalActions(snapshot.room.match)[0]);
    assert.equal(next.room.match.revision, 1);
  }
});

test('malformed NPC counts and client-injected mode fields fail before writes', async () => {
  const f = fixture();
  for (const npcCount of [-1, 3, 99, 1.5, '1', true, null, undefined, NaN, Infinity, [], {}]) {
    await reject(f.handlers.floatingGardenCreateRoom(f.request('host', { displayName: '庭', requestId: f.id(), npcCount })), 'invalid-argument');
  }
  assert.equal(f.db.paths().length, 0);
  const room = await f.create(2);
  await reject(f.handlers.floatingGardenJoinRoom(f.request('guest', { inviteCode: room.inviteCode, displayName: '月', requestId: f.id(), npcCount: 0 })), 'invalid-argument');
  await reject(f.handlers.floatingGardenStartMatch(f.request('host', { roomId: room.roomId, expectedRevision: 1, requestId: f.id(), npcCount: 0 })), 'invalid-argument');
});

test('NPC mode belongs to the immutable create receipt and duplicate creates converge', async () => {
  const f = fixture(); const requestId = f.id();
  const results = await Promise.all(Array.from({ length: 6 }, () => f.create(2, requestId)));
  results.forEach((result) => assert.deepEqual(result, results[0]));
  await reject(f.create(1, requestId), 'already-exists', 'request-id-reused');
  assert.equal(f.db.paths().filter((path) => /^floatingGardenRooms\/[^/]+$/.test(path)).length, 1);
  assert.equal(f.db.peek(f.roomPath(results[0])).npcCount, 2);
});

for (const npcCount of [0, 1, 2]) test(`offer target is bounded by actual ${2 + npcCount}-seat room`, async () => {
  const f = fixture(); const room = await f.ready(npcCount); const snapshot = await f.draw(room);
  for (const target of [-1, 2 + npcCount, 4, 100, '2']) await reject(f.act(room, { type: 'offer', target, seat: 0 }), 'invalid-argument');
  assert.equal((await f.get(room)).room.match.revision, snapshot.room.match.revision);
  if (npcCount) {
    const output = await f.act(room, { type: 'offer', target: 1 + npcCount, seat: 0 });
    assert.equal(output.room.match.players[1 + npcCount].garden.filter(Boolean).length, 1);
    assert.equal(core.getDecision(output.room.match).seat, 0);
    assert.equal(output.room.match.revision, 4); // human offer, NPC accept and place
    assertReplays(f.db.peek(f.gamePath(room)));
  }
});

test('even a forged server membership cannot claim NPC seats or replay as an NPC', async () => {
  const f = fixture(); const room = await f.ready(2); const snapshot = await f.draw(room);
  const guestPath = `${f.roomPath(room)}/members/guest`; const guest = f.db.peek(guestPath);
  for (const seat of [2, 3]) {
    f.db.set(guestPath, { ...guest, seat });
    await reject(f.get(room, 'guest'), 'permission-denied');
    await reject(f.join(room), 'permission-denied');
    await reject(f.act(room, core.legalActions(snapshot.room.match)[0], 'guest'), 'permission-denied');
  }
  assert.equal(f.db.peek(f.gamePath(room)).state.revision, 1);
});

test('NPC receives only public fields and legal actions, including after future secret fields are added', async () => {
  let calls = 0;
  const f = fixture({ cpuLoader: async () => ({ chooseCpuAction(visible, legal) {
    calls += 1; assertPublic(visible); assertPublic(legal);
    assert.deepEqual(legal, core.legalActions(visible));
    return chooseCpuAction(visible, legal);
  } }) });
  const room = await f.ready(2); await f.draw(room);
  const game = f.db.peek(f.gamePath(room));
  game.state.secret = 'NEVER-SHARE'; game.state.players[2].uid = 'NEVER-SHARE';
  game.state.drawn.tile.secret = 'NEVER-SHARE'; game.state.players[2].private = { note: 'NEVER-SHARE' };
  f.db.set(f.gamePath(room), game);
  const result = await f.act(room, { type: 'offer', seat: 0, target: 2 });
  assert.ok(calls >= 2); assertPublic(result); assert.equal(JSON.stringify(result).includes('NEVER-SHARE'), false);
});

test('duplicate/lost-response retries across transaction conflicts never double-advance NPCs', async () => {
  let injectConflict = true; let calls = 0;
  const observations = [];
  const f = fixture({ cpuLoader: async () => ({ chooseCpuAction(visible, legal) {
    calls += 1;
    if (injectConflict) { injectConflict = false; f.db.forceConflicts(1); }
    const action = chooseCpuAction(visible, legal); observations.push({ revision: visible.revision, action }); return action;
  } }) });
  const room = await f.ready(2); await f.draw(room);
  const request = f.request('host', f.actionData(room, { type: 'offer', target: 2 }));
  const results = await Promise.all(Array.from({ length: 6 }, () => f.handlers.floatingGardenSubmitAction(request)));
  results.forEach((result) => assert.deepEqual(result, results[0]));
  const game = f.db.peek(f.gamePath(room)); assertReplays(game);
  assert.deepEqual(game.commands.map((command) => command.type), ['draw', 'offer', 'accept', 'place']);
  assert.equal(game.state.players[2].garden.filter(Boolean).length, 1);
  assert.ok(calls > 2); // callbacks really retried
  for (const revision of new Set(observations.map((item) => item.revision))) {
    const group = observations.filter((item) => item.revision === revision);
    group.forEach((item) => assert.deepEqual(item.action, group[0].action));
  }
  await f.act(room, core.legalActions(results[0].room.match)[0]);
  const beforeReplay = f.db.peek(f.gamePath(room));
  assert.deepEqual(await f.handlers.floatingGardenSubmitAction(request), results[0]);
  assert.deepEqual(f.db.peek(f.gamePath(room)), beforeReplay);
  assertReplays(beforeReplay);
});

test('competing human requests and stale snapshots cannot repeat or overwrite NPC progression', async () => {
  const f = fixture(); const room = await f.ready(2); await f.draw(room);
  const requests = [f.actionData(room, { type: 'offer', target: 2 }), f.actionData(room, { type: 'offer', target: 3 })];
  const outcomes = await Promise.allSettled(requests.map((data) => f.handlers.floatingGardenSubmitAction(f.request('host', data))));
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find((outcome) => outcome.status === 'rejected').reason.details.reason, 'stale-revision');
  const game = f.db.peek(f.gamePath(room)); assert.equal(game.state.revision, 4); assertReplays(game);
  await reject(f.handlers.floatingGardenSubmitAction(f.request('host', { ...requests[0], requestId: f.id() })), 'failed-precondition', 'stale-revision');
  await reject(f.act(room, core.legalActions((await f.get(room)).room.match)[0], 'guest'), 'permission-denied');
});

test('NPC action budget exhaustion is atomic and retryable after service recovery', async () => {
  const f = fixture({ npcActionBudget: 1 }); const room = await f.ready(2); await f.draw(room);
  const request = f.request('host', f.actionData(room, { type: 'offer', target: 2 }));
  const beforeRoom = f.db.peek(f.roomPath(room)); const beforeGame = f.db.peek(f.gamePath(room));
  const receiptPath = `floatingGardenActionRequests/${contract.uidKey('host')}_${request.data.requestId}`;
  await reject(f.handlers.floatingGardenSubmitAction(request), 'internal', 'npc-action-budget');
  assert.deepEqual(f.db.peek(f.roomPath(room)), beforeRoom); assert.deepEqual(f.db.peek(f.gamePath(room)), beforeGame);
  assert.equal(f.db.peek(receiptPath), undefined);
  const recovered = createHandlers({ db: f.db, now: () => START, inviteSecret: () => KEY, rateLimits: generousRates });
  const result = await recovered.floatingGardenSubmitAction(request);
  assert.equal(result.room.match.revision, 4); assertReplays(f.db.peek(f.gamePath(room)));
});

test('invalid CPU choice cannot commit the human move or a partial NPC sequence', async () => {
  const f = fixture({ cpuLoader: async () => ({ chooseCpuAction: (visible) => ({ type: 'draw', seat: 0, revision: visible.revision }) }) });
  const room = await f.ready(1); await f.draw(room); const before = f.db.peek(f.gamePath(room));
  await reject(f.act(room, { type: 'offer', target: 2, seat: 0 }), 'internal', 'npc-illegal-action');
  assert.deepEqual(f.db.peek(f.gamePath(room)), before);
});

test('disconnected human responses pause NPC play; reload and invitation resume are read-only', async () => {
  const f = fixture(); const room = await f.ready(2); await f.draw(room);
  const snapshot = await f.act(room, { type: 'offer', target: 1, seat: 0 });
  assert.equal(core.getDecision(snapshot.room.match).seat, 1);
  const before = f.db.peek(f.gamePath(room));
  f.advance(2 * 60 * 60 * 1000);
  assert.deepEqual((await f.get(room, 'guest')).room, snapshot.room);
  assert.equal((await f.join(room, 'guest')).seat, 1);
  assert.deepEqual(f.db.peek(f.gamePath(room)), before);
  await reject(f.act(room, core.legalActions(snapshot.room.match)[0], 'host'), 'permission-denied');
  const resumed = await f.act(room, core.legalActions(snapshot.room.match).find((action) => action.type === 'accept'));
  assert.equal(core.getDecision(resumed.room.match).seat, 1); assert.equal(resumed.room.match.step, 'place');
});

test('NPC rooms preserve expiry and current-membership checks on new actions and receipt replay', async () => {
  const f = fixture(); const room = await f.ready(2); await f.draw(room);
  const request = f.request('host', f.actionData(room, { type: 'offer', target: 2 }));
  await f.handlers.floatingGardenSubmitAction(request);
  const before = f.db.peek(f.gamePath(room)); const memberPath = `${f.roomPath(room)}/members/host`; const member = f.db.peek(memberPath);
  f.db.set(memberPath, { ...member, active: false });
  await reject(f.handlers.floatingGardenSubmitAction(request), 'permission-denied');
  f.db.set(memberPath, member); f.advance(contract.ROOM_TTL_MILLIS);
  await reject(f.get(room), 'failed-precondition', 'room-expired');
  await reject(f.join(room), 'not-found');
  await reject(f.handlers.floatingGardenSubmitAction(request), 'failed-precondition', 'room-expired');
  await reject(f.act(room, core.legalActions(contract.toPublicSnapshot(before.state))[0]), 'failed-precondition', 'room-expired');
  assert.deepEqual(f.db.peek(f.gamePath(room)), before);
});

for (const npcCount of [0, 1, 2]) test(`complete deterministic ${2 + npcCount}-seat games retain public secrecy, fairness, scores and full replay`, async () => {
  const terminalStates = [];
  for (const seed of [1, 29, 1]) {
    const f = fixture({ randomInt: random(seed) }); const room = await f.ready(npcCount);
    let snapshot = room.snapshot; let operations = 0; const choose = random(seed * 97);
    while (snapshot.room.status !== 'finished') {
      assert.ok(core.getDecision(snapshot.room.match).seat < 2, 'snapshot must stop at a human decision');
      const actions = core.legalActions(snapshot.room.match); const action = actions[choose(actions.length)];
      const previousRevision = snapshot.room.match.revision;
      snapshot = await f.act(room, action); operations += 1;
      const advanced = snapshot.room.match.revision - previousRevision - 1;
      assert.ok(advanced >= 0 && advanced <= MAX_NPC_ACTIONS_PER_OPERATION);
      if (!npcCount) assert.equal(advanced, 0);
      assertPublic(snapshot.room);
      assert.deepEqual((await f.get(room, 'guest')).room, snapshot.room);
      assert.ok(operations < 500);
    }
    const game = f.db.peek(f.gamePath(room)); assertReplays(game);
    assert.deepEqual(snapshot.room.scores, core.rankMatch(game.state));
    assert.equal(game.state.players.length, 2 + npcCount);
    assert.equal(game.state.players.every((player) => player.garden.filter(Boolean).length === 16), true);
    assert.equal(new Set(game.state.players.map((player) => player.careCount)).size, 1);
    assert.equal(core.assertMatchInvariants(game.state), true);
    assert.equal(game.commands.filter((action) => action.seat < 2).length, operations);
    if (npcCount) assert.ok(game.commands.some((action) => action.seat >= 2));
    assert.ok(Buffer.byteLength(JSON.stringify(game)) < 1024 * 1024);
    terminalStates.push(game.state);
  }
  assert.deepEqual(terminalStates[0], terminalStates[2], 'same initial deck and human actions yield deterministic NPC play');
});

for (const npcCount of [1, 2]) test(`start shuffles only the ${2 + npcCount}-seat inventory once through transaction retries`, async () => {
  const bounds = []; let injectConflict = true;
  const f = fixture({ randomInt: (bound) => {
    bounds.push(bound);
    if (injectConflict) { injectConflict = false; f.db.forceConflicts(2); }
    return bound - 1;
  } });
  const room = await f.ready(npcCount);
  assert.deepEqual(bounds, Array.from({ length: (2 + npcCount) * 20 - 1 }, (_, index) => (2 + npcCount) * 20 - index));
  assert.equal(f.db.paths().filter((path) => path.includes('/serverGames/')).length, 1);
  assert.equal(f.db.peek(f.gamePath(room)).state.players.length, 2 + npcCount);
});

test('NPC decisions before a draw are independent of hidden future deck order', async () => {
  const f = fixture(); const room = await f.ready(2); await f.draw(room);
  const game = f.db.peek(f.gamePath(room));
  const offered = core.applyMatchAction(game.state, { type: 'offer', target: 2, seat: 0, revision: game.state.revision });
  const alternative = structuredClone(offered);
  alternative.deck.splice(alternative.deckCursor, alternative.deck.length - alternative.deckCursor, ...alternative.deck.slice(alternative.deckCursor).reverse());
  const observations = [];
  const advance = (state) => advanceNpcTurns(core, (visible, legal) => {
    observations.push(visible); return chooseCpuAction(visible, legal);
  }, state);
  const left = advance(offered); const leftInputs = observations.splice(0);
  const right = advance(alternative);
  assert.deepEqual(leftInputs, observations);
  assert.deepEqual(left.commands, right.commands);
  assert.equal(core.getDecision(left.state).seat, 0);
  assert.equal(core.assertMatchInvariants(left.state), true); assert.equal(core.assertMatchInvariants(right.state), true);
});

test('NPC loop enforces its hard bound even if a future transition ceases making progress', async () => {
  const state = core.createMatch({ playerCount: 4, humanSeat: -1 }); state.activeSeat = 2;
  const before = structuredClone(state); let count = 0;
  const stuckCore = { ...core, applyMatchAction(current) { count += 1; return { ...current, revision: current.revision + 1 }; } };
  assert.throws(() => advanceNpcTurns(stuckCore, (visible, legal) => legal[0], state), (error) => error.details?.reason === 'npc-action-budget');
  assert.equal(count, MAX_NPC_ACTIONS_PER_OPERATION); assert.deepEqual(state, before);
});

test('one human operation with multiple NPC transitions consumes only one rate admission', async () => {
  const f = fixture({ rateLimits: { ...generousRates, submit: { limit: 2, windowMillis: 60000 } } });
  const room = await f.ready(2); await f.draw(room);
  const request = f.request('host', f.actionData(room, { type: 'offer', target: 2 }));
  const result = await f.handlers.floatingGardenSubmitAction(request);
  assert.equal(result.room.match.revision, 4);
  assert.equal(f.db.peek(`floatingGardenRateLimits/submit_uid_${contract.uidKey('host')}`).count, 2);
  assert.deepEqual(await f.handlers.floatingGardenSubmitAction(request), result);
  await reject(f.act(room, core.legalActions(result.room.match)[0]), 'resource-exhausted');
});

for (const target of ['room', 'member', 'game']) test(`${target} expiry during NPC work rolls back all action writes`, async () => {
  const f = fixture({ cpuLoader: async () => ({ chooseCpuAction(visible, legal) {
    f.advance(1); return chooseCpuAction(visible, legal);
  } }) });
  const room = await f.ready(2); await f.draw(room);
  const paths = { room: f.roomPath(room), member: `${f.roomPath(room)}/members/host`, game: f.gamePath(room) };
  f.db.set(paths[target], { ...f.db.peek(paths[target]), expiresAtMillis: START + 1 });
  const before = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, f.db.peek(path)]));
  const request = f.request('host', f.actionData(room, { type: 'offer', target: 2 }));
  await reject(f.handlers.floatingGardenSubmitAction(request), 'failed-precondition', 'room-expired');
  for (const [name, path] of Object.entries(paths)) assert.deepEqual(f.db.peek(path), before[name]);
  assert.equal(f.db.peek(`floatingGardenActionRequests/${contract.uidKey('host')}_${request.data.requestId}`), undefined);
});

test('room expiry during start shuffle leaves the lobby and receipt unchanged', async () => {
  const f = fixture({ randomInt: (bound) => { f.advance(1); return bound - 1; } });
  const room = await f.create(2); await f.join(room);
  f.db.set(f.roomPath(room), { ...f.db.peek(f.roomPath(room)), expiresAtMillis: START + 1 });
  const before = f.db.peek(f.roomPath(room));
  await reject(f.handlers.floatingGardenStartMatch(f.request('host', { roomId: room.roomId, expectedRevision: 2, requestId: f.id() })), 'failed-precondition', 'room-expired');
  assert.deepEqual(f.db.peek(f.roomPath(room)), before);
  assert.equal(f.db.paths().filter((path) => path.includes('/serverGames/')).length, 0);
});

test('corrupt or mixed room modes fail closed on snapshot, resume, start and actions', async () => {
  const f = fixture(); const room = await f.create(2); await f.join(room);
  const lobby = f.db.peek(f.roomPath(room));
  for (const patch of [{ npcCount: 3 }, { npcCount: '2' }, { playerCount: 3 }, { npcCount: undefined }, { players: [...lobby.players, { seat: 2, name: 'NPC' }] }]) {
    f.db.set(f.roomPath(room), { ...lobby, ...patch });
    await reject(f.get(room), 'internal'); await reject(f.join(room), 'internal');
    await reject(f.handlers.floatingGardenStartMatch(f.request('host', { roomId: room.roomId, expectedRevision: 2, requestId: f.id() })), 'internal');
  }
  assert.equal(f.db.paths().filter((path) => path.includes('/serverGames/')).length, 0);
  f.db.set(f.roomPath(room), lobby);
  const snapshot = await f.handlers.floatingGardenStartMatch(f.request('host', { roomId: room.roomId, expectedRevision: 2, requestId: f.id() }));
  const original = f.db.peek(f.roomPath(room)); const game = f.db.peek(f.gamePath(room));
  for (const patch of [{ npcCount: 1 }, { players: original.players.slice(0, 3) }, { match: { ...original.match, players: original.match.players.slice(0, 3) } }]) {
    f.db.set(f.roomPath(room), { ...original, ...patch });
    await reject(f.get(room), 'internal');
    await reject(f.act(room, core.legalActions(snapshot.room.match)[0]), 'internal');
    assert.deepEqual(f.db.peek(f.gamePath(room)), game);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createMemoryStore } from './helpers/floating-garden-store.mjs';
import * as canonical from '../lab/floating-garden/match-engine.js';
import * as canonicalEngine from '../lab/floating-garden/engine.js';
const require = createRequire(import.meta.url);
const { createHandlers, loadCore, secureMatch, RATE_LIMITS } = require('../functions/floating-garden-online/handlers.js');
const contract = require('../functions/floating-garden-online/contract.js');
const invitation = require('../functions/floating-garden-online/invite-code.js');
const KEY = 'fixture-floating-garden-hmac-key-for-local-tests-only';
const START = 1700000000000;
const generousRates = Object.fromEntries(Object.entries(RATE_LIMITS).map(([type, value]) => [type, { ...value, limit: 10000, ...(value.ipLimit ? { ipLimit: 10000 } : {}) }]));
function fixture(options = {}) {
  const db = createMemoryStore();
  let clock = START;
  let requestNumber = 0;
  const handlers = createHandlers({ db, now: () => clock, inviteSecret: () => KEY, rateLimits: generousRates, ...options });
  function request(uid, data) { return { auth: uid ? { uid } : null, rawRequest: { ip: '127.0.0.1' }, data }; }
  function requestId() { return `request-${String(++requestNumber).padStart(6, '0')}`; }
  async function create(uid = 'host', displayName = '星の庭', id = requestId()) { return handlers.floatingGardenCreateRoom(request(uid, { displayName, requestId: id })); }
  async function join(room, uid = 'guest', displayName = '月の庭', id = requestId()) { return handlers.floatingGardenJoinRoom(request(uid, { displayName, inviteCode: room.inviteCode, requestId: id })); }
  async function get(room, uid = 'host') { return handlers.floatingGardenGetSnapshot(request(uid, { roomId: room.roomId })); }
  async function ready() {
    const room = await create(); await join(room);
    const { room: current } = await get(room);
    const result = await handlers.floatingGardenStartMatch(request('host', { roomId: room.roomId, expectedRevision: current.revision, requestId: requestId() }));
    return { ...room, snapshot: result };
  }
  function actionData(room, command, id = requestId()) {
    const snapshot = db.peek(`floatingGardenRooms/${room.roomId}`);
    const { seat, revision, ...payload } = command;
    return { roomId: room.roomId, gameId: snapshot.gameId, rulesVersion: contract.RULES_VERSION,
      expectedRevision: snapshot.match.revision, requestId: id, command: payload };
  }
  async function act(room, command, uid = command.seat === 0 ? 'host' : 'guest', id) {
    return handlers.floatingGardenSubmitAction(request(uid, actionData(room, command, id)));
  }
  return { db, handlers, request, requestId, create, join, get, ready, actionData, act, advance: (millis) => { clock += millis; } };
}
const rejectsCode = (promise, code, reason) => assert.rejects(promise, (error) => error.code === code && (!reason || error.details?.reason === reason));
function random(seed) { let value = seed; return (max) => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value % max; }; }

for (const name of ['engine.js', 'match-engine.js']) test(`server stages byte-identical ${name}`, async () => {
  assert.deepEqual(await readFile(new URL(`../functions/floating-garden-online/core/${name}`, import.meta.url)), await readFile(new URL(`../lab/floating-garden/${name}`, import.meta.url)));
});
test('staged core is an isolated ESM package', async () => {
  assert.equal(JSON.parse(await readFile(new URL('../functions/floating-garden-online/core/package.json', import.meta.url))).type, 'module');
  assert.equal((await loadCore()).MATCH_VERSION, canonical.MATCH_VERSION);
});
for (const playerCount of [2, 3, 4]) test(`canonical and staged core have complete ${playerCount}-seat replay parity`, async () => {
  const staged = await loadCore();
  for (let seed = 1; seed <= 5; seed += 1) {
    let left = secureMatch(staged, random(seed), playerCount);
    let right = structuredClone(left);
    const choose = random(seed * 991);
    let transitions = 0;
    while (left.phase !== 'finished') {
      assert.deepEqual(staged.legalActions(left), canonical.legalActions(right));
      const actions = canonical.legalActions(right);
      const action = actions[choose(actions.length)];
      left = staged.applyMatchAction(left, action);
      right = canonical.applyMatchAction(right, action);
      assert.deepEqual(left, right);
      assert.equal(staged.assertMatchInvariants(left), true);
      assert.ok(++transitions < 500);
    }
    assert.deepEqual(staged.rankMatch(left), canonical.rankMatch(right));
    assert.ok(left.players.every((player) => player.garden.filter(Boolean).length === 16));
    assert.equal(new Set(left.players.map((player) => player.careCount)).size, 1);
  }
});
test('online shuffle uses injected crypto-range entropy and preserves exact inventory', async () => {
  const core = await loadCore(); const bounds = [];
  const state = secureMatch(core, (bound) => { bounds.push(bound); return 0; });
  assert.deepEqual(bounds, Array.from({ length: 39 }, (_, index) => 40 - index));
  const inventory = core.createMatch({ playerCount: 2, humanSeat: -1, seed: 'server-shuffled' });
  assert.notDeepEqual(state.deck, inventory.deck);
  assert.deepEqual(state.deck.slice().sort((a, b) => a.id.localeCompare(b.id)), inventory.deck.slice().sort((a, b) => a.id.localeCompare(b.id)));
  assert.throws(() => secureMatch(core, () => 999), /random index/);
});
test('production invitation configuration fails closed; fallback is demo-emulator-only', () => {
  for (const env of [{}, { FUNCTIONS_EMULATOR: 'true' }, { FUNCTIONS_EMULATOR: 'true', FIRESTORE_EMULATOR_HOST: 'localhost:8182', GCLOUD_PROJECT: 'production' }, { FIRESTORE_EMULATOR_HOST: 'localhost:8182', GCLOUD_PROJECT: 'demo-garden' }]) {
    assert.throws(() => invitation.requireInviteHmacKey(() => '', env), /must be configured/);
    assert.throws(() => invitation.requireInviteHmacKey(() => { throw new Error('unavailable'); }, env), /must be configured/);
  }
  assert.equal(invitation.requireInviteHmacKey(() => '', { FUNCTIONS_EMULATOR: 'true', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8182', GCLOUD_PROJECT: 'demo-garden' }), invitation.EMULATOR_ONLY_KEY);
  assert.equal(invitation.requireInviteHmacKey(() => KEY, {}), KEY);
  assert.throws(() => invitation.requireInviteHmacKey(() => 'short', {}), /must be configured/);
});
test('invitation is scoped, deterministic, verifiable and strict to parse', () => {
  const one = invitation.createInviteCode('a:b', 'c', KEY);
  assert.deepEqual(one, invitation.createInviteCode('a:b', 'c', KEY));
  assert.notEqual(one.code, invitation.createInviteCode('a', 'b:c', KEY).code);
  assert.deepEqual(invitation.parseInviteCode(one.code), { locator: one.locator, secret: one.secret });
  assert.equal(invitation.parseInviteCode(`MSD1${one.code}`), null);
  assert.equal(invitation.parseInviteCode(`<${one.code}>`), null);
  assert.equal(invitation.safeEqual(invitation.inviteMac(one.locator, one.secret, KEY), invitation.inviteMac(one.locator, one.secret, `${KEY}2`)), false);
});
test('all endpoints require authentication before any database work', async () => {
  const f = fixture();
  for (const handler of Object.values(f.handlers)) await rejectsCode(handler(f.request(null, {})), 'unauthenticated');
  assert.equal(f.db.paths().length, 0);
});
test('create sanitizes display name and stores public-only room, private membership and hashed invite', async () => {
  const f = fixture(); const created = await f.create('private-host-uid', '  <星>\u202e\u0000  庭  ');
  const room = f.db.peek(`floatingGardenRooms/${created.roomId}`);
  assert.deepEqual(room.players, [{ seat: 0, name: '星 庭' }]);
  assert.deepEqual(Object.keys(room).sort(), ['id', 'status', 'hostSeat', 'playerCount', 'gameId', 'revision', 'rulesVersion', 'expiresAtMillis', 'players', 'match', 'scores'].sort());
  assert.equal(JSON.stringify(room).includes('private-host-uid'), false);
  assert.deepEqual(f.db.peek(`floatingGardenRooms/${created.roomId}/members/private-host-uid`), { seat: 0, isHost: true, active: true, expiresAtMillis: START + contract.ROOM_TTL_MILLIS });
  const locator = f.db.peek(`floatingGardenInvites/${invitation.parseInviteCode(created.inviteCode).locator}`);
  assert.equal(JSON.stringify(locator).includes(created.inviteCode), false);
  assert.equal(locator.verifier.length, 64);
  assert.equal(JSON.stringify(f.db.entries()).includes(created.inviteCode), false);
  assert.equal(JSON.stringify(f.db.entries()).includes(invitation.parseInviteCode(created.inviteCode).secret), false);
});
test('name, object shape and payload size validation reject unbounded or injected input', async () => {
  const f = fixture();
  for (const displayName of ['', ' ', 'x'.repeat(21), 'x'.repeat(201), {}, null]) await rejectsCode(f.create('host', displayName), 'invalid-argument');
  await rejectsCode(f.handlers.floatingGardenCreateRoom(f.request('host', { displayName: '庭', requestId: f.requestId(), playerCount: 4 })), 'invalid-argument');
  assert.equal(f.db.paths().length, 0);
});
test('parallel duplicate create converges to one room and original invitation', async () => {
  const f = fixture(); const id = f.requestId();
  const results = await Promise.all(Array.from({ length: 8 }, () => f.create('host', '庭', id)));
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.equal(f.db.paths().filter((path) => /^floatingGardenRooms\/[^/]+$/.test(path)).length, 1);
  assert.equal(f.db.paths().filter((path) => path.startsWith('floatingGardenActionRequests/')).length, 1);
  assert.ok(f.db.transactionAttempts > 8);
  await rejectsCode(f.create('host', '別の庭', id), 'already-exists', 'request-id-reused');
  assert.deepEqual(await f.create('host', '庭', id), results[0]);
});
test('parallel same-ID create retries share the rate admission even at limit one', async () => {
  const f = fixture({ rateLimits: { ...generousRates, create: { limit: 1, ipLimit: 1, windowMillis: 60000 } } });
  const id = f.requestId();
  const results = await Promise.all(Array.from({ length: 12 }, () => f.create('host', '庭', id)));
  assert.ok(results.every((result) => result.roomId === results[0].roomId));
  assert.equal(f.db.peek(`floatingGardenRateLimits/create_uid_${contract.uidKey('host')}`).count, 1);
  await rejectsCode(f.create(), 'resource-exhausted');
});
test('receipt identity is UID-scoped without delimiter collisions and accepts property reorder only', async () => {
  const f = fixture();
  const left = await f.create('host_a', '庭', 'request_same');
  const right = await f.create('host', '庭', 'a_request_same');
  assert.notEqual(left.roomId, right.roomId);
  const request = { requestId: 'request_same', displayName: '庭' };
  assert.deepEqual(await f.handlers.floatingGardenCreateRoom(f.request('host_a', request)), left);
  await rejectsCode(f.create('host_a', ' 庭 ', 'request_same'), 'already-exists');
  const special = await f.create('host_a', '庭', '__proto__');
  assert.deepEqual(await f.create('host_a', '庭', '__proto__'), special);
});
test('identifier collisions reject without modifying another room or invitation', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const f = fixture({ randomUUID: () => id });
  const room = await f.create(); const before = f.db.peek(`floatingGardenRooms/${id}`);
  await rejectsCode(f.create('other'), 'failed-precondition', 'identifier-collision');
  assert.deepEqual(f.db.peek(`floatingGardenRooms/${id}`), before);
  assert.equal((await f.get(room)).room.players[0].name, '星の庭');
});
test('join authenticates invite; same UID resumes one seat; competing guests cannot exceed two', async () => {
  const f = fixture(); const room = await f.create();
  await rejectsCode(f.join({ ...room, inviteCode: room.inviteCode.slice(0, -1) + (room.inviteCode.endsWith('0') ? '1' : '0') }), 'not-found');
  const outcomes = await Promise.allSettled([f.join(room, 'guest'), f.join(room, 'other')]);
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
  const failed = outcomes.find((item) => item.status === 'rejected').reason;
  assert.equal(failed.details.reason, 'room-full');
  assert.deepEqual(await f.join(room, 'host', 'attempt rename'), { roomId: room.roomId, seat: 0 });
  assert.equal((await f.get(room)).room.players.length, 2);
});
test('parallel duplicate join creates only one guest membership', async () => {
  const f = fixture(); const room = await f.create(); const id = f.requestId();
  const result = await Promise.all([f.join(room, 'guest', '月', id), f.join(room, 'guest', '月', id)]);
  assert.deepEqual(result[0], result[1]);
  assert.equal(f.db.paths().filter((path) => path.includes('/members/')).length, 2);
  assert.equal((await f.get(room)).room.revision, 2);
});
test('nonmember and inactive member cannot read; own member seat is authoritative', async () => {
  const f = fixture(); const room = await f.create();
  await rejectsCode(f.get(room, 'outside'), 'permission-denied');
  const path = `floatingGardenRooms/${room.roomId}/members/host`;
  const original = f.db.peek(path);
  f.db.set(path, { ...original, active: false });
  await rejectsCode(f.get(room), 'permission-denied');
  f.db.set(path, { ...original, seat: 1 });
  await rejectsCode(f.get(room), 'permission-denied');
});
test('start requires host, two members and exact lobby revision', async () => {
  const f = fixture(); const room = await f.create();
  const start = (uid, revision) => f.handlers.floatingGardenStartMatch(f.request(uid, { roomId: room.roomId, expectedRevision: revision, requestId: f.requestId() }));
  await rejectsCode(start('host', 1), 'failed-precondition', 'room-not-ready');
  await f.join(room);
  await rejectsCode(start('guest', 2), 'permission-denied');
  await rejectsCode(start('host', 1), 'failed-precondition', 'stale-revision');
  const output = await start('host', 2);
  assert.equal(output.room.revision, 3); assert.equal(output.room.match.revision, 0);
  assert.equal(output.room.match.deckRemaining, 40); assert.equal(output.room.status, 'playing');
  assert.deepEqual(output.self, { seat: 0, isHost: true });
  await rejectsCode(f.join(room, 'other'), 'failed-precondition', 'match-already-started');
  assert.equal((await f.join(room, 'guest')).seat, 1);
});
test('parallel duplicate start fixes game/order once, even across transaction retries', async () => {
  let randomCalls = 0;
  const f = fixture({ randomInt: (bound) => { randomCalls += 1; return bound - 1; } });
  const room = await f.create(); await f.join(room);
  const request = f.request('host', { roomId: room.roomId, expectedRevision: 2, requestId: f.requestId() });
  const result = await Promise.all([f.handlers.floatingGardenStartMatch(request), f.handlers.floatingGardenStartMatch(request)]);
  assert.deepEqual(result[0], result[1]); assert.equal(randomCalls, 78);
  assert.equal(f.db.paths().filter((path) => path.includes('/serverGames/')).length, 1);
  const saved = f.db.peek(`floatingGardenRooms/${room.roomId}/serverGames/${result[0].room.gameId}`);
  assert.deepEqual(saved.initialState, saved.state);
});
test('join racing stale start never starts with the wrong lobby revision', async () => {
  const f = fixture(); const room = await f.create();
  const results = await Promise.allSettled([
    f.join(room),
    f.handlers.floatingGardenStartMatch(f.request('host', { roomId: room.roomId, expectedRevision: 1, requestId: f.requestId() })),
  ]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
  const snapshot = await f.get(room); assert.equal(snapshot.room.status, 'waiting'); assert.equal(snapshot.room.players.length, 2);
});
test('public projection recursively excludes future secret fields and keeps legalActions compatible', async () => {
  const core = await loadCore(); const state = secureMatch(core, random(1));
  state.uid = 'SECRET'; state.private = 'SECRET'; state.players[0].uid = 'SECRET'; state.players[0].storage = { ...state.deck[0], secret: 'SECRET' };
  state.drawn = { tile: { ...state.deck[1], secret: 'SECRET' }, ownerSeat: 0, source: 'draw', protected: false, canOffer: true, canStore: true, secret: 'SECRET' };
  const projected = contract.toPublicSnapshot(state);
  assert.equal(JSON.stringify(projected).includes('SECRET'), false);
  for (const key of ['deck', 'deckCursor', 'seed', 'uid', 'private']) assert.equal(Object.hasOwn(projected, key), false);
  assert.deepEqual(core.getDecision(projected), core.getDecision(state));
  assert.deepEqual(core.legalActions(projected), core.legalActions(state));
  projected.players[0].garden[0] = 'changed'; assert.equal(state.players[0].garden[0], null);
});
test('submit rejects unauthorized actor, stale game/version/revision, injected seat/tile/score and extra fields', async () => {
  const f = fixture(); const room = await f.ready(); const draw = canonical.legalActions(room.snapshot.room.match)[0];
  const base = f.actionData(room, draw);
  await rejectsCode(f.handlers.floatingGardenSubmitAction(f.request('guest', base)), 'permission-denied');
  await rejectsCode(f.handlers.floatingGardenSubmitAction(f.request('outside', base)), 'permission-denied');
  for (const [patch, code, reason] of [
    [{ gameId: '11111111-1111-4111-8111-111111111111' }, 'failed-precondition', 'wrong-game'],
    [{ rulesVersion: 'old' }, 'failed-precondition', 'rules-version'],
    [{ expectedRevision: 1 }, 'failed-precondition', 'stale-revision'],
    [{ command: { type: 'draw', seat: 0 } }, 'invalid-argument'],
    [{ command: { type: 'draw', revision: 0 } }, 'invalid-argument'],
    [{ command: { type: 'draw', tile: { terrain: 'magic' } } }, 'invalid-argument'],
    [{ score: 999 }, 'invalid-argument'],
    [{ command: { type: 'place', index: -1, rotation: 0 } }, 'invalid-argument'],
    [{ command: { type: 'place', index: 0, rotation: 4 } }, 'invalid-argument'],
    [{ command: { type: 'self' } }, 'failed-precondition', 'illegal-action'],
  ]) await rejectsCode(f.handlers.floatingGardenSubmitAction(f.request('host', { ...base, ...patch, requestId: f.requestId() })), code, reason);
  assert.equal((await f.get(room)).room.match.revision, 0);
});
test('parallel duplicate submit/lost-response replay advances once and preserves immutable original result', async () => {
  const f = fixture(); const room = await f.ready(); const draw = canonical.legalActions(room.snapshot.room.match)[0];
  const request = f.request('host', f.actionData(room, draw));
  const results = await Promise.all(Array.from({ length: 6 }, () => f.handlers.floatingGardenSubmitAction(request)));
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.equal(results[0].room.match.revision, 1); assert.equal(results[0].room.match.deckRemaining, 39);
  await f.act(room, canonical.legalActions(results[0].room.match).find((action) => action.type === 'store'));
  const replay = await f.handlers.floatingGardenSubmitAction(request);
  assert.deepEqual(replay, results[0]); assert.equal((await f.get(room)).room.match.revision, 2);
  await rejectsCode(f.handlers.floatingGardenSubmitAction(f.request('host', { ...request.data, command: { type: 'store' } })), 'already-exists', 'request-id-reused');
});
test('receipt replay rechecks current membership and room in its transaction', async () => {
  const f = fixture(); const id = f.requestId(); const room = await f.create('host', '庭', id);
  const path = `floatingGardenRooms/${room.roomId}/members/host`;
  f.db.set(path, { ...f.db.peek(path), active: false });
  await rejectsCode(f.create('host', '庭', id), 'permission-denied');
});
test('different request IDs for a concurrent same-seat action allow only one revision', async () => {
  const f = fixture(); const room = await f.ready();
  const command = canonical.legalActions(room.snapshot.room.match)[0];
  const left = f.actionData(room, command); const right = f.actionData(room, command);
  const results = await Promise.allSettled([f.handlers.floatingGardenSubmitAction(f.request('host', left)), f.handlers.floatingGardenSubmitAction(f.request('host', right))]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(results.find((item) => item.status === 'rejected').reason.details.reason, 'stale-revision');
  assert.equal((await f.get(room)).room.match.revision, 1);
});
test('snapshot does not mutate match; response/placement states survive disconnection and reload', async () => {
  const f = fixture(); const room = await f.ready();
  let snapshot = room.snapshot;
  for (const type of ['draw', 'offer', 'accept']) {
    const action = canonical.legalActions(snapshot.room.match).find((item) => item.type === type);
    snapshot = await f.act(room, action);
    const gamePath = `floatingGardenRooms/${room.roomId}/serverGames/${snapshot.room.gameId}`;
    const before = f.db.peek(gamePath);
    f.advance(60000);
    assert.deepEqual((await f.get(room, 'guest')).room, snapshot.room);
    assert.deepEqual(f.db.peek(gamePath), before);
  }
  assert.equal(snapshot.room.match.step, 'place'); assert.equal(canonical.getDecision(snapshot.room.match).seat, 1);
  await rejectsCode(f.act(room, canonical.legalActions(snapshot.room.match)[0], 'host'), 'permission-denied');
});
test('expiry blocks snapshot, joining, new moves and receipt replays without resurrecting rooms', async () => {
  const f = fixture(); const id = f.requestId(); const room = await f.create('host', '庭', id);
  f.advance(contract.ROOM_TTL_MILLIS);
  await rejectsCode(f.get(room), 'failed-precondition', 'room-expired');
  await rejectsCode(f.create('host', '庭', id), 'failed-precondition', 'room-expired');
  await rejectsCode(f.join(room), 'not-found');
  const receipt = f.db.entries().find(([path]) => path.startsWith('floatingGardenActionRequests/'))[1];
  assert.equal(receipt.expiresAt, START + contract.ROOM_TTL_MILLIS + contract.RECEIPT_RETENTION_MILLIS);
  assert.equal(f.db.paths().filter((path) => /^floatingGardenRooms\/[^/]+$/.test(path)).length, 1);
});
test('failed invite attempts consume rate budgets, successful retry does not and window resets', async () => {
  const low = { ...generousRates, create: { limit: 1, ipLimit: 2, windowMillis: 1000 }, join: { limit: 2, ipLimit: 100, windowMillis: 1000 } };
  const f = fixture({ rateLimits: low }); const id = f.requestId(); const room = await f.create('host', '庭', id);
  assert.deepEqual(await f.create('host', '庭', id), room);
  await rejectsCode(f.create(), 'resource-exhausted');
  await rejectsCode(f.join({ inviteCode: 'bad' }), 'not-found');
  await rejectsCode(f.join({ inviteCode: 'bad' }), 'not-found');
  await rejectsCode(f.join(room), 'resource-exhausted');
  f.advance(1000); assert.equal((await f.join(room)).seat, 1);
  assert.equal((await f.create()).seat, 0);
  assert.equal(JSON.stringify(f.db.entries().filter(([path]) => path.startsWith('floatingGardenRateLimits/'))).includes('127.0.0.1'), false);
});
test('key rotation never returns a regenerated code that was not stored', async () => {
  let key = KEY; const f = fixture({ inviteSecret: () => key }); const id = f.requestId();
  await f.create('host', '庭', id); key += '-rotated';
  await rejectsCode(f.create('host', '庭', id), 'failed-precondition', 'invitation-unavailable');
});
test('missing invitation configuration produces no room, receipt or rate writes', async () => {
  const f = fixture({ inviteSecret: () => { throw new Error('not configured'); } });
  await rejectsCode(f.create(), 'unavailable'); assert.equal(f.db.paths().length, 0);
});
test('server completes multiple two-human games with all rule branches, matching final scores and replay', async () => {
  const seen = new Set();
  for (let seed = 1; seed <= 8; seed += 1) {
    const choose = random(seed * 9283); const f = fixture({ randomInt: random(seed) }); const room = await f.ready();
    let snapshot = room.snapshot;
    while (snapshot.room.status !== 'finished') {
      const actions = canonical.legalActions(snapshot.room.match);
      const missing = actions.find((action) => !seen.has(action.type));
      const action = missing || actions[choose(actions.length)]; seen.add(action.type);
      snapshot = await f.act(room, action);
      assert.deepEqual((await f.get(room, 'guest')).room, snapshot.room);
      assert.ok(snapshot.room.match.revision < 500);
    }
    const game = f.db.peek(`floatingGardenRooms/${room.roomId}/serverGames/${snapshot.room.gameId}`);
    let replay = game.initialState;
    for (const command of game.commands) replay = canonical.applyMatchAction(replay, command);
    assert.deepEqual(replay, game.state);
    assert.ok(Buffer.byteLength(JSON.stringify(game)) < 1024 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot.room)) < 1024 * 1024);
    assert.deepEqual(snapshot.room.scores, canonical.rankMatch(replay));
    assert.ok(snapshot.room.match.players.every((player) => player.garden.filter(Boolean).length === 16));
    assert.equal(new Set(snapshot.room.match.players.map((player) => player.careCount)).size, 1);
    for (const player of snapshot.room.match.players) assert.equal(snapshot.room.scores.find((score) => score.seat === player.seat).score, canonicalEngine.scoreGarden(player.garden).total);
    await rejectsCode(f.handlers.floatingGardenSubmitAction(f.request('host', f.actionData(room, { type: 'draw' }))), 'failed-precondition', 'match-finished');
  }
  assert.deepEqual([...seen].sort(), ['draw', 'use-storage', 'self', 'offer', 'store', 'accept', 'decline', 'request-invite', 'pass-invite', 'welcome', 'yield', 'place', 'meditate', 'stone', 'pass-final'].sort());
});

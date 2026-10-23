/** First NPC rollout boundary, using the real immutable pre-NPC generator/runtime.
 * No network, deployed service, credentials, simulated old readRoom, or source rewrite.
 * Firestore request contexts/transactions are fixtures; both cores load from their bundles.
 * A failed request may charge its separate rate budget, never room/game/member/receipt data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareTrialBundle } from '../scripts/prepare-floating-garden-trial.mjs';
import { createMemoryStore } from './helpers/floating-garden-store.mjs';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BASELINE = 'ce20dce88490ee42cc8e427ab90b0b2c8a576c95';
const LEGACY = 'floating-garden-match-1';
const NPC = 'floating-garden-online-npc-1';
const START = Date.parse('2026-10-02T00:00:00Z');
const KEY = 'compatibility-test-hmac-key-never-used-by-a-live-service';
const configuration = {
  schemaVersion: 1, enabled: true, projectId: 'garden-trial-compatibility',
  previewOrigin: 'https://garden-trial-compatibility--garden-7day-a1b2c3.web.app',
  startsAtMillis: START, endsAtMillis: START + 7 * 86400000, region: 'asia-northeast1', maxTesters: 2, maxRooms: 20,
  firebase: { apiKey: 'AIza' + 'a'.repeat(35), authDomain: 'garden-trial-compatibility.firebaseapp.com', projectId: 'garden-trial-compatibility', appId: '1:123456789:web:abcdef0123456789' },
  appCheck: { provider: 'recaptcha-enterprise', siteKey: '6L' + 'a'.repeat(38), verified: true },
};
const git = (...args) => execFileSync('git', args, { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 });
let temporary, legacy, current;
test.before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'garden-npc-compatibility-'));
  const oldRoot = join(temporary, 'immutable-pre-npc-source');
  // Full SHA, never HEAD/index/branch: a rollout commit cannot replace the adversarial code.
  assert.equal(git('rev-parse', `${BASELINE}^{commit}`).toString().trim(), BASELINE);
  const paths = git('ls-tree', '-r', '--name-only', BASELINE, '--', 'package.json', 'functions/package.json',
    'scripts/prepare-floating-garden-trial.mjs', 'functions/floating-garden-online',
    'functions/floating-garden-trial', 'lab/floating-garden').toString().trim().split('\n');
  for (const path of paths) {
    const destination = join(oldRoot, path); await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, git('show', `${BASELINE}:${path}`));
  }
  const oldGenerator = await import(pathToFileURL(join(oldRoot, 'scripts/prepare-floating-garden-trial.mjs')));
  async function generate(generator, name, repositoryRoot) {
    const output = join(temporary, name);
    await generator({ config: configuration, output, now: START, ...(repositoryRoot ? { repositoryRoot } : {}) });
    const runtime = require(join(output, 'functions/online/handlers.js'));
    return { output, runtime, contract: require(join(output, 'functions/online/contract.js')), core: await runtime.loadCore() };
  }
  legacy = await generate(oldGenerator.prepareTrialBundle, 'old-generated', oldRoot);
  current = await generate(prepareTrialBundle, 'new-generated');
});
test.after(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });

const fails = (promise, reason = 'rules-version', code = 'failed-precondition') =>
  assert.rejects(promise, (error) => error.code === code && error.details?.reason === reason);
const durable = (db) => db.entries().filter(([path]) => !path.startsWith('floatingGardenRateLimits/')).sort(([a], [b]) => a.localeCompare(b));
function fixture() {
  const db = createMemoryStore(); let serial = 0;
  const request = (uid, data) => ({ auth: { uid }, rawRequest: { ip: '127.0.0.1' }, data });
  const id = () => `compatibility-request-${++serial}`;
  const handlers = (bundle, store = db) => bundle.runtime.createHandlers({ db: store, now: () => START + 1000,
    inviteSecret: () => KEY, randomInt: () => 0,
    rateLimits: Object.fromEntries(Object.entries(bundle.runtime.RATE_LIMITS).map(([name, value]) => [name, {
      ...value, limit: 10000, ...(value.ipLimit ? { ipLimit: 10000 } : {}),
    }])),
    // Intentionally no coreLoader/cpuLoader substitutions.
  });
  const old = handlers(legacy), next = handlers(current);
  const roomPath = (room) => `floatingGardenRooms/${room.roomId}`;
  const gamePath = (room) => `${roomPath(room)}/serverGames/${db.peek(roomPath(room)).gameId}`;
  async function create(npcCount, api = next, requestId = id()) {
    const input = request('host', { displayName: 'Host', requestId, ...(npcCount === undefined ? {} : { npcCount }) });
    return { ...(await api.floatingGardenCreateRoom(input)), createRequest: input };
  }
  function joinRequest(room, uid = 'guest') { return request(uid, { inviteCode: room.inviteCode, displayName: 'Guest', requestId: id() }); }
  function startRequest(room, expectedRevision = db.peek(roomPath(room)).revision) {
    return request('host', { roomId: room.roomId, expectedRevision, requestId: id() });
  }
  async function ready(npcCount, api = next) {
    const room = await create(npcCount, api); const joining = joinRequest(room);
    const joined = await api.floatingGardenJoinRoom(joining); const starting = startRequest(room);
    const started = await api.floatingGardenStartMatch(starting);
    return { ...room, joining, joined, starting, started };
  }
  const snapshotRequest = (room, uid = 'host') => request(uid, { roomId: room.roomId });
  function actionRequest(room, action) {
    const stored = db.peek(roomPath(room)); const { seat, revision, ...command } = action;
    return request(seat === 0 ? 'host' : 'guest', { roomId: room.roomId, gameId: stored.gameId,
      expectedRevision: stored.match.revision, rulesVersion: stored.rulesVersion, command, requestId: id() });
  }
  return { db, old, next, handlers, request, id, roomPath, gamePath, create, ready, joinRequest, startRequest, snapshotRequest, actionRequest };
}
async function noMutation(f, action, reason = 'rules-version', code = 'failed-precondition') {
  const before = durable(f.db); await fails(action(), reason, code); assert.deepEqual(durable(f.db), before);
}
function forceReceiptTransactionRead(f, request) {
  const receiptPath = `floatingGardenActionRequests/${legacy.contract.uidKey(request.auth.uid)}_${request.data.requestId}`;
  assert.ok(f.db.peek(receiptPath), 'must exercise a real immutable accepted receipt');
  let forced = false;
  const db = { runTransaction: f.db.runTransaction, doc(path) {
    const ref = f.db.doc(path);
    return path !== receiptPath ? ref : { ...ref, get: async () => {
      forced = true; return { exists: false, data: () => undefined };
    } };
  } };
  return { api: f.handlers(legacy, db), assertUsed: () => assert.equal(forced, true) };
}

test('immutable old generator preserves the actual old rejection field and exact unchanged engine', async () => {
  const oldHandlers = await readFile(join(legacy.output, 'functions/online/handlers.js'));
  assert.deepEqual(oldHandlers, git('show', `${BASELINE}:functions/floating-garden-online/handlers.js`));
  assert.equal(legacy.contract.NPC_RULES_VERSION, undefined);
  assert.equal(legacy.contract.RULES_VERSION, LEGACY);
  assert.equal(current.contract.RULES_VERSION, LEGACY); assert.equal(current.contract.NPC_RULES_VERSION, NPC);
  for (const name of ['engine.js', 'match-engine.js']) {
    assert.deepEqual(await readFile(join(legacy.output, 'functions/online/core', name)), await readFile(join(current.output, 'functions/online/core', name)));
  }
  assert.equal(legacy.core.MATCH_VERSION, LEGACY); assert.equal(current.core.MATCH_VERSION, LEGACY);
});

for (const npcCount of [1, 2]) {
  test(`old code cannot join, start, submit or snapshot a new ${2 + npcCount}-seat waiting room`, async () => {
    const f = fixture(); const room = await f.create(npcCount);
    assert.equal(f.db.peek(f.roomPath(room)).rulesVersion, NPC);
    await noMutation(f, () => f.old.floatingGardenJoinRoom(f.joinRequest(room)));
    const joining = f.joinRequest(room); await f.next.floatingGardenJoinRoom(joining);
    for (const revision of [1, 2, 999]) await noMutation(f, () => f.old.floatingGardenStartMatch(f.startRequest(room, revision)));
    for (const uid of ['host', 'guest']) await noMutation(f, () => f.old.floatingGardenGetSnapshot(f.snapshotRequest(room, uid)));
    for (const rulesVersion of [LEGACY, NPC]) await noMutation(f, () => f.old.floatingGardenSubmitAction(f.request('host', {
      roomId: room.roomId, gameId: '00000000-0000-4000-8000-000000000001', rulesVersion,
      expectedRevision: 999, requestId: f.id(), command: { type: 'draw' },
    })));
    // Matching accepted join receipts hit both old replay paths, before any public projection.
    await noMutation(f, () => f.old.floatingGardenJoinRoom(joining));
    const forced = forceReceiptTransactionRead(f, joining);
    await noMutation(f, () => forced.api.floatingGardenJoinRoom(joining)); forced.assertUsed();
    assert.equal(f.db.paths().some((path) => path.includes('/serverGames/')), false);
  });

  test(`old late requests and both receipt lookup paths cannot mutate a playing ${2 + npcCount}-seat NPC room`, async () => {
    const f = fixture(); const room = await f.ready(npcCount);
    const saved = f.db.peek(f.roomPath(room)); const game = f.db.peek(f.gamePath(room));
    assert.equal(saved.rulesVersion, NPC); assert.equal(game.rulesVersion, NPC); assert.equal(game.state.version, LEGACY);
    for (const uid of ['host', 'guest', 'late-third-user']) await noMutation(f, () => f.old.floatingGardenJoinRoom(f.joinRequest(room, uid)));
    for (const revision of [2, saved.revision, 999]) await noMutation(f, () => f.old.floatingGardenStartMatch(f.startRequest(room, revision)));
    for (const uid of ['host', 'guest']) await noMutation(f, () => f.old.floatingGardenGetSnapshot(f.snapshotRequest(room, uid)));
    const draw = f.actionRequest(room, current.core.legalActions(saved.match)[0]);
    for (const rulesVersion of [LEGACY, NPC]) for (const expectedRevision of [0, 999]) {
      await noMutation(f, () => f.old.floatingGardenSubmitAction({ ...draw, data: { ...draw.data, rulesVersion, expectedRevision, requestId: f.id() } }));
    }
    for (const [method, request] of [['floatingGardenJoinRoom', room.joining], ['floatingGardenStartMatch', room.starting]]) {
      await noMutation(f, () => f.old[method](request));
      const forced = forceReceiptTransactionRead(f, request);
      await noMutation(f, () => forced.api[method](request)); forced.assertUsed();
    }
    // Hash identity stays immutable even when a delayed client changes expectedRevision.
    await noMutation(f, () => f.old.floatingGardenStartMatch({ ...room.starting, data: { ...room.starting.data, expectedRevision: 999 } }), 'request-id-reused', 'already-exists');
    const accepted = await f.next.floatingGardenSubmitAction(draw);
    await noMutation(f, () => f.old.floatingGardenSubmitAction(draw)); // old wire check rejects before receipt lookup
    await noMutation(f, () => f.old.floatingGardenSubmitAction({ ...draw, data: { ...draw.data, rulesVersion: LEGACY } }), 'request-id-reused', 'already-exists');
    assert.deepEqual(await f.next.floatingGardenSubmitAction(draw), accepted);
    assert.deepEqual(await f.next.floatingGardenStartMatch(room.starting), room.started);
  });
}

test('old and new create races cannot reuse an identity to change a two-human room into an NPC room', async () => {
  for (const order of ['old-first', 'new-first', 'concurrent']) {
    const f = fixture(); const requestId = f.id();
    const oldRequest = f.request('host', { displayName: 'Host', requestId });
    const newRequest = { ...oldRequest, data: { ...oldRequest.data, npcCount: 2 } };
    const oldCreate = () => f.old.floatingGardenCreateRoom(oldRequest);
    const newCreate = () => f.next.floatingGardenCreateRoom(newRequest);
    let result;
    if (order === 'concurrent') {
      const outcomes = await Promise.allSettled([oldCreate(), newCreate()]);
      assert.equal(outcomes.filter((value) => value.status === 'fulfilled').length, 1);
      const failure = outcomes.find((value) => value.status === 'rejected').reason;
      assert.equal(failure.code, 'already-exists'); assert.equal(failure.details.reason, 'request-id-reused');
      result = outcomes.find((value) => value.status === 'fulfilled').value;
    } else {
      result = await (order === 'old-first' ? oldCreate() : newCreate());
      await noMutation(f, order === 'old-first' ? newCreate : oldCreate, 'request-id-reused', 'already-exists');
    }
    const saved = f.db.peek(f.roomPath(result));
    assert.equal(saved.rulesVersion, saved.playerCount === 2 ? LEGACY : NPC);
    assert.equal(f.db.paths().filter((path) => /^floatingGardenRooms\/[^/]+$/.test(path)).length, 1);
    assert.equal(f.db.paths().filter((path) => path.startsWith('floatingGardenActionRequests/')).length, 1);
    await assert.rejects(f.old.floatingGardenCreateRoom({ ...newRequest, data: { ...newRequest.data, requestId: f.id() } }), (error) => error.code === 'invalid-argument');
  }
});

for (const phase of ['waiting', 'playing', 'finished']) test(`new handlers recover actual old ${phase} rooms and exact legacy receipts without migration`, async () => {
  const f = fixture(); const room = await f.create(undefined, f.old);
  const samples = [['floatingGardenCreateRoom', room.createRequest, { roomId: room.roomId, seat: room.seat, inviteCode: room.inviteCode }]];
  const joining = f.joinRequest(room); samples.push(['floatingGardenJoinRoom', joining, await f.old.floatingGardenJoinRoom(joining)]);
  let snapshot = await f.old.floatingGardenGetSnapshot(f.snapshotRequest(room));
  if (phase !== 'waiting') {
    const starting = f.startRequest(room); snapshot = await f.old.floatingGardenStartMatch(starting);
    samples.push(['floatingGardenStartMatch', starting, snapshot]);
    let count = 0;
    do {
      const action = legacy.core.legalActions(snapshot.room.match)[0]; const request = f.actionRequest(room, action);
      snapshot = await f.old.floatingGardenSubmitAction(request);
      if (count++ % 31 === 0) samples.push(['floatingGardenSubmitAction', request, snapshot]);
      assert.ok(count < 600);
    } while (phase === 'finished' && snapshot.room.status !== 'finished');
  }
  const before = durable(f.db);
  for (const uid of ['host', 'guest']) assert.deepEqual(await f.next.floatingGardenGetSnapshot(f.snapshotRequest(room, uid)), await f.old.floatingGardenGetSnapshot(f.snapshotRequest(room, uid)));
  for (const [method, request, result] of samples) assert.deepEqual(await f.next[method](request), result);
  assert.deepEqual(durable(f.db), before);
  assert.equal(snapshot.room.rulesVersion, LEGACY); assert.equal(Object.hasOwn(snapshot.room, 'npcCount'), false);
  assert.equal(snapshot.room.status, phase);
  if (phase === 'waiting') snapshot = await f.next.floatingGardenStartMatch(f.startRequest(room));
  if (phase !== 'finished') {
    const action = current.core.legalActions(snapshot.room.match)[0]; const request = f.actionRequest(room, action);
    snapshot = await f.next.floatingGardenSubmitAction(request);
    assert.deepEqual(await f.old.floatingGardenSubmitAction(request), snapshot);
  }
});

for (const npcCount of [0, 1, 2]) test(`old and new identical engines replay every transition of a complete ${2 + npcCount}-seat new-protocol game`, async () => {
  const f = fixture(); const room = await f.ready(npcCount);
  let snapshot = room.started; let count = 0;
  while (snapshot.room.status !== 'finished') {
    const request = f.actionRequest(room, current.core.legalActions(snapshot.room.match)[0]);
    // A mixed-version two-human rollout is supported in both directions.
    snapshot = await (npcCount === 0 && count % 2 ? f.old : f.next).floatingGardenSubmitAction(request);
    assert.equal(snapshot.room.rulesVersion, npcCount ? NPC : LEGACY);
    assert.equal(snapshot.room.match.version, LEGACY); assert.ok(++count < 600);
  }
  const game = f.db.peek(f.gamePath(room));
  let oldState = game.initialState, newState = game.initialState;
  for (const command of game.commands) {
    oldState = legacy.core.applyMatchAction(oldState, command); newState = current.core.applyMatchAction(newState, command);
    assert.deepEqual(oldState, newState);
  }
  assert.deepEqual(newState, game.state); assert.equal(newState.phase, 'finished');
  assert.deepEqual(snapshot.room.scores, legacy.core.rankMatch(oldState));
  assert.deepEqual(snapshot.room.scores, current.core.rankMatch(newState));
});

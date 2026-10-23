import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createMemoryStore } from './helpers/floating-garden-store.mjs';
const require = createRequire(import.meta.url);
const { createHandlers, RATE_LIMITS } = require('../functions/floating-garden-online/handlers.js');
const { createTrialHandlers, GATE_PATH, USAGE_PATH } = require('../functions/floating-garden-trial/trial-handlers.js');
const { CALLABLE_NAMES, validateTrialConfig, renderTrialRules, MAX_TRIAL_MILLIS } = require('../functions/floating-garden-trial/config.js');
const START = 1700000000000;
const CONFIG = Object.freeze({ enabled: true, projectId: 'wa-garden-trial-unit', region: 'asia-northeast1',
  previewOrigin: 'https://wa-garden-trial-unit--trial-abc123.web.app', startsAtMillis: START, endsAtMillis: START + MAX_TRIAL_MILLIS, maxRooms: 20 });
const rates = Object.fromEntries(Object.entries(RATE_LIMITS).map(([name, value]) => [name, { ...value, limit: 10000, ...(value.ipLimit ? { ipLimit: 10000 } : {}) }]));
function fixture({ config = CONFIG, env = { GCLOUD_PROJECT: config.projectId }, database, ...options } = {}) {
  const db = database || createMemoryStore(); let now = START + 1000; let counter = 0;
  db.set(GATE_PATH, { ...config, testerUids: ['host', 'guest'] });
  db.set(USAGE_PATH, { projectId: config.projectId, startsAtMillis: START, endsAtMillis: config.endsAtMillis, maxRooms: 20, createdRoomCount: 0 });
  for (const uid of ['host', 'guest']) db.set(`floatingGardenTrialTesters/${uid}`, { active: true, expiresAtMillis: config.endsAtMillis });
  const handlers = createTrialHandlers({ config, db, env, now: () => now, trustedHandlersFactory: createHandlers,
    inviteSecret: () => 'local-only-fixture-32-character-hmac-secret', rateLimits: rates, ...options });
  const request = (uid = 'host', data = {}) => ({ auth: { uid }, app: { appId: 'fixture-app' }, rawRequest: { headers: { origin: config.previewOrigin }, ip: '127.0.0.1' }, data });
  const id = () => `trial-request-${++counter}`;
  const create = (requestId = id(), displayName = 'Garden') => handlers.floatingGardenCreateRoom(request('host', { displayName, requestId }));
  const snapshot = (room) => handlers.floatingGardenGetSnapshot(request('host', { roomId: room.roomId }));
  return { config, db, handlers, request, id, create, snapshot, setNow: (value) => { now = value; },
    patchGate: (patch) => db.set(GATE_PATH, { ...db.peek(GATE_PATH), ...patch }) };
}
const rejects = (promise, reason) => assert.rejects(promise, (error) => error.details?.reason === reason);
function gameEntries(db) { return db.entries().filter(([path]) => !path.startsWith('floatingGardenTrial')); }

test('static config rejects shared projects, loose origins and unbounded windows', () => {
  for (const projectId of ['wa-awesome', 'wa-awesome-mofumofu-stg', 'demo-project', 'garden-local-project', 'garden-localhost', '', 'Project', 'ab']) assert.throws(() => validateTrialConfig({ ...CONFIG, projectId }));
  for (const previewOrigin of ['http://wa-garden-trial-unit--trial-abc123.web.app', 'https://example.com', 'https://other-project--trial-abc123.web.app', 'https://wa-garden-trial-unit--trial-abc.web.app', 'https://wa-garden-trial-unit.web.app', `${CONFIG.previewOrigin}/`, `${CONFIG.previewOrigin}:443`, `${CONFIG.previewOrigin}?x=1`, '*', [CONFIG.previewOrigin], 'https://localhost', 'https://a:secret@example.com']) assert.throws(() => validateTrialConfig({ ...CONFIG, previewOrigin }));
  for (const patch of [{ enabled: undefined }, { extra: true }, { region: 'us-central1' }, { maxRooms: 21 }, { startsAtMillis: 0 }, { endsAtMillis: START }, { endsAtMillis: START + MAX_TRIAL_MILLIS + 1 }, { endsAtMillis: '1700604800000' }]) assert.throws(() => validateTrialConfig({ ...CONFIG, ...patch }));
  assert.equal(validateTrialConfig({ ...CONFIG, enabled: false }).enabled, false);
  assert.ok(Object.isFrozen(validateTrialConfig(CONFIG)));
});

for (const name of CALLABLE_NAMES) test(`${name} rejects auth/appcheck/origin before trusted reads or mutation`, async () => {
  for (const [reason, modify] of [
    ['trial-auth-required', (r) => { r.auth = null; }],
    ['trial-app-check-required', (r) => { delete r.app; }],
    ['trial-app-check-required', (r) => { r.app = {}; }],
    ['trial-origin-mismatch', (r) => { delete r.rawRequest.headers.origin; }],
    ['trial-origin-mismatch', (r) => { r.rawRequest.headers.origin = 'https://wa-awesome.web.app'; }],
    ['trial-origin-mismatch', (r) => { r.rawRequest.headers.origin = `${CONFIG.previewOrigin}.evil.example`; }],
    ['trial-origin-mismatch', (r) => { r.rawRequest.headers.origin = [CONFIG.previewOrigin]; }],
  ]) {
    const f = fixture(); const request = f.request(); modify(request);
    const before = f.db.entries(); await rejects(f.handlers[name](request), reason);
    assert.deepEqual(f.db.entries(), before); assert.equal(f.db.transactionAttempts, 0);
  }
});

for (const name of CALLABLE_NAMES) test(`${name} gates unenrolled, disabled, invalid or expired testers before DB mutation`, async () => {
  for (const [reason, mutate] of [
    ['trial-disabled', (f) => f.patchGate({ enabled: false })],
    ['trial-gate-mismatch', (f) => f.patchGate({ projectId: 'wa-awesome' })],
    ['trial-gate-mismatch', (f) => f.patchGate({ previewOrigin: 'https://elsewhere.example' })],
    ['trial-gate-mismatch', (f) => f.patchGate({ maxRooms: 21 })],
    ['trial-tester-not-enrolled', (f) => f.patchGate({ testerUids: ['guest', 'other'] })],
    ['trial-tester-not-enrolled', (f) => f.patchGate({ testerUids: ['host'] })],
    ['trial-tester-not-enrolled', (f) => f.patchGate({ testerUids: ['host', 'host'] })],
    ['trial-tester-not-enrolled', (f) => f.patchGate({ testerUids: ['host', 'guest', 'third'] })],
    ['trial-tester-not-enrolled', (f) => f.patchGate({ testerUids: ['host', 'bad/uid'] })],
    ['trial-tester-not-enrolled', (f) => f.db.set('floatingGardenTrialTesters/host', { active: false, expiresAtMillis: CONFIG.endsAtMillis })],
    ['trial-tester-not-enrolled', (f) => f.db.set('floatingGardenTrialTesters/host', { active: true, expiresAtMillis: START })],
    ['trial-tester-not-enrolled', (f) => f.db.set('floatingGardenTrialTesters/host', { active: true, expiresAtMillis: CONFIG.endsAtMillis + 1 })],
    ['trial-tester-not-enrolled', (f) => f.db.set('floatingGardenTrialTesters/host', { active: true, expiresAtMillis: String(CONFIG.endsAtMillis) })],
    ['trial-tester-not-enrolled', (f) => f.db.set('floatingGardenTrialTesters/host', {})],
  ]) {
    const f = fixture(); mutate(f); const before = f.db.entries();
    await rejects(f.handlers[name](f.request()), reason); assert.deepEqual(f.db.entries(), before);
  }
});

test('wrong runtime project and static disabled/window guards precede database work', async () => {
  for (const env of [{}, { GCLOUD_PROJECT: 'wa-awesome' }, { GCLOUD_PROJECT: 'wa-awesome-mofumofu-stg' }, { GCLOUD_PROJECT: CONFIG.projectId, GCP_PROJECT: 'other-project' }, { GCLOUD_PROJECT: CONFIG.projectId, FIREBASE_CONFIG: '{}' }, { GCLOUD_PROJECT: CONFIG.projectId, FIREBASE_CONFIG: 'invalid' }]) {
    const f = fixture({ env }); await rejects(f.create(), 'trial-project-mismatch'); assert.equal(f.db.transactionAttempts, 0); assert.deepEqual(gameEntries(f.db), []);
  }
  const disabled = fixture({ config: { ...CONFIG, enabled: false } }); await rejects(disabled.create(), 'trial-disabled'); assert.equal(disabled.db.transactionAttempts, 0);
  for (const time of [START - 1, CONFIG.endsAtMillis, CONFIG.endsAtMillis + 1]) { const f = fixture(); f.setNow(time); await rejects(f.create(), 'trial-outside-window'); assert.equal(f.db.transactionAttempts, 0); }
});

test('exactly twenty distinct rooms admitted, receipts remain idempotent at boundary', async () => {
  const f = fixture(); const accepted = [];
  for (let n = 0; n < 20; n += 1) accepted.push(await f.create(`twenty-room-${n}`));
  assert.equal(new Set(accepted.map((r) => r.roomId)).size, 20);
  assert.equal(f.db.peek(USAGE_PATH).createdRoomCount, 20);
  await rejects(f.create('room-twenty-one'), 'trial-room-limit');
  assert.deepEqual(await f.create('twenty-room-0'), accepted[0]);
  assert.equal(f.db.peek(USAGE_PATH).createdRoomCount, 20);
  assert.equal(f.db.paths().filter((path) => /^floatingGardenRooms\/[^/]+$/.test(path)).length, 20);
});

test('concurrent same-ID retries create one room, receipt and admission', async () => {
  const f = fixture(); f.db.forceConflicts(4);
  const results = await Promise.all(Array.from({ length: 20 }, () => f.create('concurrent-same-request')));
  assert.ok(results.every((r) => r.roomId === results[0].roomId && r.inviteCode === results[0].inviteCode));
  assert.equal(f.db.peek(USAGE_PATH).createdRoomCount, 1);
  assert.equal(f.db.paths().filter((p) => p.startsWith('floatingGardenActionRequests/')).length, 1);
  assert.equal(f.db.paths().filter((p) => /^floatingGardenRooms\/[^/]+$/.test(p)).length, 1);
  await assert.rejects(f.create('concurrent-same-request', 'Changed'), (error) => error.code === 'already-exists');
  assert.equal(f.db.peek(USAGE_PATH).createdRoomCount, 1);
});

test('racing requests at nineteen rooms admit exactly one new room', async () => {
  const f = fixture(); for (let n = 0; n < 19; n += 1) await f.create(`existing-room-${n}`);
  const results = await Promise.allSettled(Array.from({ length: 6 }, (_, n) => f.create(`boundary-race-${n}`)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.details.reason === 'trial-room-limit'));
  assert.equal(f.db.peek(USAGE_PATH).createdRoomCount, 20);
});

test('identifier collision rolls back admission counter and never creates a partial room', async () => {
  const f = fixture({ randomUUID: () => '12345678-1234-4567-8123-123456789abc' });
  await f.create('first-create-id'); await assert.rejects(f.create('second-create-id'), (error) => error.details?.reason === 'identifier-collision');
  assert.equal(f.db.peek(USAGE_PATH).createdRoomCount, 1);
  assert.equal(f.db.paths().filter((p) => p.startsWith('floatingGardenActionRequests/')).length, 1);
});

test('malformed or stale counter fails closed without new room/receipt writes', async () => {
  for (const patch of [{ createdRoomCount: -1 }, { createdRoomCount: 21 }, { createdRoomCount: '1' }, { projectId: 'other-project' }, { startsAtMillis: START - 1 }]) {
    const f = fixture(); f.db.set(USAGE_PATH, { projectId: CONFIG.projectId, startsAtMillis: START, endsAtMillis: CONFIG.endsAtMillis, maxRooms: 20, createdRoomCount: 1, ...patch });
    const before = f.db.entries(); await rejects(f.create(), 'trial-usage-invalid'); assert.deepEqual(f.db.entries(), before);
  }
});

test('receipt replays and snapshots deny immediately when gate/tester expires or revokes', async () => {
  const f = fixture(); const room = await f.create('replay-test-request'); await f.snapshot(room);
  for (const patch of [{ enabled: false }, { enabled: true, testerUids: ['guest', 'other'] }]) {
    f.patchGate(patch); const before = f.db.entries(); await assert.rejects(f.create('replay-test-request')); await assert.rejects(f.snapshot(room)); assert.deepEqual(f.db.entries(), before);
  }
  f.patchGate({ enabled: true, testerUids: ['host', 'guest'] }); f.setNow(CONFIG.endsAtMillis);
  const before = f.db.entries(); await rejects(f.create('replay-test-request'), 'trial-outside-window'); await rejects(f.snapshot(room), 'trial-outside-window'); assert.deepEqual(f.db.entries(), before);
});

test('room, membership, invitation and receipt deadlines are clamped to trial end', async () => {
  const f = fixture(); f.setNow(CONFIG.endsAtMillis - 10000); const room = await f.create();
  for (const [path, value] of gameEntries(f.db)) if (Object.hasOwn(value, 'expiresAtMillis')) assert.equal(value.expiresAtMillis, CONFIG.endsAtMillis, path);
  assert.equal((await f.snapshot(room)).room.expiresAtMillis, CONFIG.endsAtMillis);
  f.setNow(CONFIG.endsAtMillis); await rejects(f.snapshot(room), 'trial-outside-window');
});

test('gate revocation during handler work prevents its transaction writes', async () => {
  const f = fixture({ trustedHandlersFactory: ({ db }) => Object.fromEntries(CALLABLE_NAMES.map((name) => [name, async () => {
    f.patchGate({ enabled: false });
    await db.runTransaction(async (tx) => tx.set(db.doc('floatingGardenRateLimits/forged'), { count: 1 }));
  }])) });
  await rejects(f.create(), 'trial-disabled'); assert.equal(f.db.peek('floatingGardenRateLimits/forged'), undefined);
});

test('entry exports exactly five hardened endpoints; missing config remains disabled without DB initialization', async () => {
  const source = await readFile(new URL('../functions/floating-garden-trial/index.js', import.meta.url), 'utf8');
  for (const suppliedConfig of [null, { ...CONFIG, projectId: 'wa-awesome' }, CONFIG]) {
    const exported = { exports: {} }; let init = 0;
    const mockRequire = (name) => {
      if (name === 'node:fs') return { readFileSync: () => { if (!suppliedConfig) throw new Error('missing'); return JSON.stringify(suppliedConfig); } };
      if (name === 'firebase-admin/app') return { getApps: () => [], initializeApp: () => { init += 1; } };
      if (name === 'firebase-admin/firestore') return { getFirestore: () => { throw new Error('Unexpected DB access'); }, Timestamp: { fromMillis: (m) => m } };
      if (name === 'firebase-functions/v2/https') return { onCall: (options, handler) => ({ options, handler }), HttpsError: class extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details; } } };
      if (name === 'firebase-functions/params') return { defineSecret: (name) => ({ name }) };
      if (name === './config') return require('../functions/floating-garden-trial/config.js');
      if (name === './trial-handlers') return require('../functions/floating-garden-trial/trial-handlers.js');
      return require(name);
    };
    vm.runInNewContext(source, { require: mockRequire, module: exported, __dirname: '/fixture', process: { env: {} }, console });
    assert.deepEqual(Object.keys(exported.exports), CALLABLE_NAMES);
    for (const endpoint of Object.values(exported.exports)) {
      assert.equal(endpoint.options.region, 'asia-northeast1'); assert.equal(endpoint.options.minInstances, 0); assert.equal(endpoint.options.maxInstances, 1);
      assert.equal(endpoint.options.timeoutSeconds, 30); assert.equal(endpoint.options.memory, '256MiB'); assert.equal(endpoint.options.cpu, 1); assert.equal(endpoint.options.concurrency, 1); assert.equal(endpoint.options.enforceAppCheck, true);
      if (suppliedConfig === CONFIG) { assert.equal(endpoint.options.serviceAccount, `garden-trial-runtime@${CONFIG.projectId}.iam.gserviceaccount.com`); assert.equal(endpoint.options.cors[0], CONFIG.previewOrigin); }
      await assert.rejects(endpoint.handler({}), (error) => error.code === 'failed-precondition');
    }
    assert.equal(init, 0);
  }
});

test('rules rendering is literal, bounded and fails on missing tokens', async () => {
  const template = await readFile(new URL('../functions/floating-garden-trial/firestore.rules.template', import.meta.url), 'utf8');
  const result = renderTrialRules(template, CONFIG);
  assert.ok(result.includes(JSON.stringify(CONFIG.previewOrigin))); assert.ok(!result.includes('__TRIAL_'));
  assert.throws(() => renderTrialRules('', CONFIG));
});

test('standalone package pins the already locked Firebase versions and omits bcrypt', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../functions/floating-garden-trial/package.json', import.meta.url)));
  const lock = JSON.parse(await readFile(new URL('../functions/floating-garden-trial/package-lock.json', import.meta.url)));
  const existing = JSON.parse(await readFile(new URL('../functions/package-lock.json', import.meta.url)));
  assert.deepEqual(Object.keys(packageJson.dependencies), ['firebase-admin', 'firebase-functions']);
  for (const name of Object.keys(packageJson.dependencies)) assert.equal(packageJson.dependencies[name], existing.packages[`node_modules/${name}`].version);
  assert.equal(packageJson.engines.node, '22'); assert.deepEqual(lock.packages[''].dependencies, packageJson.dependencies);
  assert.equal(lock.packages['node_modules/bcryptjs'], undefined);
});

test('trial wrapper supports all five unchanged trusted operations with one room admission', async () => {
  const f = fixture(); const created = await f.create();
  const joined = await f.handlers.floatingGardenJoinRoom(f.request('guest', { inviteCode: created.inviteCode, displayName: 'Moon', requestId: f.id() }));
  assert.equal(joined.roomId, created.roomId); assert.equal(joined.seat, 1);
  const snapshot = await f.snapshot(created);
  const started = await f.handlers.floatingGardenStartMatch(f.request('host', { roomId: created.roomId, expectedRevision: snapshot.room.revision, requestId: f.id() }));
  assert.equal(started.room.status, 'playing');
  const acted = await f.handlers.floatingGardenSubmitAction(f.request('host', { roomId: created.roomId,
    gameId: started.room.gameId, rulesVersion: started.room.rulesVersion, expectedRevision: started.room.match.revision,
    requestId: f.id(), command: { type: 'draw' } }));
  assert.equal(acted.room.match.revision, started.room.match.revision + 1);
  assert.equal(f.db.peek(USAGE_PATH).createdRoomCount, 1);
});

test('trial expiry inside a pending transaction aborts all its writes', async () => {
  const f = fixture({ trustedHandlersFactory: ({ db }) => Object.fromEntries(CALLABLE_NAMES.map((name) => [name, async () => {
    return db.runTransaction(async (tx) => {
      tx.set(db.doc('floatingGardenRateLimits/late-write'), { count: 1 });
      f.setNow(CONFIG.endsAtMillis);
    });
  }])) });
  await rejects(f.create(), 'trial-outside-window'); assert.equal(f.db.peek('floatingGardenRateLimits/late-write'), undefined);
});

test('gate revocation after a transaction read conflicts and prevents committed writes', async () => {
  let changed = false;
  const f = fixture({ trustedHandlersFactory: ({ db }) => Object.fromEntries(CALLABLE_NAMES.map((name) => [name, async () => {
    return db.runTransaction(async (tx) => {
      if (!changed) { changed = true; f.patchGate({ enabled: false }); }
      tx.set(db.doc('floatingGardenRateLimits/conflicted-write'), { count: 1 });
    });
  }])) });
  await rejects(f.create(), 'trial-disabled'); assert.equal(f.db.peek('floatingGardenRateLimits/conflicted-write'), undefined);
  assert.ok(f.db.transactionAttempts >= 3);
});

test('missing usage counter fails closed instead of silently resetting trial capacity', async () => {
  const memory = createMemoryStore();
  const db = { ...memory, doc: (path) => path === USAGE_PATH ? { ...memory.doc(path), get: async () => ({ exists: false }) } : memory.doc(path),
    runTransaction: (body) => memory.runTransaction((tx) => body({ ...tx, get: (ref) => ref.path === USAGE_PATH ? Promise.resolve({ exists: false }) : tx.get(ref) })) };
  const f = fixture({ database: db }); const before = memory.entries();
  await rejects(f.create(), 'trial-usage-invalid'); assert.deepEqual(memory.entries(), before);
});

test('room expiry reached during unchanged trusted engine work rolls back the action', async () => {
  const { loadCore } = require('../functions/floating-garden-online/handlers.js');
  const core = await loadCore(); let expireDuringAction = false; let roomExpiry;
  const f = fixture({ coreLoader: async () => ({ ...core, applyMatchAction: (...args) => {
    const result = core.applyMatchAction(...args); if (expireDuringAction) f.setNow(roomExpiry); return result;
  } }) });
  const created = await f.create();
  await f.handlers.floatingGardenJoinRoom(f.request('guest', { inviteCode: created.inviteCode, displayName: 'Moon', requestId: f.id() }));
  const snapshot = await f.snapshot(created);
  const started = await f.handlers.floatingGardenStartMatch(f.request('host', { roomId: created.roomId, expectedRevision: snapshot.room.revision, requestId: f.id() }));
  roomExpiry = started.room.expiresAtMillis; f.setNow(roomExpiry - 1); expireDuringAction = true;
  const action = { roomId: created.roomId, gameId: started.room.gameId, rulesVersion: started.room.rulesVersion,
    expectedRevision: started.room.match.revision, requestId: 'expiry-boundary-action', command: { type: 'draw' } };
  const roomBefore = f.db.peek(`floatingGardenRooms/${created.roomId}`);
  const gameBefore = f.db.peek(`floatingGardenRooms/${created.roomId}/serverGames/${started.room.gameId}`);
  const receiptsBefore = f.db.paths().filter((path) => path.startsWith('floatingGardenActionRequests/')).length;
  await rejects(f.handlers.floatingGardenSubmitAction(f.request('host', action)), 'room-expired');
  assert.deepEqual(f.db.peek(`floatingGardenRooms/${created.roomId}`), roomBefore);
  assert.deepEqual(f.db.peek(`floatingGardenRooms/${created.roomId}/serverGames/${started.room.gameId}`), gameBefore);
  assert.equal(f.db.paths().filter((path) => path.startsWith('floatingGardenActionRequests/')).length, receiptsBefore);
});


test('dedicated fixed origin preserves server project, origin, time, two-tester and 20-room gates', async () => {
  const config = { ...CONFIG, projectId: 'wa-awesome-garden-stg', previewOrigin: 'https://wa-awesome-garden-stg.web.app' };
  assert.equal(validateTrialConfig(config).previewOrigin, config.previewOrigin);
  for (const previewOrigin of ['https://wa-awesome-garden-stg.firebaseapp.com', config.previewOrigin + '/', config.previewOrigin + ':443', config.previewOrigin + '?x=1', config.previewOrigin + '#x', config.previewOrigin + '.evil.example', 'http://wa-awesome-garden-stg.web.app', 'https://wa-awesome-garden-stg-other.web.app', 'https://wa-awesome.web.app', 'https://wa-awesome-mofumofu-stg.web.app']) assert.throws(() => validateTrialConfig({ ...config, previewOrigin }));
  assert.throws(() => validateTrialConfig({ ...CONFIG, previewOrigin: config.previewOrigin }));
  for (const name of CALLABLE_NAMES) {
    const f = fixture({ config });
    for (const [reason, modify] of [
      ['trial-auth-required', (r) => { delete r.auth; }],
      ['trial-app-check-required', (r) => { delete r.app; }],
      ['trial-origin-mismatch', (r) => { r.rawRequest.headers.origin = 'https://wa-awesome-garden-stg--garden-7day-abcdef.web.app'; }],
    ]) {
      const request = f.request(); modify(request); const before = f.db.entries();
      await rejects(f.handlers[name](request), reason); assert.deepEqual(f.db.entries(), before);
    }
    f.patchGate({ testerUids: ['host', 'guest', 'third'] });
    await rejects(f.handlers[name](f.request()), 'trial-tester-not-enrolled');
    f.patchGate({ testerUids: ['host', 'guest'], enabled: false });
    await rejects(f.handlers[name](f.request()), 'trial-disabled');
    f.patchGate({ enabled: true }); f.setNow(config.endsAtMillis);
    await rejects(f.handlers[name](f.request()), 'trial-outside-window');
  }
  const wrongProject = fixture({ config, env: { GCLOUD_PROJECT: CONFIG.projectId } });
  await rejects(wrongProject.create(), 'trial-project-mismatch');
  const f = fixture({ config });
  for (let i = 0; i < 20; i++) await f.create(`fixed-host-room-${i}`);
  await rejects(f.create('fixed-host-room-over-limit'), 'trial-room-limit');
  assert.equal(f.db.peek(USAGE_PATH).createdRoomCount, 20);
  const template = await readFile(new URL('../functions/floating-garden-trial/firestore.rules.template', import.meta.url), 'utf8');
  assert.ok(renderTrialRules(template, config).includes(JSON.stringify(config.previewOrigin)));
});

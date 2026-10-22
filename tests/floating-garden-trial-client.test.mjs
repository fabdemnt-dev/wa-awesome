import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveTrialEnvironment, validateTrialConfig, TRIAL_MAX_DURATION_MILLIS } from '../lab/floating-garden/trial/config.js';
import runtimeTemplate from '../lab/floating-garden/trial/trialruntime.js';
import { createTrialFirebaseTransport, CALLABLE_TIMEOUT_MILLIS } from '../lab/floating-garden/trial/firebase.js';
import { bootstrapTrial, createTrialStorage, trialRecoveryKey } from '../lab/floating-garden/trial/bootstrap.js';
import { createOnlineController, ONLINE_SAVE_KEY } from '../lab/floating-garden/online/controller.js';
import { MATCH_VERSION } from '../lab/floating-garden/match-engine.js';

const NOW = Date.parse('2026-10-02T00:00:00Z');
const clone = (value) => structuredClone(value);
function config() {
  return { schemaVersion: 1, enabled: true, projectId: 'floating-garden-trial', previewOrigin: 'https://floating-garden-trial--android-abcdef.web.app', startsAtMillis: NOW - 1000, endsAtMillis: NOW + 86400000, region: 'asia-northeast1', maxTesters: 2, maxRooms: 20, firebase: { projectId: 'floating-garden-trial', authDomain: 'floating-garden-trial.firebaseapp.com', apiKey: `AIza${'a'.repeat(35)}`, appId: '1:123456789:web:123abc' }, appCheck: { provider: 'recaptcha-enterprise', siteKey: '6LconfirmedEnterpriseSiteKey12345', verified: true } };
}
const page = (value = config()) => new URL(`${value.previewOrigin}/lab/floating-garden/trial/`);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function clock() {
  let time = NOW, sequence = 0;
  const timers = new Map();
  return { now: () => time, setTimer(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: time + delay, delay }); return id; }, clearTimer(id) { timers.delete(id); }, set(value) { time = value; }, fire() { for (const [id, item] of [...timers]) if (item.at <= time) { timers.delete(id); item.fn(); } }, timers };
}
function mockSdk({ user = { uid: 'anonymous-tester', isAnonymous: true }, appCheckError = null, persistenceError = null } = {}) {
  const events = [], apps = [], listeners = [], requests = [], registered = [], auth = { currentUser: user, async authStateReady() { events.push('auth-ready'); } };
  let behavior = async () => ({ data: { okay: true } });
  const sdk = {
    appSdk: { getApps: () => apps, initializeApp(settings, name) { const app = { name, options: settings }; apps.push(app); events.push('initialize-app'); return app; }, async deleteApp(app) { events.push('delete-app'); apps.splice(apps.indexOf(app), 1); } },
    appCheckSdk: { ReCaptchaEnterpriseProvider: class { constructor(siteKey) { this.siteKey = siteKey; events.push('enterprise-provider'); } }, initializeAppCheck(app, options) { events.push('app-check-initialize'); return { app, options }; }, async getToken() { events.push('app-check-token'); if (appCheckError) throw appCheckError; return { token: 'must-never-render-this-token' }; }, setTokenAutoRefreshEnabled(_value, enabled) { events.push(`refresh:${enabled}`); } },
    authSdk: { browserLocalPersistence: { name: 'browser-local' }, getAuth() { events.push('get-auth'); return auth; }, async setPersistence(_auth, persistence) { events.push(`persistence:${persistence.name}`); if (persistenceError) throw persistenceError; }, async signInAnonymously() { events.push('sign-in-anonymous'); auth.currentUser = { uid: 'new-anonymous-tester', isAnonymous: true }; return { user: auth.currentUser }; } },
    firestoreSdk: { initializeFirestore(app, options) { events.push('get-firestore'); return { app, options }; }, doc(db, collection, id) { return { db, collection, id }; }, onSnapshot(ref, options, next, error) { const listener = { ref, options, next, error, stopped: false }; listeners.push(listener); return () => { listener.stopped = true; }; }, async disableNetwork() { events.push('disable-network'); } },
    functionsSdk: { getFunctions(app, region) { events.push(`functions:${region}`); return { app, region }; }, httpsCallable(functions, name, options) { registered.push({ functions, name, options }); return async (payload) => { requests.push({ name, payload }); return behavior(name, payload); }; } },
  };
  return { sdk, events, apps, auth, listeners, requests, registered, setBehavior(fn) { behavior = fn; } };
}
async function transportFixture(options = {}) {
  const time = clock(), fake = mockSdk(options), identities = [], refusals = [];
  const transport = await createTrialFirebaseTransport(config(), page(), { loadSdk: async () => fake.sdk, environment: {}, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer, onIdentity: (uid) => identities.push(uid), onAccessDenied: (reason) => refusals.push(reason), ...options.transportOptions });
  return { transport, fake, time, identities, refusals };
}
const storage = () => { const map = new Map(); return { map, getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) }; };

 test('explicit generated config resolves to immutable dedicated external environment', () => {
  const input = config(), value = resolveTrialEnvironment(input, page(), NOW);
  assert.equal(value.projectId, input.projectId); assert.equal(value.region, 'asia-northeast1'); assert.equal(value.maxTesters, 2); assert.equal(value.maxRooms, 20);
  assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(value.firebase)); assert.ok(Object.isFrozen(value.appCheck));
  input.firebase.projectId = 'wa-awesome'; assert.equal(value.firebase.projectId, 'floating-garden-trial');
 });
 test('missing config, disabled source template, unknown fields and query overrides never import SDK', async () => {
  const unknown = config(); unknown.emulator = true;
  const nestedUnknown = config(); nestedUnknown.firebase.databaseURL = 'https://wa-awesome.firebaseio.com';
  const cases = [[null, page()], [undefined, page()], [runtimeTemplate, page()], [unknown, page()], [nestedUnknown, page()], [config(), `${page()}?projectId=wa-awesome`], [config(), `${page()}?enabled=true`]];
  for (const [input, url] of cases) {
    let imports = 0;
    await assert.rejects(createTrialFirebaseTransport(input, url, { now: () => NOW, loadSdk: async () => { imports++; throw new Error('imported'); } }));
    assert.equal(imports, 0);
  }
  assert.equal(runtimeTemplate.enabled, false); assert.equal(runtimeTemplate.appCheck.verified, false);
 });
 test('known production/shared/demo/local projects are rejected regardless of matching fake host', () => {
  for (const projectId of ['wa-awesome', 'wa-awesome-mofumofu-stg', 'demo-floating-garden', 'demoproject', 'localproject', 'local-garden', 'garden-local-test', 'localhost-garden', 'UPPERCASE', 'garden_trial', 'x']) {
    const value = config(); value.projectId = value.firebase.projectId = projectId; value.firebase.authDomain = `${projectId}.firebaseapp.com`; value.previewOrigin = `https://${projectId}--android-abcdef.web.app`;
    assert.throws(() => resolveTrialEnvironment(value, page(value), NOW));
  }
 });
 test('known existing public API keys and App IDs are rejected before SDK import even under new project labels', async () => {
  // Read public source only in tests. A rotated or newly added existing-project
  // identifier must fail this test until the isolated trial denylist is updated.
  const existing = await readFile(new URL('../toybox/mofumofu-gathering/online/firebase-config.js', import.meta.url), 'utf8');
  const keys = [...new Set(existing.match(/AIza[A-Za-z0-9_-]{35}/g))];
  const appIds = [...new Set(existing.match(/1:[0-9]+:web:[a-f0-9]+/g))];
  assert.ok(keys.length >= 2); assert.ok(appIds.length >= 2);
  for (const [field, identifiers] of [['apiKey', keys], ['appId', appIds]]) {
    for (const identifier of identifiers) {
      const value = config(); value.firebase[field] = identifier; let imports = 0;
      assert.throws(() => validateTrialConfig(value), /既存サービス/);
      await assert.rejects(createTrialFirebaseTransport(value, page(value), { now: () => NOW, environment: {}, loadSdk: async () => { imports++; throw new Error('imported'); } }), /既存サービス/);
      assert.equal(imports, 0);
    }
  }
  const source = await readFile(new URL('../lab/floating-garden/trial/config.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:import|export)[^\n]*firebase-config/);
 });
 test('exact one HTTPS preview origin excludes live, other project, wildcard, suffix, local and ports', () => {
  const valid = config();
  for (const href of ['http://floating-garden-trial--android-abcdef.web.app/', 'https://floating-garden-trial.web.app/', 'https://floating-garden-trial.firebaseapp.com/', 'https://floating-garden-trial--other-ghijkl.web.app/', 'https://floating-garden-trial--android-abcdef.web.app.evil.example/', 'https://floating-garden-trial--android-abcdef.web.app:8443/', 'http://localhost:8000/', 'https://127.0.0.1/', 'https://wa-awesome.web.app/', 'https://wa-awesome-mofumofu-stg.web.app/']) assert.throws(() => resolveTrialEnvironment(valid, href, NOW), href);
  for (const previewOrigin of ['https://floating-garden-trial.web.app', 'https://floating-garden-trial--android-abcdef.web.app/', 'https://floating-garden-trial--android-abcdef.web.app:443', 'https://*.web.app', 'https://unrelated--android-abcdef.web.app', 'https://floating-garden-trial--android-abcdef.web.app?enabled=1', 'https://floating-garden-trial--android-abcdef.web.app#foo']) { const value = config(); value.previewOrigin = previewOrigin; assert.throws(() => validateTrialConfig(value)); }
  assert.doesNotThrow(() => resolveTrialEnvironment(valid, `${page()}#online-controls`, NOW));
 });
 test('window must be fixed, active and at most 7 days; exact end is blocked', () => {
  const value = config(); value.startsAtMillis = NOW; value.endsAtMillis = NOW + TRIAL_MAX_DURATION_MILLIS;
  assert.doesNotThrow(() => resolveTrialEnvironment(value, page(value), NOW));
  assert.throws(() => resolveTrialEnvironment(value, page(value), NOW - 1));
  assert.throws(() => resolveTrialEnvironment(value, page(value), value.endsAtMillis));
  assert.doesNotThrow(() => resolveTrialEnvironment(value, page(value), value.endsAtMillis - 1));
  for (const patch of [{ endsAtMillis: value.endsAtMillis + 1 }, { startsAtMillis: value.endsAtMillis }, { startsAtMillis: 0 }, { startsAtMillis: String(NOW) }, { endsAtMillis: Number.NaN }, { region: 'us-central1' }, { maxTesters: 3 }, { maxRooms: 21 }]) assert.throws(() => validateTrialConfig({ ...value, ...patch }));
  assert.throws(() => resolveTrialEnvironment(value, page(), Number.NaN));
 });
 test('Web config and verified Enterprise provider have no fallback or optional omissions', async () => {
  for (const patch of [{ projectId: 'wa-awesome' }, { authDomain: 'wa-awesome.firebaseapp.com' }, { apiKey: 'placeholder' }, { appId: '1:123:android:abcdef' }]) { const value = config(); Object.assign(value.firebase, patch); assert.throws(() => validateTrialConfig(value)); }
  for (const patch of [{ provider: 'recaptcha-v3' }, { verified: false }, { siteKey: '' }, { siteKey: 'replace-this-placeholder-key' }, { debug: true }]) { const value = config(); Object.assign(value.appCheck, patch); assert.throws(() => validateTrialConfig(value)); }
  let imports = 0;
  await assert.rejects(createTrialFirebaseTransport(config(), page(), { now: () => NOW, environment: { FIREBASE_APPCHECK_DEBUG_TOKEN: true }, loadSdk: async () => { imports++; } }));
  assert.equal(imports, 0);
 });
 test('gate is rechecked after SDK download before initializing any app', async () => {
  const time = clock(), fake = mockSdk();
  await assert.rejects(createTrialFirebaseTransport(config(), page(), { now: time.now, environment: {}, loadSdk: async () => { time.set(config().endsAtMillis); return fake.sdk; } }));
  assert.deepEqual(fake.events, []);
 });
 test('Enterprise attestation precedes Auth, uses persistent anonymous session and no default app', async () => {
  const { transport, fake, identities } = await transportFixture({ user: null });
  try {
    assert.equal(fake.apps[0].name, 'floating-garden-trial-floating-garden-trial'); assert.deepEqual(fake.apps[0].options, config().firebase);
    assert.ok(fake.events.indexOf('app-check-token') < fake.events.indexOf('get-auth'));
    assert.ok(fake.events.includes('persistence:browser-local')); assert.ok(fake.events.includes('functions:asia-northeast1'));
    const [one, two] = await Promise.all([transport.ensureUser(), transport.ensureUser()]);
    assert.deepEqual(one, { uid: 'new-anonymous-tester' }); assert.deepEqual(two, one); assert.deepEqual(identities, [one.uid]);
    assert.equal(fake.events.filter((event) => event === 'sign-in-anonymous').length, 1);
    assert.equal(fake.requests.length, 0); assert.equal(fake.listeners.length, 0);
  } finally { transport.dispose(); }
 });
 test('existing anonymous UID persists, other provider identity is blocked, Auth failure never falls back', async () => {
  const good = await transportFixture();
  await good.transport.ensureUser(); assert.deepEqual(good.identities, ['anonymous-tester']); assert.equal(good.fake.events.includes('sign-in-anonymous'), false); good.transport.dispose();
  const other = await transportFixture({ user: { uid: 'registered-user', isAnonymous: false } });
  await assert.rejects(other.transport.ensureUser(), /匿名認証/); assert.equal(other.fake.requests.length, 0); assert.equal(other.fake.events.includes('sign-in-anonymous'), false); other.transport.dispose();
  const fake = mockSdk({ persistenceError: new Error('storage-denied') });
  await assert.rejects(createTrialFirebaseTransport(config(), page(), { loadSdk: async () => fake.sdk, now: () => NOW, environment: {} }), /storage-denied/);
  assert.equal(fake.events.includes('sign-in-anonymous'), false); assert.ok(fake.events.includes('delete-app'));
 });
 test('failed attestation never starts Auth or Firestore and does not use debug/emulator fallback', async () => {
  const fake = mockSdk({ appCheckError: new Error('attestation-failed') });
  await assert.rejects(createTrialFirebaseTransport(config(), page(), { loadSdk: async () => fake.sdk, now: () => NOW, environment: {} }), /attestation-failed/);
  assert.equal(fake.events.includes('get-auth'), false); assert.equal(fake.events.includes('get-firestore'), false); assert.ok(fake.events.includes('delete-app'));
 });
 test('only five external callables are available, every timeout is at most 15 seconds, server denial grants nothing', async () => {
  const { transport, fake, refusals } = await transportFixture();
  try {
    assert.deepEqual(Object.keys(transport.api).sort(), ['create', 'getSnapshot', 'join', 'start', 'submit']);
    assert.equal(fake.registered.length, 5); assert.ok(fake.registered.every((item) => item.options.timeout === CALLABLE_TIMEOUT_MILLIS && item.options.timeout <= 15000));
    await assert.rejects(transport.api.create({ requestId: 'before-auth' }), /匿名認証/); assert.equal(fake.requests.length, 0);
    await transport.ensureUser();
    fake.setBehavior(async () => { throw Object.assign(new Error('not enrolled'), { code: 'functions/permission-denied', details: { reason: 'tester-not-enrolled' } }); });
    await assert.rejects(transport.api.create({ requestId: 'first-request' }), /確認待ちの操作は保存/);
    assert.deepEqual(refusals, ['tester-not-enrolled']); assert.equal(fake.requests.length, 1);
    fake.auth.currentUser = { uid: 'different-user', isAnonymous: true };
    await assert.rejects(transport.api.join({ requestId: 'wrong-user' }), /認証/); assert.equal(fake.requests.length, 1);
  } finally { transport.dispose(); }
 });
 test('lost create receipt survives middleware Auth and permission refusal then recovers the exact original room and request', async () => {
  for (const rejection of ['functions/unauthenticated', 'functions/permission-denied']) {
    const { transport, fake } = await transportFixture(), durable = storage(); let requestCount = 0, createdRooms = 0, makeRequestIdCalls = 0;
    const receipt = { roomId: 'original-room', seat: 0, inviteCode: 'GARDEN-original' };
    const room = { id: receipt.roomId, playerCount: 2, revision: 0, rulesVersion: MATCH_VERSION, players: [{ seat: 0, name: 'Host' }], status: 'waiting', match: null, expiresAtMillis: config().endsAtMillis };
    const receipts = new Map();
    fake.setBehavior(async (name, payload) => {
      if (name === 'floatingGardenGetSnapshot') return { data: { room, self: { seat: 0, isHost: true } } };
      assert.equal(name, 'floatingGardenCreateRoom'); requestCount++;
      if (requestCount === 2) throw Object.assign(new Error('middleware rejected'), { code: rejection }); // no details
      if (!receipts.has(payload.requestId)) { createdRooms++; receipts.set(payload.requestId, clone(receipt)); }
      if (requestCount === 1) throw Object.assign(new Error('committed but response lost'), { code: 'functions/unavailable' });
      return { data: receipts.get(payload.requestId) };
    });
    const controller = createOnlineController({ ...transport, storage: durable, requestId: () => `create-identity-${++makeRequestIdCalls}`, isOnline: () => transport.isActive() });
    await controller.resume(); assert.equal(await controller.create('Host'), false);
    const original = durable.getItem(ONLINE_SAVE_KEY), pending = clone(controller.getState().pending); assert.equal(createdRooms, 1);
    assert.equal(await controller.resume(), false); assert.equal(durable.getItem(ONLINE_SAVE_KEY), original); assert.deepEqual(controller.getState().pending, pending); assert.equal(controller.getState().canConfirm, false);
    assert.equal(await controller.create('Host again'), false); assert.equal(requestCount, 2); assert.equal(makeRequestIdCalls, 1);
    assert.equal(await controller.resume(), true); assert.equal(controller.getState().pending, null); assert.equal(controller.getState().room.id, 'original-room'); assert.equal(createdRooms, 1); assert.equal(makeRequestIdCalls, 1);
    const calls = fake.requests.filter((call) => call.name === 'floatingGardenCreateRoom'); assert.equal(calls.length, 3); assert.deepEqual(calls.map((call) => call.payload), [pending.payload, pending.payload, pending.payload]);
    controller.dispose(); transport.dispose();
  }
 });
 test('local Auth readiness or missing/changed identity cannot erase an older unresolved request', async () => {
  for (const kind of ['middleware', 'missing', 'changed', 'non-anonymous']) {
    const { transport, fake } = await transportFixture(), durable = storage();
    const controller = createOnlineController({ ...transport, storage: durable, requestId: () => 'retain-auth-pending', isOnline: () => transport.isActive() });
    await controller.resume(); fake.setBehavior(async () => { throw Object.assign(new Error('lost result'), { code: 'functions/unavailable' }); }); await controller.create('Host');
    const original = durable.getItem(ONLINE_SAVE_KEY), authReady = fake.auth.authStateReady;
    if (kind === 'middleware') fake.auth.authStateReady = async () => { throw Object.assign(new Error('auth rejected'), { code: 'unauthenticated' }); };
    else if (kind === 'missing') fake.auth.currentUser = null;
    else if (kind === 'changed') fake.auth.currentUser = { uid: 'new-uid', isAnonymous: true };
    else fake.auth.currentUser = { uid: 'anonymous-tester', isAnonymous: false };
    assert.equal(await controller.resume(), false); assert.equal(durable.getItem(ONLINE_SAVE_KEY), original); assert.ok(controller.getState().pending); assert.equal(fake.requests.length, 1); assert.equal(fake.events.includes('sign-in-anonymous'), false);
    fake.auth.authStateReady = authReady; controller.dispose(); transport.dispose();
  }
 });
 test('Auth deadline does not release the underlying sign-in flight or create a second UID', async () => {
  const { transport, fake, time, identities } = await transportFixture({ user: null }); const wait = deferred(); let signIns = 0;
  fake.sdk.authSdk.signInAnonymously = async () => { signIns++; const user = await wait.promise; fake.auth.currentUser = user; return { user }; };
  const first = transport.ensureUser(); for (let index = 0; index < 5; index++) await Promise.resolve(); assert.equal(signIns, 1);
  time.set(NOW + 12000); time.fire(); await assert.rejects(first, (error) => error.code === 'deadline-exceeded');
  const second = transport.ensureUser(); for (let index = 0; index < 5; index++) await Promise.resolve(); assert.equal(signIns, 1);
  wait.resolve({ uid: 'one-stable-uid', isAnonymous: true }); assert.deepEqual(await second, { uid: 'one-stable-uid' }); assert.deepEqual(identities, ['one-stable-uid']); assert.equal(signIns, 1); assert.equal(fake.auth.currentUser.uid, 'one-stable-uid');
  assert.deepEqual(await transport.ensureUser(), { uid: 'one-stable-uid' }); assert.equal(signIns, 1); transport.dispose();
 });
 test('all trial gate refusals preserve an unresolved request even after server commit', async () => {
  for (const reason of ['trial-disabled', 'trial-outside-window', 'trial-tester-not-enrolled', 'trial-auth-required', 'trial-app-check-required', 'trial-room-limit']) {
    const { transport, fake, refusals } = await transportFixture(); const durable = storage();
    const controller = createOnlineController({ ...transport, storage: durable, requestId: () => 'same-durable-request', isOnline: () => transport.isActive() });
    await controller.resume(); fake.setBehavior(async () => { throw Object.assign(new Error('refused'), { code: 'functions/failed-precondition', details: { reason } }); });
    assert.equal(await controller.create('庭師'), false); assert.equal(controller.getState().pending.payload.requestId, 'same-durable-request'); assert.equal(controller.getState().canConfirm, false); assert.deepEqual(refusals, [reason]);
    controller.dispose(); transport.dispose();
  }
 });
 test('external Firestore room subscription uses metadata and detaches fully on expiration', async () => {
  const { transport, fake, time } = await transportFixture();
  await transport.ensureUser(); const received = [], failures = [];
  transport.subscribe('room-1', (snapshot) => received.push(snapshot), (error) => failures.push(error));
  const listener = fake.listeners[0]; assert.equal(listener.ref.collection, 'floatingGardenRooms'); assert.equal(listener.ref.id, 'room-1'); assert.equal(listener.options.includeMetadataChanges, true);
  listener.next({ exists: () => true, data: () => ({ id: 'room-1' }), metadata: { fromCache: true, hasPendingWrites: false } });
  assert.deepEqual(received, [{ room: { id: 'room-1' }, fromCache: true }]);
  time.set(config().endsAtMillis); time.fire();
  assert.equal(listener.stopped, true); assert.equal(transport.isActive(), false); assert.ok(fake.events.includes('refresh:false')); assert.ok(fake.events.includes('disable-network'));
  listener.next({ exists: () => true, data: () => ({ id: 'room-1', revision: 999 }), metadata: { fromCache: false, hasPendingWrites: false } });
  assert.equal(received.length, 1); await assert.rejects(transport.api.create({}), /停止/);
 });
 test('bounded callable timeout retains the original durable request and never retries automatically', async () => {
  const { transport, fake, time } = await transportFixture(), durable = storage();
  const controller = createOnlineController({ ...transport, storage: durable, requestId: () => 'fixed-request-id', isOnline: () => transport.isActive() });
  await controller.resume(); const wait = deferred(); fake.setBehavior(() => wait.promise);
  const action = controller.create('庭師');
  for (let index = 0; index < 20 && !fake.requests.length; index++) await Promise.resolve();
  assert.equal(fake.requests.length, 1); time.set(NOW + 15000); time.fire();
  assert.equal(await action, false); assert.equal(controller.getState().pending.payload.requestId, 'fixed-request-id'); assert.equal(controller.getState().canConfirm, false);
  assert.equal(fake.requests.length, 1); assert.equal(await controller.create('別の庭師'), false); controller.dispose(); transport.dispose();
 });
 test('expiry during mutation ignores late receipt and preserves recovery verbatim', async () => {
  let controller, blocked = false;
  const { transport, fake, time } = await transportFixture({ transportOptions: { onBlocked() { if (blocked) return; blocked = true; controller?.suspend(); } } });
  const durable = storage(); controller = createOnlineController({ ...transport, storage: durable, requestId: () => 'preserve-me', isOnline: () => !blocked && transport.isActive() });
  await controller.resume(); const wait = deferred(); fake.setBehavior(() => wait.promise); const action = controller.create('庭師');
  for (let index = 0; index < 20 && !fake.requests.length; index++) await Promise.resolve();
  const original = durable.getItem(ONLINE_SAVE_KEY); time.set(config().endsAtMillis); time.fire();
  wait.resolve({ data: { roomId: 'room-1', seat: 0, inviteCode: 'GARDEN-code' } });
  assert.equal(await action, false); assert.equal(durable.getItem(ONLINE_SAVE_KEY), original); assert.equal(controller.getState().pending.payload.requestId, 'preserve-me'); assert.equal(controller.getState().canConfirm, false); assert.equal(controller.getState().room, null); controller.dispose();
 });
 test('trial recovery is namespaced and leaves CPU and emulator saves unchanged', () => {
  const raw = storage(); raw.setItem(ONLINE_SAVE_KEY, 'emulator-recovery'); raw.setItem('floating-garden-match-save-v1', 'cpu-recovery');
  const wrapped = createTrialStorage(raw, config().projectId); assert.equal(wrapped.getItem(ONLINE_SAVE_KEY), null); wrapped.setItem(ONLINE_SAVE_KEY, 'trial-recovery');
  assert.equal(raw.getItem(trialRecoveryKey(config().projectId)), 'trial-recovery'); assert.equal(raw.getItem(ONLINE_SAVE_KEY), 'emulator-recovery'); assert.equal(raw.getItem('floating-garden-match-save-v1'), 'cpu-recovery');
 });
 test('bootstrap blocks before transport and uses the shared controller/mount without granting enrollment', async () => {
  let calls = 0; await assert.rejects(bootstrapTrial({}, null, runtimeTemplate, { location: page(), now: () => NOW, transportFactory: async () => { calls++; } })); assert.equal(calls, 0);
  const files = await Promise.all(['bootstrap.js', 'firebase.js', 'app.js', 'index.html'].map((name) => readFile(new URL(`../lab/floating-garden/trial/${name}`, import.meta.url), 'utf8')));
  assert.match(files[0], /\.\.\/online\/controller\.js/); assert.match(files[0], /\.\.\/online\/mount\.js/); assert.match(files[0], /匿名認証だけでは参加できません/); assert.match(files[0], /root\.inert = true/);
  assert.doesNotMatch(files[1], /connectAuthEmulator|connectFirestoreEmulator|connectFunctionsEmulator|firebase-config|setDoc|updateDoc|setCustomUserClaims|signOut/);
  assert.match(files[1], /ReCaptchaEnterpriseProvider/); assert.match(files[2], /\.\/trialruntime\.js/); assert.match(files[3], /\.\.\/online\/style\.css/);
  assert.doesNotMatch(files.join('\n'), /getIdToken|\.token\s*\}/);
 });

function trialDom() {
  const handlers = () => {
    const listeners = new Map();
    return { listeners, addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); }, removeEventListener(type, fn) { listeners.get(type)?.delete(fn); if (!listeners.get(type)?.size) listeners.delete(type); }, emit(type, event) { return Promise.all([...(listeners.get(type) || [])].map((fn) => fn(event))); } };
  };
  const page = { ...handlers(), localStorage: storage(), navigator: { onLine: true }, scrollX: 0, scrollY: 0, scrollTo() {} };
  const document = { ...handlers(), defaultView: page, visibilityState: 'visible', activeElement: null, body: { style: { overflow: '' } } };
  let html = '', buttons = [], details = [];
  const attributes = new Map();
  const root = { ...handlers(), ownerDocument: document, inert: false,
    set innerHTML(value) {
      html = value;
      buttons = [...value.matchAll(/<button\b([^>]*)>[\s\S]*?<\/button>/g)].map(([, attrs]) => ({ dataset: Object.fromEntries([...attrs.matchAll(/data-([\w-]+)="([^"]*)"/g)].map(([, key, text]) => [key.replace(/-([a-z])/g, (_, char) => char.toUpperCase()), text])), disabled: /\bdisabled\b/.test(attrs), focus() { document.activeElement = this; } }));
      details = [...value.matchAll(/<details\b([^>]*)>/g)].map(([, attrs]) => ({ id: attrs.match(/id="([^"]+)"/)[1], open: /\bopen\b/.test(attrs) }));
    }, get innerHTML() { return html; },
    setAttribute(key, value) { attributes.set(key, value); },
    querySelectorAll(selector) { return selector === 'details' ? details : selector === 'button[data-action]' ? buttons : []; },
    querySelector(selector) { if (selector.startsWith('#')) return details.find((item) => `#${item.id}` === selector) || null; const action = selector.match(/^\[data-(?:focus|action)="([^"]+)"\]$/)?.[1]; return buttons.find((item) => item.dataset.action === action || item.dataset.focus === action) || null; },
    contains(button) { return buttons.includes(button); },
  };
  return { root, status: { innerHTML: '' }, page, document, attributes, click(action) { const target = root.querySelector(`[data-action="${action}"]`); assert.ok(target); return root.emit('click', { target: { closest: () => target } }); }, input(id, value) { return root.emit('input', { target: { id, value } }); } };
}
 test('real trial bootstrap shows UID, routes entry buttons, honors namespaced storage events, freezes on expiry and cleans listeners', async () => {
  const dom = trialDom(), fake = mockSdk(), time = clock();
  fake.setBehavior(async () => { throw Object.assign(new Error('not enrolled'), { code: 'functions/permission-denied', details: { reason: 'trial-tester-not-enrolled' } }); });
  const application = await bootstrapTrial(dom.root, dom.status, config(), { location: page(), now: time.now, transportFactory: (value, location, callbacks) => createTrialFirebaseTransport(value, location, { ...callbacks, environment: {}, loadSdk: async () => fake.sdk, setTimer: time.setTimer, clearTimer: time.clearTimer }) });
  await application.ready;
  assert.match(dom.status.innerHTML, /anonymous-tester/); assert.doesNotMatch(dom.status.innerHTML, /must-never-render-this-token/); assert.match(dom.root.innerHTML, /参加資格は操作ごとにサーバーが確認/);
  await dom.input('online-name', 'Host'); await dom.click('create');
  assert.equal(fake.requests.length, 1); assert.equal(fake.requests[0].name, 'floatingGardenCreateRoom'); assert.equal(fake.requests[0].payload.displayName, 'Host');
  assert.ok(application.controller.getState().pending); assert.equal(application.controller.getState().canConfirm, false); assert.match(dom.status.innerHTML, /サーバーに拒否/);
  const saved = dom.page.localStorage.getItem(trialRecoveryKey(config().projectId)); assert.ok(saved); assert.equal(dom.page.localStorage.getItem(ONLINE_SAVE_KEY), null);
  await dom.page.emit('storage', { key: trialRecoveryKey(config().projectId) }); assert.equal(application.controller.getState().connection, 'conflict');
  time.set(config().endsAtMillis); time.fire();
  assert.equal(dom.root.inert, true); assert.equal(dom.attributes.get('aria-disabled'), 'true'); assert.match(dom.status.innerHTML, /停止しました/); assert.equal(dom.page.localStorage.getItem(trialRecoveryKey(config().projectId)), saved);
  await dom.click('create'); assert.equal(fake.requests.length, 1);
  application.unmount(); assert.equal(dom.root.listeners.size, 0); assert.equal(dom.page.listeners.size, 0); assert.equal(dom.document.listeners.size, 0);
 });

 test('dedicated fixed garden host is exact and retains every client gate before SDK import', async () => {
  const fixed = config(); fixed.projectId = fixed.firebase.projectId = 'wa-awesome-garden-stg';
  fixed.firebase.authDomain = 'wa-awesome-garden-stg.firebaseapp.com';
  fixed.previewOrigin = 'https://wa-awesome-garden-stg.web.app';
  assert.equal(resolveTrialEnvironment(fixed, page(fixed), NOW).previewOrigin, fixed.previewOrigin);
  assert.doesNotThrow(() => resolveTrialEnvironment(fixed, `${page(fixed)}#online-controls`, NOW));
  for (const origin of [fixed.previewOrigin + '/', fixed.previewOrigin + ':443', fixed.previewOrigin + '?enabled=1', fixed.previewOrigin + '#x', 'http://wa-awesome-garden-stg.web.app', 'https://wa-awesome-garden-stg.firebaseapp.com', 'https://wa-awesome-garden-stg.web.app.evil.example', 'https://wa-awesome-garden-stg-extra.web.app', 'https://wa-awesome.web.app', 'https://wa-awesome-mofumofu-stg.web.app', 'https://*.web.app']) assert.throws(() => validateTrialConfig({ ...fixed, previewOrigin: origin }), origin);
  assert.throws(() => validateTrialConfig({ ...config(), previewOrigin: fixed.previewOrigin }));
  const disallowed = [
    [fixed, page(fixed), fixed.startsAtMillis - 1], [fixed, page(fixed), fixed.endsAtMillis],
    [{ ...fixed, enabled: false }, page(fixed), NOW], [{ ...fixed, maxRooms: 21 }, page(fixed), NOW],
    [{ ...fixed, maxTesters: 3 }, page(fixed), NOW], [{ ...fixed, endsAtMillis: fixed.startsAtMillis + TRIAL_MAX_DURATION_MILLIS + 1 }, page(fixed), NOW],
    [fixed, `${page(fixed)}?enabled=true`, NOW], [fixed, 'https://wa-awesome-garden-stg--garden-7day-abcdef.web.app/', NOW],
  ];
  for (const [input, url, now] of disallowed) {
    let imports = 0;
    await assert.rejects(createTrialFirebaseTransport(input, url, { now: () => now, loadSdk: async () => { imports++; throw new Error('imported'); } }));
    assert.equal(imports, 0);
  }
 });

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  CONNECTION_PROJECT, CONNECTION_ORIGIN, CONNECTION_APP_NAME,
  CONNECTION_MAX_DURATION_MILLIS, CONNECTION_STAGE_TIMEOUT_MILLIS,
  CONNECTION_LABELS, IDENTITY_ATTEMPT_KEY,
  validateConnectionRuntime, assertConnectionAccess, createConnectionCheck,
} from '../lab/floating-garden/connection-check/connection.js';

const NOW = Date.parse('2026-10-03T02:00:00Z');
const PAGE = `${CONNECTION_ORIGIN}/connection-check/`;
const PRIVATE = 'synthetic-secret-never-render-or-log';
const identity = (uid = 'same-anonymous-uid') => ({ uid, isAnonymous: true, accessToken: PRIVATE });
function runtime() {
  return { schemaVersion: 1, projectId: CONNECTION_PROJECT, origin: CONNECTION_ORIGIN,
    startsAtMillis: NOW - 1000, expiresAtMillis: NOW + 86400000,
    firebase: { apiKey: 'AIzaSyCfa04hxQzY0T6gsVLsvTxIhB2zAB0v874', authDomain: 'wa-awesome-garden-stg.firebaseapp.com', projectId: CONNECTION_PROJECT, appId: '1:120030709276:web:015f4e996b7c42a4e801d9' },
    appCheck: { provider: 'recaptcha-enterprise', siteKey: '6Lc_LNwtAAAAADRAHvq10FwxirR3c5jZlxS9QpYw' } };
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function clock() {
  let time = NOW, sequence = 0;
  const timers = new Map(), scheduled = [];
  return { now: () => time, setTimer(fn, delay) { const id = ++sequence; scheduled.push({ delay, at: time }); timers.set(id, { fn, at: time + delay }); return id; }, clearTimer(id) { timers.delete(id); },
    set(value) { time = value; }, fire() { for (const [id, item] of [...timers]) if (item.at <= time) { timers.delete(id); item.fn(); } }, timers, scheduled };
}
function store() {
  const values = new Map(), writes = [];
  return { values, writes, getItem(key) { return values.get(key) ?? null; }, setItem(key, value) { writes.push({ key, value }); values.set(key, value); } };
}
function fixture(options = {}) {
  const time = options.time || clock(), storage = options.storage || store(), events = [], states = [], apps = [];
  const auth = { currentUser: options.user === undefined ? identity() : options.user,
    async authStateReady() { events.push('auth-ready'); if (options.ready) await options.ready.promise; } };
  const sdk = {
    appSdk: {
      getApps() { return options.duplicate ? [{ name: CONNECTION_APP_NAME }] : apps; },
      initializeApp(config, name) { events.push('initialize-app'); const app = { name, options: config }; apps.push(app); return app; },
      deleteApp(app) { events.push('delete-app'); apps.splice(apps.indexOf(app), 1); if (options.deleteThrows) throw new Error(PRIVATE); return Promise.resolve(); },
    },
    appCheckSdk: {
      ReCaptchaEnterpriseProvider: class { constructor(key) { events.push('enterprise-provider'); assert.equal(key, runtime().appCheck.siteKey); } },
      initializeAppCheck(app, config) { events.push('initialize-app-check'); assert.equal(config.isTokenAutoRefreshEnabled, false); if (options.initializeCheckThrows) throw new Error(PRIVATE); return { app }; },
      async getToken(_check, force) { events.push('get-token'); assert.equal(force, false); if (options.proof) return options.proof.promise; if (options.proofError) throw new Error(PRIVATE); return options.invalidProof === undefined ? { token: PRIVATE } : options.invalidProof; },
      setTokenAutoRefreshEnabled(_check, enabled) { events.push(`refresh:${enabled}`); if (options.refreshThrows) throw new Error(PRIVATE); },
    },
    authSdk: {
      browserLocalPersistence: { kind: 'local' },
      initializeAuth(app, config) { events.push('initialize-auth'); assert.equal(app.name, CONNECTION_APP_NAME); assert.equal(config.persistence, sdk.authSdk.browserLocalPersistence); return auth; },
      async setPersistence(value, persistence) { events.push('persistence'); assert.equal(value, auth); assert.equal(persistence, sdk.authSdk.browserLocalPersistence); if (options.persistence) await options.persistence.promise; if (options.persistenceError) throw new Error(PRIVATE); },
      async signInAnonymously(value) { events.push('sign-in'); assert.equal(value, auth); assert.equal(storage.getItem(IDENTITY_ATTEMPT_KEY), 'attempted'); if (options.signInError) throw new Error(PRIVATE); const result = options.signIn ? await options.signIn.promise : { user: identity('new-anonymous-uid') }; auth.currentUser = result.user; return result; },
    },
  };
  options.configure?.({ sdk, auth, storage, events });
  const location = { href: options.href || PAGE }, environment = options.environment || {};
  const client = createConnectionCheck(options.runtime === undefined ? runtime() : options.runtime, {
    location, environment, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
    getAttemptStorage: () => options.storageThrows ? (() => { throw new Error(PRIVATE); })() : storage,
    withIdentityLock: options.withIdentityLock || (async (callback) => { events.push('identity-lock'); if (options.lockBlocked) throw new Error(PRIVATE); return callback(); }),
    loadSdk: options.loadSdk || (async () => { events.push('load-sdk'); if (options.sdkFlight) await options.sdkFlight.promise; return sdk; }),
    onState(state) { states.push(state); },
  });
  return { client, sdk, auth, storage, events, states, time, location, environment, apps };
}
const source = (name) => readFile(new URL(`../lab/floating-garden/connection-check/${name}`, import.meta.url), 'utf8');

test('constructor is inert until explicit start and state contains only safe fields', () => {
  const f = fixture(); assert.deepEqual(f.events, []); assert.equal(f.time.timers.size, 0); assert.deepEqual(f.storage.writes, []);
  assert.deepEqual(f.client.getState(), { status: 'idle', label: CONNECTION_LABELS.idle, uid: null, expiresAtMillis: runtime().expiresAtMillis, canStart: true, diagnosticStage: null, diagnosticCode: null });
});
test('exact dedicated config is cloned/frozen, with independent finite <=48h window', () => {
  const input = runtime(), validated = validateConnectionRuntime(input);
  input.firebase.projectId = 'wa-awesome'; assert.equal(validated.firebase.projectId, CONNECTION_PROJECT);
  assert.ok(Object.isFrozen(validated)); assert.ok(Object.isFrozen(validated.firebase)); assert.ok(Object.isFrozen(validated.appCheck));
  const bounded = runtime(); bounded.expiresAtMillis = bounded.startsAtMillis + CONNECTION_MAX_DURATION_MILLIS;
  assert.doesNotThrow(() => validateConnectionRuntime(bounded)); bounded.expiresAtMillis++; assert.throws(() => validateConnectionRuntime(bounded));
});
test('schema rejects unknown fields, getters and every unpinned Firebase/Enterprise identifier before SDK/network', async () => {
  const bad = [null, {}, { ...runtime(), enabled: true }, { ...runtime(), schemaVersion: 2 }, { ...runtime(), projectId: 'wa-awesome' }, { ...runtime(), origin: `${CONNECTION_ORIGIN}/` },
    { ...runtime(), startsAtMillis: 0 }, { ...runtime(), expiresAtMillis: Infinity }, { ...runtime(), expiresAtMillis: NOW - 1000 }, { ...runtime(), expiresAtMillis: `${NOW}` },
    { ...runtime(), expiresAtMillis: NOW + CONNECTION_MAX_DURATION_MILLIS + 1 }];
  for (const field of ['apiKey', 'appId', 'projectId', 'authDomain']) { const value = runtime(); value.firebase[field] += '-different'; bad.push(value); }
  for (const patch of [{ databaseURL: 'https://wa-awesome.firebaseio.com' }, { apiKey: 'AIzaSyBtb74uz6clsoc9uA_AkDHi7DdepEWn2dw' }]) { const value = runtime(); Object.assign(value.firebase, patch); bad.push(value); }
  for (const patch of [{ provider: 'recaptcha-v3' }, { siteKey: '6Lc_LNwtAAAAADRAHvq1OFwxirR3c5jZlxs9QpYw' }, { debug: true }, { verified: true }]) { const value = runtime(); Object.assign(value.appCheck, patch); bad.push(value); }
  const getter = runtime(); Object.defineProperty(getter, 'origin', { get() { throw new Error(PRIVATE); }, enumerable: true }); bad.push(getter);
  for (const input of bad) { const f = fixture({ runtime: input }); assert.equal((await f.client.start()).status, 'invalid'); assert.deepEqual(f.events, []); assert.equal(f.time.timers.size, 0); assert.deepEqual(f.storage.writes, []); }
});
test('exact origin, no query overrides, active window and no inherited/own debug global are enforced before imports', async () => {
  const origins = ['http://wa-awesome-garden-stg.web.app/', 'https://wa-awesome.web.app/', 'https://wa-awesome-garden-stg.firebaseapp.com/', 'https://wa-awesome-garden-stg.web.app.evil.example/', 'https://wa-awesome-garden-stg.web.app:8443/', 'https://someone:password@wa-awesome-garden-stg.web.app/', 'http://localhost:8080/', `${PAGE}?debug=true`];
  for (const href of origins) { const f = fixture({ href }); assert.equal((await f.client.start()).status, 'invalid'); assert.deepEqual(f.events, []); }
  for (const environment of [{ FIREBASE_APPCHECK_DEBUG_TOKEN: true }, { FIREBASE_APPCHECK_DEBUG_TOKEN: false }, Object.create({ FIREBASE_APPCHECK_DEBUG_TOKEN: PRIVATE })]) { const f = fixture({ environment }); await f.client.start(); assert.deepEqual(f.events, []); }
  for (const now of [NOW - 1001, runtime().expiresAtMillis, NaN, Infinity]) { const f = fixture(); f.time.set(now); await f.client.start(); assert.deepEqual(f.events, []); }
  assert.doesNotThrow(() => assertConnectionAccess(validateConnectionRuntime(runtime()), `${PAGE}#information`, NOW, {}));
});
test('Enterprise success precedes Auth, uses exact app and local persistence, exposes only own UID', async () => {
  const f = fixture({ user: null }), result = await f.client.start();
  assert.equal(result.status, 'connected'); assert.equal(result.uid, 'new-anonymous-uid');
  assert.equal(f.apps[0].name, CONNECTION_APP_NAME); assert.deepEqual(f.apps[0].options, runtime().firebase);
  assert.ok(f.events.indexOf('get-token') < f.events.indexOf('initialize-auth')); assert.ok(f.events.indexOf('persistence') < f.events.indexOf('sign-in'));
  assert.equal(f.events.filter((e) => e === 'sign-in').length, 1); assert.deepEqual(f.storage.writes, [{ key: IDENTITY_ATTEMPT_KEY, value: 'attempted' }]);
  for (const state of f.states) { assert.deepEqual(Object.keys(state).sort(), ['canStart', 'diagnosticCode', 'diagnosticStage', 'expiresAtMillis', 'label', 'status', 'uid']); assert.ok(Object.isFrozen(state)); }
  assert.ok(!JSON.stringify(f.states).includes(PRIVATE)); f.client.stop();
});
test('duplicate clicks share one flight and completed start cannot create another UID', async () => {
  const signIn = deferred(), f = fixture({ user: null, signIn });
  const one = f.client.start(), two = f.client.start(); assert.equal(one, two); await flush(); assert.equal(f.events.filter((e) => e === 'sign-in').length, 1);
  signIn.resolve({ user: identity() }); await one; await f.client.start(); assert.equal(f.events.filter((e) => e === 'sign-in').length, 1); f.client.stop();
});
test('existing anonymous UID survives reload and expiry without another sign-in or clearing persistence', async () => {
  const storage = store(), first = fixture({ storage }); const before = await first.client.start(); first.time.set(runtime().expiresAtMillis); first.time.fire();
  assert.equal(first.client.getState().status, 'expired'); assert.equal(first.auth.currentUser.uid, before.uid); assert.equal(storage.getItem(IDENTITY_ATTEMPT_KEY), 'attempted');
  const second = fixture({ storage, user: first.auth.currentUser }); assert.equal((await second.client.start()).uid, before.uid);
  assert.equal(first.events.includes('sign-in'), false); assert.equal(second.events.includes('sign-in'), false); second.client.stop();
});
test('nonanonymous or malformed identity fails without sign-out or sign-in fallback', async () => {
  for (const user of [{ uid: 'signed-in-person', isAnonymous: false }, { uid: '<svg>', isAnonymous: true }, { uid: '', isAnonymous: true }, { uid: PRIVATE, isAnonymous: false }]) {
    const f = fixture({ user }); assert.equal((await f.client.start()).status, 'failed'); assert.equal(f.events.includes('sign-in'), false); assert.equal(f.auth.currentUser, user); assert.ok(!JSON.stringify(f.states).includes(PRIVATE));
  }
});
test('failed/empty App Check never initializes Auth and raw errors are not reflected', async () => {
  for (const opts of [{ proofError: true }, { invalidProof: null }, { invalidProof: {} }, { invalidProof: { token: '' } }, { invalidProof: { token: 3 } }, { initializeCheckThrows: true }]) {
    const f = fixture(opts); assert.equal((await f.client.start()).status, 'failed'); assert.equal(f.events.includes('initialize-auth'), false); assert.equal(f.events.includes('sign-in'), false); assert.ok(f.events.includes('delete-app')); assert.ok(!JSON.stringify(f.states).includes(PRIVATE));
  }
});
test('duplicate app fails closed without deleting another owner app', async () => {
  const f = fixture({ duplicate: true }); assert.equal((await f.client.start()).status, 'failed'); assert.deepEqual(f.events, ['load-sdk']);
});
test('SDK arrival after pagehide, deadline, expiry, wrong origin or injected debug cannot initialize', async () => {
  for (const action of ['stop', 'timeout', 'expiry', 'origin', 'debug']) {
    const sdkFlight = deferred(), f = fixture({ sdkFlight }), pending = f.client.start();
    if (action === 'stop') f.client.stop();
    if (action === 'timeout') { f.time.set(NOW + CONNECTION_STAGE_TIMEOUT_MILLIS); f.time.fire(); }
    if (action === 'expiry') { f.time.set(runtime().expiresAtMillis); f.time.fire(); }
    if (action === 'origin') f.location.href = 'https://wa-awesome.web.app/';
    if (action === 'debug') f.environment.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    sdkFlight.resolve(); await pending; await flush(); assert.deepEqual(f.events, ['load-sdk']); assert.equal(f.client.getState().uid, null); assert.equal(f.time.timers.size, 0);
  }
});
test('late proof after pagehide/deadline cannot start Auth or publish success; refresh disabled and app deleted once', async () => {
  for (const action of ['stop', 'timeout', 'expiry']) {
    const proof = deferred(), f = fixture({ proof }), pending = f.client.start(); await flush();
    if (action === 'stop') f.client.stop(); else { f.time.set(action === 'expiry' ? runtime().expiresAtMillis : NOW + CONNECTION_STAGE_TIMEOUT_MILLIS); f.time.fire(); }
    await pending; proof.resolve({ token: PRIVATE }); await flush(); f.client.stop(); await f.client.start();
    assert.equal(f.events.includes('initialize-auth'), false); assert.equal(f.events.filter((e) => e === 'delete-app').length, 1); assert.equal(f.events.filter((e) => e === 'refresh:false').length, 1); assert.equal(f.states.some((s) => s.status === 'connected'), false); assert.equal(f.time.timers.size, 0);
  }
});
test('expiry/pagehide during persistence or auth restoration never starts sign-in', async () => {
  for (const field of ['persistence', 'ready']) {
    const latch = deferred(), f = fixture({ user: null, [field]: latch }), pending = f.client.start(); await flush(); f.client.stop(); await pending;
    latch.resolve(); await flush(); assert.equal(f.events.includes('sign-in'), false); assert.equal(f.states.some((s) => s.status === 'connected'), false); assert.deepEqual(f.storage.writes, []);
  }
});
test('late Auth after timeout/pagehide/expiry is not repeated or shown as success, and reload does not mint a second UID', async () => {
  for (const action of ['stop', 'timeout', 'expiry']) {
    const signIn = deferred(), f = fixture({ user: null, signIn }), pending = f.client.start(); await flush(); assert.ok(f.events.includes('sign-in'));
    if (action === 'stop') f.client.stop(); else { f.time.set(action === 'expiry' ? runtime().expiresAtMillis : NOW + CONNECTION_STAGE_TIMEOUT_MILLIS); f.time.fire(); }
    await pending; await f.client.start(); assert.equal(f.events.filter((e) => e === 'sign-in').length, 1);
    const reload = fixture({ user: null, storage: f.storage }); assert.equal((await reload.client.start()).status, 'failed'); assert.equal(reload.events.includes('sign-in'), false);
    signIn.resolve({ user: identity('late-anonymous-uid') }); await flush(); assert.equal(f.states.some((s) => s.status === 'connected'), false); assert.equal(f.client.getState().uid, null);
    const recovered = fixture({ user: f.auth.currentUser, storage: f.storage }); assert.equal((await recovered.client.start()).uid, 'late-anonymous-uid'); assert.equal(recovered.events.includes('sign-in'), false); recovered.client.stop();
  }
});
test('Auth rejection remains one-shot across retry/reload and does not leak rejected payload', async () => {
  const f = fixture({ user: null, signInError: true }); assert.equal((await f.client.start()).status, 'failed'); await f.client.start();
  const reload = fixture({ user: null, storage: f.storage }); assert.equal((await reload.client.start()).status, 'failed'); assert.equal(reload.events.includes('sign-in'), false); assert.ok(!JSON.stringify(f.states).includes(PRIVATE));
});
test('unavailable persistence/storage/identity lock fails closed before a new anonymous UID', async () => {
  for (const options of [{ persistenceError: true }, { storageThrows: true }, { lockBlocked: true }, { storage: { getItem() { return null; }, setItem() {} } }]) {
    const f = fixture({ user: null, ...options }); assert.equal((await f.client.start()).status, 'failed'); assert.equal(f.events.includes('sign-in'), false); assert.equal(f.time.timers.size, 0);
  }
});
test('terminal pagehide before start prevents any network and unknown disposal errors remain safe', async () => {
  const never = fixture(); never.client.stop(); await never.client.start(); assert.deepEqual(never.events, []);
  const f = fixture({ refreshThrows: true, deleteThrows: true }); await f.client.start(); assert.doesNotThrow(() => f.client.stop()); assert.equal(f.client.getState().status, 'stopped'); assert.ok(!JSON.stringify(f.states).includes(PRIVATE));
});
test('suspended/early timers and visibility access recheck respect fixed wall-clock end', async () => {
  const f = fixture(); await f.client.start(); const [id, oldExpiry] = [...f.time.timers.entries()][0]; f.time.timers.delete(id); oldExpiry.fn(); assert.equal(f.client.getState().status, 'connected');
  f.time.set(runtime().expiresAtMillis); assert.equal(f.client.checkAccess().status, 'expired'); assert.equal(f.time.timers.size, 0);
});
test('default browser lock absence blocks identity creation rather than using unsafe fallback', async () => {
  // The default lock is deliberately required, not emulated with a check/write race.
  const f = fixture(), sourceText = await source('connection.js');
  assert.match(sourceText, /navigator\?\.locks\?\.request/); assert.match(sourceText, /ifAvailable: true/); f.client.stop();
});
test('static isolation: exactly three pinned remote SDK imports, no game/network/token sinks, explicit start and lifecycle handlers', async () => {
  const js = await source('connection.js'), app = await source('app.js'), html = await source('index.html'), css = await source('style.css');
  assert.deepEqual([...js.matchAll(/import\('([^']+)'\)/g)].map((m) => m[1]), [
    'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js',
    'https://www.gstatic.com/firebasejs/10.8.0/firebase-app-check.js',
    'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js',
  ]);
  for (const text of [js, app, html]) assert.doesNotMatch(text, /firebase-firestore|firebase-functions|httpsCallable|onSnapshot|trialruntime|match-engine|trial\/config|fetch\(|XMLHttpRequest|sendBeacon|console\.|innerHTML|sessionStorage|signOut\(|(?:localStorage|sessionStorage|storage)\.clear\(|removeItem\(/);
  assert.match(app, /import runtime from '\.\/connection-runtime\.js'/); assert.match(app, /addEventListener\('click'/); assert.match(app, /addEventListener\('pagehide'/); assert.match(app, /addEventListener\('pageshow'/); assert.match(app, /addEventListener\('visibilitychange'/);
  assert.equal((app.match(/connection\.start\(/g) || []).length, 1); assert.match(html, /id="connection-start"[^>]*disabled/); assert.doesNotMatch(html + css, /https?:\/\//); assert.match(app, /textContent/);
});

test('fake-browser UI shows expiry before Start; repeated click, pagehide, BFCache and visibility never restart', async () => {
  const appSource = (await source('app.js')).replace(/^import[^\n]+\n/gm, '');
  const nodes = new Map(['connection-start', 'connection-status', 'connection-uid', 'connection-expiry', 'connection-diagnostic'].map((id) => [id, { textContent: '', disabled: true, handlers: new Map(), addEventListener(event, callback) { this.handlers.set(event, callback); } }]));
  const documentHandlers = new Map(), windowHandlers = new Map(), time = clock(), storage = store(), f = fixture({ storage, user: null });
  let controller;
  vm.runInNewContext(appSource, {
    runtime: runtime(), Intl,
    document: { getElementById: (id) => nodes.get(id), addEventListener: (event, callback) => documentHandlers.set(event, callback) },
    window: { addEventListener: (event, callback) => windowHandlers.set(event, callback) },
    createConnectionCheck(value, { onState }) {
      controller = createConnectionCheck(value, { location: PAGE, environment: {}, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
        loadSdk: async () => { f.events.push('load-sdk'); return f.sdk; }, getAttemptStorage: () => storage, withIdentityLock: async (callback) => callback(), onState });
      return controller;
    },
  });
  assert.equal(nodes.get('connection-status').textContent, '開始前'); assert.equal(nodes.get('connection-start').disabled, false);
  assert.notEqual(nodes.get('connection-expiry').textContent, '開始時に確認します'); assert.deepEqual(f.events, []);
  nodes.get('connection-start').handlers.get('click')(); nodes.get('connection-start').handlers.get('click')(); await flush();
  assert.equal(nodes.get('connection-uid').textContent, 'new-anonymous-uid'); assert.equal(f.events.filter((e) => e === 'sign-in').length, 1);
  windowHandlers.get('pagehide')(); assert.equal(nodes.get('connection-status').textContent, '接続確認を停止しました'); assert.equal(nodes.get('connection-start').disabled, true);
  windowHandlers.get('pageshow')(); documentHandlers.get('visibilitychange')(); nodes.get('connection-start').handlers.get('click')(); await flush();
  assert.equal(nodes.get('connection-status').textContent, '接続確認を停止しました'); assert.equal(nodes.get('connection-uid').textContent, '未確認'); assert.equal(f.events.filter((e) => e === 'sign-in').length, 1);
  assert.equal(time.timers.size, 0); assert.equal(controller.getState().status, 'stopped');
});

test('observer-triggered stop cannot continue from a state publication into SDK/Auth work', async () => {
  for (const atStatus of ['checking', 'authenticating']) {
    const f = fixture(), time = clock(); let client;
    client = createConnectionCheck(runtime(), { location: PAGE, environment: {}, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
      loadSdk: async () => { f.events.push('load-sdk'); return f.sdk; }, getAttemptStorage: () => f.storage, withIdentityLock: async (callback) => callback(),
      onState(state) { if (state.status === atStatus) client.stop(); } });
    await client.start(); assert.equal(client.getState().status, 'stopped'); assert.equal(f.events.includes('initialize-auth'), false);
    if (atStatus === 'checking') assert.deepEqual(f.events, []); assert.equal(time.timers.size, 0);
  }
});
test('actual default lock path refuses a browser lacking Web Locks before anonymous creation', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
  try {
    const f = fixture({ user: null }), client = createConnectionCheck(runtime(), { location: PAGE, environment: {}, now: f.time.now,
      setTimer: f.time.setTimer, clearTimer: f.time.clearTimer, loadSdk: async () => f.sdk, getAttemptStorage: () => f.storage });
    assert.equal((await client.start()).status, 'failed'); assert.equal(f.events.includes('sign-in'), false); assert.deepEqual(f.storage.writes, []);
  } finally { if (saved) Object.defineProperty(globalThis, 'navigator', saved); else delete globalThis.navigator; }
});

const SDK_CODES = [
  'appCheck/recaptcha-error', 'appCheck/fetch-network-error', 'appCheck/fetch-parse-error',
  'appCheck/fetch-status-error', 'appCheck/throttled', 'appCheck/already-initialized',
  'appCheck/use-before-activation', 'appCheck/storage-open', 'appCheck/storage-get', 'appCheck/storage-set',
  'auth/network-request-failed', 'auth/operation-not-allowed', 'auth/admin-restricted-operation',
  'auth/invalid-api-key', 'auth/app-not-authorized', 'auth/too-many-requests', 'auth/quota-exceeded',
  'auth/internal-error', 'auth/web-storage-unsupported', 'auth/invalid-user-token',
  'auth/user-token-expired', 'auth/user-disabled', 'auth/already-initialized',
];
const LOCAL_CODES = [
  'connection/unknown', 'connection/invalid-access', 'connection/timeout', 'connection/expired',
  'connection/stopped', 'connection/duplicate-app', 'connection/lock-unavailable', 'connection/lock-busy',
  'connection/storage-unavailable', 'connection/previous-attempt', 'connection/storage-unconfirmed',
  'connection/invalid-proof', 'connection/invalid-identity', 'connection/identity-mismatch',
];
function expectDiagnostic(state, stage, code, status = 'failed') {
  assert.equal(state.status, status);
  assert.equal(state.diagnosticStage, stage);
  assert.equal(state.diagnosticCode, code);
  assert.equal(state.uid, null);
  assert.equal(state.canStart, false);
  assert.ok(Object.isFrozen(state));
}
function rejectionFixture(operation, error, async = false) {
  const fail = async ? () => Promise.reject(error) : () => { throw error; };
  const options = { user: null };
  if (operation === 'sdk-load') options.loadSdk = fail;
  else if (operation === 'identity-lock') options.withIdentityLock = fail;
  else options.configure = ({ sdk, auth }) => {
    const methods = {
      'app-init': [sdk.appSdk, 'initializeApp'],
      'app-check-init': [sdk.appCheckSdk, 'initializeAppCheck'],
      'app-check-request': [sdk.appCheckSdk, 'getToken'],
      'auth-init': [sdk.authSdk, 'initializeAuth'],
      'auth-persistence-restore': [sdk.authSdk, 'setPersistence'],
      'identity-ready': [auth, 'authStateReady'],
      'anonymous-signup': [sdk.authSdk, 'signInAnonymously'],
    };
    const [target, method] = methods[operation]; target[method] = fail;
  };
  return fixture(options);
}

test('every synchronous SDK operation is attributed before invocation; asynchronous rejections retain its phase', async () => {
  const cases = [
    ['sdk-load', 'initialize-app', true], ['app-init', 'enterprise-provider', false],
    ['app-check-init', 'get-token', false], ['app-check-request', 'initialize-auth', true],
    ['auth-init', 'persistence', false], ['auth-persistence-restore', 'identity-lock', true],
    ['identity-lock', 'auth-ready', true], ['identity-ready', 'sign-in', true],
    ['anonymous-signup', null, true],
  ];
  for (const [stage, blocked, supportsAsync] of cases) {
    for (const async of supportsAsync ? [false, true] : [false]) {
      const error = Object.assign(new Error(PRIVATE), { code: 'auth/network-request-failed', customData: { token: PRIVATE } });
      const f = rejectionFixture(stage, error, async);
      expectDiagnostic(await f.client.start(), stage, 'auth/network-request-failed');
      if (blocked) assert.equal(f.events.includes(blocked), false, stage);
      assert.equal(f.states.some((state) => state.status === 'connected'), false);
      assert.ok(!JSON.stringify(f.states).includes(PRIVATE)); assert.equal(f.time.timers.size, 0);
    }
  }
});

test('preflight, app lookup, provider construction, guard and validation identify synchronous failure sites', async () => {
  const invalid = fixture({ runtime: {} });
  expectDiagnostic(await invalid.client.start(), 'preflight', 'connection/invalid-access', 'invalid');
  assert.deepEqual(invalid.events, []);
  for (const [stage, configure] of [
    ['app-init', ({ sdk }) => { sdk.appSdk.getApps = () => { throw { code: 'auth/internal-error', message: PRIVATE }; }; }],
    ['app-check-init', ({ sdk }) => { sdk.appCheckSdk.ReCaptchaEnterpriseProvider = class { constructor() { throw { code: 'appCheck/recaptcha-error', message: PRIVATE }; } }; }],
  ]) {
    const f = fixture({ configure }); const result = await f.client.start();
    expectDiagnostic(result, stage, stage === 'app-init' ? 'auth/internal-error' : 'appCheck/recaptcha-error');
    assert.equal(f.events.includes('get-token'), false);
  }
  const guard = fixture({ user: null, storageThrows: true });
  expectDiagnostic(await guard.client.start(), 'identity-guard', 'connection/storage-unavailable');
  assert.equal(guard.events.includes('sign-in'), false);
  const user = { uid: 'safe-uid', get isAnonymous() { throw { code: 'auth/internal-error', message: PRIVATE }; } };
  const validation = fixture({ user });
  expectDiagnostic(await validation.client.start(), 'final-validation', 'auth/internal-error');
});

test('diagnostic allowlist is exact and permits only primitive own data values', async () => {
  for (const code of [...SDK_CODES, ...LOCAL_CODES]) {
    const error = Object.assign(Object.create(null), { code, message: PRIVATE, stack: PRIVATE, cause: PRIVATE, customData: { token: PRIVATE }, accessToken: PRIVATE });
    for (const async of [false, true]) {
      const f = rejectionFixture('app-check-request', error, async);
      expectDiagnostic(await f.client.start(), 'app-check-request', code);
      assert.ok(!JSON.stringify(f.states).includes(PRIVATE));
    }
  }
  for (const code of ['auth/not-allowlisted', 'appCheck/not-allowlisted', `auth/${PRIVATE}`, `connection/${PRIVATE}`,
    ' auth/network-request-failed', 'auth/network-request-failed ', 'AUTH/network-request-failed',
    `auth/network-request-failed\n${PRIVATE}`, '', 42, null, new String('auth/network-request-failed'), Symbol(PRIVATE),
    { toString() { throw new Error(PRIVATE); } }]) {
    const f = rejectionFixture('anonymous-signup', { code, message: PRIVATE }, true);
    expectDiagnostic(await f.client.start(), 'anonymous-signup', 'connection/unknown');
    assert.ok(!JSON.stringify(f.states).includes(PRIVATE));
  }
});

test('error boundary never invokes code/accessor inheritance, formatting, or secret field getters', async () => {
  let accesses = 0;
  const trap = () => { accesses++; throw new Error(PRIVATE); };
  const ownGetter = Object.defineProperty({}, 'code', { get: trap });
  const inheritedGetter = Object.create(Object.defineProperty({}, 'code', { get: trap }));
  const inheritedData = Object.create({ code: 'auth/network-request-failed' });
  const secretGetters = { code: 'appCheck/throttled' };
  for (const key of ['message', 'stack', 'cause', 'customData', 'accessToken', 'name', 'toString', 'toJSON']) {
    Object.defineProperty(secretGetters, key, { get: trap });
  }
  for (const error of [ownGetter, inheritedGetter, inheritedData, secretGetters, null, undefined, PRIVATE, 7, true, Symbol(PRIVATE)]) {
    for (const async of [false, true]) {
      const f = rejectionFixture('app-check-request', error, async);
      expectDiagnostic(await f.client.start(), 'app-check-request', error === secretGetters ? 'appCheck/throttled' : 'connection/unknown');
      assert.ok(!JSON.stringify(f.states).includes(PRIVATE));
    }
  }
  assert.equal(accesses, 0);
});

test('throwing/revoked Proxy errors cannot escape or reflect arbitrary fields', async () => {
  let descriptors = 0, properties = 0;
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const throwing = new Proxy({}, {
    getOwnPropertyDescriptor(_target, key) { descriptors++; assert.equal(key, 'code'); throw new Error(PRIVATE); },
    get() { properties++; throw new Error(PRIVATE); },
  });
  const allowed = new Proxy({ code: 'appCheck/fetch-network-error' }, {
    get() { properties++; throw new Error(PRIVATE); },
  });
  for (const error of [revoked.proxy, throwing, allowed]) {
    for (const async of [false, true]) {
      const f = rejectionFixture('app-check-request', error, async);
      expectDiagnostic(await f.client.start(), 'app-check-request', error === allowed ? 'appCheck/fetch-network-error' : 'connection/unknown');
      assert.ok(!JSON.stringify(f.states).includes(PRIVATE));
    }
  }
  assert.equal(descriptors, 2); assert.equal(properties, 0);
});

test('application-owned checks have fixed local codes and keep attempt/write behavior', async () => {
  const previous = store(); previous.values.set(IDENTITY_ATTEMPT_KEY, 'attempted');
  const unreadable = { getItem() { throw { code: 'auth/internal-error', message: PRIVATE }; }, setItem() { assert.fail('must not write'); } };
  const unwritable = { getItem() { return null; }, setItem() { throw new Error(PRIVATE); } };
  const unconfirmed = { getItem() { return null; }, setItem() {} };
  for (const [options, stage, code] of [
    [{ duplicate: true }, 'app-init', 'connection/duplicate-app'],
    [{ invalidProof: null }, 'app-check-request', 'connection/invalid-proof'],
    [{ user: null, storage: previous }, 'identity-guard', 'connection/previous-attempt'],
    [{ user: null, storage: unreadable }, 'identity-guard', 'connection/storage-unavailable'],
    [{ user: null, storage: unwritable }, 'identity-guard', 'connection/storage-unavailable'],
    [{ user: null, storage: unconfirmed }, 'identity-guard', 'connection/storage-unconfirmed'],
    [{ user: { uid: 'nonanonymous', isAnonymous: false } }, 'final-validation', 'connection/invalid-identity'],
  ]) {
    const f = fixture(options); expectDiagnostic(await f.client.start(), stage, code);
    assert.equal(f.events.includes('sign-in'), false);
  }
  const mismatch = fixture({ user: null, configure({ sdk }) { sdk.authSdk.signInAnonymously = async () => ({ user: identity('different-user') }); } });
  expectDiagnostic(await mismatch.client.start(), 'final-validation', 'connection/identity-mismatch');
  assert.equal(mismatch.storage.getItem(IDENTITY_ATTEMPT_KEY), 'attempted');
  assert.deepEqual(previous.writes, []);
});

test('actual missing/busy browser lock failures use fixed local diagnostics', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    for (const [navigator, code] of [[{}, 'connection/lock-unavailable'], [{ locks: { request: async (_name, _options, callback) => callback(null) } }, 'connection/lock-busy']]) {
      Object.defineProperty(globalThis, 'navigator', { value: navigator, configurable: true });
      const f = fixture({ user: null }), client = createConnectionCheck(runtime(), { location: PAGE, environment: {}, now: f.time.now,
        setTimer: f.time.setTimer, clearTimer: f.time.clearTimer, loadSdk: async () => f.sdk, getAttemptStorage: () => f.storage });
      expectDiagnostic(await client.start(), 'identity-lock', code);
      assert.equal(f.events.includes('sign-in'), false); assert.deepEqual(f.storage.writes, []);
    }
  } finally { if (saved) Object.defineProperty(globalThis, 'navigator', saved); else delete globalThis.navigator; }
});

test('each existing timeout reports the active phase and late rejections are not inspected', async () => {
  for (const [field, stage] of [['sdkFlight', 'sdk-load'], ['proof', 'app-check-request'], ['persistence', 'auth-persistence-restore'], ['ready', 'identity-ready'], ['signIn', 'anonymous-signup']]) {
    const latch = deferred(), f = fixture({ user: null, [field]: latch }), pending = f.client.start(); await flush();
    f.time.set(NOW + CONNECTION_STAGE_TIMEOUT_MILLIS); f.time.fire();
    const first = await pending; expectDiagnostic(first, stage, 'connection/timeout', 'timeout');
    let inspected = 0;
    latch.reject(new Proxy({}, { getOwnPropertyDescriptor() { inspected++; throw new Error(PRIVATE); } }));
    await flush(); f.client.stop(); f.time.set(runtime().expiresAtMillis); f.client.checkAccess(); await f.client.start();
    assert.equal(f.client.getState(), first); assert.equal(inspected, 0); assert.equal(f.time.timers.size, 0);
    assert.equal(f.states.filter((state) => state.status === 'timeout').length, 1);
    assert.equal(f.states.some((state) => state.status === 'connected'), false);
  }
});

test('lock, readiness and signup share one timeout budget without reset or added timers', async () => {
  const lock = deferred(), ready = deferred(), signIn = deferred();
  const f = fixture({ user: null, ready, signIn, withIdentityLock: async (callback) => { await lock.promise; return callback(); } });
  const pending = f.client.start(); await flush();
  const budgets = () => f.time.scheduled.filter(({ delay }) => delay === CONNECTION_STAGE_TIMEOUT_MILLIS);
  assert.equal(budgets().length, 4);
  f.time.set(NOW + 5000); lock.resolve(); await flush(); assert.ok(f.events.includes('auth-ready'));
  f.time.set(NOW + 10000); ready.resolve(); await flush(); assert.ok(f.events.includes('sign-in'));
  assert.equal(budgets().length, 4); assert.equal(f.time.timers.size, 2);
  f.time.set(NOW + 15000); f.time.fire();
  expectDiagnostic(await pending, 'anonymous-signup', 'connection/timeout', 'timeout');
  signIn.resolve({ user: identity('late-shared-budget-uid') }); await flush();
  expectDiagnostic(f.client.getState(), 'anonymous-signup', 'connection/timeout', 'timeout');
  assert.equal(f.storage.getItem(IDENTITY_ATTEMPT_KEY), 'attempted');
  const waitingLock = deferred();
  const blocked = fixture({ user: null, withIdentityLock: async (callback) => { await waitingLock.promise; return callback(); } });
  const blockedFlight = blocked.client.start(); await flush(); blocked.time.set(NOW + 15000); blocked.time.fire();
  expectDiagnostic(await blockedFlight, 'identity-lock', 'connection/timeout', 'timeout');
  waitingLock.resolve(); await flush(); assert.equal(blocked.events.includes('auth-ready'), false); assert.deepEqual(blocked.storage.writes, []);
});

test('first expiry/pagehide/access failure freezes diagnostics despite late results and cleanup errors', async () => {
  for (const action of ['stop', 'expiry', 'origin', 'debug']) {
    const proof = deferred(), f = fixture({ proof, deleteThrows: true, refreshThrows: true }), pending = f.client.start(); await flush();
    if (action === 'stop') f.client.stop();
    if (action === 'expiry') { f.time.set(runtime().expiresAtMillis); f.time.fire(); }
    if (action === 'origin') { f.location.href = 'https://wa-awesome.web.app/'; f.client.checkAccess(); }
    if (action === 'debug') { f.environment.FIREBASE_APPCHECK_DEBUG_TOKEN = true; f.client.checkAccess(); }
    const first = await pending;
    const status = action === 'stop' ? 'stopped' : action === 'expiry' ? 'expired' : 'invalid';
    expectDiagnostic(first, 'app-check-request', `connection/${status === 'invalid' ? 'invalid-access' : status}`, status);
    proof.resolve({ token: PRIVATE }); await flush(); f.client.stop(); await f.client.start();
    assert.equal(f.client.getState(), first); assert.equal(f.events.includes('initialize-auth'), false);
    assert.equal(f.states.filter((state) => state.status === status).length, 1);
  }
  const failed = rejectionFixture('anonymous-signup', { code: 'auth/operation-not-allowed', message: PRIVATE }, true);
  const first = await failed.client.start(); failed.client.stop(); failed.time.set(runtime().expiresAtMillis); failed.client.checkAccess();
  assert.equal(failed.client.getState(), first); expectDiagnostic(first, 'anonymous-signup', 'auth/operation-not-allowed');
});

test('diagnostic UI uses textContent for fixed stage/code, and never raw rejected values', async () => {
  const appSource = (await source('app.js')).replace(/^import[^\n]+\n/gm, '');
  const nodes = new Map(['connection-start', 'connection-status', 'connection-uid', 'connection-expiry', 'connection-diagnostic'].map((id) => [id, {
    textContent: '', disabled: true, addEventListener() {}, set innerHTML(_value) { assert.fail('HTML sink'); },
  }]));
  for (const error of [{ code: 'auth/operation-not-allowed', message: PRIVATE }, { code: `<img src=x onerror=${PRIVATE}>`, message: PRIVATE }]) {
    const f = rejectionFixture('anonymous-signup', error, true); const result = await f.client.start();
    vm.runInNewContext(appSource, {
      runtime: {}, Intl, document: { getElementById: (id) => nodes.get(id), addEventListener() {} }, window: { addEventListener() {} },
      createConnectionCheck() { return { getState: () => result }; },
    });
    assert.equal(nodes.get('connection-diagnostic').textContent, `anonymous-signup / ${error.code.startsWith('auth/') ? 'auth/operation-not-allowed' : 'connection/unknown'}`);
    assert.ok(!JSON.stringify([...nodes.values()].map((node) => node.textContent)).includes(PRIVATE));
  }
});

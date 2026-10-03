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
  const timers = new Map();
  return { now: () => time, setTimer(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: time + delay }); return id; }, clearTimer(id) { timers.delete(id); },
    set(value) { time = value; }, fire() { for (const [id, item] of [...timers]) if (item.at <= time) { timers.delete(id); item.fn(); } }, timers };
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
  const location = { href: options.href || PAGE }, environment = options.environment || {};
  const client = createConnectionCheck(options.runtime === undefined ? runtime() : options.runtime, {
    location, environment, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
    getAttemptStorage: () => options.storageThrows ? (() => { throw new Error(PRIVATE); })() : storage,
    withIdentityLock: async (callback) => { events.push('identity-lock'); if (options.lockBlocked) throw new Error(PRIVATE); return callback(); },
    loadSdk: async () => { events.push('load-sdk'); if (options.sdkFlight) await options.sdkFlight.promise; return sdk; },
    onState(state) { states.push(state); },
  });
  return { client, sdk, auth, storage, events, states, time, location, environment, apps };
}
const source = (name) => readFile(new URL(`../lab/floating-garden/connection-check/${name}`, import.meta.url), 'utf8');

test('constructor is inert until explicit start and state contains only safe fields', () => {
  const f = fixture(); assert.deepEqual(f.events, []); assert.equal(f.time.timers.size, 0); assert.deepEqual(f.storage.writes, []);
  assert.deepEqual(f.client.getState(), { status: 'idle', label: CONNECTION_LABELS.idle, uid: null, expiresAtMillis: runtime().expiresAtMillis, canStart: true });
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
  for (const state of f.states) { assert.deepEqual(Object.keys(state).sort(), ['canStart', 'expiresAtMillis', 'label', 'status', 'uid']); assert.ok(Object.isFrozen(state)); }
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
  const nodes = new Map(['connection-start', 'connection-status', 'connection-uid', 'connection-expiry'].map((id) => [id, { textContent: '', disabled: true, handlers: new Map(), addEventListener(event, callback) { this.handlers.set(event, callback); } }]));
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

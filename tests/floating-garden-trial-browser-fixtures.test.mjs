// Pure regression tests: no emulator process, Chromium or network. Installed SDK
// construction is used only to verify direct callable endpoint selection.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeApp, deleteApp } from 'firebase/app';
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions';
import { prepareTrialEmulator } from './helpers/prepare-floating-garden-trial-emulator.mjs';
import { trialSdkFixture, sanitizeTrialRelayFailure, createTrialListenerDiagnostics, sanitizeTrialSnapshotRevisions } from './helpers/floating-garden-trial-sdk-fixture.mjs';

const origin = 'https://wa-garden-ci-trial--garden-7day-ci0001.web.app';
const fixture = { kind: 'floating-garden-trial-browser-emulator-only-v1', browserOrigin: 'http://127.0.0.1:8783', projectId: 'demo-floating-garden-trial',
  ports: { auth: 9099, firestore: 8183, functions: 5103 }, runtime: { previewOrigin: origin },
  config: { projectId: 'wa-garden-ci-trial', region: 'asia-northeast1', previewOrigin: origin } };
const baseEnv = { FUNCTIONS_EMULATOR: 'true', GCLOUD_PROJECT: fixture.projectId,
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8183', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' };

test('SDK fixtures require generated marker, exact demo project, loopback origin and pinned emulator ports', () => {
  for (const patch of [{ kind: undefined }, { projectId: 'wa-awesome' }, { browserOrigin: 'http://localhost:8783' },
    { browserOrigin: 'https://untrusted.example' }, { ports: { ...fixture.ports, auth: 443 } }, { runtime: { previewOrigin: 'https://untrusted.example' } }]) {
    assert.throws(() => trialSdkFixture('firebase-app.js', { ...fixture, ...patch }));
  }
  assert.equal(trialSdkFixture('unknown.js', fixture), null);
});

test('SDK adapters use native direct emulator connections without stream proxy or forced polling', () => {
  assert.match(trialSdkFixture('firebase-app.js', fixture), /projectId: "demo-floating-garden-trial"/);
  assert.match(trialSdkFixture('firebase-auth.js', fixture), /connectAuthEmulator\(auth, 'http:\/\/127\.0\.0\.1:9099'/);
  const firestore = trialSdkFixture('firebase-firestore.js', fixture);
  assert.match(firestore, /connectFirestoreEmulator\(db, '127\.0\.0\.1', 8183\)/);
  assert.doesNotMatch(firestore, /experimentalForceLongPolling|mockUserToken|route\.fetch/);
  assert.match(trialSdkFixture('firebase-functions.js', fixture), /connectFunctionsEmulator\(functions, '127\.0\.0\.1', 5103\)/);
  assert.match(trialSdkFixture('firebase-app-check.js', fixture), /synthetic fixture/);
});

function loadFirestoreFacade(real) {
  // Evaluate the exact generated facade without fetching the remote SDK. Only
  // the module prelude/export syntax is removed; its real-SDK calls are mocked.
  const source = trialSdkFixture('firebase-firestore.js', fixture).split('\n').slice(1).join('\n').replace(/export (const|function) /g, '$1 ');
  const context = { real };
  vm.runInNewContext(`${source}\nthis.facade = { onSnapshot, initializeFirestore };`, context);
  return { ...context.facade, history: context.__trialListenerDiagnostics };
}

test('generated listener facade forwards callbacks, arguments, options and each unsubscribe unchanged', () => {
  const calls = [], stopped = [], receiver = {}, reference = {}, options = { includeMetadataChanges: true };
  const real = { onSnapshot(...args) { assert.equal(this, real); calls.push(args); return function (...values) { stopped.push({ receiver: this, values }); return 'unsubscribed'; }; } };
  const facade = loadFirestoreFacade(real), callbacks = [];
  function next(...values) { callbacks.push({ receiver: this, values }); return 'next-result'; }
  function error(...values) { callbacks.push({ receiver: this, values }); return 'error-result'; }
  const complete = () => {}, unsubscribe = facade.onSnapshot(reference, options, next, error, complete);
  assert.equal(calls.length, 1); assert.equal(calls[0].length, 5);
  assert.equal(calls[0][0], reference); assert.equal(calls[0][1], options); assert.equal(calls[0][4], complete);
  const snapshot = { data: () => ({ revision: 14, match: { revision: 12 }, secret: 'never-record' }), metadata: { fromCache: true, hasPendingWrites: false } };
  const problem = Object.assign(new Error('never-record'), { code: 'permission-denied' });
  assert.equal(calls[0][2].call(receiver, snapshot, 'extra'), 'next-result');
  assert.equal(calls[0][3].call(receiver, problem), 'error-result');
  assert.deepEqual(callbacks, [{ receiver, values: [snapshot, 'extra'] }, { receiver, values: [problem] }]);
  assert.equal(unsubscribe.call(receiver, 1), 'unsubscribed');
  assert.equal(unsubscribe.call(receiver, 2), 'unsubscribed');
  assert.deepEqual(stopped, [{ receiver, values: [1] }, { receiver, values: [2] }]);
  const history = JSON.parse(JSON.stringify(facade.history));
  assert.deepEqual(history.map(({ event }) => event), ['start', 'next', 'error', 'stop', 'stop']);
  assert.ok(history.every(({ id, time }) => id === 1 && Number.isSafeInteger(time)));
  assert.deepEqual(history[1], { id: 1, event: 'next', time: history[1].time, revision: 14, matchRevision: 12, fromCache: true, hasPendingWrites: false });
  assert.equal(history[2].code, 'permission-denied');
  assert.equal(JSON.stringify(history).includes('never-record'), false);
});

test('listener facade preserves observer receivers, missing callbacks and synchronous exceptions', () => {
  const calls = [], seen = [], history = [];
  const onSnapshot = createTrialListenerDiagnostics({ onSnapshot: (...args) => { calls.push(args); return () => {}; } }, history, () => 123);
  const observer = { next(value) { seen.push([this, value]); }, error(value) { seen.push([this, value]); }, complete() { seen.push([this, 'complete']); } };
  const snapshot = { data: () => ({ revision: 1 }), metadata: {} }, problem = { code: 'unavailable' };
  for (const options of [[], [{ includeMetadataChanges: true }]]) {
    onSnapshot({}, ...options, observer);
    const forwarded = calls.at(-1).at(-1);
    forwarded.next(snapshot); forwarded.error(problem); forwarded.complete();
    assert.deepEqual(seen.splice(0), [[observer, snapshot], [observer, problem], [observer, 'complete']]);
  }
  const thrown = new Error('callback-secret');
  onSnapshot({}, () => { throw thrown; });
  assert.equal(calls.at(-1).length, 2, 'no error callback is synthesized when the caller omitted it');
  assert.throws(() => calls.at(-1)[1](snapshot), (error) => error === thrown);
  let forwardedValue;
  onSnapshot({}, (value) => { forwardedValue = value; });
  const unreadable = { data() { throw thrown; } };
  calls.at(-1)[1](unreadable);
  assert.equal(forwardedValue, unreadable, 'diagnostic extraction cannot prevent original delivery');
  const failed = createTrialListenerDiagnostics({ onSnapshot() { throw thrown; } }, history);
  assert.throws(() => failed({}), (error) => error === thrown);
  assert.equal(history.at(-1).event, 'error'); assert.equal(history.at(-1).code, 'unknown');
  assert.equal(JSON.stringify(history).includes('callback-secret'), false);
});

test('listener diagnostics keep only bounded numeric metadata and fixed error codes', () => {
  const history = [], calls = [], secret = 'room-path-token-payload-do-not-record';
  const onSnapshot = createTrialListenerDiagnostics({ onSnapshot: (...args) => { calls.push(args); return () => {}; } }, history, () => Infinity);
  onSnapshot({ path: secret }, () => {}, () => {});
  const next = calls[0][1], error = calls[0][2];
  for (let revision = 0; revision < 300; revision += 1) next({ data: () => ({ revision, match: { revision }, id: secret, payload: secret }), metadata: { fromCache: false, hasPendingWrites: true } });
  assert.equal(history.length, 256); assert.equal(history[0].revision, 44); assert.equal(history.at(-1).revision, 299);
  next({ data: () => ({ revision: secret, match: { revision: -1 } }), metadata: { fromCache: secret, hasPendingWrites: 1 } });
  assert.deepEqual(history.at(-1), { id: 1, event: 'next', time: null, revision: null, matchRevision: null, fromCache: null, hasPendingWrites: null });
  for (const code of [secret, 'firestore/permission-denied', 7, null]) { error({ code, message: secret, stack: secret }); assert.equal(history.at(-1).code, 'unknown'); }
  error({ code: 'unavailable', message: secret }); assert.equal(history.at(-1).code, 'unavailable');
  onSnapshot({}, () => {})();
  assert.equal(history.at(-1).id, 2); assert.equal(history.length, 256);
  assert.equal(JSON.stringify(history).includes(secret), false);
  assert.deepEqual(sanitizeTrialSnapshotRevisions({ room: { id: secret, revision: 7, match: { revision: 5, payload: secret } }, self: { uid: secret } }), { revision: 7, matchRevision: 5 });
  for (const value of [undefined, null, '7', -1, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.deepEqual(sanitizeTrialSnapshotRevisions({ room: { revision: value, match: { revision: value } } }), { revision: null, matchRevision: null });
});

test('actual installed SDK creates exact direct demo/region callable URLs without making requests', async () => {
  const app = initializeApp({ projectId: fixture.projectId, apiKey: 'demo-floating-garden-trial-key', appId: 'demo-inert-url-check' }, 'trial-fixture-url-regression');
  try {
    const functions = getFunctions(app, fixture.config.region);
    connectFunctionsEmulator(functions, '127.0.0.1', fixture.ports.functions);
    for (const suffix of ['CreateRoom', 'JoinRoom', 'StartMatch', 'GetSnapshot', 'SubmitAction']) {
      assert.equal(functions._url(`floatingGarden${suffix}`), `http://127.0.0.1:5103/demo-floating-garden-trial/asia-northeast1/floatingGarden${suffix}`);
    }
  } finally { await deleteApp(app); }
});

test('finite lost-response diagnostics never preserve bearer headers, query tokens, message or stack', () => {
  const bearer = 'synthetic-bearer-do-not-record', token = 'synthetic-query-token';
  const url = `http://127.0.0.1:5103/demo-floating-garden-trial/asia-northeast1/floatingGardenSubmitAction?token=${token}`;
  const error = new Error(`route.fetch failed\nCall log:\nAuthorization: Bearer ${bearer}\nGET ${url}`);
  error.stack += `\nsecret ${bearer}`;
  const diagnostic = sanitizeTrialRelayFailure({ kind: 'functions', url, error });
  assert.deepEqual(diagnostic, { kind: 'functions', path: '/demo-floating-garden-trial/asia-northeast1/floatingGardenSubmitAction', errorName: 'Error', category: 'relay-failed' });
  for (const forbidden of [bearer, token, 'Authorization', 'Call log', 'message', 'stack', '?']) assert.equal(JSON.stringify(diagnostic).includes(forbidden), false);
  assert.deepEqual(sanitizeTrialRelayFailure({ kind: bearer, url: `${origin}/${token}`, error: { name: bearer, message: token }, status: 302 }),
    { kind: 'unknown', path: '[unrecognized]', errorName: 'Error', category: 'redirect-refused', status: 302 });
});

async function loadFixture(env, data = fixture) {
  const source = await readFile(new URL('./helpers/floating-garden-trial-functions-fixture.cjs', import.meta.url), 'utf8');
  let initializations = 0;
  const module = { exports: {} }, forwarded = [];
  class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const mocks = {
    'node:assert/strict': assert,
    'firebase-admin/app': { getApps: () => [], initializeApp: () => { initializations += 1; return {}; } },
    'firebase-admin/firestore': { getFirestore: () => ({}), Timestamp: { fromMillis: (value) => value } },
    'firebase-functions/v2/https': { onCall: (options, handler) => ({ options, handler }), HttpsError },
    './trial-handlers': { createTrialHandlers: () => ({ floatingGardenCreateRoom: (request) => { forwarded.push(request); return { ok: true }; } }), TrialError: class extends Error {} },
    './online/handlers': { createHandlers: () => ({}) }, './emulator-fixture.json': data,
  };
  try { vm.runInNewContext(source, { require: (name) => mocks[name], module, process: { env } }); }
  catch (error) { assert.equal(initializations, 0, 'unsafe environment must fail before SDK initialization'); throw error; }
  return { exports: module.exports, initializations, forwarded };
}

test('fixture discovery accepts CLI-filtered env and fails closed on non-emulator/project/loopback', async () => {
  assert.equal((await loadFixture({ ...baseEnv })).initializations, 1);
  for (const patch of [{ FUNCTIONS_EMULATOR: undefined }, { FUNCTIONS_EMULATOR: 'false' }, { GCLOUD_PROJECT: 'wa-awesome' },
    { FIRESTORE_EMULATOR_HOST: 'googleapis.com:443' }, { FIREBASE_AUTH_EMULATOR_HOST: undefined }]) await assert.rejects(loadFixture({ ...baseEnv, ...patch }));
  for (const patch of [{ kind: undefined }, { projectId: 'wa-awesome' }, { browserOrigin: 'https://untrusted.example' }]) await assert.rejects(loadFixture(baseEnv, { ...fixture, ...patch }));
  const env = { ...baseEnv }, runtime = await loadFixture(env);
  env.GCLOUD_PROJECT = 'wa-awesome';
  await assert.rejects(runtime.exports.floatingGardenCreateRoom.handler({}), /demo-floating-garden-trial/);
});

test('fixture validates actual exact loopback Origin before explicit synthetic Origin adaptation', async () => {
  const runtime = await loadFixture({ ...baseEnv });
  const endpoint = runtime.exports.floatingGardenCreateRoom;
  assert.equal(endpoint.options.cors.length, 1); assert.equal(endpoint.options.cors[0], fixture.browserOrigin);
  const makeRequest = (origin) => ({ auth: { uid: 'real-emulator-uid', token: { firebase: { sign_in_provider: 'anonymous' } } }, rawRequest: { ip: '127.0.0.1', headers: { origin } }, data: { requestId: 'inert-request-id' } });
  for (const wrong of [undefined, fixture.config.previewOrigin, 'http://localhost:8783', 'http://127.0.0.1:8784', 'https://untrusted.example']) {
    await assert.rejects(endpoint.handler(makeRequest(wrong)), { code: 'permission-denied' });
  }
  assert.equal(runtime.forwarded.length, 0);
  await assert.rejects(endpoint.handler({ ...makeRequest(fixture.browserOrigin), auth: null }), { code: 'unauthenticated' });
  const request = makeRequest(fixture.browserOrigin);
  await endpoint.handler(request);
  assert.equal(runtime.forwarded.length, 1);
  assert.equal(runtime.forwarded[0].rawRequest.headers.origin, fixture.config.previewOrigin);
  assert.equal(request.rawRequest.headers.origin, fixture.browserOrigin, 'original HTTP request is not mutated');
  assert.equal(runtime.forwarded[0].auth, request.auth);
  assert.equal(runtime.forwarded[0].data, request.data);
});

test('generated production graph and Functions remain unchanged; test entry stays outside deployable public', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'garden-trial-browser-fixtures-'));
  try {
    const { output } = await prepareTrialEmulator(join(parent, 'prepared'));
    const generated = JSON.parse(await readFile(join(output, 'emulator-fixture.json'), 'utf8'));
    assert.equal(generated.kind, fixture.kind); assert.equal(generated.browserOrigin, fixture.browserOrigin);
    for (const name of ['index.html', 'app.js', 'bootstrap.js', 'config.js', 'firebase.js']) {
      assert.deepEqual(await readFile(join(output, 'public/lab/floating-garden/trial', name)), await readFile(new URL(`../lab/floating-garden/trial/${name}`, import.meta.url)));
    }
    assert.deepEqual(await readFile(join(output, 'functions/index.js')), await readFile(new URL('../functions/floating-garden-trial/index.js', import.meta.url)));
    assert.equal((await readdir(join(output, 'public/lab/floating-garden/trial'))).some((name) => name.startsWith('emulator-')), false);
    assert.match(await readFile(join(output, 'browser-fixture/entry.js'), 'utf8'), /bootstrapTrial.*location: new URL/s);
    assert.match(await readFile(join(output, 'browser-fixture/index.html'), 'utf8'), /src="\.\/emulator-entry\.js"/);
    assert.equal(JSON.parse(await readFile(join(output, 'firebase.emulator.json'), 'utf8')).functions.source, 'emulator-functions');
    assert.ok(generated.boundaries.some((value) => value.includes('successful production app.js/default-window-location/HTTPS/CORS/App Check path is not validated')));
  } finally { await rm(parent, { recursive: true, force: true }); }
});

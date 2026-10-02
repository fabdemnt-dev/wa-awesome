// Pure regression tests: no emulator process, Chromium or network. The installed
// client SDK is used only to observe real callable URL construction.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeApp, deleteApp } from 'firebase/app';
import { getFunctions } from 'firebase/functions';
import { prepareTrialEmulator } from './helpers/prepare-floating-garden-trial-emulator.mjs';
import { trialEmulatorRoute, trialSdkFixture, isTrialRelayNavigationCancellation } from './helpers/floating-garden-trial-sdk-fixture.mjs';

const origin = 'https://wa-garden-ci-trial--garden-7day-ci0001.web.app';
const fixture = { kind: 'floating-garden-trial-browser-emulator-only-v1', projectId: 'demo-floating-garden-trial',
  ports: { auth: 9099, firestore: 8183, functions: 5103 }, runtime: { previewOrigin: origin },
  config: { projectId: 'wa-garden-ci-trial', region: 'asia-northeast1', previewOrigin: origin } };
const baseEnv = { FUNCTIONS_EMULATOR: 'true', GCLOUD_PROJECT: fixture.projectId,
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8183', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' };

test('trial browser relay permits only exact same-origin SDK routes to pinned demo emulators', () => {
  for (const [path, method, kind, port] of [
    ['/identitytoolkit.googleapis.com/v1/accounts:signUp?key=inert', 'POST', 'auth', 9099],
    ['/identitytoolkit.googleapis.com/v1/accounts:lookup?key=inert', 'POST', 'auth', 9099],
    ['/securetoken.googleapis.com/v1/token?key=inert', 'POST', 'auth', 9099],
    ['/google.firestore.v1.Firestore/Listen/channel?database=projects%2Fdemo-floating-garden-trial%2Fdatabases%2F(default)', 'POST', 'firestore', 8183],
    ['/google.firestore.v1.Firestore/Listen/channel?SID=inert&RID=rpc', 'GET', 'firestore', 8183],
    ['/google.firestore.v1.Firestore/Write/channel', 'POST', 'firestore', 8183],
  ]) assert.deepEqual(trialEmulatorRoute(origin + path, method, fixture), { kind, url: `http://127.0.0.1:${port}${path}` });
  for (const suffix of ['CreateRoom', 'JoinRoom', 'StartMatch', 'GetSnapshot', 'SubmitAction']) {
    assert.deepEqual(trialEmulatorRoute(`${origin}/floatingGarden${suffix}`, 'POST', fixture),
      { kind: 'functions', url: `http://127.0.0.1:5103/demo-floating-garden-trial/asia-northeast1/floatingGarden${suffix}` });
  }
  for (const [url, method] of [
    [origin + '/lab/floating-garden/trial/index.html', 'GET'],
    [origin + '/identitytoolkit.googleapis.com/v1/accounts:signUp', 'GET'],
    [origin + '/identitytoolkit.googleapis.com/v1/accounts:delete', 'POST'],
    [origin + '/demo-floating-garden-trial/asia-northeast1/arbitraryFunction', 'POST'],
    [origin + '/demo-floating-garden-trial/asia-northeast1/floatingGardenCreateRoom', 'POST'],
    [origin + '/floatingGardenCreateRoom?extra=true', 'POST'],
    [origin + '/floatingGardenCreateRoom', 'GET'],
    [origin + '/arbitraryFunction', 'POST'],
    [origin + '/wa-awesome/asia-northeast1/floatingGardenCreateRoom', 'POST'],
    [origin + '/google.firestore.v1.Firestore/Listen/channel?database=projects/wa-awesome/databases/(default)', 'GET'],
    [origin + '/google.firestore.v1.Firestore/Listen/channel', 'DELETE'],
    [origin + '/google.firestore.v1.Firestore/Listen/channel#fragment', 'GET'],
    ['http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp', 'POST'],
    ['https://untrusted.example/google.firestore.v1.Firestore/Listen/channel', 'GET'],
  ]) assert.equal(trialEmulatorRoute(url, method, fixture), null, `${method} ${url}`);
  for (const patch of [{ kind: undefined }, { projectId: 'wa-awesome' }, { ports: { ...fixture.ports, auth: 443 } }, { runtime: { previewOrigin: 'https://untrusted.example' } }]) {
    assert.throws(() => trialEmulatorRoute(origin, 'GET', { ...fixture, ...patch }));
    assert.throws(() => trialSdkFixture('firebase-app.js', { ...fixture, ...patch }));
  }
});

test('relay ignores only browser-confirmed aborted Firestore navigation requests', () => {
  assert.equal(isTrialRelayNavigationCancellation('firestore', { errorText: 'net::ERR_ABORTED' }), true);
  for (const kind of ['auth', 'functions', undefined]) assert.equal(isTrialRelayNavigationCancellation(kind, { errorText: 'net::ERR_ABORTED' }), false);
  for (const failure of [null, {}, { errorText: 'net::ERR_FAILED' }, { errorText: 'net::ERR_CONNECTION_REFUSED' }, { errorText: 'net::ERR_TIMED_OUT' }]) assert.equal(isTrialRelayNavigationCancellation('firestore', failure), false);
});

test('trial SDK facades use supported HTTPS same-origin configuration without browser security changes', () => {
  const auth = trialSdkFixture('firebase-auth.js', fixture);
  assert.ok(auth.includes(`connectAuthEmulator(auth, ${JSON.stringify(origin)}`));
  const firestore = trialSdkFixture('firebase-firestore.js', fixture);
  assert.match(firestore, /ssl: true/); assert.match(firestore, /experimentalForceLongPolling: true/);
  assert.match(firestore, /timeoutSeconds: 5/); assert.doesNotMatch(firestore, /mockUserToken/);
  assert.ok(trialSdkFixture('firebase-functions.js', fixture).includes(`real.getFunctions(app, ${JSON.stringify(origin)})`));
  assert.equal(trialSdkFixture('unknown.js', fixture), null);
});

test('actual installed Firebase SDK origin-only callable URLs map to exact demo/region endpoints', async () => {
  const app = initializeApp({ projectId: fixture.projectId, apiKey: 'demo-floating-garden-trial-key', appId: 'demo-inert-url-check' }, 'trial-fixture-url-regression');
  try {
    const functions = getFunctions(app, origin);
    for (const suffix of ['CreateRoom', 'JoinRoom', 'StartMatch', 'GetSnapshot', 'SubmitAction']) {
      // This is SDK URL construction only: do not invoke a callable or fetch.
      const actual = functions._url(`floatingGarden${suffix}`);
      assert.equal(actual, `${origin}/floatingGarden${suffix}`);
      assert.deepEqual(trialEmulatorRoute(actual, 'POST', fixture),
        { kind: 'functions', url: `http://127.0.0.1:5103/demo-floating-garden-trial/asia-northeast1/floatingGarden${suffix}` });
    }
  } finally { await deleteApp(app); }
});

test('fixture discovery accepts CLI-filtered emulator env and fails closed before any SDK initialization otherwise', async () => {
  const source = await readFile(new URL('./helpers/floating-garden-trial-functions-fixture.cjs', import.meta.url), 'utf8');
  function discover(env, data = fixture) {
    let initializations = 0;
    const module = { exports: {} };
    const mocks = {
      'node:assert/strict': assert,
      'firebase-admin/app': { getApps: () => [], initializeApp: () => { initializations += 1; return {}; } },
      'firebase-admin/firestore': { getFirestore: () => ({}), Timestamp: { fromMillis: (value) => value } },
      'firebase-functions/v2/https': { onCall: (options, handler) => ({ options, handler }), HttpsError: class extends Error {} },
      './trial-handlers': { createTrialHandlers: () => ({ floatingGardenCreateRoom: () => ({ ok: true }) }), TrialError: class extends Error {} },
      './online/handlers': { createHandlers: () => ({}) }, './emulator-fixture.json': data,
    };
    try { vm.runInNewContext(source, { require: (name) => mocks[name], module, process: { env } }); }
    catch (error) { assert.equal(initializations, 0, 'unsafe environment must fail before SDK initialization'); throw error; }
    return { exports: module.exports, initializations };
  }
  assert.equal(discover({ ...baseEnv }).initializations, 1, 'the filtered env intentionally has no custom parent-shell flag');
  for (const patch of [{ FUNCTIONS_EMULATOR: undefined }, { FUNCTIONS_EMULATOR: 'false' }, { GCLOUD_PROJECT: 'wa-awesome' },
    { FIRESTORE_EMULATOR_HOST: 'googleapis.com:443' }, { FIREBASE_AUTH_EMULATOR_HOST: undefined }]) assert.throws(() => discover({ ...baseEnv, ...patch }));
  assert.throws(() => discover(baseEnv, { ...fixture, kind: undefined }));
  assert.throws(() => discover(baseEnv, { ...fixture, projectId: 'wa-awesome' }));
  const env = { ...baseEnv }, runtime = discover(env);
  env.GCLOUD_PROJECT = 'wa-awesome';
  await assert.rejects(runtime.exports.floatingGardenCreateRoom.handler({}), /demo-floating-garden-trial/,
    'the environment is checked on every call, not just discovery');
});

test('pure generated browser fixture preserves public graph and production Functions entry', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'garden-trial-browser-fixtures-'));
  try {
    const { output } = await prepareTrialEmulator(join(parent, 'prepared'));
    const generated = JSON.parse(await readFile(join(output, 'emulator-fixture.json'), 'utf8'));
    assert.equal(generated.kind, fixture.kind); assert.equal(generated.projectId, fixture.projectId);
    for (const name of ['index.html', 'app.js', 'bootstrap.js', 'config.js', 'firebase.js']) {
      assert.deepEqual(await readFile(join(output, 'public/lab/floating-garden/trial', name)),
        await readFile(new URL(`../lab/floating-garden/trial/${name}`, import.meta.url)));
    }
    assert.deepEqual(await readFile(join(output, 'functions/index.js')), await readFile(new URL('../functions/floating-garden-trial/index.js', import.meta.url)));
    assert.equal(JSON.parse(await readFile(join(output, 'firebase.emulator.json'), 'utf8')).functions.source, 'emulator-functions');
    assert.ok(generated.boundaries.some((value) => value.includes('no Hosting/TLS/CORS/private-network validation')));
  } finally { await rm(parent, { recursive: true, force: true }); }
});

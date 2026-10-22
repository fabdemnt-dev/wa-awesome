import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { prepareTrialBundle, FUNCTION_NAMES } from '../scripts/prepare-floating-garden-trial.mjs';

// This suite is separate from npm test: CI installs the standalone trial package
// first. It executes the real pinned Firebase SDK, never an onCall replacement.
// In-memory HTTP objects below exercise middleware without opening an HTTP server,
// requesting credentials, running an emulator, or verifying real attestation.
const trialRequire = createRequire(new URL('../functions/floating-garden-trial/package.json', import.meta.url));
const START = Date.parse('2026-10-02T00:00:00Z');
const SECRET_NAME = 'FLOATING_GARDEN_INVITE_HMAC_KEY';
const configuration = () => ({ schemaVersion: 1, enabled: true, projectId: 'garden-trial-check', previewOrigin: 'https://garden-trial-check--garden-7day-a1b2c3.web.app', startsAtMillis: START, endsAtMillis: START + 7 * 86400000, region: 'asia-northeast1', maxTesters: 2, maxRooms: 20, firebase: { apiKey: 'AIza' + 'a'.repeat(35), authDomain: 'garden-trial-check.firebaseapp.com', projectId: 'garden-trial-check', appId: '1:123456789:web:abcdef0123456789' }, appCheck: { provider: 'recaptcha-enterprise', siteKey: '6L' + 'a'.repeat(38), verified: true } });
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const backendConfiguration = () => Object.fromEntries(['enabled', 'projectId', 'region', 'previewOrigin', 'startsAtMillis', 'endsAtMillis', 'maxRooms'].map((key) => [key, configuration()[key]]));
async function installedPackage(entry, name) {
  let dir = dirname(trialRequire.resolve(entry));
  while (dirname(dir) !== dir) {
    try { const data = await json(join(dir, 'package.json')); if (data.name === name) return { dir, data }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    dir = dirname(dir);
  }
  throw new Error(`Cannot locate installed package ${name}`);
}
async function fixture(t, { configText, config = configuration() } = {}) {
  const dependencies = (await json(new URL('../functions/floating-garden-trial/package.json', import.meta.url))).dependencies;
  const sdk = await installedPackage('firebase-functions/v2/https', 'firebase-functions');
  const admin = await installedPackage('firebase-admin/app', 'firebase-admin');
  assert.equal(sdk.data.version, dependencies['firebase-functions'], 'test the exact deployable SDK version');
  assert.equal(admin.data.version, dependencies['firebase-admin'], 'test the exact deployable Admin version');
  assert.equal(dirname(sdk.dir), dirname(admin.dir));
  assert.notEqual(process.env.FIREBASE_DEBUG_MODE, 'true', 'never enable Firebase token-verification or CORS overrides');
  const networkAttempts = [];
  const forbiddenNetwork = (...args) => { networkAttempts.push(args[0]); throw new Error('Trial entry tests must not use the network'); };
  t.mock.method(Socket.prototype, 'connect', forbiddenNetwork);
  t.mock.method(http, 'request', forbiddenNetwork);
  t.mock.method(https, 'request', forbiddenNetwork);
  t.mock.method(globalThis, 'fetch', forbiddenNetwork);
  const dir = await mkdtemp(join(tmpdir(), 'garden-trial-entry-'));
  const output = join(dir, 'bundle'), functions = join(output, 'functions');
  t.after(async () => {
    assert.equal(networkAttempts.length, 0, 'all entry checks must remain socket/network-free');
    for (const path of Object.keys(trialRequire.cache)) if (path.startsWith(dir + '/')) delete trialRequire.cache[path];
    await rm(dir, { recursive: true, force: true });
  });
  await prepareTrialBundle({ config, output, now: START });
  if (configText === null) await rm(join(functions, 'trial-config.json'));
  else if (configText !== undefined) await writeFile(join(functions, 'trial-config.json'), configText);
  // Dependencies are supplied only after verifying the generated bundle. Symlinks
  // are test fixtures, not files included by the preparation script or deploy plan.
  await symlink(dirname(sdk.dir), join(functions, 'node_modules'), 'dir');
  const getApps = trialRequire('firebase-admin/app').getApps;
  const beforeApps = getApps().map((app) => app.name);
  const exported = trialRequire(functions);
  t.after(() => assert.deepEqual(getApps().map((app) => app.name), beforeApps, 'denied requests must not initialize an Admin app'));
  return { exported, functions, require: createRequire(join(functions, 'package.json')) };
}
function runtimeEnvironment(t, values = {}) {
  const keys = ['GCLOUD_PROJECT', 'GCP_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'FIREBASE_CONFIG', 'FUNCTIONS_EMULATOR', 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST'];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) { if (Object.hasOwn(values, key)) process.env[key] = values[key]; else delete process.env[key]; }
  t.after(() => { for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; } });
}
function request() { return { data: {}, auth: { uid: 'host' }, app: { appId: configuration().firebase.appId }, rawRequest: { headers: { origin: configuration().previewOrigin } } }; }
class Response extends EventEmitter {
  statusCode = 200;
  headers = {};
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  getHeader(name) { return this.headers[name.toLowerCase()]; }
  status(code) { this.statusCode = code; return this; }
  send(body) { this.body = body; this.emit('finish'); return this; }
  end() { this.emit('finish'); return this; }
}
async function callHttp(endpoint, { method = 'POST', origin = configuration().previewOrigin, headers = {}, data = {} } = {}) {
  const req = { method, headers: { 'content-type': 'application/json', ...(origin === null ? {} : { origin }), ...headers }, body: { data }, header(name) { return this.headers[name.toLowerCase()]; } };
  const res = new Response();
  await endpoint(req, res);
  return res;
}
function rejectsReason(promise, code, reason) {
  const { HttpsError } = trialRequire('firebase-functions/v2/https');
  return assert.rejects(promise, (error) => error instanceof HttpsError && error.code === code && error.details?.reason === reason);
}

test('generated package main loads with real pinned SDK and exactly five constrained callable deployments', async (t) => {
  const f = await fixture(t);
  assert.equal((await json(join(f.functions, 'package.json'))).main, 'index.js');
  assert.equal(f.require.resolve(f.functions), join(f.functions, 'index.js'));
  assert.deepEqual(Object.keys(f.exported), FUNCTION_NAMES);
  for (const [name, callable] of Object.entries(f.exported)) {
    assert.equal(typeof callable, 'function');
    assert.equal(typeof callable.run, 'function');
    const endpoint = callable.__endpoint;
    assert.equal(endpoint.platform, 'gcfv2');
    assert.deepEqual(endpoint.callableTrigger, {});
    assert.equal(Object.hasOwn(endpoint, 'httpsTrigger'), false);
    assert.deepEqual(endpoint.region, ['asia-northeast1']);
    for (const [key, value] of Object.entries({ availableMemoryMb: 256, timeoutSeconds: 30, minInstances: 0, maxInstances: 1, cpu: 1, concurrency: 1 })) assert.equal(endpoint[key], value, `${name}: ${key}`);
    assert.equal(endpoint.serviceAccountEmail, `garden-trial-runtime@${configuration().projectId}.iam.gserviceaccount.com`);
    const secrets = FUNCTION_NAMES.slice(0, 2).includes(name) ? [{ key: SECRET_NAME }] : [];
    assert.deepEqual(endpoint.secretEnvironmentVariables || [], secrets, `${name}: only create/join can bind the invitation key`);
    assert.deepEqual(callable.__trigger.httpsTrigger, { allowInsecure: false });
    assert.equal(callable.__trigger.labels['deployment-callable'], 'true');
  }
  // Load every copied CommonJS dependency and the unchanged ESM core from the
  // generated directory, proving the lazy runtime paths have no repository fallback.
  for (const name of ['config.js', 'trial-handlers.js', 'online/handlers.js', 'online/contract.js', 'online/invite-code.js']) {
    assert.equal(f.require.resolve('./' + name), join(f.functions, name));
    assert.equal(typeof f.require('./' + name), 'object');
  }
  const core = await import(pathToFileURL(join(f.functions, 'online/core/match-engine.js')));
  assert.equal(core.createMatch({ playerCount: 2, seed: 'generated-package' }).players.length, 2);
});

test('real HTTP middleware requires App Check before custom guards, even with forged body and callable-context auth', async (t) => {
  const f = await fixture(t);
  runtimeEnvironment(t, { GCLOUD_PROJECT: 'wa-awesome' });
  for (const callable of Object.values(f.exported)) {
    const res = await callHttp(callable, { data: { auth: { uid: 'host' }, app: { appId: 'forged' } }, headers: { 'x-callable-context-auth': encodeURIComponent(JSON.stringify({ uid: 'host' })) } });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: { message: 'Unauthenticated', status: 'UNAUTHENTICATED' } }, 'SDK enforcement precedes the deliberately wrong project guard');
    assert.equal(res.getHeader('access-control-allow-origin'), configuration().previewOrigin);
  }
});

test('real CORS middleware allows only the exact preview origin and POST, without reflecting a hostile origin', async (t) => {
  const f = await fixture(t);
  for (const callable of Object.values(f.exported)) {
    for (const origin of [configuration().previewOrigin, 'https://wa-awesome.web.app', configuration().previewOrigin + '.evil.example', 'http://localhost:5000', null]) {
      const res = await callHttp(callable, { method: 'OPTIONS', origin, headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-firebase-appcheck' } });
      assert.equal(res.statusCode, 204);
      // SDK 6.6.0 collapses a one-item allowlist to a fixed CORS response. The
      // hostile browser origin never matches it; CORS alone is not authentication.
      assert.equal(res.getHeader('access-control-allow-origin'), configuration().previewOrigin);
      assert.equal(res.getHeader('access-control-allow-methods'), 'POST');
      assert.equal(res.getHeader('access-control-allow-credentials'), undefined);
      assert.equal(res.body, undefined);
    }
  }
});

for (const [label, configText] of [
  ['missing', null], ['malformed JSON', '{broken'], ['invalid project', JSON.stringify({ ...backendConfiguration(), projectId: 'wa-awesome' })],
  ['unexpected keys', JSON.stringify({ ...backendConfiguration(), permissive: true })],
]) test(`generated entry fails closed with ${label} configuration and no CORS or Admin initialization`, async (t) => {
  const f = await fixture(t, { configText });
  runtimeEnvironment(t, { GCLOUD_PROJECT: configuration().projectId });
  t.mock.method(Date, 'now', () => START + 1000);
  assert.deepEqual(Object.keys(f.exported), FUNCTION_NAMES);
  for (const callable of Object.values(f.exported)) {
    await rejectsReason(callable.run(request()), 'failed-precondition', 'trial-config-missing');
    const res = await callHttp(callable);
    assert.equal(res.statusCode, 401);
    assert.equal(res.getHeader('access-control-allow-origin'), undefined);
  }
});

test('actual generated handler rejects wrong runtime, window and request gates before loading trusted handlers', async (t) => {
  const f = await fixture(t);
  const now = t.mock.method(Date, 'now', () => START + 1000);
  runtimeEnvironment(t);
  for (const env of [{}, { GCLOUD_PROJECT: 'wa-awesome' }, { GCLOUD_PROJECT: 'wa-awesome-mofumofu-stg' }, { GCLOUD_PROJECT: configuration().projectId, GCP_PROJECT: 'wrong-project' }, { GCLOUD_PROJECT: configuration().projectId, FIREBASE_CONFIG: 'invalid' }]) {
    for (const key of ['GCLOUD_PROJECT', 'GCP_PROJECT', 'FIREBASE_CONFIG']) { if (Object.hasOwn(env, key)) process.env[key] = env[key]; else delete process.env[key]; }
    for (const callable of Object.values(f.exported)) await rejectsReason(callable.run(request()), 'failed-precondition', 'trial-project-mismatch');
  }
  process.env.GCLOUD_PROJECT = configuration().projectId;
  delete process.env.GCP_PROJECT; delete process.env.FIREBASE_CONFIG;
  for (const time of [START - 1, configuration().endsAtMillis]) {
    now.mock.mockImplementation(() => time);
    for (const callable of Object.values(f.exported)) await rejectsReason(callable.run(request()), 'failed-precondition', 'trial-outside-window');
  }
  now.mock.mockImplementation(() => START + 1000);
  for (const callable of Object.values(f.exported)) {
    await rejectsReason(callable.run({ ...request(), auth: null }), 'unauthenticated', 'trial-auth-required');
    await rejectsReason(callable.run({ ...request(), app: undefined }), 'unauthenticated', 'trial-app-check-required');
    await rejectsReason(callable.run({ ...request(), rawRequest: { headers: { origin: 'https://wa-awesome.web.app' } } }), 'permission-denied', 'trial-origin-mismatch');
  }
  assert.equal(f.require.cache[join(f.functions, 'online/handlers.js')], undefined, 'all guards precede trusted-handler loading');
});

test('a valid explicitly disabled deployment configuration still rejects every generated callable', async (t) => {
  const backend = backendConfiguration();
  const f = await fixture(t, { configText: JSON.stringify({ ...backend, enabled: false }) });
  runtimeEnvironment(t, { GCLOUD_PROJECT: configuration().projectId });
  t.mock.method(Date, 'now', () => START + 1000);
  for (const callable of Object.values(f.exported)) await rejectsReason(callable.run(request()), 'failed-precondition', 'trial-disabled');
  assert.equal(f.require.cache[join(f.functions, 'online/handlers.js')], undefined);
});


test('fixed dedicated origin uses exact real SDK CORS and retains early-denial gates without Admin or network', async (t) => {
  const config = configuration(); config.projectId = config.firebase.projectId = 'wa-awesome-garden-stg';
  config.firebase.authDomain = 'wa-awesome-garden-stg.firebaseapp.com'; config.previewOrigin = 'https://wa-awesome-garden-stg.web.app';
  runtimeEnvironment(t, { GCLOUD_PROJECT: config.projectId });
  const f = await fixture(t, { config });
  t.mock.method(Date, 'now', () => START + 1000);
  for (const callable of Object.values(f.exported)) {
    for (const origin of [config.previewOrigin, 'https://wa-awesome.web.app', config.previewOrigin + '.evil.example', 'https://wa-awesome-garden-stg--garden-7day-abcdef.web.app', null]) {
      const res = await callHttp(callable, { method: 'OPTIONS', origin, headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-firebase-appcheck' } });
      assert.equal(res.getHeader('access-control-allow-origin'), config.previewOrigin);
    }
    const denied = { ...request(), rawRequest: { headers: { origin: config.previewOrigin } } };
    await rejectsReason(callable.run({ ...denied, auth: null }), 'unauthenticated', 'trial-auth-required');
    await rejectsReason(callable.run({ ...denied, app: undefined }), 'unauthenticated', 'trial-app-check-required');
    await rejectsReason(callable.run({ ...denied, rawRequest: { headers: { origin: configuration().previewOrigin } } }), 'permission-denied', 'trial-origin-mismatch');
  }
});

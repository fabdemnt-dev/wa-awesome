// Offline contract regression, not browser CSP conformance or live attestation.
// SourceTextModule requires a dedicated --experimental-vm-modules subprocess;
// package scripts include it in the trial and aggregate suites without widening
// NODE_OPTIONS for unrelated publisher environment-validation tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { CONNECTION_CSP, runtimeConfig } from '../scripts/deploy-floating-garden-connection-template.mjs';
import { IDENTITY_ATTEMPT_KEY } from '../lab/floating-garden/connection-check/connection.js';
import {
  SDK_BASE, APP_CHECK_ORIGIN, AUTH_ORIGIN, NOW, UID, TOKENS,
  RECAPTCHA_PROOF, RECAPTCHA_SCRIPT, loadOfficialSdk, syntheticResponse, legacyCsp,
} from './fixtures/firebase-10.8.0/fixture.mjs';

const connectionSource = await readFile(new URL('../lab/floating-garden/connection-check/connection.js', import.meta.url), 'utf8');
const sdkSources = await loadOfficialSdk();

async function runClient(csp, persistedStorage = [], fault = null) {
  assert.equal(typeof vm.SourceTextModule, 'function', 'run npm run test:floating-garden:connection:sdk');
  const connectSources = csp.split(';').map((directive) => directive.trim()).find((directive) => directive.startsWith('connect-src ')).split(/\s+/).slice(1);
  const allowedOrigins = connectSources.map((source) => new URL(source).origin);
  const requests = [], denials = [], states = [], sdkLoads = [], unexpected = [];
  const timers = new Set();
  function schedule(fn, delay, repeat = false) {
    const timer = (repeat ? setInterval : setTimeout)(fn, delay);
    timer.unref(); timers.add(timer); return timer;
  }
  function clear(timer) { clearTimeout(timer); clearInterval(timer); timers.delete(timer); }
  const context = vm.createContext({
    URL, Headers, Request, Response, atob, btoa,
    setTimeout: (fn, delay) => schedule(fn, delay), clearTimeout: clear,
    setInterval: (fn, delay) => schedule(fn, delay, true), clearInterval: clear,
    console: { log() {}, info() {}, debug() {}, warn() {}, error() {} },
    __state: (state) => states.push(JSON.parse(JSON.stringify(state))),
    // Never forward to host fetch. This is the only VM transport capability.
    fetch: async (address, options = {}) => {
      const url = new URL(address);
      const endpoint = url.origin + url.pathname;
      requests.push({ endpoint, method: options.method, body: options.body ? JSON.parse(options.body) : null });
      if (!allowedOrigins.includes(url.origin)) {
        denials.push({ directive: 'connect-src', origin: url.origin });
        throw new TypeError('Failed to fetch');
      }
      const body = syntheticResponse(address);
      if (!body || options.method !== 'POST') {
        unexpected.push(endpoint);
        throw new Error('Unexpected synthetic endpoint');
      }
      const rejection = fault === 'app-check-403' && url.origin === APP_CHECK_ORIGIN ? { status: 403, error: 'PERMISSION_DENIED' } :
        fault === 'signup-disabled' && url.pathname === '/v1/accounts:signUp' ? { status: 400, error: 'OPERATION_NOT_ALLOWED' } :
        fault === 'lookup-invalid' && url.pathname === '/v1/accounts:lookup' ? { status: 400, error: 'INVALID_ID_TOKEN' } : null;
      const response = rejection ? { error: { message: rejection.error, code: rejection.status, details: 'synthetic-private-error-detail-not-for-display' } } : body;
      return new Response(JSON.stringify(response), { status: rejection?.status ?? 200, headers: { 'content-type': 'application/json' } });
    },
  });
  vm.runInContext(`
    globalThis.window = globalThis; globalThis.self = globalThis; globalThis.top = globalThis;
    Date.now = () => ${NOW};
    globalThis.location = new URL('https://wa-awesome-garden-stg.web.app/connection-check/');
    globalThis.addEventListener = () => {}; globalThis.removeEventListener = () => {};
    globalThis.navigator = { onLine: true, userAgent: 'Mozilla/5.0 Chrome/140.0.0.0', locks: { request: async (name, options, callback) => callback({ name }) } };
    const store = new Map(${JSON.stringify(persistedStorage)});
    globalThis.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: (key) => store.delete(key) };
    globalThis.__storage = () => [...store.entries()];
    globalThis.document = { cookie: '', readyState: 'complete', createElement: (tag) => ({ tagName: tag, style: {} }), head: { appendChild: () => { throw new Error('Unexpected script load'); } }, body: { appendChild() {} }, addEventListener() {}, removeEventListener() {} };
    ${RECAPTCHA_SCRIPT}
  `, context);
  const sdkModules = new Map([...sdkSources].map(([identifier, source]) => [identifier, new vm.SourceTextModule(source, { context, identifier })]));
  const linker = (specifier) => {
    assert.ok(sdkModules.has(specifier), 'only exact pinned official SDK module URLs may be loaded');
    return sdkModules.get(specifier);
  };
  const connection = new vm.SourceTextModule(connectionSource, {
    context, identifier: 'connection.js',
    importModuleDynamically: async (specifier) => {
      sdkLoads.push(specifier);
      const module = linker(specifier);
      await module.evaluate();
      return module;
    },
  });
  const entry = new vm.SourceTextModule(`
    import { createConnectionCheck, IDENTITY_ATTEMPT_KEY } from 'connection.js';
    const client = createConnectionCheck(${JSON.stringify(runtimeConfig())}, { onState: __state });
    const beforeStart = { state: client.getState(), guard: localStorage.getItem(IDENTITY_ATTEMPT_KEY) };
    const first = client.start();
    const second = client.start();
    const result = await first;
    const repeated = await client.start();
    export const report = { beforeStart, result, repeated, sameFlight: first === second, guard: localStorage.getItem(IDENTITY_ATTEMPT_KEY), storage: __storage() };
    client.stop();
  `, { context, identifier: 'entry.js' });
  try {
    // Link app first because both of the other CDN modules import that singleton.
    await sdkModules.get(SDK_BASE + 'firebase-app.js').link(linker);
    for (const module of sdkModules.values()) if (module.status === 'unlinked') await module.link(linker);
    await entry.link((specifier) => {
      assert.equal(specifier, 'connection.js'); return connection;
    });
    await entry.evaluate({ timeout: 10000 });
    const report = JSON.parse(JSON.stringify(entry.namespace.report));
    assert.deepEqual(unexpected, [], 'all transport must match explicit synthetic endpoints');
    assert.deepEqual([...sdkLoads].sort(), [...sdkSources.keys()].sort(), 'exercise unchanged dynamic SDK loader exactly once');
    for (const token of [...TOKENS, 'synthetic-private-error-detail-not-for-display']) assert.equal(JSON.stringify(states).includes(token), false, 'observer never receives token or raw error material');
    assert.equal(report.beforeStart.state.status, 'idle');
    assert.equal(report.sameFlight, true, 'duplicate starts share the one-shot operation');
    assert.deepEqual(report.repeated, report.result);
    return { ...report, requests, denials, states: states.map((state) => state.status), observableStates: states };
  } finally { for (const timer of timers) clear(timer); }
}

test('old CSP rejects the exact official SDK endpoint before Auth or identity-attempt storage', { timeout: 15000 }, async () => {
  const result = await runClient(legacyCsp(CONNECTION_CSP));
  assert.equal(result.result.status, 'failed');
  assert.equal(result.result.uid, null);
  assert.equal(result.guard, null);
  assert.deepEqual(result.storage, []);
  assert.deepEqual(result.states, ['checking', 'failed']);
  assert.deepEqual(result.denials, [{ directive: 'connect-src', origin: APP_CHECK_ORIGIN }]);
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].endpoint, `${APP_CHECK_ORIGIN}/v1/projects/wa-awesome-garden-stg/apps/1:120030709276:web:015f4e996b7c42a4e801d9:exchangeRecaptchaEnterpriseToken`);
  assert.equal(result.requests[0].body.recaptcha_enterprise_token, RECAPTCHA_PROOF);
  assert.equal(result.requests.some((request) => request.endpoint.startsWith(AUTH_ORIGIN)), false);
});

test('actual corrected publisher CSP reaches Auth once and reuses official SDK persistence after reload', { timeout: 15000 }, async () => {
  const first = await runClient(CONNECTION_CSP);
  assert.equal(first.result.status, 'connected');
  assert.equal(first.result.uid, UID);
  assert.equal(first.guard, 'attempted');
  assert.deepEqual(first.denials, []);
  assert.deepEqual(first.states, ['checking', 'authenticating', 'connected', 'stopped']);
  assert.equal(first.requests.filter((request) => request.endpoint.endsWith('/accounts:signUp')).length, 1);
  assert.equal(first.requests.find((request) => request.endpoint.endsWith('/accounts:signUp')).body.returnSecureToken, true);
  assert.equal(first.requests.filter((request) => request.endpoint.endsWith('/accounts:lookup')).length, 1);
  const reloaded = await runClient(CONNECTION_CSP, first.storage);
  assert.equal(reloaded.result.status, 'connected');
  assert.equal(reloaded.result.uid, UID);
  assert.equal(reloaded.guard, 'attempted');
  assert.deepEqual(reloaded.denials, []);
  assert.equal(reloaded.requests.filter((request) => request.endpoint.endsWith('/accounts:signUp')).length, 0);
  assert.equal(reloaded.requests.filter((request) => request.endpoint.endsWith('/accounts:lookup')).length, 1);
  assert.equal(new Map(reloaded.storage).get(IDENTITY_ATTEMPT_KEY), 'attempted');
});

test('official SDK cannot replace an identity after its persisted Auth record is lost', { timeout: 15000 }, async () => {
  const result = await runClient(CONNECTION_CSP, [[IDENTITY_ATTEMPT_KEY, 'attempted']]);
  assert.equal(result.result.status, 'failed');
  assert.equal(result.result.uid, null);
  assert.equal(result.guard, 'attempted');
  assert.deepEqual(result.denials, []);
  assert.deepEqual(result.states, ['checking', 'authenticating', 'failed']);
  assert.equal(result.requests.some((request) => request.endpoint.startsWith(AUTH_ORIGIN)), false);
});

test('exact SDK regression stays in both aggregate and trial scripts, with a dedicated VM subprocess', async () => {
  const { scripts } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(scripts['test:floating-garden:connection:sdk'], 'node --experimental-vm-modules --test tests/floating-garden-connection-sdk.test.mjs');
  for (const name of ['test', 'test:floating-garden:trial']) assert.ok(scripts[name].endsWith(' && npm run test:floating-garden:connection:sdk'));
});

// The official SDK can wrap multiple server causes in the same public code.
// These cases assert only the observed stage/code, never a claimed root cause.
for (const scenario of [
  { fault: 'app-check-403', stage: 'app-check-request', code: 'appCheck/throttled', signup: 0, lookup: 0, guard: null },
  { fault: 'signup-disabled', stage: 'anonymous-signup', code: 'auth/operation-not-allowed', signup: 1, lookup: 0, guard: 'attempted' },
  { fault: 'lookup-invalid', stage: 'anonymous-signup', code: 'auth/invalid-user-token', signup: 1, lookup: 1, guard: 'attempted' },
]) {
  test(`official SDK diagnostic preserves safe stage/code for ${scenario.fault} without retry`, { timeout: 15000 }, async () => {
    const result = await runClient(CONNECTION_CSP, [], scenario.fault);
    assert.equal(result.result.status, 'failed');
    assert.equal(result.result.uid, null);
    assert.equal(result.result.diagnosticStage, scenario.stage);
    assert.equal(result.result.diagnosticCode, scenario.code);
    assert.equal(result.guard, scenario.guard);
    assert.equal(result.requests.filter((request) => request.endpoint.endsWith('/accounts:signUp')).length, scenario.signup);
    assert.equal(result.requests.filter((request) => request.endpoint.endsWith('/accounts:lookup')).length, scenario.lookup);
    assert.deepEqual(result.denials, []);
    assert.deepEqual(result.observableStates.at(-1), result.result, 'stop after failure cannot replace its diagnostic');
  });
}

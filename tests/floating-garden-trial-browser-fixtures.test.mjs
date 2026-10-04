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
import { FIRESTORE_DIAGNOSTIC_SOURCE, DISCARD_ANCHOR, ARRIVAL_ANCHOR, createTrialSdkWatchDiagnostics, instrumentTrialFirestoreSdk,
  isTrialDiagnosticFirestoreRequest, loadTrialDiagnosticFirestoreSdk, collectTrialSdkWatchDiagnostics } from './helpers/floating-garden-trial-sdk-discard-fixture.mjs';

const origin = 'https://wa-garden-ci-trial--garden-7day-ci0001.web.app';
const fixture = { kind: 'floating-garden-trial-browser-emulator-only-v1', browserOrigin: 'http://127.0.0.1:8783', projectId: 'demo-floating-garden-trial',
  ports: { auth: 9099, firestore: 8183, functions: 5103 }, runtime: { previewOrigin: origin },
  config: { projectId: 'wa-garden-ci-trial', region: 'asia-northeast1', previewOrigin: origin } };
const baseEnv = { FUNCTIONS_EMULATOR: 'true', GCLOUD_PROJECT: fixture.projectId,
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8183', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' };

const officialFirestore = () => readFile(new URL('./fixtures/firebase-10.8.0/firebase-firestore.js', import.meta.url));
const discardedExpression = `(__PRIVATE_trialRecordDiscard1080(o,u),${DISCARD_ANCHOR})`;
const arrivalExpression = `(__PRIVATE_trialRecordArrival1080(e,s),${ARRIVAL_ANCHOR})`;

test('Firestore diagnostic source fails closed and changes exactly two expressions in memory', async () => {
  const bytes = await officialFirestore(), original = bytes.toString('utf8');
  const instrumented = await loadTrialDiagnosticFirestoreSdk();
  assert.equal(bytes.length, FIRESTORE_DIAGNOSTIC_SOURCE.bytes);
  for (const anchor of [DISCARD_ANCHOR, ARRIVAL_ANCHOR]) assert.equal(original.split(anchor).length - 1, 1);
  const originalStart = instrumented.indexOf(original.slice(0, 100));
  assert.ok(originalStart > 0);
  assert.equal(instrumented.slice(originalStart).replace(discardedExpression, DISCARD_ANCHOR).replace(arrivalExpression, ARRIVAL_ANCHOR), original,
    'every original SDK byte and log/callback expression survives unchanged');
  assert.doesNotMatch(instrumented.slice(0, originalStart), /setLogLevel|console\./);
  assert.deepEqual(await officialFirestore(), bytes, 'instrumentation never rewrites the vendor fixture');
  assert.throws(() => instrumentTrialFirestoreSdk(original), /exact original bytes/);
  assert.throws(() => instrumentTrialFirestoreSdk(bytes.subarray(1)), /byte length/);
  const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
  assert.throws(() => instrumentTrialFirestoreSdk(changed), /SHA-256/);
  assert.throws(() => instrumentTrialFirestoreSdk(Buffer.from(instrumented)), /byte length/);
});

test('only the exact original Firestore GET receives SDK instrumentation', () => {
  const address = `${FIRESTORE_DIAGNOSTIC_SOURCE.url}?trial-emulator-original=1`;
  assert.equal(isTrialDiagnosticFirestoreRequest(address, 'GET'), true);
  for (const candidate of [FIRESTORE_DIAGNOSTIC_SOURCE.url, address + '&extra=1', address + '#fragment', address.replace('=1', '=01'),
    address.replace('https:', 'http:'), address.replace('10.8.0', '10.8.1'), address.replace('firestore', 'auth'), address.replace('www.gstatic.com', '127.0.0.1:8183')]) {
    assert.equal(isTrialDiagnosticFirestoreRequest(candidate, 'GET'), false);
  }
  for (const method of ['POST', 'HEAD', undefined]) assert.equal(isTrialDiagnosticFirestoreRequest(address, method), false);
});

function diagnosticDocument({ seconds = 123, nanoseconds = 7, revision = 5, matchRevision = 4, found = true } = {}) {
  return { key: 'never-record-document-path', payload: 'never-record-payload',
    data: { value: { mapValue: { fields: { revision: { integerValue: revision },
      match: { mapValue: { fields: { revision: { integerValue: matchRevision }, payload: { stringValue: 'never-record-payload' } } } } } } } },
    version: { toTimestamp: () => ({ seconds, nanoseconds }) }, isFoundDocument: () => found };
}

test('discard diagnostics distinguish duplicate versions from older timestamps with newer revisions', () => {
  const diagnostics = createTrialSdkWatchDiagnostics(() => 10);
  const current = diagnosticDocument(), incoming = diagnosticDocument({ nanoseconds: 6, revision: '6', matchRevision: '5' });
  diagnostics.discard(diagnosticDocument(), current);
  diagnostics.discard(incoming, current);
  diagnostics.discard(diagnosticDocument({ nanoseconds: 6 }), current);
  diagnostics.discard(diagnosticDocument({ nanoseconds: 8 }), current);
  diagnostics.discard(diagnosticDocument({ seconds: Infinity, revision: 'private-text', matchRevision: -1, found: 'private-text' }), current);
  diagnostics.discard(diagnosticDocument({ revision: 6 }), current);
  diagnostics.discard(diagnosticDocument({ matchRevision: 5 }), current);
  const result = diagnostics.snapshot();
  assert.deepEqual(result.counts, { discardEqual: 1, discardEqualWithNewerRevision: 2, discardOlderWithNewerRevision: 1, discardOlder: 1, discardNewer: 1, discardUnknown: 1,
    listenDocumentChange: 0, listenTargetChange: 0, listenOther: 0 });
  assert.deepEqual(result.events.map(({ comparison }) => comparison), [0, -1, -1, 1, null, 0, 0]);
  assert.equal(result.events[5].category, 'discardEqualWithNewerRevision');
  assert.equal(result.events[6].category, 'discardEqualWithNewerRevision');
  assert.deepEqual(result.events[1], { code: 'trial-firestore-watch-v1', sequence: 2, time: 10, category: 'discardOlderWithNewerRevision',
    incoming: { revision: 6, matchRevision: 5 }, current: { revision: 5, matchRevision: 4 },
    incomingVersion: { seconds: 123, nanoseconds: 6 }, currentVersion: { seconds: 123, nanoseconds: 7 }, comparison: -1, incomingFound: true, currentFound: true });
  assert.deepEqual(result.events[4].incoming, { revision: null, matchRevision: null });
  assert.equal(result.events[4].incomingFound, null);
  incoming.data.value.mapValue.fields.revision.integerValue = 999;
  result.events[1].incoming.revision = 1000; result.events[1].incomingVersion.seconds = 0; result.counts.discardEqual = 0;
  assert.equal(diagnostics.snapshot().events[1].incoming.revision, 6, 'neither the input nor returned snapshots can mutate retained metadata');
  assert.equal(diagnostics.snapshot().events[1].incomingVersion.seconds, 123);
  assert.equal(diagnostics.snapshot().counts.discardEqual, 1);
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /never-record|private-text/);
});

test('Listen arrival diagnostics preserve nanosecond precision and omit identifiers and raw wire data', () => {
  const diagnostics = createTrialSdkWatchDiagnostics(() => 0), secret = 'never-record-stream-document-token';
  const document = { fields: diagnosticDocument().data.value.mapValue.fields, updateTime: '2026-10-04T00:00:00.123456789Z', name: secret };
  const message = { documentChange: { document, targetIds: [123], removedTargetIds: [456] }, token: secret };
  diagnostics.arrival('Write', message);
  assert.equal(diagnostics.snapshot().events.length, 0);
  diagnostics.arrival('Listen', message);
  diagnostics.arrival('Listen', { targetChange: { targetChangeType: 'CURRENT', targetIds: [123, 456], readTime: '2026-10-04T00:00:00.1Z', resumeToken: secret } });
  diagnostics.arrival('Listen', { targetChange: { readTime: '2026-10-04T00:00:00Z' } });
  diagnostics.arrival('Listen', { targetChange: { targetChangeType: secret, targetIds: secret, readTime: '2026-02-30T00:00:00.123Z' } });
  diagnostics.arrival('Listen', { documentDelete: { document: secret } });
  const result = diagnostics.snapshot();
  assert.deepEqual(result.events[0].incomingVersion, { seconds: 1791072000, nanoseconds: 123456789 });
  assert.deepEqual(result.events[1], { code: 'trial-firestore-watch-v1', sequence: 2, time: 0, category: 'listenTargetChange', targetType: 'CURRENT',
    readTime: { seconds: 1791072000, nanoseconds: 100000000 }, targetCount: 2, global: false });
  assert.equal(result.events[2].global, true); assert.equal(result.events[2].targetType, 'NO_CHANGE');
  assert.equal(result.events[3].targetType, 'UNKNOWN'); assert.equal(result.events[3].targetCount, null); assert.equal(result.events[3].readTime, null);
  assert.deepEqual(result.events[4], { code: 'trial-firestore-watch-v1', sequence: 5, time: 0, category: 'listenOther' });
  assert.doesNotMatch(JSON.stringify(result), /never-record|targetIds|removedTargetIds|resumeToken|2026-/);
  for (const updateTime of ['2026-10-04T00:00:00.1234567890Z', '2026-10-04T00:00:00+00:00', secret, { seconds: secret }, null]) {
    diagnostics.arrival('Listen', { documentChange: { document: { fields: {}, updateTime } } });
    assert.equal(diagnostics.snapshot().events.at(-1).incomingVersion, null);
  }
});

test('SDK diagnostics remain nonthrowing, bounded and monotonic with hostile inputs', () => {
  const moments = [9.9, 3, Infinity, 11.2], diagnostics = createTrialSdkWatchDiagnostics(() => moments.shift());
  const hostile = new Proxy({}, { get() { throw new Error('never-record-getter-secret'); } });
  for (let index = 0; index < 300; index += 1) assert.doesNotThrow(() => diagnostics.discard(hostile, hostile));
  const result = diagnostics.snapshot();
  assert.equal(result.events.length, 256); assert.equal(result.overflow, 44); assert.equal(result.counts.discardUnknown, 300);
  assert.equal(result.events[0].sequence, 45); assert.equal(result.events.at(-1).sequence, 300);
  assert.ok(result.events.every(({ time }) => time === 11));
  const samples = [9.9, 3, Infinity, 11.2], clocked = createTrialSdkWatchDiagnostics(() => samples.shift());
  for (let index = 0; index < 4; index += 1) clocked.arrival('Listen', {});
  assert.deepEqual(clocked.snapshot().events.map(({ time }) => time), [9, 9, 9, 11]);
  const throwingClock = createTrialSdkWatchDiagnostics(() => { throw new Error('never-record-clock-secret'); });
  assert.doesNotThrow(() => throwingClock.arrival('Listen', hostile));
  assert.doesNotThrow(() => throwingClock.discard(hostile, hostile));
  assert.equal(throwingClock.snapshot().events.length, 2);
  assert.doesNotMatch(JSON.stringify([result, throwingClock.snapshot()]), /never-record/);
});

test('instrumented official LocalStore branch preserves decisions, comparison counts and original log exceptions', async () => {
  const original = (await officialFirestore()).toString('utf8'), instrumented = await loadTrialDiagnosticFirestoreSdk();
  function run(source, { incomingNanos = 6, pending = false, valid = true, unreadable = false, logError } = {}) {
    const effects = { comparisons: 0, additions: 0, insertions: 0, logs: 0 }, diagnostics = createTrialSdkWatchDiagnostics(() => 1);
    const incoming = diagnosticDocument({ nanoseconds: incomingNanos }), current = diagnosticDocument();
    incoming.isNoDocument = () => false; current.isValidDocument = () => valid; current.hasPendingWrites = pending;
    incoming.version.compareTo = () => { effects.comparisons += 1; return Math.sign(incomingNanos - 7); };
    if (unreadable) Object.defineProperty(incoming, 'data', { get() { throw new Error('never-record-data-secret'); } });
    const context = { __PRIVATE_documentKeySet: () => ({ add() { return this; } }),
      __PRIVATE_mutableDocumentMap: () => ({ insert() { effects.insertions += 1; return this; } }),
      __PRIVATE_trialRecordDiscard1080: diagnostics.discard,
      __PRIVATE_logDebug() { effects.logs += 1; if (logError) throw logError; } };
    const start = source.indexOf('function __PRIVATE_populateDocumentChangeBuffer(');
    vm.runInNewContext(source.slice(start, source.indexOf('function __PRIVATE_localStoreGetNextMutationBatch(', start)), context);
    const cache = { getEntries: () => ({ next: (callback) => callback({ get: () => current }) }), addEntry() { effects.additions += 1; } };
    context.__PRIVATE_populateDocumentChangeBuffer({}, cache, { forEach: (callback) => callback('private-key', incoming) });
    return { effects, diagnostics: diagnostics.snapshot() };
  }
  for (const options of [{}, { incomingNanos: 7 }, { incomingNanos: 8 }, { pending: true, incomingNanos: 7 }, { valid: false }, { unreadable: true }]) {
    const before = run(original, options), after = run(instrumented, options);
    assert.deepEqual(after.effects, before.effects, 'the actual SDK condition, comparison call count, accepted writes and logs are unchanged');
    assert.equal(after.diagnostics.events.length, before.effects.logs);
  }
  const originalError = new Error('original SDK log failure');
  for (const source of [original, instrumented]) assert.throws(() => run(source, { logError: originalError }), (error) => error === originalError);
});

test('instrumented stream expression preserves log arguments, callback receiver, result and exception identity', async () => {
  const instrumented = await loadTrialDiagnosticFirestoreSdk();
  assert.ok(instrumented.includes(arrivalExpression));
  for (const expression of [ARRIVAL_ANCHOR, arrivalExpression]) {
    const message = { documentChange: { document: { fields: {}, updateTime: '2026-10-04T00:00:00Z' } } }, calls = [], diagnostics = createTrialSdkWatchDiagnostics(() => { throw Error('clock'); });
    const receiver = { mo(value) { calls.push({ receiver: this, value }); return 'callback-result'; } };
    const context = { Ft: 'WebChannelConnection', e: 'Listen', i: 'private-stream', s: message, g: receiver,
      __PRIVATE_logDebug: (...args) => calls.push(args), __PRIVATE_trialRecordArrival1080: diagnostics.arrival };
    assert.equal(vm.runInNewContext(expression, context), 'callback-result');
    assert.deepEqual(calls, [['WebChannelConnection', "RPC 'Listen' stream private-stream received:", message], { receiver, value: message }]);
    const originalError = new Error('original callback failure'); receiver.mo = () => { throw originalError; };
    assert.throws(() => vm.runInNewContext(expression, context), (error) => error === originalError);
    assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /private-stream|clock/);
  }
});

test('SDK diagnostic artifact collection tolerates closed pages and unavailable recorders', async () => {
  const diagnostics = createTrialSdkWatchDiagnostics(() => 0); diagnostics.arrival('Listen', {});
  assert.deepEqual(await collectTrialSdkWatchDiagnostics({ evaluate: () => diagnostics.snapshot() }), diagnostics.snapshot());
  assert.equal(await collectTrialSdkWatchDiagnostics({ evaluate: () => { throw new Error('never-record-evaluation-secret'); } }), null);
  const previous = globalThis.__trialSdkWatchDiagnostics;
  try { delete globalThis.__trialSdkWatchDiagnostics; assert.equal(await collectTrialSdkWatchDiagnostics({ evaluate: (callback) => callback() }), null); }
  finally { if (previous !== undefined) globalThis.__trialSdkWatchDiagnostics = previous; }
});

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

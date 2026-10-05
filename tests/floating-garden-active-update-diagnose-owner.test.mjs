// Standalone owner-entry packaging. All public downloads/provider reads below
// are injected; the real immutable source modules, generators, packet reader
// and owner packet selector execute. No ADC/SDK/network or Cloud write runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, lstat, symlink, chmod, link, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { executeOwnerActiveUpdate, main as executionMain, INSPECTION_ENTRY_COMMIT, INSPECTION_ENTRY_SHA256, EXECUTION_GUARD_NAME, EXECUTION_PREPARATION_NAME } from '../scripts/floating-garden-active-update-execute-owner.mjs';
import { OWNER_SOURCE_COMMIT, OWNER_SOURCE_TREE, OWNER_SOURCE_FILES, OWNER_PREPARATION_NAME,
  inspectOwnerActiveUpdate, main as inspectMain } from '../scripts/floating-garden-active-update-owner.mjs';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OLD = 'ce20dce88490ee42cc8e427ab90b0b2c8a576c95';
const START = 1791157551472, END = 1791762351472, NOW = START + 10000;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const review = { schemaVersion: 1, startsAtMillis: START, endsAtMillis: END,
  testerUids: ['SYNTHETIC_OWNER_ALPHA', 'SYNTHETIC_OWNER_BETA'], retainBuildArtifacts: true,
  allowInitialFunctionRecreate: true, approvePublicInvoker: true };
let directory, oldGenerator, inspectorBytes; const sources = new Map();
test.before(async () => {
  inspectorBytes = execFileSync('git', ['show', `${INSPECTION_ENTRY_COMMIT}:scripts/floating-garden-active-update-owner.mjs`], { cwd: ROOT, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(hash(inspectorBytes), INSPECTION_ENTRY_SHA256);
  directory = await mkdtemp(join(tmpdir(), 'garden-owner-inspection-'));
  const oldRoot = join(directory, 'old-source'); await mkdir(oldRoot, { mode: 0o700 });
  const archive = execFileSync('git', ['archive', OLD, 'package.json', 'lab/floating-garden', 'functions/floating-garden-online',
    'functions/floating-garden-trial', 'scripts/prepare-floating-garden-trial.mjs', 'scripts/prepare-floating-garden-trial-operation.mjs'], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', oldRoot], { input: archive });
  oldGenerator = await import(pathToFileURL(join(oldRoot, 'scripts/prepare-floating-garden-trial-operation.mjs')));
  // Read the immutable published commit, never mutable HEAD/index/worktree.
  // CI fetches full history and the local read-only fetch supplies this object.
  assert.equal(execFileSync('git', ['show', '-s', '--format=%T', OWNER_SOURCE_COMMIT], { cwd: ROOT, encoding: 'utf8' }).trim(), OWNER_SOURCE_TREE);
  for (const [path, expected] of Object.entries(OWNER_SOURCE_FILES)) {
    const bytes = execFileSync('git', ['show', `${OWNER_SOURCE_COMMIT}:${path}`], { cwd: ROOT, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(hash(bytes), expected); sources.set(path, bytes);
  }
});
test.after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
async function put(path, value) { await mkdir(join(path, '..'), { recursive: true, mode: 0o700 }); await writeFile(path, value, { mode: 0o600 }); }
async function runtime(packet) {
  const root = join(packet.gameDir, 'functions/node_modules');
  const module = async (name, version, files, entry = 'index.js') => {
    await put(join(root, name, 'package.json'), JSON.stringify({ name, version, main: entry }));
    for (const path of files) await put(join(root, name, path), 'throw Error("SYNTHETIC SDK MUST NEVER EXECUTE");\n');
  };
  await module('firebase-admin', '12.7.0', ['index.js', 'app.js', 'firestore.js']);
  await module('firebase-functions', '6.6.0', ['index.js', 'v2/https.js']);
  await module('google-auth-library', '9.15.1', ['index.js']);
  await module('@google-cloud/firestore', '7.11.6', ['index.js']);
  await module('gaxios', '6.7.1', ['index.js']);
}
async function snapshot(path) {
  const files = {};
  async function visit(at, prefix = '') {
    for (const name of (await readdir(at)).sort()) {
      const full = join(at, name), info = await lstat(full);
      if (info.isDirectory()) await visit(full, prefix + name + '/');
      else files[prefix + name] = { hash: hash(await readFile(full)), mode: info.mode & 0o777 };
    }
  }
  await visit(path); return files;
}
async function fixture(t, { updated = true } = {}) {
  const home = await mkdtemp(join(directory, 'owner-'));
  const base = join(home, 'garden-final-reviewed-v1'), latest = join(home, 'garden-lobby-entry-reviewed-v1');
  await mkdir(base, { mode: 0o700 });
  const original = await oldGenerator.prepareTrialOperation({ review, output: join(base, 'operation'), now: NOW });
  let selected = original;
  if (updated) {
    await mkdir(latest, { mode: 0o700 });
    selected = await oldGenerator.prepareTrialOperation({ review, output: join(latest, 'operation'), now: NOW });
    const state = { schemaVersion: 1, manifestDigest: selected.manifestDigest, reviewDigest: selected.reviewDigest,
      hostingUpdate: { schemaVersion: 1, priorOutput: original.output, priorManifestDigest: original.manifestDigest,
        reviewDigest: selected.reviewDigest, originalJournalDigest: 'a'.repeat(64), activationReceiptDigest: 'b'.repeat(64) },
      deploy: { status: 'active' }, stop: { status: 'new' }, events: [
        { stage: 'update-hosting', status: 'issued', atMillis: NOW }, { stage: 'update-hosting', status: 'verified', atMillis: NOW + 1 },
      ] };
    await put(join(selected.output, 'OPERATION-STATE.json'), JSON.stringify(state));
  }
  await runtime(selected);
  const tooling = join(home, 'garden-trial-f0bc4eb0/tooling'); await mkdir(tooling, { recursive: true, mode: 0o700 });
  await put(join(tooling, 'untouched.txt'), 'existing tooling; provider fixture never executes it');
  const requests = [], inspections = [], logs = []; let responseHook, providerHook;
  const fetchImpl = async (url, options) => {
    requests.push({ url, options }); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    const prefix = `https://raw.githubusercontent.com/fabdemnt-dev/wa-awesome/${OWNER_SOURCE_COMMIT}/`;
    assert(url.startsWith(prefix)); const path = url.slice(prefix.length); assert(sources.has(path));
    const response = new Response(sources.get(path), { status: 200 }); Object.defineProperty(response, 'url', { value: url });
    return responseHook ? responseHook(path, response) : response;
  };
  const createProvider = options => {
    inspections.push(options);
    assert.equal(options.toolingDir, tooling); assert.equal(options.plan.executionReady, false);
    return { inspect: async () => providerHook ? providerHook() : { kind: 'baseline', fingerprint: 'c'.repeat(64),
      createdRoomCount: 2, roomCount: 2, documentCount: 50 },
      bindJournal: () => assert.fail('inspection must never bind a journal'), pause: () => assert.fail('inspection must never pause'),
      updateFunctions: () => assert.fail('inspection must never deploy'), reopen: () => assert.fail('inspection must never reopen') };
  };
  const options = { home, fetchImpl, createProvider, env: {}, execArgv: [], now: () => NOW, log: value => logs.push(value) };
  return { home, base, latest, tooling, selected, original, requests, inspections, logs, options,
    target: join(home, OWNER_PREPARATION_NAME), setResponseHook(value) { responseHook = value; },
    setProviderHook(value) { providerHook = value; }, run: () => inspectOwnerActiveUpdate(options) };
}


import {createRequire} from 'node:module';
import {FUNCTION_NAMES} from '../scripts/prepare-floating-garden-trial.mjs';
import {REGION, RUNTIME_ACCOUNT} from '../scripts/floating-garden-trial-cloud-adapter.mjs';
import {ACTIVE_UPDATE_SCOPE as S} from '../scripts/floating-garden-active-update.mjs';
const require=createRequire(join(ROOT, 'package.json')),archiver=require('archiver');
let oldPacket,newPacket,plan,createActiveUpdateProvider;
const clone = value => structuredClone(value);
function memoryDatabase() {
  const values = new Map(); let version = 0;
  const writes = [], attempts = []; let fault;
  const snapshot = path => ({ ref: { path }, exists: values.has(path), data: () => clone(values.get(path)) });
  const ref = path => ({ path, get: async () => snapshot(path) });
  const db = {
    doc: ref, collection: id => ({ limit: count => ({ id, count, group: false }) }),
    collectionGroup: id => ({ limit: count => ({ id, count, group: true }) }),
    listCollections: async () => [...new Set([...values.keys()].map(p => p.split('/')[0]))].map(id => ({ id })),
    async getAll(...refs) { return refs.map(r => snapshot(r.path)); },
    async runTransaction(body, options = {}) {
      attempts.push(clone(options)); const start = version, pending = [];
      const tx = { get: async target => {
        assert.equal(pending.length, 0, 'all reads precede writes');
        if (target.path) return snapshot(target.path);
        const names = [...values.keys()].filter(p => target.group ? p.split('/').at(-2) === target.id : p.split('/').length === 2 && p.startsWith(`${target.id}/`));
        return { docs: names.slice(0, target.count).map(snapshot) };
      }, create: (r, data) => { assert(!values.has(r.path)); pending.push({ kind: 'create', path: r.path, data: clone(data) }); },
      set: (r, data) => pending.push({ kind: 'set', path: r.path, data: clone(data) }),
      update: (r, data) => { assert(values.has(r.path)); pending.push({ kind: 'update', path: r.path, data: clone(data) }); } };
      const result = await body(tx);
      if (pending.length && fault) await fault({ phase: 'before', pending, db });
      if (!options.readOnly && start !== version) throw Error('ABORTED synthetic concurrent change');
      for (const item of pending) { values.set(item.path, item.kind === 'update' ? { ...values.get(item.path), ...item.data } : item.data); writes.push(item); version++; }
      if (pending.length && fault) await fault({ phase: 'after', pending, db });
      return result;
    },
    set(path, data) { values.set(path, clone(data)); version++; }, get: path => clone(values.get(path)),
    entries: () => [...values].map(([path, data]) => [path, clone(data)]), writes, attempts,
    setFault(value) { fault = value; },
  }; return db;
}
async function legacyData() {
  const db = memoryDatabase(), dir = oldPacket.packet.gameDir;
  const old = require(join(dir, 'functions/online/handlers.js'));
  const trial = require(join(dir, 'functions/trial-handlers.js'));
  const config = JSON.parse(await readFile(join(dir, 'functions/trial-config.json')));
  const records = JSON.parse(await readFile(join(dir, 'ADMIN-RECORDS-REVIEW.json')));
  db.set('floatingGardenTrial/config', { ...records['floatingGardenTrial/config'], enabled: true, testerUids: [...review.testerUids], preservedExtra: 'retain' });
  db.set('floatingGardenTrial/usage', records['floatingGardenTrial/usage']);
  review.testerUids.forEach(uid => db.set(`floatingGardenTrialTesters/${uid}`, { ...records.testerDocumentTemplate, active: true, preservedExtra: 'retain' }));
  let serial = 0;
  const handlers = trial.createTrialHandlers({ db, config, trustedHandlersFactory: old.createHandlers,
    now: () => NOW, env: { GCLOUD_PROJECT: S.project }, inviteSecret: () => 'synthetic-local-only-hmac-key-12345678901234567890',
    randomUUID: () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`, randomInt: () => 0 });
  const request = (uid, data) => ({ auth: { uid }, app: { appId: 'synthetic' }, rawRequest: { headers: { origin: S.origin }, ip: '127.0.0.1' }, data });
  const first = await handlers.floatingGardenCreateRoom(request(review.testerUids[0], { displayName: 'A', requestId: 'synthetic-waiting' }));
  const second = await handlers.floatingGardenCreateRoom(request(review.testerUids[0], { displayName: 'A', requestId: 'synthetic-active' }));
  await handlers.floatingGardenJoinRoom(request(review.testerUids[1], { displayName: 'B', requestId: 'synthetic-join', inviteCode: second.inviteCode }));
  await handlers.floatingGardenStartMatch(request(review.testerUids[0], { requestId: 'synthetic-start', roomId: second.roomId, expectedRevision: 2 }));
  assert.equal(db.get('floatingGardenTrial/usage').createdRoomCount, 2); db.writes.length = 0; db.attempts.length = 0;
  return { db, first, second };
}
async function zip(packet) {
  const archive = archiver('zip'), chunks = [];
  const done = new Promise((ok, fail) => { archive.on('end', ok); archive.on('error', fail); });
  archive.on('data', bytes => chunks.push(bytes));
  for (const path of Object.keys(packet.manifest.files).filter(p => p.startsWith('game/functions/'))) archive.append(await readFile(join(packet.output, path)), { name: path.slice(15), mode: 0o100644 });
  await archive.finalize(); await done; return Buffer.concat(chunks);
}
function metadata(i, generation = '123') {
  const name = FUNCTION_NAMES[i], service = `projects/${S.project}/locations/${REGION}/services/garden-${i}`;
  return { name: `projects/${S.project}/locations/${REGION}/functions/${name}`, environment: 'GEN_2', state: 'ACTIVE',
    labels: { 'firebase-functions-codebase': 'floating-garden-trial', 'deployment-callable': 'true' },
    buildConfig: { runtime: 'nodejs22', entryPoint: name, sourceProvenance: { resolvedStorageSource: {
      bucket: `gcf-v2-sources-${S.projectNumber}-${REGION}`, object: `source-${generation}.zip`, generation } } },
    serviceConfig: { service, revision: `garden-${i}-${generation}`, serviceAccountEmail: RUNTIME_ACCOUNT,
      availableMemory: '256Mi', availableCpu: '1', maxInstanceRequestConcurrency: 1, maxInstanceCount: 1,
      timeoutSeconds: 30, ingressSettings: 'ALLOW_ALL', allTrafficOnLatestRevision: true,
      secretEnvironmentVariables: i < 2 ? [{ key: 'FLOATING_GARDEN_INVITE_HMAC_KEY', secret: 'FLOATING_GARDEN_INVITE_HMAC_KEY', projectId: S.projectNumber, version: '1' }] : [] } };
}
function run(fn) {
  const name = fn.serviceConfig.service, revision = `${name}/revisions/${fn.serviceConfig.revision}`;
  return { name, generation: '1', observedGeneration: '1', terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
    latestCreatedRevision: revision, latestReadyRevision: revision, template: { serviceAccount: RUNTIME_ACCOUNT,
      scaling: { maxInstanceCount: 1 }, maxInstanceRequestConcurrency: 1, timeout: '30s', containers: [{ image: 'old-or-new-image', resources: { limits: { memory: '256Mi', cpu: '1' } } }] },
    traffic: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 100 }], trafficStatuses: [{ revision, percent: 100 }] };
}
async function harness({ ownerTooling } = {}) {
  const { db } = await legacyData();
  const path = await mkdtemp(join(directory, 'provider-')), toolingDir = ownerTooling || join(path, 'tooling');
  await mkdir(join(toolingDir, 'node_modules/firebase-tools/lib/bin'), { recursive: true });
  await writeFile(join(toolingDir, 'package.json'), await readFile(join(ROOT, 'tests/fixtures/floating-garden-maintenance-package.json')));
  await writeFile(join(toolingDir, 'package-lock.json'), await readFile(join(ROOT, 'package-lock.json')));
  await writeFile(join(toolingDir, 'node_modules/firebase-tools/package.json'), '{"version":"14.27.0"}');
  await writeFile(join(toolingDir, 'node_modules/firebase-tools/lib/bin/firebase.js'), '// synthetic; never executed');
  const archives = { '123': await zip(oldPacket.packet) };
  const functions = FUNCTION_NAMES.map((_, i) => metadata(i));
  const rulesPhase = 'old', hostingPhase = 'old', settingsRevision = 1; let override, constructions = 0;
  const calls = [], providerWrites = [];
  const policy = () => ({ version: 3, etag: 'preserved', bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }, { role: 'roles/run.viewer', members: ['group:synthetic@example.invalid'], condition: { title: 'preserved', expression: 'true' } }], auditConfigs: [{ service: 'allServices', auditLogConfigs: [{ logType: 'ADMIN_READ' }] }] });
  const choose = phase => phase === 'old' ? oldPacket.packet : newPacket.packet;
  let requestClient = { request: async options => {
    calls.push(options); if (options.method !== 'GET') providerWrites.push(options.method); assert.equal(options.method, 'GET'); assert.equal(options.retry, false); assert.equal(options.maxRedirects, 0);
    const { url } = options; let data;
    if (url.startsWith('https://cloudfunctions.googleapis.com/') && url.includes(':getIamPolicy')) data = policy();
    else if (url.startsWith('https://cloudfunctions.googleapis.com/')) data = { functions: clone(functions) };
    else if (url.startsWith('https://run.googleapis.com/') && url.includes(':getIamPolicy')) data = policy();
    else if (url.startsWith('https://run.googleapis.com/')) data = run(functions.find(fn => url.endsWith(fn.serviceConfig.service)));
    else if (url.includes('/releases/cloud.firestore')) data = { name: `projects/${S.project}/releases/cloud.firestore`, rulesetName: `projects/${S.project}/rulesets/${rulesPhase}` };
    else if (url.includes('/rulesets/')) data = { name: `projects/${S.project}/rulesets/${rulesPhase}`, source: { files: [{ name: 'firestore.rules', content: await readFile(join(choose(rulesPhase).gameDir, 'firestore.rules'), 'utf8') }] } };
    else if (url.startsWith('https://storage.googleapis.com/')) {
      const generation = new URL(url).searchParams.get('generation') || '123';
      data = url.includes('&alt=media') ? archives[generation] : url.includes('/o/') ? {
        bucket: `gcf-v2-sources-${S.projectNumber}-${REGION}`, name: `source-${generation}.zip`, generation, size: String(archives[generation].length),
      } : { name: `gcf-v2-sources-${S.projectNumber}-${REGION}`, projectNumber: S.projectNumber };
    } else if (url.startsWith('https://identitytoolkit.googleapis.com/')) data = { name: `projects/${S.project}/config`, signIn: { anonymous: { enabled: true } }, settingsRevision };
    else if (url.startsWith('https://firebaseappcheck.googleapis.com/')) data = url.includes('/services?') ? { services: [{ name: 'firestore', enforcementMode: 'ENFORCED' }] } : { siteKey: 'synthetic-preserved' };
    else assert.fail(`Unexpected synthetic URL ${url}`);
    return { status: 200, data: override ? override(url, data) : data };
  } };
  const runner = (command, args) => {
    calls.push({ command, args }); let result;
    if (command === 'gcloud') {
      if (args[0] === 'config') result = {};
      else if (args[0] === 'projects' && args[1] === 'describe') result = { projectId: S.project, projectNumber: S.projectNumber, lifecycleState: 'ACTIVE' };
      else if (args.includes('get-iam-policy')) result = policy();
      else if (args[0] === 'artifacts' || args[0] === 'services') result = [];
      else result = { name: args.slice(0, 3).join('-'), settingsRevision };
      return { exitCode: 0, stdout: JSON.stringify(result) };
    }
    assert.equal(command, process.execPath);
    if (args.includes('--version')) return { exitCode: 0, stdout: '14.27.0' };
    if (args[1] === 'hosting:sites:list') result = { sites: [{ name: `projects/${S.project}/sites/${S.project}`, defaultUrl: S.origin }] };
    else { assert.equal(args[1], 'hosting:channel:list'); result = { channels: [{ name: `sites/${S.project}/channels/live`, url: S.origin,
      release: { type: 'DEPLOY', message: `garden-trial-game-v1:${choose(hostingPhase).manifestDigest}`,
        version: { name: `sites/${S.project}/versions/${hostingPhase}`, status: 'FINALIZED' } } }] }; }
    return { exitCode: 0, stdout: JSON.stringify({ status: 'success', result }) };
  };
  const fetchImpl = async url => {
    const packet = choose(hostingPhase), config = JSON.parse(await readFile(join(packet.gameDir, 'firebase.hosting-only.json')));
    const headers = Object.fromEntries(config.hosting.headers[0].headers.map(h => [h.key, h.value]));
    const path = new URL(url).pathname;
    headers['Content-Type'] = path.endsWith('.js') ? 'text/javascript; charset=utf-8' : path.endsWith('.css') ? 'text/css' : 'text/html';
    if (path === '/') return new Response('', { status: 302, headers: { ...headers, location: '/lab/floating-garden/trial/index.html' } });
    return new Response(await readFile(join(packet.gameDir, 'public', path)), { status: 200, headers });
  };
  return { db, calls, providerWrites, constructions: () => constructions,
    // No transport injection: the real pinned provider constructs its actual
    // HTTP bridge. All I/O is fake; no provider method is replaced or wrapped.
    createProvider: input => { constructions++; return createActiveUpdateProvider({ ...input, runner, requestClient, db, fetchImpl }); },
    setOverride(value) { override = value; },
  };
}

import { diagnoseOwnerActiveUpdate, main, classifyDiagnosticFailure } from '../scripts/floating-garden-active-update-diagnose-owner.mjs';

// A saved failure contains exactly the outputs produced before any issued step.
async function failedFixture(t, options = {}) {
  const h = await fixture(t, options); assert.equal((await h.run()).status, 'baseline-read-only');
  const source = join(h.target, 'source');
  const active = await import(pathToFileURL(join(source, 'scripts/floating-garden-active-update.mjs')));
  const adapter = await import(pathToFileURL(join(source, 'scripts/floating-garden-trial-cloud-adapter.mjs')));
  const plan = await active.prepareActiveUpdatePlan({ previousOutput: h.selected.output, nextOutput: join(h.target, 'operation') });
  const guard = join(h.home, EXECUTION_GUARD_NAME); await mkdir(guard, { mode: 0o700 });
  const executionPath = join(guard, 'EXECUTION.json'), inspectorPath = join(guard, 'read-only-owner.mjs');
  const execution = { schemaVersion: 1, sourceCommit: OWNER_SOURCE_COMMIT, preparation: OWNER_PREPARATION_NAME, createdAtMillis: NOW, automaticRetry: false };
  await put(executionPath, JSON.stringify(execution) + '\n'); await put(inspectorPath, inspectorBytes);
  const journal = join(h.target, 'operation/ACTIVE-UPDATE-JOURNAL.jsonl');
  const entries = [{ schemaVersion: 1, atMillis: NOW, event: 'created', oldManifestDigest: plan.oldManifestDigest, newManifestDigest: plan.newManifestDigest },
    { schemaVersion: 1, atMillis: NOW, event: 'blocked', stage: 'read-only-baseline', reason: 'unclassified', access: 'open' }];
  await put(journal, entries.map(e => JSON.stringify(e) + '\n').join(''));
  const logs = [], calls = []; let hook;
  const createProvider = input => {
    calls.push('construct'); assert.equal(input.plan.preservedTesterCount, 2); assert.equal(input.plan.maxRooms, 20); assert.equal(input.plan.endsAtMillis, END);
    let n = 0;
    const provider = { inspect: async () => { calls.push('inspect'); return hook ? hook(++n, input) :
      { kind: 'baseline', fingerprint: 'a'.repeat(64), createdRoomCount: 2, roomCount: 2, documentCount: 158 }; },
      readAccess: async () => { calls.push('readAccess'); return { access: 'open' }; } };
    for (const key of ['bindJournal', 'pause', 'updateFunctions', 'updateRules', 'updateHosting', 'reopen']) provider[key] = () => assert.fail('NO WRITE OR JOURNAL BINDING: ' + key);
    return provider;
  };
  const args = { enabled: true, home: h.home, env: {}, execArgv: [], now: () => NOW + 1, log: value => logs.push(value), createProvider };
  return { ...h, guard, source, active, adapter, plan, executionPath, inspectorPath, journal, entries, logs, calls, args,
    setInspect(value) { hook = value; }, diagnose: overrides => diagnoseOwnerActiveUpdate({ ...args, ...overrides }) };
}
async function unchanged(h, body) {
  const before = await snapshot(h.home); const value = await body(); assert.deepEqual(await snapshot(h.home), before); return value;
}
function privateOutputAbsent(value) {
  const json = JSON.stringify(value);
  for (const secret of ['SYNTHETIC_OWNER_ALPHA', 'SYNTHETIC_OWNER_BETA', 'PRIVATE_RAW', 'stdout', 'stack', 'credential', 'secret/path']) assert(!json.includes(secret), json);
}

test('default/plan/import and all update/retry/unknown flags are inert', async () => {
  let calls = 0; const args = { log: () => {}, createProvider: () => { calls++; throw Error(); } };
  assert.equal(await main([], args), 0); assert.equal(await main(['--plan'], args), 0);
  for (const flags of [['--apply'], ['--apply-approved-update'], ['--retry'], ['--inspect'], ['--diagnose-failed-update', '--apply'], ['--diagnose-failed-update', '--retry']]) assert.equal(await main(flags, args), 1);
  assert.equal(calls, 0);
});
test('saved original or latest packet and exact failed journal permit only two sequential reads', async t => {
  for (const updated of [false, true]) {
    const h = await failedFixture(t, { updated });
    const result = await unchanged(h, () => h.diagnose());
    assert.equal(result.status, 'diagnosed', JSON.stringify(result)); assert.equal(result.finding, 'not-reproduced');
    assert.equal(result.originalCause, 'unknown'); assert.equal(result.savedStateUnchanged, true); assert.equal(result.executionRetryAuthorized, false);
    assert.equal(result.cloudWrites, 0); assert.equal(result.readAccess, 'open'); assert.equal(result.pass1.status, 'passed'); assert.equal(result.pass2.status, 'passed');
    assert.deepEqual(h.calls, ['construct', 'inspect', 'inspect', 'readAccess']); privateOutputAbsent([result, h.logs]);
    assert.equal(await main(['--diagnose-failed-update'], h.args), 0);
    // A diagnosis leaves the old executor's one-shot guard intact and unusable.
    const execution = await executeOwnerActiveUpdate({ ...h.args, approved: true, playersStopped: true, exclusiveMaintenance: true,
      fetchImpl: async () => assert.fail('diagnosis must leave execution blocked before any download') });
    assert.equal(execution.stage, 'one-shot-guard');
  }
});
test('direct catch preserves branded current errors, fixed native/gRPC classifications and real access', async t => {
  const h = await failedFixture(t);
  for (const [error, expected] of [[h.active.activeUpdateFailure('admin-race'), { kind: 'active-update', reason: 'admin-race' }],
    [Object.assign(Error('PRIVATE_RAW'), { code: 14, details: 'PRIVATE_RAW' }), { kind: 'grpc', code: 14, name: 'UNAVAILABLE' }],
    [TypeError('PRIVATE_RAW'), { kind: 'error-class', name: 'TypeError' }]]) {
    h.calls.length = 0; h.setInspect(n => { if (n === 2) throw error; return { kind: 'baseline', fingerprint: 'a'.repeat(64), createdRoomCount: 2, roomCount: 2, documentCount: 158 }; });
    const result = await unchanged(h, () => h.diagnose()); assert.equal(result.pass1.status, 'passed'); assert.deepEqual(result.pass2, { status: 'failed', classification: expected });
    assert.equal(result.originalCause, 'unknown'); assert.equal(result.finding, 'current-read-failure'); assert.equal(result.readAccess, 'open'); privateOutputAbsent([result, h.logs]);
  }
  for (const access of ['closed', 'unknown', 'PRIVATE_RAW']) {
    const result = await h.diagnose({ createProvider: () => ({ inspect: async () => { throw Error('PRIVATE_RAW'); }, readAccess: async () => ({ access }) }) });
    assert.equal(result.readAccess, access === 'PRIVATE_RAW' ? 'unknown' : access); assert.equal(result.pass1.status, 'failed'); assert.equal(result.pass2.status, 'failed'); privateOutputAbsent(result);
  }
  const result = await h.diagnose({ createProvider: () => ({ inspect: async () => { throw Error('PRIVATE_RAW'); }, readAccess: async () => { throw RangeError('PRIVATE_RAW'); } }) });
  assert.deepEqual(result.accessFailure, { kind: 'error-class', name: 'RangeError' }); assert.equal(result.readAccess, 'unknown');
});
test('error strings, forged reasons, inherited codes, proxy/getter payloads never become output', () => {
  let invoked = 0;
  const getter = new Error('PRIVATE_RAW'); Object.defineProperty(getter, 'code', { get() { invoked++; throw Error('PRIVATE_RAW'); } });
  const forged = { reason: 'permission', code: 7, name: 'PRIVATE_RAW', message: 'PRIVATE_RAW', stack: 'PRIVATE_RAW' };
  const proxy = new Proxy({}, { get() { invoked++; throw Error('PRIVATE_RAW'); }, getOwnPropertyDescriptor() { invoked++; throw Error('PRIVATE_RAW'); }, getPrototypeOf() { invoked++; throw Error('PRIVATE_RAW'); } });
  const inherited = Error('PRIVATE_RAW'); Object.setPrototypeOf(inherited, { code: 7, name: 'PRIVATE_RAW' });
  for (const error of [getter, forged, proxy, inherited, 'PRIVATE_RAW', null, 14]) privateOutputAbsent(classifyDiagnosticFailure(error));
  for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE']) assert.deepEqual(classifyDiagnosticFailure(Object.assign(Error('PRIVATE_RAW'), { code })), { kind: 'system-code', code });
  assert.equal(invoked, 0); assert.deepEqual(classifyDiagnosticFailure(forged), { kind: 'unclassified' });
  for (const code of [0, -1, 17, 403, '7', NaN, 7.1, 'PRIVATE_RAW', 'app/PRIVATE_RAW']) assert.deepEqual(classifyDiagnosticFailure(Object.assign(Error('PRIVATE_RAW'), { code })), { kind: 'error-class', name: 'Error' });
});
test('scope changes in either pass are reported safely and never authorize writes', async t => {
  const h = await failedFixture(t);
  for (const changes of [{ createdRoomCount: 3 }, { roomCount: 1 }, { documentCount: 10001 }, { fingerprint: 'PRIVATE_RAW' }, { kind: 'success' }]) {
    h.setInspect(() => ({ kind: 'baseline', fingerprint: 'a'.repeat(64), createdRoomCount: 2, roomCount: 2, documentCount: 158, ...changes }));
    const value = await unchanged(h, () => h.diagnose()); assert.equal(value.pass1.classification.reason, 'admin-state'); assert.equal(value.pass2.classification.reason, 'admin-state'); assert.equal(value.cloudWrites, 0);
  }
});
test('unsafe environments, missing approval and out-of-window clocks stop before local/provider work', async t => {
  const h = await failedFixture(t);
  for (const overrides of [{ enabled: false }, { now: () => END }, { now: () => START - 1 }, { now: () => NaN },
    ...['HTTPS_PROXY', 'NODE_OPTIONS', 'NODE_DEBUG', 'GRPC_TRACE', 'GOOGLE_SDK_NODE_LOGGING', 'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUDSDK_API_ENDPOINT_OVERRIDES_FIRESTORE', 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_CONFIG', 'GOOGLE_CLOUD_UNIVERSE_DOMAIN', 'CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT', 'npm_config_registry', 'NODE_TLS_REJECT_UNAUTHORIZED'].map(key => ({ env: { [key]: 'PRIVATE_RAW' } })),
    { env: { CLOUDSDK_AUTH_DISABLE_CREDENTIALS: 'true' } }, { execArgv: ['--import', '/secret/path'] }]) {
    const value = await unchanged(h, () => h.diagnose(overrides)); assert.equal(value.status, 'blocked'); assert.equal(value.stage, 'owner-paths'); privateOutputAbsent(value);
  }
  assert.deepEqual(h.calls, []);
});
test('inspector/source tampering, extra or missing inventory rejects before import/provider construction', async t => {
  for (const issue of ['inspector', 'source-bytes', 'source-extra', 'source-missing', 'source-directory', 'source-mode', 'source-hardlink']) {
    const h = await failedFixture(t), file = join(h.source, 'scripts/floating-garden-active-update-provider.mjs');
    if (issue === 'inspector') await writeFile(h.inspectorPath, 'globalThis.unverifiedGardenDiagnosisRan=true;');
    if (issue === 'source-bytes') await writeFile(file, 'globalThis.unverifiedGardenDiagnosisRan=true;');
    if (issue === 'source-extra') await put(join(h.source, 'injection.mjs'), 'globalThis.unverifiedGardenDiagnosisRan=true;');
    if (issue === 'source-missing') await rm(file);
    if (issue === 'source-directory') await mkdir(join(h.source, 'foreign'), { mode: 0o700 });
    if (issue === 'source-mode') await chmod(file, 0o644);
    if (issue === 'source-hardlink') await link(file, join(h.home, 'extra-link'));
    const value = await unchanged(h, () => h.diagnose()); assert.equal(value.status, 'blocked'); assert.deepEqual(h.calls, []); assert.equal(globalThis.unverifiedGardenDiagnosisRan, undefined);
  }
});
test('saved guard/execution exact schema and private canonical paths cannot be substituted', async t => {
  const alterations = [value => ({ ...value, automaticRetry: true }), value => ({ ...value, sourceCommit: '0'.repeat(40) }),
    value => ({ ...value, preparation: '/secret/path' }), value => ({ ...value, extra: true }), value => ({ ...value, schemaVersion: 2 }),
    value => ({ ...value, createdAtMillis: END }), value => ({ ...value, createdAtMillis: NOW + 2 }), value => ({ ...value, createdAtMillis: START - 1 })];
  for (const change of alterations) {
    const h = await failedFixture(t); await writeFile(h.executionPath, JSON.stringify(change(JSON.parse(await readFile(h.executionPath)))) + '\n');
    const result = await unchanged(h, () => h.diagnose()); assert.equal(result.stage, 'guard-verification'); assert.deepEqual(h.calls, []);
  }
  for (const target of ['guard', 'inspectorPath', 'journal']) {
    const h = await failedFixture(t), original = h[target], destination = original + '-retained';
    await rename(original, destination); await symlink(destination, original);
    const before = await readFile(target === 'guard' ? join(destination, 'EXECUTION.json') : destination);
    const result = await h.diagnose(); assert.equal(result.status, 'blocked'); assert.deepEqual(h.calls, []);
    assert.deepEqual(await readFile(target === 'guard' ? join(destination, 'EXECUTION.json') : destination), before);
  }
  for (const target of ['guard', 'executionPath', 'inspectorPath', 'journal']) {
    const h = await failedFixture(t); await chmod(h[target], target === 'guard' ? 0o755 : 0o644);
    assert.equal((await h.diagnose()).status, 'blocked'); assert.deepEqual(h.calls, []);
  }
});
test('marker bindings, packet pins and runtime identity must match retained preparation', async t => {
  for (const field of ['sourceCommit', 'sourceTree', 'previousOutput', 'previousManifestDigest', 'targetManifestDigest', 'reviewDigest', 'extra']) {
    const h = await failedFixture(t), path = join(h.target, 'PREPARATION.json'), marker = JSON.parse(await readFile(path)); marker[field] = 'PRIVATE_RAW';
    await writeFile(path, JSON.stringify(marker)); assert.equal((await unchanged(h, () => h.diagnose())).status, 'blocked'); assert.deepEqual(h.calls, []);
  }
  for (const issue of ['packet', 'runtime', 'operation-extra']) {
    const h = await failedFixture(t);
    if (issue === 'packet') await writeFile(join(h.target, 'operation/game/firestore.rules'), 'PRIVATE_RAW');
    if (issue === 'runtime') await writeFile(join(h.target, 'operation/game/functions/node_modules/firebase-admin/package.json'), '{"version":"99.0.0"}');
    if (issue === 'operation-extra') await put(join(h.target, 'operation/foreign'), 'PRIVATE_RAW');
    assert.equal((await unchanged(h, () => h.diagnose())).status, 'blocked'); assert.deepEqual(h.calls, []);
  }
});
test('only exact created then blocked/unclassified/open pre-mutation journal is admissible', async t => {
  const changes = [e => [], e => [e[0]], e => [...e, e[1]], e => [e[1], e[0]],
    e => [e[0], { ...e[1], event: 'issued', stage: 'pause-cas' }], e => [e[0], { ...e[1], event: 'provider-issued' }],
    e => [e[0], { ...e[1], stage: 'pause-cas' }], e => [e[0], { ...e[1], reason: 'provider-read' }],
    e => [e[0], { ...e[1], access: 'closed' }], e => [e[0], { ...e[1], extra: 'PRIVATE_RAW' }],
    e => [{ ...e[0], newManifestDigest: '0'.repeat(64) }, e[1]], e => [{ ...e[0], oldManifestDigest: '0'.repeat(64) }, e[1]],
    e => [{ ...e[0], schemaVersion: 2 }, e[1]], e => [e[0], { ...e[1], schemaVersion: 2 }],
    e => [{ ...e[0], atMillis: NOW - 1 }, e[1]], e => [e[0], { ...e[1], atMillis: NOW - 1 }],
    e => [e[0], { ...e[1], atMillis: NOW + 2 }], e => [e[0], { ...e[1], atMillis: END }]];
  const h = await failedFixture(t);
  for (const change of changes) {
    await writeFile(h.journal, change(structuredClone(h.entries)).map(v => JSON.stringify(v) + '\n').join(''));
    const value = await unchanged(h, () => h.diagnose()); assert.equal(value.status, 'blocked'); assert.equal(value.stage, 'journal-verification'); assert.deepEqual(h.calls, []);
  }
  for (const bytes of ['{}', '{PRIVATE_RAW', h.entries.map(v => JSON.stringify(v) + '\n').join('') + '\n',
    JSON.stringify(h.entries[0]).replace('"event":"created"', '"event":"issued","event":"created"') + '\n' + JSON.stringify(h.entries[1]) + '\n']) {
    await writeFile(h.journal, bytes); assert.equal((await h.diagnose()).stage, 'journal-verification'); assert.deepEqual(h.calls, []);
  }
});
test('diagnostic CLI flushes and exits despite lingering SDK-style handles', async () => {
  const owner = fileURLToPath(new URL('../scripts/floating-garden-active-update-diagnose-owner.mjs', import.meta.url));
  const path = join(directory, 'diagnose-lifecycle.mjs');
  await writeFile(path, `setInterval(() => {}, 100000); process.argv[1] = ${JSON.stringify(owner)}; await import(${JSON.stringify(pathToFileURL(owner).href)});`);
  assert.match(execFileSync(process.execPath, [path, '--plan'], { encoding: 'utf8', timeout: 3000 }), /^DIAGNOSTIC_PLAN_ONLY:/);
});

test('actual pinned provider/adapter/HTTP bridge: both passes, legacy second-read fault and raw Firestore second-read fault', async t => {
  for (const fault of ['none', 'adapter', 'http', 'firestore']) {
    const h = await failedFixture(t);
    ({ createActiveUpdateProvider } = await import(pathToFileURL(join(h.source, 'scripts/floating-garden-active-update-provider.mjs'))));
    plan = h.plan; const packets = h.active.activeUpdatePackets(plan); oldPacket = packets.old; newPacket = packets.next;
    const p = await harness({ ownerTooling: h.tooling });
    let functionReads = 0, transactionReads = 0, accessReads = 0;
    p.setOverride((url, data) => {
      if (url.startsWith('https://cloudfunctions.googleapis.com/') && !url.includes(':getIamPolicy')) {
        functionReads++;
        if (functionReads === 5 && fault === 'adapter') return { ...data, functions: [] };
        if (functionReads === 5 && fault === 'http') throw Object.assign(Error('PRIVATE_RAW HTTP UID SYNTHETIC_OWNER_ALPHA'), { response: { status: 403, data: 'PRIVATE_RAW' } });
      }
      return data;
    });
    const getAll = p.db.getAll;
    p.db.getAll = async (...args) => { accessReads++; return getAll(...args); };
    const original = p.db.runTransaction;
    p.db.runTransaction = async (...args) => {
      transactionReads++; assert.equal(args[1].readOnly, true);
      if (transactionReads === 3 && fault === 'firestore') throw Object.assign(Error('PRIVATE_RAW Firestore UID SYNTHETIC_OWNER_ALPHA'), { code: 14, details: 'PRIVATE_RAW' });
      return original(...args);
    };
    const beforeData = p.db.entries();
    const result = await unchanged(h, () => h.diagnose({ createProvider: p.createProvider }));
    assert.equal(result.status, 'diagnosed', JSON.stringify(result)); assert.equal(result.pass1.status, 'passed', JSON.stringify(result));
    assert.equal(result.readAccess, 'open'); assert.equal(result.cloudWrites, 0); assert.equal(result.originalCause, 'unknown'); assert.equal(p.constructions(), 1); assert.equal(accessReads, 1);
    if (fault === 'none') { assert.equal(result.pass2.status, 'passed'); assert.equal(result.finding, 'not-reproduced'); assert.equal(transactionReads, 4); assert.equal(functionReads, 8); }
    else {
      assert.equal(result.pass2.status, 'failed'); assert.equal(result.finding, 'current-read-failure'); assert.equal(transactionReads, 3);
      assert.equal(functionReads, fault === 'firestore' ? 4 : 5);
      const expected = fault === 'firestore' ? { kind: 'grpc', code: 14, name: 'UNAVAILABLE' } : fault === 'http' ?
        { kind: 'legacy-adapter', reason: 'metadata-http', httpStatus: 403 } : { kind: 'legacy-adapter', reason: 'function-inventory' };
      assert.deepEqual(result.pass2.classification, expected);
    }
    assert.equal(p.providerWrites.length, 0); assert.equal(p.db.writes.length, 0); assert.deepEqual(p.db.entries(), beforeData);
    privateOutputAbsent([result, h.logs]);
    for (const call of p.calls.filter(call => call.url)) assert.equal(call.method, 'GET');
  }
});

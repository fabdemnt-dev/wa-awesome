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
import { executeOwnerActiveUpdate, INSPECTION_ENTRY_COMMIT, INSPECTION_ENTRY_SHA256, EXECUTION_GUARD_NAME, EXECUTION_PREPARATION_NAME } from '../scripts/floating-garden-active-update-execute-owner.mjs';
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
let oldPacket, newPacket, plan, createActiveUpdateProvider;
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
import { gzipSync } from 'node:zlib';
async function harness({ ownerTooling } = {}) {
  const { first, second, db } = await legacyData();
  const path = await mkdtemp(join(directory, 'provider-')), toolingDir = ownerTooling || join(path, 'tooling');
  await mkdir(join(toolingDir, 'node_modules/firebase-tools/lib/bin'), { recursive: true });
  await writeFile(join(toolingDir, 'package.json'), await readFile(join(ROOT, 'tests/fixtures/floating-garden-maintenance-package.json')));
  await writeFile(join(toolingDir, 'package-lock.json'), await readFile(join(ROOT, 'package-lock.json')));
  await writeFile(join(toolingDir, 'node_modules/firebase-tools/package.json'), '{"version":"14.27.0"}');
  await writeFile(join(toolingDir, 'node_modules/firebase-tools/lib/bin/firebase.js'), '// synthetic; never executed');
  const archives = { '123': await zip(oldPacket.packet), '124': await zip(newPacket.packet) };
  const functions = FUNCTION_NAMES.map((_, i) => metadata(i));
  let rulesPhase = 'old', hostingPhase = 'old', settingsRevision = 1, time = NOW, override;
  const calls = [], providerWrites = [], journalEntries = [];
  const policy = () => ({ version: 3, etag: 'preserved', bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }, { role: 'roles/run.viewer', members: ['group:synthetic@example.invalid'], condition: { title: 'preserved', expression: 'true' } }], auditConfigs: [{ service: 'allServices', auditLogConfigs: [{ logType: 'ADMIN_READ' }] }] });
  const choose = phase => phase === 'old' ? oldPacket.packet : newPacket.packet;
  let requestClient = { request: async options => {
    calls.push(options); assert.equal(options.method, 'GET'); assert.equal(options.retry, false); assert.equal(options.maxRedirects, 0);
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
  const readOnlyRequestClient = requestClient;
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
  let hostingFinalized = false;
  const transportRequest = async options => {
    calls.push(options); const { url, method } = options; let body;
    if (method === 'GET') {
      if (url.startsWith('https://cloudfunctions.googleapis.com/v2/') && /\/functions\/[^/?]+$/.test(url)) body = clone(functions.find(fn => url.endsWith(fn.name)));
      else if (url.includes('/channels/live')) body = { name: `sites/${S.project}/channels/live`, release: { version: { name: `sites/${S.project}/versions/${hostingPhase}` }, message: `garden-trial-game-v1:${choose(hostingPhase).manifestDigest}` } };
      else if (url.includes('/versions/new/files')) {
        const expected = new URL(url).searchParams.get('status') === 'EXPECTED';
        body = { files: expected ? [] : await Promise.all(Object.keys(newPacket.packet.manifest.files).filter(p => p.startsWith('game/public/')).map(async path => ({
          path: '/'+path.slice(12), hash: hash(gzipSync(await readFile(join(newPacket.packet.output, path)), { level: 9 })), status: 'ACTIVE',
        }))) };
      } else if (url.endsWith('/versions/new')) {
        const h = JSON.parse(await readFile(join(newPacket.packet.gameDir, 'firebase.hosting-only.json'))).hosting;
        body = { name: `sites/${S.project}/versions/new`, status: hostingFinalized ? 'FINALIZED' : 'CREATED', config: { headers: h.headers.map(row => ({ glob: row.source, headers: Object.fromEntries(row.headers.map(header => [header.key, header.value])) })), redirects: h.redirects.map(row => ({ glob: row.source, location: row.destination, statusCode: row.type })) } };
      } else body = (await readOnlyRequestClient.request({ ...options, method: 'GET', retry: false, maxRedirects: 0 })).data;
    } else {
      assert.equal((db.get ? db.get('floatingGardenTrial/config') : (await db.doc('floatingGardenTrial/config').get()).data()).enabled, false, 'all provider writes require verified closed gate');
      providerWrites.push(url.includes('cloudfunctions') ? 'functions' : url.includes('firebaserules') ? 'rules' : 'hosting');
      if (url.endsWith('/functions:generateUploadUrl')) body = { storageSource: { bucket: `gcf-v2-uploads-${S.projectNumber}-${REGION}`, object: 'synthetic.zip' }, uploadUrl: `https://storage.googleapis.com/gcf-v2-uploads-${S.projectNumber}-${REGION}/synthetic.zip?synthetic=signature` };
      else if (url.startsWith('https://storage.googleapis.com/')) { assert.equal(options.auth, 'none'); assert(Buffer.isBuffer(options.body)); body = ''; }
      else if (url.startsWith('https://cloudfunctions.googleapis.com/') && method === 'PATCH') {
        const index = functions.findIndex(fn => fn.name === options.body.name); assert(index >= 0); functions[index] = metadata(index, '124');
        body = { name: `projects/${S.project}/locations/${REGION}/operations/synthetic-${index}`, done: true, response: clone(functions[index]) };
      } else if (url.endsWith('/rulesets')) body = { name: `projects/${S.project}/rulesets/new` };
      else if (url.endsWith('/releases/cloud.firestore')) { rulesPhase = 'new'; body = { name: `projects/${S.project}/releases/cloud.firestore`, rulesetName: `projects/${S.project}/rulesets/new` }; }
      else if (url.endsWith('/versions')) body = { name: `sites/${S.project}/versions/new`, status: 'CREATED' };
      else if (url.endsWith(':populateFiles')) body = { uploadRequiredHashes: [...new Set(Object.values(options.body.files))], uploadUrl: `https://upload-firebasehosting.googleapis.com/upload/sites/${S.project}/versions/new/files` };
      else if (url.startsWith('https://upload-firebasehosting.googleapis.com/')) body = '';
      else if (url.endsWith('?updateMask=status')) { hostingFinalized = true; body = { name: `sites/${S.project}/versions/new`, status: 'FINALIZED' }; }
      else if (url.includes('/releases?versionName=')) { hostingPhase = 'new'; body = { name: `sites/${S.project}/releases/new`, version: { name: `sites/${S.project}/versions/new` }, message: `garden-trial-game-v1:${newPacket.packet.manifestDigest}` }; }
      else assert.fail('Unexpected synthetic transport operation');
    }
    return { status: 200, body, headers: { 'x-goog-generation': '456' } };
  };
  let providerFetch;
  {
    const readClient = requestClient;
    requestClient = { request: async options => {
      if (options.responseType !== 'arraybuffer' || options.method === 'GET' && options.url.includes('storage.googleapis.com')) return readClient.request(options);
      const result = await transportRequest({ ...options, body: options.data, auth: 'google' });
      return { status: result.status, data: Buffer.from(JSON.stringify(result.body)), headers: result.headers };
    } };
    providerFetch = async (url, options) => {
      if (!url.startsWith('https://storage.googleapis.com/') && !url.startsWith('https://upload-firebasehosting.googleapis.com/')) return fetchImpl(url, options);
      const result = await transportRequest({ url, ...options, auth: 'none' });
      return new Response(result.body, { status: result.status, headers: result.headers });
    };
  }
  let constructions = 0;
  return { db, first, second, calls, functions, providerWrites, journalEntries, constructions: () => constructions,
    createProvider: input => { constructions++; return createActiveUpdateProvider({ ...input, runner, requestClient, db,
      fetchImpl: providerFetch, now: () => time, env: {}, execArgv: [] }); },
    setTime(value) { time = value; }, changeSettings() { settingsRevision++; }, setOverride(value) { override = value; },
  };
}


import { recoverOwnerActiveUpdate, main, RECOVERY_GUARD_NAME, RECOVERY_VERIFIER_COMMIT, RECOVERY_VERIFIER_SHA256 } from '../scripts/floating-garden-active-update-recover-owner.mjs';
import { loadVerifiedFailedUpdateContext } from '../scripts/floating-garden-active-update-diagnose-owner.mjs';
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
  return { ...h, guard, source, active, adapter, plan, executionPath, inspectorPath, journal, entries };
}
async function recoveryFixture(t, options = {}) {
  const h = await failedFixture(t, options), logs = [], writes = [], calls = [], requests = [];
  assert.match(RECOVERY_VERIFIER_COMMIT, /^[a-f0-9]{40}$/);
  const verifierBytes = execFileSync('git', ['show', `${RECOVERY_VERIFIER_COMMIT}:scripts/floating-garden-active-update-diagnose-owner.mjs`], { cwd: ROOT, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(hash(verifierBytes), RECOVERY_VERIFIER_SHA256);
  const verifierPin = { commit: RECOVERY_VERIFIER_COMMIT, sha256: RECOVERY_VERIFIER_SHA256 };
  const recoveryGuard = join(h.home, RECOVERY_GUARD_NAME), recoveryJournal = join(recoveryGuard, 'ACTIVE-UPDATE-JOURNAL.jsonl');
  let hook, access = 'open', bound, constructions = 0, inspections = 0;
  const fetchImpl = async (url, options) => {
    requests.push(url); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.equal(url, `https://raw.githubusercontent.com/fabdemnt-dev/wa-awesome/${verifierPin.commit}/scripts/floating-garden-active-update-diagnose-owner.mjs`);
    const response = new Response(verifierBytes, { status: 200 }); Object.defineProperty(response, 'url', { value: url }); return response;
  };
  const createProvider = input => {
    constructions++; calls.push('construct'); const provider = { bindJournal: journal => { assert(!bound); bound = journal; } };
    for (const method of ['inspect', 'pause', 'assertClosed', 'updateFunctions', 'verifyFunctions', 'updateRules', 'verifyRules',
      'updateHosting', 'verifyHosting', 'verifyPreservation', 'reopen', 'verifyReopened', 'readAccess']) provider[method] = async (...args) => {
      calls.push(method);
      if (method === 'inspect') inspections++;
      const result = await hook?.(method, { input, journal: bound, args, writes, access }); if (result !== undefined) return result;
      if (method === 'inspect') return { kind: 'baseline', fingerprint: 'a'.repeat(64), createdRoomCount: 2, roomCount: 2, documentCount: 158 };
      if (method === 'readAccess') return { access };
      if (method === 'pause') { writes.push('pause'); access = 'closed'; return { kind: 'success' }; }
      if (method === 'reopen') { writes.push('reopen'); access = 'open'; return { kind: 'success' }; }
      if (method.startsWith('update')) {
        const kind = method.slice(6).toLowerCase();
        await bound.providerStep({ stage: { functions: 'function-patch', rules: 'rules-create', hosting: 'hosting-file-upload' }[kind], resourceKind: kind, index: 0 });
        writes.push(kind); return { kind: 'success' };
      }
      return { kind: 'verified' };
    };
    return provider;
  };
  const args = { renewedApproval: true, playersStopped: true, exclusiveMaintenance: true, home: h.home,
    env: {}, execArgv: [], now: () => NOW + 1, log: value => logs.push(value), fetchImpl, createProvider, verifierPin };
  return { ...h, logs, writes, calls, requests, args, recoveryGuard, recoveryJournal,
    setHook(value) { hook = value; }, constructions: () => constructions, inspections: () => inspections,
    recover: overrides => recoverOwnerActiveUpdate({ ...args, ...overrides }) };
}
async function retainedUnchanged(h, body) {
  const before = await snapshot(h.home), result = await body(), after = await snapshot(h.home);
  for (const name of Object.keys(after)) if (name.startsWith(RECOVERY_GUARD_NAME + '/')) delete after[name];
  for (const name of Object.keys(before)) if (name.startsWith(RECOVERY_GUARD_NAME + '/')) delete before[name];
  assert.deepEqual(after, before); return result;
}
async function rows(h) { return (await readFile(h.recoveryJournal, 'utf8')).trim().split('\n').map(JSON.parse); }
function privateOutputAbsent(value) {
  const json = JSON.stringify(value);
  for (const secret of ['SYNTHETIC_OWNER_ALPHA', 'SYNTHETIC_OWNER_BETA', 'PRIVATE_RAW', 'stdout', 'stack', 'credential', 'secret/path']) assert(!json.includes(secret), json);
}

test('import/default/plan and incomplete or broad retry flags are inert', async () => {
  let calls = 0; const capabilities = { log: () => {}, fetchImpl: () => { calls++; throw Error(); }, createProvider: () => { calls++; throw Error(); } };
  assert.equal(await main([], capabilities), 0); assert.equal(await main(['--plan'], capabilities), 0);
  for (const args of [['--apply'], ['--apply-approved-update'], ['--apply-approved-recovery'], ['--apply-approved-recovery', '--players-stopped'],
    ['--reset'], ['--resume'], ['--retry'], ['--home', '/tmp'], ['--apply-approved-recovery', '--players-stopped', '--exclusive-maintenance', '--retry']]) assert.equal(await main(args, capabilities), 1);
  assert.equal(calls, 0);
  const owner = fileURLToPath(new URL('../scripts/floating-garden-active-update-recover-owner.mjs', import.meta.url));
  const script = join(directory, 'recovery-lifecycle.mjs');
  await writeFile(script, `globalThis.fetch=()=>{throw Error('NO NETWORK')}; setInterval(() => {}, 100000); process.argv[1]=${JSON.stringify(owner)}; await import(${JSON.stringify(pathToFileURL(owner).href)});`);
  assert.match(execFileSync(process.execPath, [script, '--plan'], { encoding: 'utf8', timeout: 3000 }), /^RECOVERY_PLAN_ONLY:/);
});
test('pure verifier returns cached brands and performs no provider construction, SDK import or Cloud I/O', async t => {
  const h = await recoveryFixture(t), before = await snapshot(h.home);
  const context = await loadVerifiedFailedUpdateContext(h.args);
  assert.equal(context.active, h.active); assert.equal(context.adapter, h.adapter);
  assert.equal(context.active.activeUpdatePackets(context.plan).next.packet.output, join(h.target, 'operation'));
  assert.equal(await context.recheck(), true); assert.deepEqual(h.calls, []); assert.deepEqual(await snapshot(h.home), before);
});
test('one provider, exactly one core baseline, separate durable journal and old bytes unchanged', async t => {
  const h = await recoveryFixture(t), syncs = [];
  const result = await retainedUnchanged(h, () => h.recover({ sync: async (file, event) => { syncs.push(event); await file.sync(); } }));
  assert.equal(result.status, 'active-updated', JSON.stringify(result)); assert.equal(h.constructions(), 1); assert.equal(h.inspections(), 1);
  assert.deepEqual(h.writes, ['pause', 'functions', 'rules', 'hosting', 'reopen']); assert.equal(h.requests.length, 1);
  assert.deepEqual(syncs.slice(0, 5).map(e => e.kind), ['guard-parent', 'marker-file', 'marker-directory', 'verifier-file', 'verifier-directory']);
  const entries = await rows(h); assert.equal(entries[0].event, 'created'); assert.equal(entries.at(-1).event, 'finished');
  assert.equal(entries[0].priorJournalDigest, hash(await readFile(h.journal))); assert.equal(entries[0].oldManifestDigest, h.plan.oldManifestDigest);
  assert.equal(entries[0].newManifestDigest, h.plan.newManifestDigest);
  assert.equal((await lstat(h.recoveryGuard)).mode & 0o777, 0o700); assert.equal((await lstat(h.recoveryJournal)).mode & 0o777, 0o600);
  assert.equal(result.endsAtMillis, END); assert.equal(result.maxRooms, 20); assert.equal(result.usageWritten, false); privateOutputAbsent([result, h.logs, entries]);
  assert.equal((await h.recover()).stage, 'one-shot-guard'); assert.equal(h.requests.length, 1); assert.equal(h.constructions(), 1);
});
test('concurrent, second and interrupted attempts cannot reuse or clear the guard', async t => {
  const h = await recoveryFixture(t), values = await Promise.all([h.recover(), h.recover()]);
  assert.equal(values.filter(v => v.status === 'active-updated').length, 1); assert.equal(values.filter(v => v.stage === 'one-shot-guard').length, 1);
  assert.equal(h.constructions(), 1); assert.equal(h.inspections(), 1);
  const interrupted = await recoveryFixture(t); await mkdir(interrupted.recoveryGuard, { mode: 0o700 });
  assert.equal((await interrupted.recover()).stage, 'one-shot-guard'); assert.equal(interrupted.requests.length, 0);
  assert.deepEqual(await readdir(interrupted.recoveryGuard), []);
});
test('unsafe approval/environment/window/owner paths and unpublished pins fail before admission', async t => {
  const h = await recoveryFixture(t);
  for (const overrides of [{ renewedApproval: false }, { playersStopped: false }, { exclusiveMaintenance: false }, { now: () => END },
    { env: { HTTPS_PROXY: 'PRIVATE_RAW' } }, { env: { GOOGLE_APPLICATION_CREDENTIALS: '/secret/path' } }, { execArgv: ['--import', '/secret/path'] },
    { verifierPin: { commit: 'UNPUBLISHED', sha256: 'UNPUBLISHED' } }]) {
    assert.equal((await h.recover(overrides)).stage, 'owner-paths');
  }
  assert.equal(h.requests.length, 0); assert.equal(h.constructions(), 0); await assert.rejects(lstat(h.recoveryGuard), e => e.code === 'ENOENT');
});
test('unverified, redirected or foreign verifier bytes never import and consume the one-shot guard', async t => {
  for (const issue of ['bytes', 'redirect', 'url']) {
    const h = await recoveryFixture(t);
    const value = await retainedUnchanged(h, () => h.recover({ fetchImpl: async (url, options) => {
      if (issue === 'bytes') { const r = new Response('globalThis.UNVERIFIED_RECOVERY=true;'); Object.defineProperty(r, 'url', { value: url }); return r; }
      const r = await h.args.fetchImpl(url, options);
      if (issue === 'redirect') Object.defineProperty(r, 'redirected', { value: true });
      else return new Proxy(r, { get(target, key) { if (key === 'url') return 'https://foreign.invalid/'; return Reflect.get(target, key, target); } });
      return r;
    } }));
    assert.equal(value.stage, 'verifier-download'); assert.equal(h.constructions(), 0); assert.equal(globalThis.UNVERIFIED_RECOVERY, undefined);
    assert.equal((await h.recover()).stage, 'one-shot-guard');
  }
});
test('exact prior terminal pre-pause proof only: malformed or mutation-bearing journals rejected', async t => {
  const changes = [e => [], e => [e[0]], e => [...e, e[1]], e => [e[1], e[0]],
    e => [e[0], { ...e[1], event: 'issued', stage: 'pause-cas' }], e => [e[0], { ...e[1], event: 'provider-issued' }],
    e => [e[0], { ...e[1], stage: 'pause-cas' }], e => [e[0], { ...e[1], reason: 'provider-read' }],
    e => [e[0], { ...e[1], access: 'closed' }], e => [{ ...e[0], newManifestDigest: '0'.repeat(64) }, e[1]]];
  for (const change of changes) {
    const h = await recoveryFixture(t); await writeFile(h.journal, change(h.entries).map(e => JSON.stringify(e) + '\n').join(''));
    const value = await retainedUnchanged(h, () => h.recover()); assert.equal(value.stage, 'journal-verification'); assert.equal(h.constructions(), 0); assert.deepEqual(h.writes, []);
  }
});
test('changed admission counts stop after one baseline, before pause, without a retry', async t => {
  for (const changes of [{ createdRoomCount: 3 }, { roomCount: 1 }, { documentCount: 10001 }]) {
    const h = await recoveryFixture(t); h.setHook(method => method === 'inspect' ? { kind: 'baseline', fingerprint: 'a'.repeat(64), createdRoomCount: 2, roomCount: 2, documentCount: 158, ...changes } : undefined);
    const value = await retainedUnchanged(h, () => h.recover()); assert.equal(value.stage, 'read-only-baseline'); assert.equal(value.reason, 'admin-state');
    assert.equal(h.inspections(), 1); assert.deepEqual(h.writes, []); assert.equal((await h.recover()).stage, 'one-shot-guard');
  }
});
test('raw first-operation diagnosis survives secondary access and journal failures without private text', async t => {
  const h = await recoveryFixture(t);
  h.setHook(method => { if (method === 'inspect') throw Object.assign(Error('PRIVATE_RAW'), { code: 14, details: 'PRIVATE_RAW' });
    if (method === 'readAccess') throw RangeError('PRIVATE_RAW'); });
  const value = await retainedUnchanged(h, () => h.recover());
  assert.deepEqual(value.operationFailure, { method: 'inspect', classification: { kind: 'grpc', code: 14, name: 'UNAVAILABLE' } });
  assert.deepEqual(value.accessFailure, { method: 'readAccess', classification: { kind: 'error-class', name: 'RangeError' } });
  assert.equal(value.access, 'unknown'); assert.deepEqual((await rows(h)).at(-1).operationFailure, value.operationFailure);
  privateOutputAbsent([value, h.logs, await rows(h)]); assert.deepEqual(h.writes, []);
  const j = await recoveryFixture(t); j.setHook(method => { if (method === 'inspect') throw TypeError('PRIVATE_RAW'); });
  const other = await j.recover({ sync: async (file, event) => { if (event.event === 'blocked') throw Error('PRIVATE_RAW'); await file.sync(); } });
  assert.equal(other.operationFailure.classification.name, 'TypeError'); assert.equal(other.journalFailure.method, 'append'); privateOutputAbsent([other, j.logs]);
});
test('unknown pause/reopen reconcile read-only once and never retry or roll back', async t => {
  for (const method of ['pause', 'reopen']) for (const access of ['open', 'closed', 'unknown']) {
    const h = await recoveryFixture(t);
    h.setHook(name => { if (name === method) { h.writes.push(method); return { kind: 'unknown' }; } if (name === 'readAccess') return { access }; });
    const value = await retainedUnchanged(h, () => h.recover());
    assert.equal(value.status, 'blocked'); assert.equal(value.reason, 'mutation-unknown'); assert.equal(value.access, access);
    assert.equal(h.calls.filter(name => name === method).length, 1); assert.equal(h.calls.filter(name => name === 'readAccess').length, 1);
    assert.equal(value.automaticRetry, false); assert.equal(value.automaticRollback, false); assert.equal(value.operationFailure, undefined); assert.equal((await h.recover()).stage, 'one-shot-guard');
  }
});
test('retained evidence changed during baseline/provider/reopen verification blocks the next write or success row', async t => {
  for (const during of ['inspect', 'updateFunctions', 'verifyReopened']) {
    const h = await recoveryFixture(t);
    h.setHook(async method => { if (method === during) await writeFile(h.executionPath, (await readFile(h.executionPath)) + ' '); });
    const value = await h.recover(); assert.equal(value.status, 'blocked');
    if (during === 'inspect') assert.deepEqual(h.writes, []);
    if (during === 'updateFunctions') assert.deepEqual(h.writes, ['pause']);
    if (during === 'verifyReopened') { assert.equal(value.stage, 'verify-reopened'); assert.deepEqual(h.writes, ['pause', 'functions', 'rules', 'hosting', 'reopen']); }
    assert.equal((await rows(h)).some(row => row.event === 'finished'), false);
  }
});
test('parent/marker/journal sync failure prevents the next mutation and retains guard/evidence', async t => {
  for (const point of ['guard-parent', 'marker-file', 'marker-directory', 'journal-directory', 'created', 'pause-cas', 'provider-issued', 'finished']) {
    const h = await recoveryFixture(t), value = await retainedUnchanged(h, () => h.recover({ sync: async (file, event) => {
      if (event.kind === point || event.event === point || event.event === 'issued' && event.stage === point) throw Error('PRIVATE_RAW sync failure'); await file.sync();
    } }));
    assert.equal(value.status, 'blocked', point);
    if (point === 'provider-issued') assert.deepEqual(h.writes, ['pause']);
    else if (point !== 'finished') assert.deepEqual(h.writes, []);
    assert.equal((await h.recover()).stage, 'one-shot-guard'); privateOutputAbsent([value, h.logs]);
  }
});
test('recovery journal tampering prevents the next issued provider write', async t => {
  const h = await recoveryFixture(t);
  h.setHook(async method => { if (method === 'updateFunctions') await writeFile(h.recoveryJournal, 'PRIVATE_RAW'); });
  const value = await h.recover(); assert.equal(value.status, 'blocked'); assert.deepEqual(h.writes, ['pause']); assert(value.journalFailure); privateOutputAbsent([value, h.logs]);
});
test('actual pinned provider and actual HTTP transport preserve all old bytes with multiple Hosting uploads', async t => {
  const h = await recoveryFixture(t);
  ({ createActiveUpdateProvider } = await import(pathToFileURL(join(h.source, 'scripts/floating-garden-active-update-provider.mjs'))));
  plan = h.plan; ({ old: oldPacket, next: newPacket } = h.active.activeUpdatePackets(plan));
  const p = await harness({ ownerTooling: h.tooling });
  const beforeData = p.db.entries(), value = await retainedUnchanged(h, () => h.recover({ createProvider: p.createProvider }));
  assert.equal(value.status, 'active-updated', JSON.stringify(value)); assert.equal(p.constructions(), 1);
  const entries = await rows(h), uploads = entries.filter(e => e.event === 'provider-issued' && e.stage === 'hosting-file-upload');
  assert(uploads.length > 1, JSON.stringify(entries)); assert(uploads.every(e => e.resourceKind === 'hosting' && e.index === 0));
  assert.equal(p.calls.filter(c => c.url?.startsWith('https://upload-firebasehosting.googleapis.com/')).length, uploads.length);
  assert.deepEqual(p.db.entries(), beforeData); assert.equal(p.db.writes.length, 6);
  assert(p.db.writes.every(w => w.path === 'floatingGardenTrial/config' || w.path.startsWith('floatingGardenTrialTesters/')));
  assert.deepEqual(p.db.attempts.slice(0, 3), [{ readOnly: true }, { readOnly: true }, { maxAttempts: 1 }]);
  assert.equal(p.db.attempts.filter(a => a.maxAttempts === 1).length, 2); privateOutputAbsent([value, h.logs, entries]);
});
test('actual pinned provider raw Firestore and legacy adapter baseline failures stay safely classified', async t => {
  for (const fault of ['http', 'adapter', 'firestore']) {
    const h = await recoveryFixture(t);
    ({ createActiveUpdateProvider } = await import(pathToFileURL(join(h.source, 'scripts/floating-garden-active-update-provider.mjs'))));
    plan = h.plan; ({ old: oldPacket, next: newPacket } = h.active.activeUpdatePackets(plan));
    const p = await harness({ ownerTooling: h.tooling });
    p.setOverride((url, data) => {
      if (url.startsWith('https://cloudfunctions.googleapis.com/') && !url.includes(':getIamPolicy')) {
        if (fault === 'adapter') return { ...data, functions: [] };
        if (fault === 'http') throw Object.assign(Error('PRIVATE_RAW'), { response: { status: 403, data: 'PRIVATE_RAW' } });
      }
      return data;
    });
    if (fault === 'firestore') p.db.runTransaction = async () => { throw Object.assign(Error('PRIVATE_RAW'), { code: 14 }); };
    const value = await retainedUnchanged(h, () => h.recover({ createProvider: p.createProvider }));
    const expected = fault === 'firestore' ? { kind: 'grpc', code: 14, name: 'UNAVAILABLE' } : fault === 'http'
      ? { kind: 'legacy-adapter', reason: 'metadata-http', httpStatus: 403 } : { kind: 'legacy-adapter', reason: 'function-inventory' };
    assert.deepEqual(value.operationFailure, { method: 'inspect', classification: expected }); assert.equal(value.stage, 'read-only-baseline');
    assert.equal(p.providerWrites.length, 0); assert.equal(p.db.writes.length, 0); privateOutputAbsent([value, h.logs, await rows(h)]);
  }
});
test('actual pinned CAS unknown outcomes are not retried or reconstructed from swallowed errors', async t => {
  for (const at of [1, 2]) {
    const h = await recoveryFixture(t);
    ({ createActiveUpdateProvider } = await import(pathToFileURL(join(h.source, 'scripts/floating-garden-active-update-provider.mjs'))));
    plan = h.plan; ({ old: oldPacket, next: newPacket } = h.active.activeUpdatePackets(plan));
    const p = await harness({ ownerTooling: h.tooling }); let writes = 0;
    p.db.setFault(({ phase }) => { if (phase === 'after' && ++writes === at) throw Object.assign(Error('PRIVATE_RAW swallowed CAS detail'), { code: 14 }); });
    const value = await retainedUnchanged(h, () => h.recover({ createProvider: p.createProvider }));
    assert.equal(value.status, 'blocked'); assert.equal(value.reason, 'mutation-unknown'); assert.equal(value.stage, at === 1 ? 'pause-cas' : 'reopen-cas');
    assert.equal(value.access, at === 1 ? 'closed' : 'open'); assert.equal(p.db.attempts.filter(a => a.maxAttempts === 1).length, at);
    assert.equal(value.operationFailure, undefined, 'CAS already consumed its error; the wrapper must not fabricate its detail');
    assert.equal((await h.recover()).stage, 'one-shot-guard'); privateOutputAbsent([value, h.logs, await rows(h)]);
  }
});
test('a symlink at the fixed recovery admission path is refused without following it', async t => {
  const h = await recoveryFixture(t), foreign = await mkdtemp(join(directory, 'foreign-recovery-'));
  await symlink(foreign, h.recoveryGuard, 'dir');
  assert.equal((await h.recover()).stage, 'one-shot-guard'); assert.equal(h.requests.length, 0); assert.equal(h.constructions(), 0);
  assert.deepEqual(await readdir(foreign), []);
});

test('durable terminal success survives only a close cleanup failure without reconciliation or retry', async t => {
  const h = await recoveryFixture(t); let closes = 0;
  const value = await retainedUnchanged(h, () => h.recover({ closeJournal: async (file, event) => {
    closes++; assert.equal(event.event, 'finished'); await file.close();
    throw Object.assign(Error('PRIVATE_RAW close cleanup failure'), { code: 'EPIPE' });
  } }));
  assert.equal(value.status, 'active-updated'); assert.equal(value.access, 'open'); assert.equal(closes, 1);
  assert.deepEqual(value.cleanupWarning, { method: 'journal-close-after-success', classification: { kind: 'system-code', code: 'EPIPE' } });
  assert.equal(value.journalFailure, undefined); assert.equal(value.operationFailure, undefined);
  const entries = await rows(h); assert.equal(entries.filter(e => e.event === 'finished').length, 1);
  assert.equal(entries.filter(e => e.event === 'blocked').length, 0); assert.equal(entries.at(-1).status, 'active-updated');
  assert.equal(h.calls.filter(m => m === 'readAccess').length, 0); assert.equal(h.inspections(), 1); assert.equal(h.constructions(), 1);
  assert.equal(value.automaticRetry, false); assert.equal(value.automaticRollback, false);
  assert.deepEqual(h.writes, ['pause', 'functions', 'rules', 'hosting', 'reopen']);
  assert.equal((await h.recover()).stage, 'one-shot-guard'); assert.equal(closes, 1);
  privateOutputAbsent([value, h.logs, entries]);
});

// Actual old/new generators and actual provider adapters; all SDK/HTTP/CLI I/O
// below is local injected evidence. No ADC, Cloud API, or deployment is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { prepareTrialOperation } from '../scripts/prepare-floating-garden-trial-operation.mjs';
import { readOperationPacket } from '../scripts/operate-floating-garden-trial.mjs';
import { FUNCTION_NAMES } from '../scripts/prepare-floating-garden-trial.mjs';
import { REGION, RUNTIME_ACCOUNT, FIRESTORE_CLIENT_CONFIG } from '../scripts/floating-garden-trial-cloud-adapter.mjs';
import { ACTIVE_UPDATE_SCOPE as S, prepareActiveUpdatePlan, activeUpdatePackets, recheckActiveUpdatePlan,
  assertActiveRecords, toggleActiveRecords, assertPreservedRecords, activeUpdateReason,
  executeActiveUpdate, createActiveUpdateJournal, proveOldInvocationIsolation, main, canonicalData } from '../scripts/floating-garden-active-update.mjs';
import { createActiveUpdateTransport } from '../scripts/floating-garden-active-update-transport.mjs';
import { createActiveUpdateProvider, stableFunctionConfiguration, stableArtifactRepositories } from '../scripts/floating-garden-active-update-provider.mjs';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url), archiver = require('archiver');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const NOW = S.startsAtMillis + 10000;
const review = { schemaVersion: 1, startsAtMillis: S.startsAtMillis, endsAtMillis: S.endsAtMillis,
  testerUids: ['SYNTHETIC_ACTIVE_A', 'SYNTHETIC_ACTIVE_B'], retainBuildArtifacts: false,
  allowInitialFunctionRecreate: false, approvePublicInvoker: false };
let directory, oldRoot, oldPacket, newPacket, plan;
test.before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'garden-active-update-test-'));
  oldRoot = join(directory, 'previous-source'); await mkdir(oldRoot);
  const archive = execFileSync('git', ['archive', S.oldCommit, 'package.json', 'lab/floating-garden',
    'functions/floating-garden-online', 'functions/floating-garden-trial',
    'scripts/prepare-floating-garden-trial.mjs', 'scripts/prepare-floating-garden-trial-operation.mjs'], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', oldRoot], { input: archive });
  const previousGenerator = await import(pathToFileURL(join(oldRoot, 'scripts/prepare-floating-garden-trial-operation.mjs')));
  await previousGenerator.prepareTrialOperation({ review, output: join(directory, 'previous'), now: NOW, repositoryRoot: oldRoot });
  await prepareTrialOperation({ review, output: join(directory, 'next'), now: NOW });
  oldPacket = await readOperationPacket(join(directory, 'previous'));
  newPacket = await readOperationPacket(join(directory, 'next'));
  plan = await prepareActiveUpdatePlan({ previousOutput: oldPacket.packet.output, nextOutput: newPacket.packet.output });
});
test.after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
const approval = () => ({ oldManifestDigest: plan.oldManifestDigest, newManifestDigest: plan.newManifestDigest,
  pauseExistingPair: true, updateFiveFunctionSources: true, updateDedicatedRules: true, updateExactHosting: true,
  reopenExistingPair: true, retainAllData: true, preserveExistingIam: true, exclusiveMaintenance: true });
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
async function harness({ actualTransport = false, actualBridge = false, database, iamPolicy } = {}) {
  const legacy = await legacyData(), { first, second } = legacy; const db = database || legacy.db;
  if (database) {
    const batch = database.batch();
    for (const [path, data] of legacy.db.entries()) batch.set(database.doc(path), data);
    await batch.commit();
  }
  const path = await mkdtemp(join(directory, 'provider-')), toolingDir = join(path, 'tooling');
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
      else if (args.includes('get-iam-policy')) result = iamPolicy
        ? iamPolicy(args[0] === 'iam' ? 'runtime' : args[0] === 'secrets' ? 'secret' : 'project', policy()) : policy();
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
  let transport = {
    async functions({ beforeMutation }) { await beforeMutation({ stage: 'functions-patch', resourceKind: 'function', index: 0 }); providerWrites.push('functions'); functions.splice(0, 5, ...FUNCTION_NAMES.map((_, i) => metadata(i, '124'))); return { kind: 'success' }; },
    async rules({ beforeMutation }) { await beforeMutation({ stage: 'rules-patch', resourceKind: 'rules', index: 0 }); providerWrites.push('rules'); rulesPhase = 'new'; return { kind: 'success' }; },
    async hosting({ beforeMutation }) { await beforeMutation({ stage: 'hosting-release', resourceKind: 'hosting', index: 0 }); providerWrites.push('hosting'); hostingPhase = 'new'; return { kind: 'success' }; },
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
          path: '/'+path.slice(12), hash: sha(gzipSync(await readFile(join(newPacket.packet.output, path)), { level: 9 })), status: 'ACTIVE',
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
      else if (url.endsWith(':populateFiles')) body = { uploadRequiredHashes: [], uploadUrl: `https://upload-firebasehosting.googleapis.com/upload/sites/${S.project}/versions/new/files` };
      else if (url.endsWith('?updateMask=status')) { hostingFinalized = true; body = { name: `sites/${S.project}/versions/new`, status: 'FINALIZED' }; }
      else if (url.includes('/releases?versionName=')) { hostingPhase = 'new'; body = { name: `sites/${S.project}/releases/new`, version: { name: `sites/${S.project}/versions/new` }, message: `garden-trial-game-v1:${newPacket.packet.manifestDigest}` }; }
      else assert.fail('Unexpected synthetic transport operation');
    }
    return { status: 200, body, headers: { 'x-goog-generation': '456' } };
  };
  if (actualTransport) transport = createActiveUpdateTransport({ now: () => time, wait: async millis => { time += millis; }, request: transportRequest });
  let providerFetch = fetchImpl;
  if (actualBridge) {
    transport = undefined; const readClient = requestClient;
    requestClient = { request: async options => {
      if (options.responseType !== 'arraybuffer' || options.method === 'GET' && options.url.includes('storage.googleapis.com')) return readClient.request(options);
      const result = await transportRequest({ ...options, body: options.data, auth: 'google' });
      return { status: result.status, data: Buffer.from(JSON.stringify(result.body)), headers: result.headers };
    } };
    providerFetch = async (url, options) => {
      if (!url.startsWith('https://storage.googleapis.com/')) return fetchImpl(url, options);
      const result = await transportRequest({ url, ...options, auth: 'none' });
      return new Response(result.body, { status: result.status, headers: result.headers });
    };
  }
  const cloud = createActiveUpdateProvider({ plan, toolingDir, runner, requestClient, db, fetchImpl: providerFetch, now: () => time, env: {}, execArgv: [], transport, recordStep: async step => journalEntries.push(step) });
  const journal = { providerStep: async step => journalEntries.push(step), issued: async stage => journalEntries.push({ issued: stage }), verified: async stage => journalEntries.push({ verified: stage }),
    finish: async () => journalEntries.push({ finished: true }), fail: async (stage, reason, access) => journalEntries.push({ stage, reason, access }) };
  return { cloud, db, first, second, calls, functions, transport, providerWrites, journal, journalEntries,
    setTime(value) { time = value; }, changeSettings() { settingsRevision++; }, setOverride(value) { override = value; },
    run: options => executeActiveUpdate({ plan, mode: 'apply', approval: approval(), cloud, journal, now: () => time, ...options }) };
}

test('actual generator packets pin the full first-NPC delta and keep all approvals false', async () => {
  assert.equal(Object.keys(oldPacket.packet.manifest.files).length, 43); assert.equal(Object.keys(newPacket.packet.manifest.files).length, 44);
  assert.equal(plan.added.length, 1); assert.equal(plan.changed.length, 8); assert.equal(plan.unchangedFileCount, 35);
  assert.deepEqual(activeUpdatePackets(plan).next.review, review);
  assert.equal(JSON.stringify(plan).includes(review.testerUids[0]), false);
  assert.equal(await recheckActiveUpdatePlan(plan), true);
});
test('default CLI and mode are plan-only; apply flag cannot invoke providers', async () => {
  const logs = []; assert.equal(await main([], { log: v => logs.push(v) }), 0);
  assert.equal(await main(['--apply'], { log: v => logs.push(v) }), 1);
  assert.equal(await executeActiveUpdate({ plan }), plan);
  await assert.rejects(executeActiveUpdate({ plan, mode: 'apply', approval: review }), e => activeUpdateReason(e) === 'approval-required');
});
test('actual provider read-only inspection verifies both legacy rooms and all five archive/config/IAM proofs', async () => {
  const h = await harness(), result = await h.cloud.inspect();
  assert.equal(result.kind, 'baseline'); assert.equal(result.createdRoomCount, 2); assert.equal(result.roomCount, 2);
  assert(result.documentCount > 10); assert.equal(h.db.writes.length, 0); assert.equal(h.providerWrites.length, 0);
  assert(h.calls.some(c => c.url?.includes('&alt=media'))); assert(h.calls.some(c => c.url?.includes(':getIamPolicy')));
  assert(h.calls.every(c => !c.args?.includes('deploy')));
});
test('documented etag-only runtime policy passes real read-only provider inspection without writes', async () => {
  const h = await harness({ iamPolicy: (name, value) => name === 'runtime' ? { etag: 'BwWKmjvelug=' } : value });
  const result = await h.cloud.inspect();
  assert.equal(result.kind, 'baseline'); assert.equal(result.createdRoomCount, 2);
  assert.equal(h.db.writes.length, 0); assert.equal(h.providerWrites.length, 0); assert.equal(h.journalEntries.length, 0);
});
test('empty-runtime exception rejects malformed and broader shapes and never applies to project or secret', async () => {
  for (const value of [null, [], false, 'invalid', {}, { etag: '' }, { etag: 1 }, { etag: null },
    { etag: 'not base64!' }, { etag: 'BwWKmjvelug' }, { etag: 'AB==' }, { etag: 'BwWKmjvelug=', error: {} },
    { etag: 'BwWKmjvelug=', version: 1 }, { etag: 'BwWKmjvelug=', bindings: null }, { bindings: {} }]) {
    const h = await harness({ iamPolicy: (name, original) => name === 'runtime' ? value : original });
    await assert.rejects(h.cloud.inspect(), error => activeUpdateReason(error) === 'iam-preservation');
    assert.equal(h.db.writes.length, 0); assert.equal(h.providerWrites.length, 0); assert.equal(h.journalEntries.length, 0);
  }
  for (const target of ['project', 'secret']) {
    const h = await harness({ iamPolicy: (name, value) => name === target ? { etag: 'BwWKmjvelug=' } : value });
    await assert.rejects(h.cloud.inspect(), error => activeUpdateReason(error) === 'iam-preservation');
    assert.equal(h.db.writes.length, 0); assert.equal(h.providerWrites.length, 0); assert.equal(h.journalEntries.length, 0);
  }
});
test('etag-only runtime metadata remains in exact baseline and pre-pause preservation comparisons', async () => {
  let reads = 0;
  const h = await harness({ iamPolicy: (name, value) => name === 'runtime'
    ? { etag: ++reads > 1 ? 'BwWKmjveluk=' : 'BwWKmjvelug=' } : value });
  await assert.rejects(h.cloud.inspect(), error => activeUpdateReason(error) === 'provider-drift');
  assert.equal(h.db.writes.length, 0); assert.equal(h.providerWrites.length, 0);
  reads = 0;
  const next = await harness({ iamPolicy: (name, value) => name === 'runtime'
    ? { etag: ++reads > 2 ? 'BwWKmjveluk=' : 'BwWKmjvelug=' } : value });
  const result = await next.run(); assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'iam-preservation');
  assert.equal(result.access, 'open'); assert.equal(next.db.writes.length, 0); assert.equal(next.providerWrites.length, 0);
});
test('full real-adapter staged path preserves nonzero usage, original data, dates, roster and extra fields', async () => {
  const h = await harness(), before = h.db.entries(); const result = await h.run();
  assert.equal(result.status, 'active-updated', JSON.stringify(result)); assert.deepEqual(h.providerWrites, ['functions', 'rules', 'hosting']);
  assert.deepEqual(h.db.entries(), before); assert.equal(h.db.get('floatingGardenTrial/usage').createdRoomCount, 2);
  assert(h.db.writes.every(w => w.kind === 'update' && (w.path === 'floatingGardenTrial/config' || w.path.startsWith('floatingGardenTrialTesters/'))));
  assert.equal(h.db.writes.length, 6); assert(h.db.attempts.filter(a => !a.readOnly).every(a => a.maxAttempts === 1));
  assert.equal(result.oldInvocationsDrained, false); assert.equal(result.oldInvocationsIsolatedBySourceFence, true);
});
test('complete IAM/config comparisons preserve audit config, conditional binding and environment', async () => {
  const h = await harness(); h.setOverride((url, value) => url.includes(':getIamPolicy') && h.providerWrites.length ? { ...value, auditConfigs: [] } : value);
  const result = await h.run(); assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'iam-preservation'); assert.equal(result.access, 'closed');
  assert.deepEqual(h.providerWrites, ['functions']);
});
test('source archive mismatch stops before pause', async () => {
  const h = await harness(); h.setOverride((url, value) => url.includes('&alt=media') ? Buffer.from('invalid synthetic archive') : value);
  const result = await h.run(); assert.equal(result.status, 'blocked'); assert.equal(h.db.writes.length, 0); assert.equal(h.providerWrites.length, 0);
});
test('changed initial baseline and expired trial stop before admin/provider mutation', async () => {
  const h = await harness(); h.setTime(S.endsAtMillis); assert.equal((await h.run()).status, 'blocked'); assert.equal(h.db.writes.length, 0);
  const other = await harness(); other.db.set('floatingGardenTrial/usage', { ...other.db.get('floatingGardenTrial/usage'), createdRoomCount: 0 });
  assert.equal((await other.run()).status, 'blocked'); assert.equal(other.db.writes.length, 0);
});
test('pause CAS includes nonzero usage and all data, races never retry', async () => {
  const h = await harness(); let count = 0;
  h.db.setFault(({ phase, pending, db }) => { if (phase === 'before' && pending[0].data.enabled === false && count++ === 0) db.set('floatingGardenTrial/usage', { ...db.get('floatingGardenTrial/usage'), createdRoomCount: 3 }); });
  const result = await h.run(); assert.equal(result.status, 'blocked'); assert.equal(h.providerWrites.length, 0); assert.equal(h.db.writes.length, 0);
  assert.equal(h.db.attempts.filter(a => a.maxAttempts === 1).length, 1);
});
test('uncertain pause stays closed, records stage, and never deploys or retries', async () => {
  const h = await harness(); h.db.setFault(({ phase }) => { if (phase === 'after') throw Error('SYNTHETIC_PRIVATE_TOKEN'); });
  const result = await h.run(); assert.equal(result.status, 'blocked'); assert.equal(result.stage, 'pause-cas'); assert.equal(result.access, 'closed');
  assert.equal(h.providerWrites.length, 0); assert.equal(h.db.writes.length, 3); assert(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_TOKEN'));
});
test('each uncertain provider stage is single-attempt, retains closed access, and forbids downstream work', async () => {
  for (const kind of ['functions', 'rules', 'hosting']) {
    const h = await harness(), original = h.transport[kind]; let attempts = 0;
    h.transport[kind] = async args => { attempts++; await original(args); return { kind: 'unknown', reason: 'PRIVATE_SENTINEL' }; };
    const result = await h.run(); assert.equal(result.status, 'blocked'); assert.equal(result.access, 'closed'); assert.equal(attempts, 1);
    assert.equal(h.providerWrites.at(-1), kind); assert.equal(h.db.writes.length, 3);
    await assert.rejects(h.cloud[`update${kind[0].toUpperCase()}${kind.slice(1)}`]()); assert.equal(attempts, 1);
  }
});
test('uncertain reopening is never reported closed or retried', async () => {
  const h = await harness(); h.db.setFault(({ phase, pending }) => { if (phase === 'after' && pending[0].data.enabled === true) throw Error('synthetic lost commit response'); });
  const result = await h.run(); assert.equal(result.status, 'blocked'); assert.equal(result.stage, 'reopen-cas'); assert.equal(result.access, 'open');
  assert.equal(h.db.writes.length, 6); await assert.rejects(h.cloud.reopen()); assert.equal(h.db.writes.length, 6);
});
test('late compatible old create usage increase after reopen is not reset or misclassified', async () => {
  const h = await harness(); h.db.setFault(({ phase, pending, db }) => {
    if (phase === 'after' && pending[0].data.enabled === true) db.set('floatingGardenTrial/usage', { ...db.get('floatingGardenTrial/usage'), createdRoomCount: 3 });
  });
  const result = await h.run(); assert.equal(result.status, 'active-updated', JSON.stringify(result));
  assert.equal(h.db.get('floatingGardenTrial/usage').createdRoomCount, 3); assert(h.db.writes.every(w => w.path !== 'floatingGardenTrial/usage'));
});
test('settings drift and data change while closed block reopening', async () => {
  const h = await harness(), original = h.transport.rules;
  h.transport.rules = async args => { const result = await original(args); h.changeSettings(); return result; };
  const result = await h.run(); assert.equal(result.status, 'blocked'); assert.equal(result.access, 'closed'); assert.equal(h.db.writes.length, 3);
  const other = await harness(), hosting = other.transport.hosting;
  other.transport.hosting = async args => { const result = await hosting(args); const path = `floatingGardenRooms/${other.first.roomId}`; other.db.set(path, { ...other.db.get(path), revision: 2 }); return result; };
  assert.equal((await other.run()).status, 'blocked'); assert.equal(other.db.writes.length, 3);
});
test('durable journal is private, one-shot and sanitized', async () => {
  const journal = await createActiveUpdateJournal({ plan, now: () => NOW });
  await journal.issued('pause-cas'); await journal.verified('pause-cas'); await journal.fail('pause-cas', 'SYNTHETIC_PRIVATE_TOKEN', 'closed');
  const text = await readFile(join(newPacket.packet.output, 'ACTIVE-UPDATE-JOURNAL.jsonl'), 'utf8');
  assert(!text.includes('SYNTHETIC_PRIVATE_TOKEN')); assert(!text.includes(review.testerUids[0]));
  await assert.rejects(createActiveUpdateJournal({ plan, now: () => NOW }));
});

 test('canonical preservation hashing cannot confuse Timestamp, map, array or number tags', () => {
  class Timestamp { constructor(seconds, nanoseconds) { this._seconds = seconds; this._nanoseconds = nanoseconds; } toMillis() { return 0; } toDate() { return new Date(0); } }
  const timestamp = new Timestamp(123, 456);
  const inputs = [timestamp, { $timestamp: [123, 456] }, ['timestamp', 123, 456], { _seconds: 123, _nanoseconds: 456 }, null, 'null', 0, -0, { $number: '-0' }];
  assert.equal(new Set(inputs.map(canonicalData)).size, inputs.length);
  assert.notEqual(canonicalData(timestamp), canonicalData(new Timestamp(123, 457)));
  assert.throws(() => canonicalData(new Proxy({}, {})));
 });

 test('Artifact storage growth is allowed while cleanup, KMS, identity and configuration remain exact', () => {
  const original = [{ name: 'synthetic-repo', createTime: '2026-10-01T00:00:00Z', updateTime: '2026-10-01T00:00:00Z', sizeBytes: '1',
    mode: 'STANDARD_REPOSITORY', kmsKeyName: 'preserved-key', cleanupPolicyDryRun: true, cleanupPolicies: { keep: { action: 'KEEP' } } }];
  const larger = clone(original); larger[0].sizeBytes = '1000'; larger[0].updateTime = '2026-10-05T00:00:00Z';
  assert.deepEqual(stableArtifactRepositories(original), stableArtifactRepositories(larger));
  for (const key of ['createTime', 'name', 'kmsKeyName', 'mode', 'cleanupPolicyDryRun', 'cleanupPolicies']) {
    const changed = clone(larger); changed[0][key] = 'changed'; assert.notDeepEqual(stableArtifactRepositories(original), stableArtifactRepositories(changed));
  }
 });

 test('actual source-only transport executes through real provider proofs and CAS with injected HTTP only', async () => {
  const h = await harness({ actualTransport: true }); const before = h.db.entries();
  const result = await h.run(); assert.equal(result.status, 'active-updated', JSON.stringify(result)); assert.deepEqual(h.db.entries(), before);
  const patches = h.calls.filter(call => call.method === 'PATCH' && call.url?.includes('cloudfunctions.googleapis.com'));
  assert.equal(patches.length, 5); assert(patches.every(call => call.url.endsWith('?updateMask=buildConfig.source')));
  assert(h.calls.every(call => call.method !== 'DELETE'));
  assert.equal(h.db.writes.length, 6);
 });

 test('CAS record projections retain Timestamp-typed unrelated gate and tester fields', async () => {
  class Timestamp { constructor() { this._seconds = 123; this._nanoseconds = 456; Object.freeze(this); } toMillis() { return 0; } toDate() { return new Date(0); } }
  const h = await legacyData(); const records = { gate: h.db.get('floatingGardenTrial/config'), usage: h.db.get('floatingGardenTrial/usage'), testers: review.testerUids.map(uid => h.db.get(`floatingGardenTrialTesters/${uid}`)) };
  records.gate.extraTimestamp = new Timestamp(); records.testers[0].extraTimestamp = new Timestamp();
  const closed = toggleActiveRecords(records, review, false);
  assert(closed.gate.extraTimestamp instanceof Timestamp); assert(closed.testers[0].extraTimestamp instanceof Timestamp);
  assert.equal(closed.usage, records.usage); assert.equal(assertPreservedRecords(records, closed, review, false), true);
  const reopened = toggleActiveRecords(closed, review, true); assert.deepEqual(reopened, records);
 });

 test('documented output-only runtime patch version can move without permitting configured policy changes', () => {
  const fn = metadata(0); fn.buildConfig.onDeployUpdatePolicy = { runtimeVersion: 'nodejs22-previous', retainedFutureField: 'preserve' };
  const before = [{ function: fn, run: run(fn), iam: { bindings: [] } }];
  const after = clone(before); after[0].function.buildConfig.onDeployUpdatePolicy.runtimeVersion = 'nodejs22-current';
  assert.deepEqual(stableFunctionConfiguration(before), stableFunctionConfiguration(after));
  after[0].function.buildConfig.onDeployUpdatePolicy.retainedFutureField = 'changed';
  assert.notDeepEqual(stableFunctionConfiguration(before), stableFunctionConfiguration(after));
  delete after[0].function.buildConfig.onDeployUpdatePolicy; after[0].function.buildConfig.automaticUpdatePolicy = {};
  assert.notDeepEqual(stableFunctionConfiguration(before), stableFunctionConfiguration(after));
 });

// Registered only by the explicit *.integration.mjs entry. Importing the ordinary
// unit suite never loads Admin/ADC or contacts an emulator.
export function registerActiveUpdateEmulatorTests() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  assert.match(host || '', /^(127\.0\.0\.1|localhost):[0-9]{2,5}$/);
  const sdk = createRequire(join(ROOT, 'functions/floating-garden-trial/package.json'));
  const { initializeApp, deleteApp } = sdk('firebase-admin/app');
  const { getFirestore, Timestamp } = sdk('firebase-admin/firestore');
  async function fixture(t, fault) {
    const projectId = `demo-garden-active-${Math.random().toString(36).slice(2, 10)}`;
    const app = initializeApp({ projectId }, projectId); const actual = getFirestore(app);
    actual.settings({ ignoreUndefinedProperties: false, clientConfig: FIRESTORE_CLIENT_CONFIG });
    t.after(async () => { await actual.terminate(); await deleteApp(app); });
    const writes = [], attempts = []; let inject;
    const database = {
      doc: path => actual.doc(path), collection: path => actual.collection(path), collectionGroup: id => actual.collectionGroup(id),
      getAll: (...refs) => actual.getAll(...refs), listCollections: () => actual.listCollections(), batch: () => actual.batch(),
      async runTransaction(body, options) {
        attempts.push(options);
        if (options?.maxAttempts === 1 && inject) await inject('before', []);
        let pending = [];
        const result = await actual.runTransaction(tx => body({ get: target => tx.get(target),
          update(ref, data) { pending.push({ path: ref.path, data }); return tx.update(ref, data); } }), options);
        writes.push(...pending);
        if (pending.length && inject) await inject('after', pending);
        return result;
      },
    };
    const h = await harness({ actualTransport: true, database });
    const stamp = new Timestamp(1791157551, 472000123);
    await actual.doc('floatingGardenTrial/config').update({ extraTimestamp: stamp });
    await actual.doc(`floatingGardenTrialTesters/${review.testerUids[0]}`).update({ extraTimestamp: stamp });
    const groups = await actual.collectionGroup('serverGames').get();
    for (const doc of groups.docs) await doc.ref.update({ expiresAt: stamp });
    async function allData() {
      const map = new Map();
      for (const root of await actual.listCollections()) for (const doc of (await root.get()).docs) map.set(doc.ref.path, doc.data());
      for (const group of ['members', 'serverGames']) for (const doc of (await actual.collectionGroup(group).get()).docs) map.set(doc.ref.path, doc.data());
      return [...map].sort(([a], [b]) => a.localeCompare(b));
    }
    return { ...h, actual, writes, attempts, allData, setFault(value) { inject = value; } };
  }
  test('Firestore emulator: actual query transactions preserve two legacy rooms, nonzero usage and nanosecond Timestamp fields', async t => {
    const h = await fixture(t); const before = canonicalData(await h.allData()); const result = await h.run();
    assert.equal(result.status, 'active-updated', JSON.stringify(result)); assert.equal(canonicalData(await h.allData()), before);
    assert.equal((await h.actual.doc('floatingGardenTrial/usage').get()).data().createdRoomCount, 2);
    assert.equal(h.writes.length, 6); assert(h.writes.every(w => w.path !== 'floatingGardenTrial/usage'));
    assert(h.attempts.filter(a => !a.readOnly).every(a => a.maxAttempts === 1));
  });
  test('Firestore emulator: baseline race is detected by real query CAS and never resets usage or retries', async t => {
    const h = await fixture(t); let injected = false;
    h.setFault(async phase => { if (phase === 'before' && !injected) { injected = true; await h.actual.doc('floatingGardenTrial/usage').update({ createdRoomCount: 3 }); } });
    const result = await h.run(); assert.equal(result.status, 'blocked'); assert.equal(h.writes.length, 0);
    assert.equal(h.attempts.filter(a => a.maxAttempts === 1).length, 1); assert.equal((await h.actual.doc('floatingGardenTrial/usage').get()).data().createdRoomCount, 3);
  });
  for (const active of [false, true]) test(`Firestore emulator: uncertain ${active ? 'reopen' : 'pause'} commit is reconciled without resend`, async t => {
    const h = await fixture(t);
    h.setFault(async (phase, pending) => { if (phase === 'after' && pending[0]?.data.enabled === active) throw Error('SYNTHETIC_LOST_RESPONSE'); });
    const result = await h.run(); assert.equal(result.status, 'blocked'); assert.equal(result.access, active ? 'open' : 'closed');
    assert.equal(h.writes.length, active ? 6 : 3); assert.equal((await h.actual.doc('floatingGardenTrial/usage').get()).data().createdRoomCount, 2);
  });
}

 test('private baseline rejects altered window/roster/cap and legacy-version NPC-shaped rooms', async () => {
  for (const corrupt of [
    h => h.db.set('floatingGardenTrial/config', { ...h.db.get('floatingGardenTrial/config'), endsAtMillis: S.endsAtMillis + 1 }),
    h => h.db.set('floatingGardenTrial/config', { ...h.db.get('floatingGardenTrial/config'), testerUids: ['OTHER_SYNTHETIC', review.testerUids[1]] }),
    h => h.db.set('floatingGardenTrial/config', { ...h.db.get('floatingGardenTrial/config'), maxRooms: 21 }),
    h => { const path = `floatingGardenRooms/${h.second.roomId}`, room = h.db.get(path); h.db.set(path, { ...room, players: [...room.players, { seat: 2, name: 'invalid NPC' }] }); },
  ]) { const h = await harness(); corrupt(h); const result = await h.run(); assert.equal(result.status, 'blocked'); assert.equal(h.db.writes.length, 0); assert.equal(h.providerWrites.length, 0); }
 });
 test('expiry immediately before reopen retains closed gate and original deadline', async () => {
  const h = await harness(), original = h.cloud.verifyPreservation;
  const cloud = { ...h.cloud, verifyPreservation: async () => { const value = await original(); h.setTime(S.endsAtMillis); return value; } };
  const result = await h.run({ cloud }); assert.equal(result.status, 'blocked'); assert.equal(result.access, 'closed');
  assert.equal(h.db.writes.length, 3); assert.equal(h.db.get('floatingGardenTrial/config').endsAtMillis, S.endsAtMillis);
 });
 test('provider-step journal failure prevents the corresponding first provider mutation', async () => {
  const h = await harness({ actualTransport: true }); h.journal.providerStep = async () => { throw Error('synthetic journal unavailable'); };
  const result = await h.run(); assert.equal(result.status, 'blocked'); assert.equal(result.access, 'closed'); assert.equal(h.providerWrites.length, 0);
 });
 test('uncertain reopen reconciles access independently from corrupt usage and new NPC data', async () => {
  const h = await harness(); h.db.setFault(({ phase, pending, db }) => {
    if (phase === 'after' && pending[0].data.enabled === true) {
      db.set('floatingGardenTrial/usage', { ...db.get('floatingGardenTrial/usage'), createdRoomCount: -1 });
      db.set('floatingGardenRooms/synthetic-new-npc', { id: 'synthetic-new-npc', rulesVersion: 'floating-garden-online-npc-1', npcCount: 1, playerCount: 3 });
      throw Error('synthetic response lost');
    }
  });
  const result = await h.run(); assert.equal(result.status, 'blocked'); assert.equal(result.access, 'open'); assert.equal(h.db.writes.length, 6);
 });
 test('source packet mutation and coherently rewritten manifest still fail the reviewed full-byte pin', async () => {
  const dir = await mkdtemp(join(directory, 'tampered-')); const output = join(dir, 'next'); await cp(newPacket.packet.output, output, { recursive: true });
  const path = 'game/functions/online/core/cpu.js'; await writeFile(join(output, path), 'changed');
  let manifest = JSON.parse(await readFile(join(output, 'OPERATION-MANIFEST.json'))); manifest.files[path] = sha('changed');
  await writeFile(join(output, 'OPERATION-MANIFEST.json'), JSON.stringify(manifest, null, 2)+'\n');
  await assert.rejects(prepareActiveUpdatePlan({ previousOutput: oldPacket.packet.output, nextOutput: output }), e => activeUpdateReason(e) === 'packet-source-pin');
  assert(Object.isFrozen(activeUpdatePackets(plan).next.packet.manifest.files));
 });

 test('approved default provider wiring uses real authenticated request bridge with only injected SDK and fetch', async () => {
  const h = await harness({ actualBridge: true }); const result = await h.run();
  assert.equal(result.status, 'active-updated', JSON.stringify(result));
  const patches = h.calls.filter(call => call.method === 'PATCH' && call.url?.includes('cloudfunctions.googleapis.com'));
  assert.equal(patches.length, 5); assert.equal(h.db.writes.length, 6);
 });

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { prepareTrialOperation } from '../scripts/prepare-floating-garden-trial-operation.mjs';
import { readOperationPacket } from '../scripts/operate-floating-garden-trial.mjs';
import { validateSourceArchive } from '../scripts/floating-garden-trial-cloud-adapter.mjs';
import { FUNCTION_NAMES } from '../scripts/prepare-floating-garden-trial.mjs';
import { createActiveUpdateTransport, createActiveUpdateRequest, createSourceZip, prepareActiveUpdatePayload, describeTransportFailure } from '../scripts/floating-garden-active-update-transport.mjs';
const NOW = 1800000000000;
const P = 'wa-awesome-garden-stg', R = 'asia-northeast1';
const CF = 'https://cloudfunctions.googleapis.com/v2/';
const RULES = 'https://firebaserules.googleapis.com/v1/';
const HOSTING = 'https://firebasehosting.googleapis.com/v1beta1/';
const PREFIX = `projects/${P}/locations/${R}`;
const RELEASE = `projects/${P}/releases/cloud.firestore`;
const VERSION = `sites/${P}/versions/new-version`;
const SOURCE = { bucket: `gcf-v2-uploads-120030709276-${R}`, object: 'source-upload.zip', generation: '0' };
const UPLOAD = `https://storage.googleapis.com/${SOURCE.bucket}/${SOURCE.object}?GoogleAccessId=fixture&Signature=fixture`;
const HASH = b => createHash('sha256').update(b).digest('hex');
const clone = x => structuredClone(x);
let fixture;
test.before(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'garden-transport-test-'));
  const review = { schemaVersion: 1, startsAtMillis: NOW, endsAtMillis: NOW + 604800000, testerUids: ['TRANSPORT_SYNTHETIC_A', 'TRANSPORT_SYNTHETIC_B'], retainBuildArtifacts: false, allowInitialFunctionRecreate: false, approvePublicInvoker: false };
  const made = await prepareTrialOperation({ review, output: join(dir, 'packet'), now: NOW });
  fixture = { dir, next: await readOperationPacket(made.output) };
});
test.after(async () => { if (fixture) await rm(fixture.dir, { recursive: true, force: true }); });
function harness(options = {}) {
  let time = NOW, poll = 0, activeOperation, hostedFiles, hostedConfig, hostedStatus = 'CREATED';
  const calls = [], guards = [], events = [];
  const functions = new Map(FUNCTION_NAMES.map(name => [name, { name: `${PREFIX}/functions/${name}`, state: 'ACTIVE', buildConfig: { runtime: 'nodejs22', entryPoint: name, source: { storageSource: { bucket: `gcf-v2-sources-120030709276-${R}`, object: `${name}/old.zip`, generation: '10' } } }, serviceConfig: { serviceAccountEmail: `garden-trial-runtime@${P}.iam.gserviceaccount.com`, maxInstanceCount: 1 }, updateTime: 'old' }]));
  let release = { name: RELEASE, rulesetName: `projects/${P}/rulesets/old-rules` };
  const oldHosting = { kind: 'game', version: `sites/${P}/versions/old-version`, marker: `garden-trial-game-v1:${fixture.next.packet.manifestDigest}` };
  let channel = { name: `sites/${P}/channels/live`, release: { version: { name: oldHosting.version }, message: oldHosting.marker } };
  const baseline = { functions: [...functions.values()].map(fn => ({ function: clone(fn), run: {}, iam: {} })), rules: { release: clone(release), ruleset: {} }, hosting: oldHosting };
  const response = body => {
    const value = clone(body);
    function aliasNames(item) {
      if (!item || typeof item !== 'object') return;
      if (typeof item.name === 'string' && item.name.startsWith(`sites/${P}/`)) {
        if (options.hostingAlias?.liveRelease) item.name = item.name.replace(`sites/${P}/releases/`, `sites/${P}/channels/live/releases/`);
        item.name = (options.hostingAlias?.prefix ?? '') + item.name;
      }
      for (const child of Object.values(item)) aliasNames(child);
    }
    if (options.hostingAlias) aliasNames(value);
    options.hostingResponse?.(value);
    return { status: 200, body: value };
  };
  const request = async call => {
    calls.push({ ...call, body: Buffer.isBuffer(call.body) ? Buffer.from(call.body) : clone(call.body) }); events.push(call.method);
    assert.equal(call.redirect, 'error'); assert.equal(call.timeoutMillis, 30000);
    const overridden = await options.route?.(call, { calls, functions, release, baseline });
    if (overridden !== undefined) return overridden;
    if (call.method === 'GET' && call.url.startsWith(CF + PREFIX + '/functions/')) return response(functions.get(call.url.split('/').at(-1)));
    if (call.url === CF + PREFIX + '/functions:generateUploadUrl') return response({ uploadUrl: UPLOAD, storageSource: SOURCE });
    if (call.url === UPLOAD) { assert.equal(call.auth, 'none'); return { status: 200, headers: { 'x-goog-generation': '101' } }; }
    if (call.method === 'PATCH' && call.url.startsWith(CF)) {
      const name = call.body.name.split('/').at(-1), old = functions.get(name);
      functions.set(name, { ...old, updateTime: 'new', buildConfig: { ...old.buildConfig, source: { storageSource: { bucket: `gcf-v2-sources-120030709276-${R}`, object: `${name}/new.zip`, generation: '20' } } } });
      activeOperation = { name: `${PREFIX}/operations/update-${name}`, response: clone(functions.get(name)) }; poll = 0;
      return response({ name: activeOperation.name, done: false });
    }
    if (call.method === 'GET' && call.url.startsWith(CF + PREFIX + '/operations/')) { poll++; return response({ ...activeOperation, done: !options.neverDone && poll >= 2, ...options.operationError && { error: { code: 13, message: 'DO_NOT_LEAK' }, response: undefined } }); }
    if (call.url === RULES + RELEASE && call.method === 'GET') return response(release);
    if (call.url === RULES + `projects/${P}/rulesets`) return response({ name: `projects/${P}/rulesets/new-rules` });
    if (call.url === RULES + RELEASE && call.method === 'PATCH') { release = clone(call.body.release); return response(release); }
    if (call.url === HOSTING + `sites/${P}/channels/live`) return response(channel);
    if (call.url === HOSTING + `sites/${P}/versions`) { hostedConfig = clone(call.body.config); return response({ name: VERSION, status: 'CREATED', config: call.body.config }); }
    if (call.url === HOSTING + VERSION + ':populateFiles') { hostedFiles = clone(call.body.files); return response({ uploadRequiredHashes: options.noUploads ? [] : [...new Set(Object.values(call.body.files))], uploadUrl: `https://upload-firebasehosting.googleapis.com/upload/${VERSION}/files` }); }
    if (call.url.startsWith('https://upload-firebasehosting.googleapis.com/')) return { status: 200 };
    if (call.url === HOSTING + VERSION + '?updateMask=status') { hostedStatus = 'FINALIZED'; return response({ name: VERSION, status: 'FINALIZED' }); }
    if (call.url === HOSTING + VERSION && call.method === 'GET') return response({ name: VERSION, status: hostedStatus, config: hostedConfig });
    if (call.url.startsWith(HOSTING + VERSION + '/files?')) return response({ files: call.url.includes('status=EXPECTED') ? [] : Object.entries(hostedFiles).map(([path, hash]) => ({ path, hash, status: 'ACTIVE' })) });
    if (call.url === HOSTING + `sites/${P}/releases?versionName=${VERSION}`) { channel = { ...channel, release: { name: `sites/${P}/releases/new-release`, version: { name: VERSION }, message: call.body.message } }; return response(channel.release); }
    throw new Error('Unexpected local fixture request');
  };
  const bridge = options.bridge ? createActiveUpdateRequest({
    requestClient: { request: async opts => {
      const response = await request({ url: opts.url, method: opts.method, body: opts.data, headers: opts.headers, auth: 'google', redirect: 'error', timeoutMillis: opts.timeout });
      return { status: response.status, data: response.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(response.body)), headers: response.headers ?? {} };
    } },
    fetchImpl: async (url, opts) => {
      const response = await request({ url, method: opts.method, body: opts.body, headers: opts.headers, auth: 'none', redirect: opts.redirect, timeoutMillis: 30000 });
      return new Response(null, { status: response.status, headers: response.headers });
    },
  }) : request;
  const transport = createActiveUpdateTransport({ request: bridge, now: () => time, wait: async ms => { time += ms; }, operationTimeoutMillis: options.operationTimeoutMillis ?? 600000 });
  const args = { previous: fixture.next, next: fixture.next, baseline, beforeMutation: async row => { guards.push(clone(row)); events.push('guard'); await options.beforeMutation?.(row, { calls, functions, baseline }); } };
  return { calls, guards, events, args, baseline, transport, functions };
}
test('constructor is inert and has no implicit request/auth client', () => {
  let calls = 0;
  const t = createActiveUpdateTransport({ request: () => { calls++; }, now: () => NOW, wait: async () => {} });
  assert.equal(calls, 0); assert.equal(typeof t.functions, 'function'); assert.throws(() => createActiveUpdateTransport());
});
test('real packet creates exact ZIP plus documented five source-only PATCH/LRO flow', async () => {
  const h = harness(); const result = await h.transport.functions(h.args);
  assert.deepEqual(result, { kind: 'success', functionCount: 5 });
  const writes = h.calls.filter(c => c.method !== 'GET'); assert.equal(writes.length, 7); assert.equal(h.guards.length, writes.length);
  assert.deepEqual(writes[0].body, { environment: 'GEN_2' });
  const upload = writes[1]; assert.equal(upload.auth, 'none'); assert.deepEqual(upload.headers, { 'Content-Type': 'application/zip' });
  const files = {};
  for (const path of Object.keys(fixture.next.packet.manifest.files).filter(p => p.startsWith('game/functions/'))) files[path.slice(15)] = await readFile(join(fixture.next.packet.output, path));
  assert.deepEqual(validateSourceArchive(upload.body, files), { verified: true, fileCount: Object.keys(files).length });
  assert.deepEqual(createSourceZip(files), upload.body);
  for (let i = 0; i < 5; i++) {
    const call = writes[i + 2], name = `${PREFIX}/functions/${FUNCTION_NAMES[i]}`;
    assert.equal(call.url, `${CF}${name}?updateMask=buildConfig.source`);
    assert.deepEqual(call.body, { name, buildConfig: { source: { storageSource: { ...SOURCE, generation: '101' } } } });
    assert.equal(h.guards[i + 2].index, i);
  }
  for (let i = 0; i < h.events.length; i++) if (h.events[i] !== 'GET' && h.events[i] !== 'guard') assert.equal(h.events[i - 1], 'guard');
  const count = h.calls.length; assert.equal((await h.transport.functions(h.args)).kind, 'failed'); assert.equal(h.calls.length, count);
});
test('Rules creates source ruleset then PATCHES existing release without claiming propagation', async () => {
  const h = harness(); const result = await h.transport.rules(h.args);
  assert.equal(result.kind, 'success'); assert.equal(result.pointerVerified, true); assert.equal(result.propagationVerified, false);
  const writes = h.calls.filter(c => c.method !== 'GET'); assert.equal(writes.length, 2);
  assert.deepEqual(writes[0].body, { source: { files: [{ name: 'firestore.rules', content: await readFile(join(fixture.next.packet.gameDir, 'firestore.rules'), 'utf8') }] } });
  assert.equal(writes[1].method, 'PATCH'); assert.deepEqual(writes[1].body, { release: { name: RELEASE, rulesetName: `projects/${P}/rulesets/new-rules` }, updateMask: 'rulesetName' });
});
test('Hosting uses every actual generated gzip hash, exact config and release marker', async () => {
  const h = harness(); const result = await h.transport.hosting(h.args); assert.equal(result.kind, 'success');
  const writes = h.calls.filter(c => c.method !== 'GET'), populate = writes.find(c => c.url.endsWith(':populateFiles'));
  const paths = Object.keys(fixture.next.packet.manifest.files).filter(p => p.startsWith('game/public/'));
  assert.equal(Object.keys(populate.body.files).length, paths.length);
  for (const path of paths) {
    const hash = populate.body.files['/' + path.slice(12)], upload = writes.find(c => c.url.endsWith('/' + hash));
    assert.ok(upload); assert.equal(HASH(upload.body), hash); assert.deepEqual(gunzipSync(upload.body), await readFile(join(fixture.next.packet.output, path)));
    assert.equal(upload.method, 'POST'); assert.equal(upload.auth, 'google'); assert.deepEqual(upload.headers, { 'Content-Type': 'application/octet-stream' });
  }
  assert.deepEqual(writes[0].body.config.redirects, [{ glob: '/', location: '/lab/floating-garden/trial/index.html', statusCode: 302 }]);
  assert.equal(writes[0].body.config.headers[0].headers['Cache-Control'], 'no-store, max-age=0');
  assert.deepEqual(writes.at(-2).body, { status: 'FINALIZED' });
  assert.deepEqual(writes.at(-1).body, { message: `garden-trial-game-v1:${fixture.next.packet.manifestDigest}` });
  assert.equal(h.guards.length, writes.length);
  const count = h.calls.length; assert.equal((await h.transport.hosting(h.args)).kind, 'failed'); assert.equal(h.calls.length, count);
});
test('pre-mutation gate rejection permits no mutation', async () => {
  for (const kind of ['functions', 'rules', 'hosting']) {
    const h = harness({ beforeMutation: async () => { throw new Error('PRIVATE_AUTHORIZATION'); } });
    const result = await h.transport[kind](h.args); assert.equal(result.reason, 'authorization'); assert.equal(h.calls.filter(c => c.method !== 'GET').length, 0); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
});
test('unexpected provider drift stops before write, including earlier updated Functions', async () => {
  const h = harness({ beforeMutation: async ({ stage, index }, { functions }) => {
    if (stage === 'function-patch' && index === 0) { const last = functions.get(FUNCTION_NAMES.at(-1)); last.serviceConfig.maxInstanceCount = 2; }
  } });
  const result = await h.transport.functions(h.args); assert.equal(result.reason, 'drift'); assert.equal(result.completedFunctionCount, 1);
  assert.equal(h.calls.filter(c => c.method === 'PATCH').length, 1);
});
test('failed/unknown writes are single-attempt and stop remaining stages; errors sanitized', async () => {
  for (const [status, expected] of [[403, 'failed'], [429, 'failed'], [503, 'unknown'], [408, 'unknown'], [302, 'unknown']]) {
    const h = harness({ route: c => c.method === 'PATCH' && c.url.startsWith(CF) ? { status, body: { message: 'SECRET_ERROR' } } : undefined });
    const result = await h.transport.functions(h.args); assert.equal(result.kind, expected); assert.equal(result.stage, 'function-patch'); assert.equal(result.completedFunctionCount, 0);
    assert.equal(h.calls.filter(c => c.method === 'PATCH').length, 1); assert.ok(!JSON.stringify(result).includes('SECRET'));
    const count = h.calls.length; await h.transport.functions(h.args); assert.equal(h.calls.length, count);
  }
  const h = harness({ route: c => { if (c.method === 'PATCH' && c.url.startsWith(CF)) throw new Error('SECRET NETWORK DETAIL'); } });
  assert.equal((await h.transport.functions(h.args)).kind, 'unknown');
});
test('LRO timeout only polls reads and never retries source PATCH', async () => {
  const h = harness({ neverDone: true, operationTimeoutMillis: 3000 }); const result = await h.transport.functions(h.args);
  assert.equal(result.kind, 'unknown'); assert.equal(result.reason, 'timeout'); assert.equal(h.calls.filter(c => c.method === 'PATCH').length, 1);
  assert.equal(h.calls.filter(c => c.url.includes('/operations/')).length, 3);
});
test('terminal LRO error is definitive failed and remaining Functions are untouched', async () => {
  const h = harness({ operationError: true }); const result = await h.transport.functions(h.args);
  assert.equal(result.kind, 'failed'); assert.equal(result.reason, 'operation-failed'); assert.equal(result.completedFunctionCount, 0);
});
test('malicious signed URL/path variations never receive upload or credentials', async () => {
  for (const bad of ['http://storage.googleapis.com/x', UPLOAD.replace('storage.googleapis.com', 'evil.example'), UPLOAD.replace('https://', 'https://user:pass@'), UPLOAD + '#fragment', UPLOAD.replace('/source-upload.zip', '/a/../source-upload.zip'), UPLOAD.replace('/source-upload.zip', '/%2e%2e/source-upload.zip'), UPLOAD.replace(SOURCE.bucket, 'other-bucket')]) {
    const h = harness({ route: c => c.url.endsWith(':generateUploadUrl') ? { status: 200, body: { uploadUrl: bad, storageSource: SOURCE } } : undefined });
    const result = await h.transport.functions(h.args); assert.equal(result.kind, 'unknown'); assert.equal(h.calls.filter(c => c.method === 'PUT').length, 0);
    assert.ok(!JSON.stringify(result).includes('Signature'));
  }
});
test('Hosting wrong upload site and unknown hashes stop before upload/finalization', async () => {
  for (const wrongHash of [false, true]) {
    const h = harness({ route: c => c.url.endsWith(':populateFiles') ? { status: 200, body: { uploadRequiredHashes: [wrongHash ? '0'.repeat(64) : Object.values(c.body.files)[0]], uploadUrl: 'https://upload-firebasehosting.googleapis.com/upload/sites/other/versions/new-version/files' } } : undefined });
    assert.equal((await h.transport.hosting(h.args)).kind, 'unknown'); assert.equal(h.calls.some(c => c.url.startsWith('https://upload-firebasehosting')), false); assert.equal(h.calls.some(c => c.method === 'PATCH'), false);
  }
});
test('missing Rules release never creates a release and missing uploads skip file writes', async () => {
  const h = harness({ route: c => c.url === RULES + RELEASE ? { status: 404 } : undefined });
  assert.equal((await h.transport.rules(h.args)).kind, 'failed'); assert.equal(h.calls.filter(c => c.method !== 'GET').length, 0);
  const h2 = harness({ noUploads: true }); assert.equal((await h2.transport.hosting(h2.args)).kind, 'success'); assert.equal(h2.calls.filter(c => c.url.startsWith('https://upload-firebasehosting')).length, 0);
});
test('tampered packet and unknown payload objects fail locally', async () => {
  await assert.rejects(prepareActiveUpdatePayload({ ...fixture.next.packet, manifestDigest: '0'.repeat(64) }), e => describeTransportFailure(e).reason === 'packet');
  const h = harness(); const bad = { ...h.args, next: { packet: { ...fixture.next.packet, manifestDigest: '0'.repeat(64) } } };
  assert.equal((await h.transport.functions(bad)).reason, 'packet'); assert.equal(h.calls.length, 0);
  assert.throws(() => createSourceZip({ '../escape': Buffer.from('x') }));
});
test('combined provider stages preserve completed-source proof callback and never invent CAS fields', async () => {
  const h = harness();
  for (const kind of ['functions', 'rules', 'hosting']) assert.equal((await h.transport[kind](h.args)).kind, 'success');
  const patches = h.guards.filter(g => g.stage === 'function-patch');
  for (let i = 0; i < patches.length; i++) assert.deepEqual(patches[i].completedFunctionNames, FUNCTION_NAMES.slice(0, i));
  assert.deepEqual(h.guards.find(g => g.stage === 'rules-release').completedFunctionNames, FUNCTION_NAMES);
  for (const c of h.calls.filter(c => c.method !== 'GET')) {
    assert.ok(!/requestId|etag|ifMatch|updateTime|ifGenerationMatch/i.test(c.url));
    assert.equal(Object.keys(c.headers).some(k => /if-match|authorization|cookie/i.test(k)), false);
    if (!Buffer.isBuffer(c.body)) assert.ok(!/"(?:etag|requestId|updateTime)"/.test(JSON.stringify(c.body)));
  }
});
test('third Function rejection records exact partial count and bars further provider stages', async () => {
  const h = harness({ route: c => c.method === 'PATCH' && c.url.startsWith(CF) && c.url.includes(FUNCTION_NAMES[2]) ? { status: 403 } : undefined });
  const result = await h.transport.functions(h.args); assert.equal(result.kind, 'failed'); assert.equal(result.completedFunctionCount, 2);
  assert.equal(h.calls.filter(c => c.method === 'PATCH').length, 3);
  const count = h.calls.length; assert.equal((await h.transport.rules(h.args)).reason, 'halted'); assert.equal((await h.transport.hosting(h.args)).reason, 'halted'); assert.equal(h.calls.length, count);
});
test('each Hosting pipeline boundary stops with no fallback, release or retry', async () => {
  for (const suffix of ['/versions', ':populateFiles', '/files/', '?updateMask=status', '/releases?']) {
    const h = harness({ route: c => c.method !== 'GET' && (suffix === '/files/' || suffix === '/releases?' ? c.url.includes(suffix) : c.url.endsWith(suffix)) ? { status: 503, body: { error: 'SECRET_REMOTE_TRACE' } } : undefined });
    const result = await h.transport.hosting(h.args); assert.equal(result.kind, 'unknown'); assert.ok(!JSON.stringify(result).includes('SECRET'));
    const writes = h.calls.filter(c => c.method !== 'GET'); assert.ok(writes.length > 0);
    const last = writes.at(-1); assert.ok(suffix === '/files/' || suffix === '/releases?' ? last.url.includes(suffix) : last.url.endsWith(suffix));
    const count = h.calls.length; await h.transport.hosting(h.args); assert.equal(h.calls.length, count);
  }
});
test('Rules pointer read failure after PATCH is unknown, not propagation or definitive rollback', async () => {
  let patched = false;
  const h = harness({ route: c => {
    if (c.method === 'PATCH' && c.url === RULES + RELEASE) patched = true;
    else if (patched && c.url === RULES + RELEASE) return { status: 503 };
  } });
  const result = await h.transport.rules(h.args); assert.equal(result.kind, 'unknown'); assert.equal(result.reason, 'read');
  assert.equal(h.calls.filter(c => c.method === 'PATCH').length, 1);
});
test('concurrent callers cannot overlap mutable phases', async () => {
  let unblock, entered;
  const blocked = new Promise(r => { unblock = r; });
  const atGuard = new Promise(r => { entered = r; });
  const h = harness({ beforeMutation: async () => { entered(); await blocked; } });
  const first = h.transport.functions(h.args); await atGuard;
  const second = await h.transport.hosting(h.args); assert.equal(second.reason, 'already-attempted');
  unblock(); assert.equal((await first).kind, 'success'); assert.equal(h.calls.some(c => c.url.startsWith(HOSTING)), false);
});
test('unusable LRO read and redirect responses are sanitized unknown outcomes', async () => {
  for (const bad of [{ status: 200, body: { name: 'projects/other/locations/us-central1/operations/o' } }, { status: 200, body: {}, redirected: true }, { status: 503 }]) {
    const h = harness({ route: c => c.url.includes('/operations/') ? bad : undefined });
    const result = await h.transport.functions(h.args); assert.equal(result.kind, 'unknown'); assert.equal(h.calls.filter(c => c.method === 'PATCH').length, 1);
  }
});
test('source upload generation is pinned from response and absent/invalid generation stops before PATCH', async () => {
  for (const headers of [undefined, {}, { 'x-goog-generation': '0' }, { 'x-goog-generation': 'invalid' }, { 'x-goog-generation': '101', 'X-Goog-Generation': '102' }]) {
    const h = harness({ route: c => c.url === UPLOAD ? { status: 200, headers } : undefined });
    const result = await h.transport.functions(h.args); assert.equal(result.kind, 'unknown'); assert.equal(result.reason, 'source-generation'); assert.equal(result.stage, 'functions-source-upload');
    assert.equal(h.calls.filter(c => c.method === 'PATCH').length, 0);
  }
  const h = harness({ route: c => c.url === UPLOAD ? { status: 200, headers: { 'X-Goog-Generation': '12345678901234567890' } } : undefined });
  assert.equal((await h.transport.functions(h.args)).kind, 'success');
  for (const call of h.calls.filter(c => c.method === 'PATCH')) assert.equal(call.body.buildConfig.source.storageSource.generation, '12345678901234567890');
});
test('full Hosting inventory pagination is followed before finalizing and before releasing', async () => {
  let files;
  const h = harness({ route: c => {
    if (c.url.endsWith(':populateFiles')) files = Object.entries(c.body.files).map(([path, hash]) => ({ path, hash, status: 'ACTIVE' }));
    if (c.url.includes('/files?status=ACTIVE')) {
      const second = new URL(c.url).searchParams.get('pageToken') === 'opaque+/=';
      return { status: 200, body: second ? { files: files.slice(3) } : { files: files.slice(0, 3), nextPageToken: 'opaque+/=' } };
    }
  } });
  assert.equal((await h.transport.hosting(h.args)).kind, 'success');
  const lists = h.calls.filter(c => c.url.includes('/files?status=ACTIVE')); assert.equal(lists.length, 4);
  assert.ok(lists[1].url.endsWith('pageToken=opaque%2B%2F%3D'));
  assert.equal(h.calls.filter(c => c.url.includes('/files?status=EXPECTED')).length, 2);
});
test('extra/missing/mismatched/duplicate/inactive Hosting inventory cannot be finalized or released', async () => {
  for (const mode of ['extra', 'missing', 'hash', 'duplicate', 'inactive', 'expected', 'loop', 'config']) {
    let files, config;
    const h = harness({ route: c => {
      if (c.url === HOSTING + `sites/${P}/versions`) config = clone(c.body.config);
      if (c.url.endsWith(':populateFiles')) files = Object.entries(c.body.files).map(([path, hash]) => ({ path, hash, status: 'ACTIVE' }));
      if (mode === 'config' && c.url === HOSTING + VERSION) return { status: 200, body: { name: VERSION, status: 'CREATED', config: { ...config, rewrites: [{ glob: '**', path: '/surprise.html' }] } } };
      if (c.url.includes('/files?status=EXPECTED') && mode === 'expected') return { status: 200, body: { files: [{ ...files[0], status: 'EXPECTED' }] } };
      if (!c.url.includes('/files?status=ACTIVE')) return;
      const entries = clone(files);
      if (mode === 'extra') entries.push({ path: '/surprise.html', hash: '0'.repeat(64), status: 'ACTIVE' });
      if (mode === 'missing') entries.pop();
      if (mode === 'hash') entries[0].hash = '0'.repeat(64);
      if (mode === 'duplicate') entries.push(clone(entries[0]));
      if (mode === 'inactive') entries[0].status = 'EXPECTED';
      return { status: 200, body: { files: entries, ...(mode === 'loop' ? { nextPageToken: 'loop' } : {}) } };
    } });
    const result = await h.transport.hosting(h.args); assert.equal(result.kind, 'unknown', mode); assert.equal(result.reason, 'hosting-inventory', mode);
    assert.equal(h.calls.some(c => c.method === 'PATCH'), false, mode); assert.equal(h.calls.some(c => c.url.includes('/releases?')), false, mode);
  }
});
test('file drift after finalization still prevents release', async () => {
  let files, finalized = false;
  const h = harness({ route: c => {
    if (c.url.endsWith(':populateFiles')) files = Object.entries(c.body.files).map(([path, hash]) => ({ path, hash, status: 'ACTIVE' }));
    if (c.method === 'PATCH' && c.url.endsWith('?updateMask=status')) finalized = true;
    if (finalized && c.url.includes('/files?status=ACTIVE')) return { status: 200, body: { files: [...files, { path: '/extra', hash: '0'.repeat(64), status: 'ACTIVE' }] } };
  } });
  const result = await h.transport.hosting(h.args); assert.equal(result.kind, 'unknown'); assert.equal(result.reason, 'hosting-inventory');
  assert.equal(h.calls.filter(c => c.method === 'PATCH').length, 1); assert.equal(h.calls.some(c => c.url.includes('/releases?')), false);
});
const bridgeCall = changes => ({ url: CF + PREFIX + '/functions:generateUploadUrl', method: 'POST', body: { environment: 'GEN_2' }, headers: { 'Content-Type': 'application/json' }, auth: 'google', redirect: 'error', timeoutMillis: 30000, ...changes });
test('explicit request bridge is inert; sets zero retries, no redirects, bounded responses', async () => {
  const calls = []; let fetched = 0;
  const request = createActiveUpdateRequest({ requestClient: { request: async opts => { calls.push(opts); return { status: 200, data: Buffer.from('{"ok":true}') }; } }, fetchImpl: async () => { fetched++; } });
  assert.equal(calls.length, 0); assert.equal(fetched, 0);
  const response = await request(bridgeCall()); assert.deepEqual(response, { status: 200, body: { ok: true }, headers: {} });
  const opts = calls[0]; assert.equal(opts.retry, false); assert.deepEqual(opts.retryConfig, { retry: 0, noResponseRetries: 0, httpMethodsToRetry: [] });
  assert.equal(opts.maxRedirects, 0); assert.equal(opts.redirect, 'error'); assert.equal(opts.timeout, 30000); assert.equal(opts.responseType, 'arraybuffer');
  assert.equal(opts.maxContentLength, 4 * 1024 * 1024); assert.equal(opts.maxBodyLength, 17 * 1024 * 1024);
  assert.equal(opts.validateStatus(401), true); assert.equal(opts.validateStatus(403), true); assert.equal(opts.validateStatus(503), true);
  assert.equal(opts.signal.aborted, false); assert.equal(fetched, 0);
});
test('real pinned Google Auth/Gaxios do not replay 401/403 or server errors', async () => {
  const require = createRequire(import.meta.url), { OAuth2Client } = require('google-auth-library');
  assert.equal(require('google-auth-library/package.json').version, '9.15.1');
  assert.equal(require('gaxios/package.json').version, '6.7.1');
  for (const status of [401, 403, 503]) {
    const client = new OAuth2Client(); let calls = 0, refreshed = 0;
    client.forceRefreshOnFailure = true;
    client.credentials = { access_token: 'SYNTHETIC_LOCAL_ONLY', refresh_token: 'SYNTHETIC_LOCAL_ONLY' };
    client.getRequestMetadataAsync = async () => ({ headers: { Authorization: 'Bearer SYNTHETIC_LOCAL_ONLY' } });
    client.refreshAccessTokenAsync = async () => { refreshed++; throw new Error('Unexpected refresh'); };
    client.transporter.defaults.adapter = async opts => { calls++; return { status, statusText: 'fixture', data: Buffer.from('DO_NOT_LEAK'), config: opts, headers: {} }; };
    const request = createActiveUpdateRequest({ requestClient: client, fetchImpl: async () => { throw new Error('unexpected'); } });
    assert.deepEqual(await request(bridgeCall()), { status, headers: {} }); assert.equal(calls, 1); assert.equal(refreshed, 0);
  }
});
test('real pinned SDK transport network errors are single attempt despite default retries', async () => {
  const require = createRequire(import.meta.url), { OAuth2Client } = require('google-auth-library');
  const client = new OAuth2Client(); let calls = 0;
  client.getRequestMetadataAsync = async () => ({ headers: {} });
  client.transporter.defaults.retry = true;
  client.transporter.defaults.retryConfig = { retry: 5, noResponseRetries: 5 };
  client.transporter.defaults.adapter = async () => { calls++; throw new Error('PRIVATE_PROVIDER_DETAIL'); };
  const request = createActiveUpdateRequest({ requestClient: client, fetchImpl: async () => {} });
  await assert.rejects(request(bridgeCall()), error => { assert.ok(!error.message.includes('PRIVATE')); assert.deepEqual(describeTransportFailure(error), { kind: 'unknown', reason: 'network' }); return true; });
  assert.equal(calls, 1);
});
test('signed ZIP upload uses only injected fetch and no credentials, cookies or redirects', async () => {
  let calls = 0, authenticated = 0, cancelled = 0, received;
  const request = createActiveUpdateRequest({ requestClient: { request: async () => { authenticated++; } }, fetchImpl: async (url, opts) => { calls++; received = { url, opts }; return { status: 200, url, redirected: false, headers: new Headers({ 'x-goog-generation': '1234567890123456' }), body: { cancel: async () => { cancelled++; } } }; } });
  const bytes = Buffer.from('local synthetic zip');
  assert.deepEqual(await request(bridgeCall({ url: UPLOAD, method: 'PUT', body: bytes, auth: 'none', headers: { 'Content-Type': 'application/zip' } })), { status: 200, headers: { 'x-goog-generation': '1234567890123456' } });
  assert.equal(authenticated, 0); assert.equal(calls, 1); assert.equal(cancelled, 1);
  assert.equal(received.opts.credentials, 'omit'); assert.equal(received.opts.redirect, 'error'); assert.equal(received.opts.referrerPolicy, 'no-referrer');
  assert.deepEqual(received.opts.headers, { 'Content-Type': 'application/zip' }); assert.deepEqual(received.opts.body, bytes);
});
test('bridge bounds hanging requests, aborts once and never retries', async () => {
  for (const signed of [false, true]) {
    let calls = 0, signal;
    const hanging = async (_, options) => { calls++; signal = options.signal; return new Promise(() => {}); };
    const request = createActiveUpdateRequest({ requestClient: { request: opts => hanging(undefined, opts) }, fetchImpl: hanging });
    const call = bridgeCall({ timeoutMillis: 5, ...(signed ? { url: UPLOAD, method: 'PUT', body: Buffer.from('zip'), auth: 'none', headers: { 'Content-Type': 'application/zip' } } : {}) });
    await assert.rejects(request(call), e => describeTransportFailure(e).reason === 'timeout'); assert.equal(calls, 1); assert.equal(signal.aborted, true);
  }
});
test('bridge rejects credential injection, foreign paths, redirects and oversized/malformed responses', async () => {
  let count = 0;
  const request = createActiveUpdateRequest({ requestClient: { request: async () => { count++; return { status: 200, data: '{}' }; } }, fetchImpl: async () => { count++; } });
  for (const change of [{ url: 'https://evil.example/' }, { url: CF + 'projects/other/locations/asia-northeast1/functions:generateUploadUrl' }, { headers: { Authorization: 'DO_NOT_SEND' } }, { redirect: 'follow' }, { url: UPLOAD, auth: 'google', method: 'PUT', body: Buffer.from('zip') }]) await assert.rejects(request(bridgeCall(change)));
  assert.equal(count, 0);
  for (const data of [Buffer.alloc(4 * 1024 * 1024 + 1), Buffer.from('invalid json'), { unexpected: true }]) {
    const r = createActiveUpdateRequest({ requestClient: { request: async () => ({ status: 200, data }) }, fetchImpl: async () => {} });
    await assert.rejects(r(bridgeCall()));
  }
  const r = createActiveUpdateRequest({ requestClient: { request: async () => {} }, fetchImpl: async () => ({ status: 200, redirected: true }) });
  await assert.rejects(r(bridgeCall({ url: UPLOAD, method: 'PUT', body: Buffer.from('zip'), auth: 'none', headers: { 'Content-Type': 'application/zip' } })));
});
test('actual generated packet runs through complete authenticated bridge with injected HTTP routes', async () => {
  const h = harness({ bridge: true });
  for (const kind of ['functions', 'rules', 'hosting']) assert.equal((await h.transport[kind](h.args)).kind, 'success');
  assert.equal(h.calls.filter(c => c.method === 'PUT').length, 1);
  assert.equal(h.calls.filter(c => c.method === 'PATCH' && c.url.startsWith(CF)).length, 5);
  assert.equal(h.calls.filter(c => c.url.includes('/releases?')).length, 1);
  assert.equal(h.guards.length, h.calls.filter(c => c.method !== 'GET').length);
});
test('bridge plus transport preserves unknown partial failure and does not replay it', async () => {
  const h = harness({ bridge: true, route: c => c.method === 'PATCH' && c.url.includes(FUNCTION_NAMES[1]) ? { status: 503, body: { message: 'PRIVATE' } } : undefined });
  const result = await h.transport.functions(h.args); assert.equal(result.kind, 'unknown'); assert.equal(result.completedFunctionCount, 1);
  assert.equal(h.calls.filter(c => c.method === 'PATCH').length, 2); const count = h.calls.length;
  assert.equal((await h.transport.rules(h.args)).reason, 'halted'); assert.equal(h.calls.length, count);
});
test('Hosting binary upload accepts bounded opaque success body without inventing JSON contract', async () => {
  let calls = 0;
  const request = createActiveUpdateRequest({ requestClient: { request: async () => { calls++; return { status: 200, data: Buffer.from('Opaque upload response, not JSON') }; } }, fetchImpl: async () => {} });
  assert.deepEqual(await request(bridgeCall({ url: `https://upload-firebasehosting.googleapis.com/upload/${VERSION}/files/${'a'.repeat(64)}`, body: Buffer.from('gzip'), headers: { 'Content-Type': 'application/octet-stream' } })), { status: 200, headers: {} });
  assert.equal(calls, 1);
});
const HOSTING_PREFIXES = ['', `projects/${P}/`, 'projects/120030709276/'];
test('generated-packet bridge flow accepts only approved Hosting prefixes and both live release forms', async () => {
  for (const prefix of HOSTING_PREFIXES) for (const liveRelease of [false, true]) {
    const h = harness({ bridge: true, hostingAlias: { prefix, liveRelease } });
    h.baseline.hosting.version = prefix + h.baseline.hosting.version;
    for (const kind of ['functions', 'rules', 'hosting']) {
      const result = await h.transport[kind](h.args); assert.equal(result.kind, 'success', `${prefix} ${liveRelease} ${kind}`);
      if (kind === 'hosting') assert.deepEqual(result, { kind: 'success', versionName: VERSION, releaseName: `sites/${P}/${liveRelease ? 'channels/live/' : ''}releases/new-release` });
    }
    for (const call of h.calls.filter(c => c.url.startsWith(HOSTING))) {
      assert.ok(call.url.startsWith(HOSTING + `sites/${P}/`)); assert.ok(!call.url.includes('/projects/'));
    }
    for (const call of h.calls.filter(c => c.url.startsWith('https://upload-firebasehosting.googleapis.com'))) assert.match(call.url, new RegExp(`^https://upload-firebasehosting\\.googleapis\\.com/upload/${VERSION}/files/[a-f0-9]{64}$`));
  }
});
test('mixed aliases normalize independently at every Hosting response boundary', async () => {
  let created = 0, finalized = 0, channels = 0, releases = 0;
  const h = harness({ bridge: true, hostingResponse: value => {
    if (value?.name === `sites/${P}/channels/live`) { channels++; value.name = 'projects/120030709276/' + value.name; value.release.version.name = `projects/${P}/` + value.release.version.name; }
    else if (value?.name === VERSION && value.status === 'CREATED') { value.name = HOSTING_PREFIXES[++created] + value.name; }
    else if (value?.name === VERSION && value.status === 'FINALIZED') { value.name = (finalized++ ? '' : `projects/${P}/`) + value.name; }
    else if (value?.name === `sites/${P}/releases/new-release`) { releases++; value.name = `projects/120030709276/sites/${P}/channels/live/releases/new-release`; value.version.name = `projects/${P}/${VERSION}`; }
  } });
  assert.equal((await h.transport.hosting(h.args)).kind, 'success');
  assert.equal(created, 2); assert.equal(finalized, 2); assert.equal(releases, 1); assert.ok(channels > 2);
});
test('readHostingVersion accepts exact approved response-style aliases but sends canonical site GET', async () => {
  const h = harness({ bridge: true });
  for (const prefix of HOSTING_PREFIXES) { const result = await h.transport.readHostingVersion(prefix + VERSION); assert.equal(result.name, VERSION); }
  assert.deepEqual(h.calls.map(c => [c.method, c.url]), HOSTING_PREFIXES.map(() => ['GET', HOSTING + VERSION]));
  for (const invalid of [
    `projects/other-project/${VERSION}`, `projects/120030709277/${VERSION}`, `projects/-/${VERSION}`,
    VERSION.replace(P, 'other-site'), VERSION + '/', VERSION + '/suffix', VERSION + '\n', VERSION + '\r\n',
    VERSION.replace('/versions/', '/versions/%2F'), VERSION.replace('/versions/', '/channels/preview/versions/'), 'https://firebasehosting.googleapis.com/v1beta1/' + VERSION,
  ]) assert.throws(() => h.transport.readHostingVersion(invalid));
  assert.equal(h.calls.length, HOSTING_PREFIXES.length);
});
function alterHostingBoundary(field, replacement) {
  let created = 0, finalized = 0, changed = false;
  return { get changed() { return changed; }, change(value) {
    if (changed) return;
    const replace = (object, key) => { object[key] = typeof replacement === 'function' ? replacement(object[key]) : replacement; changed = true; };
    if (value?.name === `sites/${P}/channels/live`) {
      if (field === 'channel') replace(value, 'name');
      if (field === 'baseline-version') replace(value.release.version, 'name');
    } else if (value?.name === VERSION && value.status === 'CREATED') {
      created++;
      if (field === 'created' && created === 1 || field === 'created-inventory' && created === 2) replace(value, 'name');
    } else if (value?.name === VERSION && value.status === 'FINALIZED') {
      finalized++;
      if (field === 'finalized' && finalized === 1 || field === 'finalized-inventory' && finalized === 2) replace(value, 'name');
    } else if (value?.name === `sites/${P}/releases/new-release`) {
      if (field === 'released-version') replace(value.version, 'name');
      if (field === 'release') replace(value, 'name');
    }
  } };
}
test('foreign project/site and malformed aliases fail at each response boundary without a subsequent mutation', async () => {
  const fields = ['channel', 'baseline-version', 'created', 'created-inventory', 'finalized', 'finalized-inventory', 'released-version', 'release'];
  const replacements = [name => `projects/other-project/${name}`, name => `projects/120030709277/${name}`, name => `projects/-/${name}`, name => name.replace(P, 'other-site'), name => name + '\n', name => name + '/suffix', name => name.replace('sites/', 'sites%2F')];
  for (const field of fields) for (const replacement of replacements) {
    const alteration = alterHostingBoundary(field, replacement);
    const h = harness({ bridge: true, hostingResponse: value => alteration.change(value) });
    const result = await h.transport.hosting(h.args); assert.notEqual(result.kind, 'success', field); assert.equal(alteration.changed, true, field);
    if (['channel', 'baseline-version'].includes(field)) assert.equal(h.calls.filter(c => c.method !== 'GET').length, 0, field);
    if (field === 'created') assert.equal(h.calls.filter(c => c.method !== 'GET').length, 1);
    if (field === 'created-inventory') assert.equal(h.calls.some(c => c.method === 'PATCH'), false);
    if (['finalized', 'finalized-inventory'].includes(field)) assert.equal(h.calls.some(c => c.url.includes('/releases?')), false);
    const before = h.calls.filter(c => c.method !== 'GET').length;
    if (before > 0) { await h.transport.hosting(h.args); assert.equal(h.calls.filter(c => c.method !== 'GET').length, before, field); }
  }
});
test('another version or non-live channel cannot use an otherwise approved project prefix', async () => {
  for (const field of ['baseline-version', 'created-inventory', 'finalized', 'finalized-inventory', 'released-version']) {
    const alteration = alterHostingBoundary(field, name => `projects/${P}/` + name.replace(/versions\/[^/]+$/, 'versions/another-version'));
    const h = harness({ bridge: true, hostingResponse: value => alteration.change(value) });
    assert.notEqual((await h.transport.hosting(h.args)).kind, 'success', field); assert.equal(alteration.changed, true);
  }
  for (const [field, value] of [['channel', `projects/${P}/sites/${P}/channels/preview`], ['release', `projects/120030709276/sites/${P}/channels/preview/releases/new-release`], ['release', `projects/${P}/sites/${P}/channels/live/releases/new-release/extra`]]) {
    const alteration = alterHostingBoundary(field, value), h = harness({ bridge: true, hostingResponse: body => alteration.change(body) });
    assert.notEqual((await h.transport.hosting(h.args)).kind, 'success', field); assert.equal(alteration.changed, true);
  }
});
test('response prefix compatibility never allows a project-prefixed Hosting upload URL', async () => {
  const h = harness({ bridge: true, hostingAlias: { prefix: `projects/${P}/`, liveRelease: true }, route: c => c.url.endsWith(':populateFiles') ? { status: 200, body: { uploadRequiredHashes: [Object.values(c.body.files)[0]], uploadUrl: `https://upload-firebasehosting.googleapis.com/upload/projects/${P}/${VERSION}/files` } } : undefined });
  assert.equal((await h.transport.hosting(h.args)).kind, 'unknown');
  assert.equal(h.calls.some(c => c.url.startsWith('https://upload-firebasehosting.googleapis.com')), false); assert.equal(h.calls.some(c => c.method === 'PATCH'), false);
});

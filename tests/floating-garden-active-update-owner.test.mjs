// Standalone owner-entry packaging. All public downloads/provider reads below
// are injected; the real immutable source modules, generators, packet reader
// and owner packet selector execute. No ADC/SDK/network or Cloud write runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, lstat, symlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { OWNER_SOURCE_COMMIT, OWNER_SOURCE_TREE, OWNER_SOURCE_FILES, OWNER_PREPARATION_NAME,
  inspectOwnerActiveUpdate, main } from '../scripts/floating-garden-active-update-owner.mjs';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OLD = 'ce20dce88490ee42cc8e427ab90b0b2c8a576c95';
const START = 1791157551472, END = 1791762351472, NOW = START + 10000;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const review = { schemaVersion: 1, startsAtMillis: START, endsAtMillis: END,
  testerUids: ['SYNTHETIC_OWNER_ALPHA', 'SYNTHETIC_OWNER_BETA'], retainBuildArtifacts: true,
  allowInitialFunctionRecreate: true, approvePublicInvoker: true };
let directory, oldGenerator; const sources = new Map();
test.before(async () => {
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
      createdRoomCount: 7, roomCount: 2, documentCount: 50 },
      bindJournal: () => assert.fail('inspection must never bind a journal'), pause: () => assert.fail('inspection must never pause'),
      updateFunctions: () => assert.fail('inspection must never deploy'), reopen: () => assert.fail('inspection must never reopen') };
  };
  const options = { home, fetchImpl, createProvider, env: {}, execArgv: [], now: () => NOW, log: value => logs.push(value) };
  return { home, base, latest, tooling, selected, original, requests, inspections, logs, options,
    target: join(home, OWNER_PREPARATION_NAME), setResponseHook(value) { responseHook = value; },
    setProviderHook(value) { providerHook = value; }, run: () => inspectOwnerActiveUpdate(options) };
}

test('owner entry default and unknown flags are inert and never offer apply', async () => {
  let calls = 0; const options = { log: () => {}, fetchImpl: () => { calls++; throw Error(); }, createProvider: () => { calls++; throw Error(); } };
  assert.equal(await main([], options), 0); assert.equal(await main(['--plan'], options), 0);
  assert.equal(await main(['--apply'], options), 1); assert.equal(await main(['--inspect', '--project', 'foreign'], options), 1); assert.equal(calls, 0);
});
test('64-file immutable package executes real generator and selects verified latest owner packet without cloud writes', async t => {
  const h = await fixture(t), beforeBase = await snapshot(h.base), beforeUpdated = await snapshot(h.latest), beforeTooling = await snapshot(h.tooling);
  const result = await h.run(); assert.equal(result.status, 'baseline-read-only', JSON.stringify({ result, logs: h.logs }));
  assert.equal(h.requests.length, 64); assert.equal(h.inspections.length, 1); assert.equal(result.cloudWrites, 0); assert.equal(result.executionApproved, false);
  assert.equal(result.createdRoomCount, 7); assert.equal(result.endsAtMillis, END);
  assert.equal(result.oldManifestDigest, h.selected.manifestDigest); assert.match(result.newManifestDigest, /^[a-f0-9]{64}$/);
  const marker = JSON.parse(await readFile(join(h.target, 'PREPARATION.json'))); assert.equal(marker.previousOutput, h.selected.output);
  const privateReview = JSON.parse(await readFile(join(h.target, 'operation/private-review.json'))); assert.deepEqual(privateReview, review);
  assert.deepEqual(await snapshot(h.base), beforeBase); assert.deepEqual(await snapshot(h.latest), beforeUpdated); assert.deepEqual(await snapshot(h.tooling), beforeTooling);
  assert(!JSON.stringify(h.logs).includes(review.testerUids[0]));
  assert.deepEqual((await readdir(join(h.target, 'operation'))).sort(), ['OPERATION-MANIFEST.json', 'OPERATION-PLAN.json', 'game', 'private-review.json', 'stopped']);
  assert.equal((await lstat(h.target)).mode & 0o777, 0o700); assert.equal((await lstat(join(h.target, 'PREPARATION.json'))).mode & 0o777, 0o600);
});
test('intact target can be re-inspected without public downloads or private-file overwrite', async t => {
  const h = await fixture(t); assert.equal((await h.run()).status, 'baseline-read-only');
  const before = await snapshot(h.target), count = h.requests.length; const result = await h.run();
  assert.equal(result.status, 'baseline-read-only'); assert.equal(result.preparedTargetReused, true); assert.equal(h.requests.length, count);
  assert.deepEqual(await snapshot(h.target), before); assert.equal(h.inspections.length, 2);
});
test('new immutable inspection generation leaves the prior preparation byte-identical', async t => {
  const h = await fixture(t), prior = join(h.home, 'garden-active-update-41c44301490e');
  assert.notEqual(prior, h.target);
  await mkdir(prior, { mode: 0o700 });
  await put(join(prior, 'PREPARATION.json'), JSON.stringify({ sourceCommit: '8829139a0cbebd2bf139969c6e6faf38d2c7dcab', retained: true }));
  await put(join(prior, 'operation/private-review.json'), JSON.stringify(review));
  await put(join(prior, 'source/scripts/floating-garden-active-update-provider.mjs'), 'globalThis.oldGardenPreparationExecuted = true;');
  const before = await snapshot(prior), result = await h.run();
  assert.equal(result.status, 'baseline-read-only'); assert.equal(result.preparedTargetReused, false);
  assert.deepEqual(await snapshot(prior), before); assert.equal(globalThis.oldGardenPreparationExecuted, undefined);
  assert.equal(h.inspections.length, 1); assert.equal(h.requests.length, 64);
});
test('original owner packet is selected when there is no verified Hosting update', async t => {
  const h = await fixture(t, { updated: false }); const result = await h.run(); assert.equal(result.status, 'baseline-read-only');
  assert.equal(JSON.parse(await readFile(join(h.target, 'PREPARATION.json'))).previousOutput, h.original.output);
});
test('partial preparation is retained and never repaired, overwritten or imported', async t => {
  const h = await fixture(t); await mkdir(h.target, { mode: 0o700 }); await put(join(h.target, 'source/partial.txt'), 'retained');
  const before = await snapshot(h.target), result = await h.run(); assert.equal(result.status, 'blocked');
  assert.deepEqual(await snapshot(h.target), before); assert.equal(h.requests.length, 0); assert.equal(h.inspections.length, 0);
});
test('wrong bytes, foreign response URL and redirect fail before any provider or SDK operation', async t => {
  for (const issue of ['bytes', 'url', 'redirect']) {
    const h = await fixture(t); h.setResponseHook((path, original) => {
      const response = new Response(issue === 'bytes' ? 'globalThis.badOwnerSourceExecuted = true;' : sources.get(path), { status: 200 });
      Object.defineProperty(response, 'url', { value: issue === 'url' ? 'https://foreign.invalid/file' : original.url });
      if (issue === 'redirect') Object.defineProperty(response, 'redirected', { value: true }); return response;
    });
    const result = await h.run(); assert.equal(result.status, 'blocked'); assert.equal(h.inspections.length, 0);
    assert.equal(globalThis.badOwnerSourceExecuted, undefined);
    const again = await h.run(); assert.equal(again.status, 'blocked'); assert.equal(h.requests.length, 1);
  }
});
test('tampered verified-cache source, extra files and changed marker stop without downloads/provider reads', async t => {
  for (const issue of ['source', 'extra', 'marker']) {
    const h = await fixture(t); assert.equal((await h.run()).status, 'baseline-read-only');
    if (issue === 'source') await writeFile(join(h.target, 'source/scripts/floating-garden-active-update-provider.mjs'), 'globalThis.badOwnerSourceExecuted=true;');
    if (issue === 'extra') await put(join(h.target, 'source/foreign.mjs'), 'globalThis.badOwnerSourceExecuted=true;');
    if (issue === 'marker') { const path = join(h.target, 'PREPARATION.json'), marker = JSON.parse(await readFile(path)); marker.previousOutput = '/foreign/operation'; await writeFile(path, JSON.stringify(marker)); }
    const result = await h.run(); assert.equal(result.status, 'blocked'); assert.equal(h.requests.length, 64); assert.equal(h.inspections.length, 1);
    assert.equal(globalThis.badOwnerSourceExecuted, undefined);
  }
});
test('foreign owner symlinks and preparation links are rejected before following them', async t => {
  const h = await fixture(t), foreign = await mkdtemp(join(directory, 'foreign-'));
  await symlink(foreign, h.target, 'dir'); assert.equal((await h.run()).status, 'blocked'); assert.deepEqual(await readdir(foreign), []);
  assert.equal(h.requests.length, 0); assert.equal(h.inspections.length, 0);
});
test('missing or unpinned existing runtime stops without installing or cloud inspection', async t => {
  const h = await fixture(t); const path = join(h.selected.gameDir, 'functions/node_modules/google-auth-library/package.json');
  await writeFile(path, JSON.stringify({ name: 'google-auth-library', version: '999.0.0', main: 'index.js' }));
  const result = await h.run(); assert.equal(result.status, 'blocked'); assert.equal(result.stage, 'runtime-reuse'); assert.equal(h.inspections.length, 0);
  assert.equal(JSON.parse(await readFile(path)).version, '999.0.0');
});
test('cloud-read blocker retains intact preparation for a later read-only retry and hides raw error text', async t => {
  const h = await fixture(t); h.setProviderHook(() => { throw Error('PRIVATE_TOKEN_uid@example.invalid'); });
  const first = await h.run(); assert.equal(first.status, 'blocked'); assert.equal(first.stage, 'baseline-read'); assert(!JSON.stringify(h.logs).includes('PRIVATE_TOKEN'));
  const before = await snapshot(h.target); h.setProviderHook(undefined); const next = await h.run();
  assert.equal(next.status, 'baseline-read-only'); assert.equal(next.preparedTargetReused, true); assert.equal(h.requests.length, 64); assert.deepEqual(await snapshot(h.target), before);
});
test('malformed provider summary never reflects private data as success', async t => {
  const h = await fixture(t); h.setProviderHook(() => ({ kind: 'baseline', fingerprint: review.testerUids[0], createdRoomCount: 21, roomCount: 2, documentCount: 50 }));
  assert.equal((await h.run()).status, 'blocked'); assert(!JSON.stringify(h.logs).includes(review.testerUids[0]));
});
test('credential/Node overrides and exposed preparation marker fail closed', async t => {
  const h = await fixture(t); assert.equal((await inspectOwnerActiveUpdate({ ...h.options, env: { GOOGLE_APPLICATION_CREDENTIALS: '/foreign.json' } })).status, 'blocked'); assert.equal(h.requests.length, 0);
  assert.equal((await h.run()).status, 'baseline-read-only'); await chmod(join(h.target, 'PREPARATION.json'), 0o644);
  assert.equal((await h.run()).status, 'blocked'); assert.equal(h.inspections.length, 1);
});

test('TLS, proxy, endpoint, debug and credential overrides reject before any public fetch or preparation', async t => {
  const h = await fixture(t);
  for (const key of ['NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NODE_DEBUG', 'NODE_V8_COVERAGE', 'DEBUG', 'GRPC_TRACE',
    'GOOGLE_SDK_NODE_LOGGING', 'CLOUDSDK_API_ENDPOINT_OVERRIDES_STORAGE', 'CLOUDSDK_AUTH_ACCESS_TOKEN', 'FIRESTORE_EMULATOR_HOST',
    'GOOGLE_API_USE_MTLS_ENDPOINT', 'npm_config_registry', 'CLOUDSDK_AUTH_DISABLE_SSL_VALIDATION']) {
    const result = await inspectOwnerActiveUpdate({ ...h.options, env: { [key]: 'true' } });
    assert.equal(result.status, 'blocked', key); assert.equal(result.stage, 'owner-paths', key);
  }
  assert.equal(h.requests.length, 0); assert.equal(h.inspections.length, 0);
  await assert.rejects(lstat(h.target), error => error.code === 'ENOENT');
});
test('standalone CLI flushes final output and exits despite a persistent handle; import remains inert', async () => {
  const path = join(directory, 'cli-lifecycle.mjs');
  const owner = fileURLToPath(new URL('../scripts/floating-garden-active-update-owner.mjs', import.meta.url));
  await writeFile(path, `setInterval(() => {}, 100000); process.argv[1] = ${JSON.stringify(owner)}; await import(${JSON.stringify(pathToFileURL(owner).href)});`);
  const planOutput = execFileSync(process.execPath, [path, '--plan'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(planOutput, /^PLAN_ONLY:/);
  assert.throws(() => execFileSync(process.execPath, [path, '--unknown'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] }), error => error.status === 1 && String(error.stdout).includes('READ_ONLY_STOP:'));
});

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
import { executeOwnerActiveUpdate, main, INSPECTION_ENTRY_COMMIT, INSPECTION_ENTRY_SHA256, EXECUTION_GUARD_NAME, EXECUTION_PREPARATION_NAME } from '../scripts/floating-garden-active-update-execute-owner.mjs';
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

async function executionFixture(t, { fault, baselineChange, downloadIssue, documents = 158 } = {}) {
  const h = await fixture(t); assert.equal((await h.run()).status, 'baseline-read-only');
  const writes = [], logs = [], requests = []; let reads = 0, constructions = 0, access = 'open', bound = false;
  const fetchImpl = async (url, options) => {
    requests.push({ url, options }); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    const expected = `https://raw.githubusercontent.com/fabdemnt-dev/wa-awesome/${INSPECTION_ENTRY_COMMIT}/scripts/floating-garden-active-update-owner.mjs`;
    assert.equal(url, expected);
    const response = new Response(downloadIssue === 'bytes' ? 'globalThis.unverifiedExecutionHelperRan=true;' : inspectorBytes, { status: 200 });
    Object.defineProperty(response, 'url', { value: downloadIssue === 'url' ? 'https://foreign.invalid/helper.mjs' : url });
    if (downloadIssue === 'redirect') Object.defineProperty(response, 'redirected', { value: true });
    return response;
  };
  const write = name => {
    assert.equal(bound, true); writes.push(name);
    if (name === 'pause') access = 'closed';
    if (name === 'reopen') access = 'open';
    if (fault?.name === name) {
      if (fault.access) access = fault.access;
      return { kind: 'unknown' };
    }
    return { kind: 'success' };
  };
  const createProvider = input => {
    constructions++; assert.equal(input.plan.preservedTesterCount, 2); assert.equal(input.plan.endsAtMillis, END);
    return {
      inspect: async () => {
        reads++; const value = { kind: 'baseline', fingerprint: 'a'.repeat(64), createdRoomCount: 2, roomCount: 2, documentCount: documents };
        return baselineChange ? baselineChange(reads, value) : value;
      },
      bindJournal: value => { assert.equal(bound, false); assert.equal(typeof value.providerStep, 'function'); bound = true; },
      pause: async value => { assert.equal(value, 'a'.repeat(64)); return write('pause'); },
      assertClosed: async () => { assert.equal(access, 'closed'); return { kind: 'verified' }; },
      updateFunctions: async () => write('functions'), verifyFunctions: async () => ({ kind: 'verified' }),
      updateRules: async () => write('rules'), verifyRules: async () => ({ kind: 'verified' }),
      updateHosting: async () => write('hosting'), verifyHosting: async () => ({ kind: 'verified' }),
      verifyPreservation: async () => ({ kind: 'verified' }), reopen: async () => write('reopen'),
      verifyReopened: async () => ({ kind: 'verified' }),
      readAccess: async () => { if (fault?.accessReadError) throw Error('PRIVATE_RAW_PROVIDER_ERROR'); return { access }; },
    };
  };
  const options = { approved: true, playersStopped: true, exclusiveMaintenance: true,
    home: h.home, env: {}, execArgv: [], now: () => NOW, fetchImpl, createProvider, log: value => logs.push(value) };
  return { ...h, options, writes, logs, requests, reads: () => reads, constructions: () => constructions,
    guard: join(h.home, EXECUTION_GUARD_NAME), journal: join(h.target, 'operation/ACTIVE-UPDATE-JOURNAL.jsonl'),
    execute: overrides => executeOwnerActiveUpdate({ ...options, ...overrides }) };
}

test('default, plan and incomplete approval flags are inert', async () => {
  let calls = 0; const options = { log: () => {}, fetchImpl: () => { calls++; throw Error(); }, createProvider: () => { calls++; throw Error(); } };
  assert.equal(await main([], options), 0); assert.equal(await main(['--plan'], options), 0);
  for (const flags of [['--apply'], ['--apply-approved-update'], ['--apply-approved-update', '--players-stopped'],
    ['--apply-approved-update', '--players-stopped', '--exclusive-maintenance', '--retry'], ['--inspect']]) assert.equal(await main(flags, options), 1);
  assert.equal(calls, 0);
});
test('real pinned preparation and staged runner execute once with a durable journal and no source/private overwrite', async t => {
  const h = await executionFixture(t), before = await snapshot(h.target), original = await snapshot(h.base), latest = await snapshot(h.latest), tooling = await snapshot(h.tooling);
  const result = await h.execute(); assert.equal(result.status, 'active-updated', JSON.stringify({ result, logs: h.logs }));
  assert.equal(result.access, 'open'); assert.equal(result.usageWritten, false); assert.equal(result.endsAtMillis, END);
  assert.deepEqual(h.writes, ['pause', 'functions', 'rules', 'hosting', 'reopen']); assert.equal(h.reads(), 2); assert.equal(h.constructions(), 1);
  const after = await snapshot(h.target); delete after['operation/ACTIVE-UPDATE-JOURNAL.jsonl']; assert.deepEqual(after, before);
  assert.deepEqual(await snapshot(h.base), original); assert.deepEqual(await snapshot(h.latest), latest); assert.deepEqual(await snapshot(h.tooling), tooling);
  const journal = (await readFile(h.journal, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(journal[0].event, 'created'); assert.equal(journal.at(-1).status, 'active-updated');
  assert.equal((await lstat(h.guard)).mode & 0o777, 0o700); assert.equal((await lstat(h.journal)).mode & 0o777, 0o600);
  assert.equal((await lstat(join(h.guard, 'EXECUTION.json'))).mode & 0o777, 0o600);
  assert(!JSON.stringify(h.logs).includes(review.testerUids[0]));
  assert(!Object.hasOwn(result, 'roomCount')); assert(!Object.hasOwn(result, 'createdRoomCount'));
  const beforeSecond = await snapshot(h.target), result2 = await h.execute();
  assert.equal(result2.status, 'blocked'); assert.equal(result2.stage, 'one-shot-guard'); assert.equal(result2.cloudChangesAttempted, false);
  assert.deepEqual(await snapshot(h.target), beforeSecond); assert.equal(h.constructions(), 1); assert.equal(h.requests.length, 1);
});
test('exact CLI flags authorize the bounded entry and legitimate receipt growth is preserved', async t => {
  const h = await executionFixture(t, { documents: 200 });
  assert.equal(await main(['--apply-approved-update', '--players-stopped', '--exclusive-maintenance'], h.options), 0);
  assert.deepEqual(h.writes, ['pause', 'functions', 'rules', 'hosting', 'reopen']);
});
test('concurrent attempts admit only one executor and never remove the admission guard', async t => {
  const h = await executionFixture(t); const results = await Promise.all([h.execute(), h.execute()]);
  assert.equal(results.filter(r => r.status === 'active-updated').length, 1); assert.equal(results.filter(r => r.stage === 'one-shot-guard').length, 1);
  assert.equal(h.constructions(), 1); assert.equal(h.requests.length, 1); assert.equal(h.writes.length, 5);
});
test('changed room admission on either inspection stops before pause and cannot be retried', async t => {
  for (const changedRead of [1, 2]) {
    const h = await executionFixture(t, { baselineChange: (n, v) => n === changedRead ? { ...v, createdRoomCount: 3 } : v });
    const result = await h.execute(); assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'admin-state'); assert.equal(h.writes.length, 0);
    assert.equal((await h.execute()).stage, 'one-shot-guard'); assert.equal(h.constructions(), 1);
  }
});
test('each uncertain mutation stops without downstream stages, retries or old-code rollback', async t => {
  const order = ['pause', 'functions', 'rules', 'hosting', 'reopen'];
  for (const name of order) {
    const h = await executionFixture(t, { fault: { name } }); const result = await h.execute();
    assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'mutation-unknown');
    assert.equal(result.access, name === 'reopen' ? 'open' : 'closed'); assert.equal(result.automaticRetry, false); assert.equal(result.automaticRollback, false);
    assert.deepEqual(h.writes, order.slice(0, order.indexOf(name) + 1));
    const journal = (await readFile(h.journal, 'utf8')).trim().split('\n').map(JSON.parse); assert.equal(journal.at(-1).event, 'blocked');
    const count = h.writes.length; assert.equal((await h.execute()).stage, 'one-shot-guard'); assert.equal(h.writes.length, count);
  }
});
test('lost pause response reports actual open or unknown access and hides raw provider errors', async t => {
  for (const fault of [{ name: 'pause', access: 'open' }, { name: 'pause', accessReadError: true }]) {
    const h = await executionFixture(t, { fault }), result = await h.execute();
    assert.equal(result.access, fault.accessReadError ? 'unknown' : 'open'); assert.deepEqual(h.writes, ['pause']);
    assert(!JSON.stringify(h.logs).includes('PRIVATE_RAW_PROVIDER_ERROR'));
  }
});
test('immutable helper download rejects changed bytes, foreign URL or redirect before any provider import', async t => {
  for (const downloadIssue of ['bytes', 'url', 'redirect']) {
    const h = await executionFixture(t, { downloadIssue }), before = await snapshot(h.target), result = await h.execute();
    assert.equal(result.status, 'blocked'); assert.equal(result.stage, 'inspector-download'); assert.equal(h.constructions(), 0);
    assert.equal(h.writes.length, 0); assert.deepEqual(await snapshot(h.target), before); assert.equal(globalThis.unverifiedExecutionHelperRan, undefined);
    assert.equal((await h.execute()).stage, 'one-shot-guard'); assert.equal(h.requests.length, 1);
  }
});
test('tampered cached source and existing journal fail without evaluating source or constructing a provider', async t => {
  for (const issue of ['source', 'journal']) {
    const h = await executionFixture(t);
    if (issue === 'source') await writeFile(join(h.target, 'source/scripts/floating-garden-active-update-provider.mjs'), 'globalThis.unverifiedGardenProviderRan=true;');
    else await put(h.journal, 'retained pre-existing journal');
    const before = await snapshot(h.target), result = await h.execute();
    assert.equal(result.status, 'blocked'); assert.equal(h.constructions(), 0); assert.equal(h.writes.length, 0);
    assert.deepEqual(await snapshot(h.target), before); assert.equal(globalThis.unverifiedGardenProviderRan, undefined);
  }
});
test('approval, expiry, missing preparation and unsafe environment stop before admission or download', async t => {
  const h = await executionFixture(t);
  for (const overrides of [{ approved: false }, { playersStopped: false }, { exclusiveMaintenance: false }, { now: () => END },
    { env: { GOOGLE_APPLICATION_CREDENTIALS: '/unapproved.json' } }, { env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' } },
    { env: { HTTPS_PROXY: 'https://foreign.invalid' } }, { env: { CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: 'foreign' } },
    { execArgv: ['--import', '/unapproved.mjs'] }]) {
    const result = await h.execute(overrides); assert.equal(result.status, 'blocked'); assert.equal(result.stage, 'owner-paths');
  }
  const absent = await mkdtemp(join(directory, 'unprepared-'));
  assert.equal((await h.execute({ home: absent })).stage, 'owner-paths');
  assert.equal(h.requests.length, 0); assert.equal(h.constructions(), 0); await assert.rejects(lstat(h.guard), e => e.code === 'ENOENT');
});
test('symlinked admission path is never followed or overwritten', async t => {
  const h = await executionFixture(t), foreign = await mkdtemp(join(directory, 'foreign-'));
  await symlink(foreign, h.guard, 'dir'); assert.equal((await h.execute()).stage, 'one-shot-guard');
  assert.deepEqual(await readdir(foreign), []); assert.equal(h.requests.length, 0); assert.equal(h.constructions(), 0);
});
test('one-shot CLI flushes plan output and exits even with an open handle; imports remain inert', async () => {
  const path = join(directory, 'execution-lifecycle.mjs');
  const owner = fileURLToPath(new URL('../scripts/floating-garden-active-update-execute-owner.mjs', import.meta.url));
  await writeFile(path, `setInterval(() => {}, 100000); process.argv[1] = ${JSON.stringify(owner)}; await import(${JSON.stringify(pathToFileURL(owner).href)});`);
  const result = execFileSync(process.execPath, [path, '--plan'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(result, /^UPDATE_PLAN_ONLY:/);
});

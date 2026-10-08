// Offline only. Actual immutable generators and local SDK copy, synthetic DB /
// CLI read responses. No credential file, cloud call, Firebase execution or RPC.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { main, matchOldReview, prepareCiReleaseFiles, createCiJournal, ciReleaseApproval, CI_RELEASE_RECOVERY, readCiOldHostingChannel, ciReleasePreparationFailure } from '../scripts/floating-garden-ci-release.mjs';
import { ACTIVE_UPDATE_SCOPE as S, activeUpdatePackets } from '../scripts/floating-garden-active-update.mjs';
import { validateSourceArchive } from '../scripts/floating-garden-trial-cloud-adapter.mjs';
import { stableFunctionConfiguration } from '../scripts/floating-garden-active-update-provider.mjs';
import { stableCiFunctionConfiguration } from '../scripts/floating-garden-ci-configuration.mjs';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const NOW = S.startsAtMillis + 10000, sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
let dir, oldRoot, generator, base, tooling;
const review = { schemaVersion: 1, startsAtMillis: S.startsAtMillis, endsAtMillis: S.endsAtMillis,
  testerUids: ['SYNTHETIC_Z', 'SYNTHETIC_A'], retainBuildArtifacts: true, allowInitialFunctionRecreate: true, approvePublicInvoker: true };
test.before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'garden-ci-release-test-')); oldRoot = join(dir, 'old-source'); await mkdir(oldRoot);
  const archive = execFileSync('git', ['archive', S.oldCommit, 'package.json', 'lab/floating-garden',
    'functions/floating-garden-online', 'functions/floating-garden-trial', 'scripts/prepare-floating-garden-trial.mjs',
    'scripts/prepare-floating-garden-trial-operation.mjs'], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', oldRoot], { input: archive });
  generator = await import(pathToFileURL(join(oldRoot, 'scripts/prepare-floating-garden-trial-operation.mjs')));
  base = await generator.prepareTrialOperation({ review, output: join(dir, 'old-packet'), repositoryRoot: oldRoot, now: NOW });
  tooling = join(dir, 'tooling'); await mkdir(join(tooling, 'node_modules/firebase-tools/lib/bin'), { recursive: true });
  await writeFile(join(tooling, 'package.json'), await readFile(join(ROOT, 'tests/fixtures/floating-garden-maintenance-package.json')));
  await writeFile(join(tooling, 'package-lock.json'), await readFile(join(ROOT, 'package-lock.json')));
  await writeFile(join(tooling, 'node_modules/firebase-tools/package.json'), '{"version":"14.27.0"}');
  await writeFile(join(tooling, 'node_modules/firebase-tools/lib/bin/firebase.js'), '// synthetic fixture; never run');
});
test.after(async () => { await rm(dir, { recursive: true, force: true }); });
test('entry default is inert and invalid arguments reveal no inputs', async () => {
  const out = []; assert.equal(await main([], { log: line => out.push(line) }), 0);
  assert.equal(await main(['--run-ci', 'DO_NOT_PRINT_PRIVATE_PATH'], { log: line => out.push(line) }), 2);
  assert(!out.join('\n').includes('DO_NOT_PRINT_PRIVATE_PATH')); assert(out[0].startsWith('CI_PLAN:'));
});
test('old marker reconstructs every exact roster order and flag combination from actual manifest schema', async () => {
  const manifest = JSON.parse(await readFile(base.manifestPath, 'utf8'));
  for (const pair of [review.testerUids, [...review.testerUids].reverse()]) for (let flags = 0; flags < 8; flags++) {
    const wanted = { ...review, testerUids: pair, retainBuildArtifacts: Boolean(flags & 1), allowInitialFunctionRecreate: Boolean(flags & 2), approvePublicInvoker: Boolean(flags & 4) };
    const packet = await generator.prepareTrialOperation({ review: wanted, output: join(dir, `candidate-${pair[0]}-${flags}`), repositoryRoot: oldRoot, now: NOW });
    const marker = `garden-trial-game-v1:${packet.manifestDigest}`;
    assert.deepEqual(matchOldReview(manifest, [...review.testerUids].sort(), marker, NOW), wanted);
  }
  assert.throws(() => matchOldReview(manifest, review.testerUids, `garden-trial-game-v1:${'0'.repeat(64)}`, NOW));
  assert.throws(() => matchOldReview(manifest, review.testerUids, 'foreign-private-marker', NOW));
});
test('full CI materialization uses real old/new generators, original marker and pinned SDK files with only one synthetic Hosting read', async () => {
  const calls = [], db = { collection(name) { assert.equal(name, 'floatingGardenTrialTesters'); return { limit(n) { assert.equal(n, 3); return { async get() { return { docs: [...review.testerUids].sort().map(id => ({ id, data: () => ({ active: false, expiresAtMillis: S.endsAtMillis }) })) }; } }; } }; } };
  const runner = (command, args, cwd) => {
    calls.push({ command, args, cwd }); assert.equal(command, process.execPath);
    if (args.includes('--version')) return { exitCode: 0, stdout: '14.27.0' };
    assert.deepEqual(args.slice(1), ['hosting:channel:list', '--site', S.project, '--project', S.project, '--config', join(dir, 'run/old-seed/game/firebase.hosting-only.json'), '--non-interactive', '--json']);
    return { exitCode: 0, stdout: JSON.stringify({ status: 'success', result: { channels: [{ name: `projects/${S.projectNumber}/sites/${S.project}/channels/live`, url: S.origin,
      release: { type: 'DEPLOY', message: `garden-trial-game-v1:${base.manifestDigest}`, version: { name: `projects/${S.project}/sites/${S.project}/versions/synthetic`, status: 'FINALIZED' } } }] } }) };
  };
  const oldFetch = globalThis.fetch; globalThis.fetch = () => { throw Error('network prohibited'); };
  let plan;
  try { plan = await prepareCiReleaseFiles({ db, workDir: join(dir, 'run'), toolingDir: tooling, runner, now: () => NOW }); }
  finally { globalThis.fetch = oldFetch; }
  const packets = activeUpdatePackets(plan); assert.deepEqual(packets.old.review, review); assert.deepEqual(packets.next.review, review);
  assert.equal(packets.old.packet.manifestDigest, base.manifestDigest); assert.equal(plan.unchangedFileCount, 35);
  assert.equal(calls.filter(c => c.args[1] === 'hosting:channel:list').length, 1); assert(calls.every(c => !c.args.includes('deploy')));
  const pkg = join(packets.next.packet.gameDir, 'functions/package.json'), require = createRequire(pkg);
  assert.equal(JSON.parse(await readFile(join(packets.next.packet.gameDir, 'functions/node_modules/firebase-admin/package.json'))).version, '12.7.0'); assert.equal(require('google-auth-library/package.json').version, '9.15.1');
  assert.equal((await lstat(join(dir, 'run'))).mode & 0o777, 0o700);
  // Exercise the pinned CLI's actual local config prerequisite and Gen2 ZIP
  // producer, not only our synthetic subprocess result shape.
  const toolRequire = createRequire(import.meta.url);
  const { Config } = toolRequire('firebase-tools/lib/config');
  const { requireConfig } = toolRequire('firebase-tools/lib/requireConfig');
  const configPath = calls.find(c => c.args[1] === 'hosting:channel:list').args;
  const options = { cwd: join(dir, 'run'), configPath: configPath[configPath.indexOf('--config') + 1] };
  options.config = Config.load(options); await requireConfig(options);
  assert.equal(options.config.get('hosting').site, S.project);
  await assert.rejects(requireConfig({}));
  const { prepareFunctionsUpload } = toolRequire('firebase-tools/lib/deploy/functions/prepareFunctionsUpload');
  const zipped = await prepareFunctionsUpload(join(packets.next.packet.gameDir, 'functions'),
    { source: 'functions', ignore: ['node_modules', '**/.*', '*-debug.log'] });
  try {
    const expected = Object.fromEntries(await Promise.all(Object.keys(packets.next.packet.manifest.files).filter(p => p.startsWith('game/functions/'))
      .map(async p => [p.slice(15), await readFile(join(packets.next.packet.output, p))])));
    assert.equal(validateSourceArchive(await readFile(zipped.pathToSource), expected).verified, true);
  } finally { await rm(zipped.pathToSource); }

  await assert.rejects(prepareCiReleaseFiles({ db, workDir: join(dir, 'run'), toolingDir: tooling, runner, now: () => NOW }));
  assert(!JSON.stringify(plan).includes('SYNTHETIC_'));
});
test('gcloud preserves source-hash and every other label/configuration exactly', () => {
  const proof = [{ function: { labels: { 'firebase-functions-hash': 'a'.repeat(40) }, buildConfig: {}, serviceConfig: {} },
    run: { labels: { 'firebase-functions-hash': 'a'.repeat(40), custom: 'retain' }, template: { containers: [] } }, iam: { etag: 'preserve' } }];
  const original = structuredClone(proof), before = stableCiFunctionConfiguration(proof, stableFunctionConfiguration);
  const changed = structuredClone(proof); changed[0].function.labels['firebase-functions-hash'] = 'b'.repeat(40);
  assert.notDeepEqual(before, stableCiFunctionConfiguration(changed, stableFunctionConfiguration)); assert.deepEqual(proof, original);
  for (const mutate of [p => delete p[0].function.labels['firebase-functions-hash'], p => p[0].run.labels.custom = 'changed', p => p[0].iam.etag = 'changed', p => p[0].function.unknown = 'extra']) {
    const p = structuredClone(proof); mutate(p); assert.notDeepEqual(before, stableCiFunctionConfiguration(p, stableFunctionConfiguration));
  }
  const bad = structuredClone(proof); bad[0].function.labels['firebase-functions-hash'] = 'not-a-hash'; assert.notDeepEqual(before, stableCiFunctionConfiguration(bad, stableFunctionConfiguration));
});
test('CI journal is fresh, private, fsynced, stage-limited and never a reusable owner record', async () => {
  const at = join(dir, 'journal'); await mkdir(at, { mode: 0o700 }); const journal = await createCiJournal(at, () => NOW);
  await journal.issued('closed-baseline'); await journal.verified('closed-baseline');
  await assert.rejects(journal.issued('closed-baseline')); await assert.rejects(journal.providerStep({ stage: 'private text', resourceKind: 'functions', index: 0 }));
  await journal.issued('functions'); await journal.providerStep({ stage: 'official-cli-functions', resourceKind: 'functions', index: 0 });
  await assert.rejects(journal.providerStep({ stage: 'official-cli-functions', resourceKind: 'functions', index: 0 }));
  await assert.rejects(journal.providerStep({ stage: 'official-cli-functions', resourceKind: 'functions', index: 2 }));
  await journal.providerStep({ stage: 'official-cli-functions', resourceKind: 'functions', index: 1 });
  await journal.fail('functions', 'source-proof', 'closed');
  const p = join(at, 'CI-RELEASE-JOURNAL.jsonl'); assert.equal((await lstat(p)).mode & 0o777, 0o600);
  assert(!String(await readFile(p)).includes('private text')); await assert.rejects(createCiJournal(at));
});
test('future release workflow is single push, fixed target and credential-free tests precede OIDC; prep workflow never gets deployment auth', async () => {
  const req = createRequire(import.meta.url), yaml = req('yaml');
  const deploy = yaml.parse(await readFile(join(ROOT, '.github/workflows/deploy-floating-garden-trial.yml'), 'utf8'));
  assert.deepEqual(deploy.on, { push: { branches: ['release/garden-trial'] } });
  assert.equal(deploy.concurrency['cancel-in-progress'], false); assert.deepEqual(deploy.permissions, { contents: 'read' });
  const job = deploy.jobs.release; assert.equal(job.environment, 'garden-trial'); assert.equal(job.permissions['id-token'], 'write');
  assert(job.if.includes('github.event.created == false') && job.if.includes("github.event.before == '74027567a8761e78423c8df0e744abc8d5633a8b'") && job.if.includes('github.run_attempt == 1'));
  const auth = job.steps.findIndex(s => s.uses?.startsWith('google-github-actions/auth@'));
  assert(auth > 0);
  assert(job.if.includes('github.run_number == 3'));
  assert(job.if.includes('github.event.after == github.sha') && job.if.includes('github.workflow_sha == github.sha') && job.if.includes('github.sha != github.event.before'));
  assert.equal(job.env.GARDEN_RELEASE_EVENT_BEFORE, '${{ github.event.before }}');
  assert.equal(job.env.GARDEN_RELEASE_EVENT_AFTER, '${{ github.event.after }}');
  assert(job.steps.slice(0, auth).some(s => s.run?.includes('tests/floating-garden-ci-trust-renewal.test.py')));
  const realSdkTest = job.steps.findIndex(s => s.run?.includes('node tests/floating-garden-ci-gcloud-sdk.integration.mjs'));
  assert(realSdkTest > 0 && realSdkTest < auth);
  assert(job.steps[realSdkTest].run.includes('tests/floating-garden-ci-trust-renewal.test.py --sdk-root'));
  const contextComment = await readFile(join(ROOT, 'scripts/floating-garden-ci-release.mjs'), 'utf8');
  assert(!contextComment.includes("GITHUB_RUN_NUMBER === '2'"));
  assert(job.steps.slice(0, auth).some(s => s.run?.includes('tests/floating-garden-ci-gcloud.test.mjs'))); assert(job.steps.slice(auth + 1).every(s => !s.uses && !/npm\s|curl\s|pip\s/.test(s.run || '')));
  assert(job.steps.every(s => !s.uses || /@[a-f0-9]{40}$/.test(s.uses)));
  assert(!JSON.stringify(deploy).includes('secrets.')); assert(!JSON.stringify(deploy).includes('upload-artifact'));
  const prep = yaml.parse(await readFile(join(ROOT, '.github/workflows/garden-ci-preparation-tests.yml'), 'utf8'));
  assert.deepEqual(Object.keys(prep.on), ['pull_request']); assert.deepEqual(prep.permissions, { contents: 'read' });
  // GitHub job-level env is evaluated before runner assignment. YAML parsing
  // alone misses this schema error; only step env may use runner.temp.
  for (const workflow of [deploy, prep]) for (const j of Object.values(workflow.jobs)) {
    assert(!JSON.stringify(j.env || {}).includes('runner.'), 'runner context forbidden in job env');
    const initialization = j.steps.find(s => s.env?.ISOLATED_GCLOUD);
    assert(initialization?.env.ISOLATED_GCLOUD.includes('${{ runner.temp }}'));
    assert(initialization.run.includes('$GITHUB_ENV') && initialization.run.includes('CLOUDSDK_CONFIG='));
  }
  assert(prep.jobs['offline-preparation'].steps.some(s => s.run?.includes('node tests/floating-garden-ci-gcloud-sdk.integration.mjs')));
  for (const path of ['scripts/floating-garden-ci-gcloud.mjs', 'tests/floating-garden-ci-gcloud.test.mjs', 'tests/floating-garden-ci-gcloud-sdk.test.py', 'tests/floating-garden-ci-gcloud-sdk.integration.mjs']) assert(prep.on.pull_request.paths.includes(path));
  assert(!JSON.stringify(prep).includes('google-github-actions/auth@')); assert(!JSON.stringify(prep).includes('id-token'));
});
test('approval contract discloses CLI effects and preserves original deadline and inventory', () => {
  const a = ciReleaseApproval('a'.repeat(40), '3'); assert.equal(a.expiresAtMillis, S.endsAtMillis);
  assert.equal(a.oldInventory, S.oldInventory); assert.equal(a.newInventory, S.newInventory);
  assert.equal(a.standardCliInternalRetriesAndParallelism, true); assert.equal(a.serviceIdentityGeneration, false); assert.equal(a.functionsDeployer, 'gcloud-568.0.0'); assert.equal(a.functionsSequential, true);
  assert.equal(a.runNumber, '3'); assert.equal(a.schemaVersion, 2); assert.equal(a.previousSourceCommit, CI_RELEASE_RECOVERY.before); assert.equal(a.releaseRefCreated, false); assert.equal(a.reopenSamePairOnce, true); assert.equal(a.exclusiveMaintenance, true);
});

const hostingPrefixes = [`sites/${S.project}`, `projects/${S.project}/sites/${S.project}`, `projects/${S.projectNumber}/sites/${S.project}`];
function hostingResponse(channelPrefix = hostingPrefixes[0], versionPrefix = hostingPrefixes[0]) {
  return { status: 'success', result: { channels: [{ name: `${channelPrefix}/channels/live`, url: S.origin,
    release: { type: 'DEPLOY', message: `garden-trial-game-v1:${'a'.repeat(64)}`,
      version: { name: `${versionPrefix}/versions/synthetic`, status: 'FINALIZED' } } }] } };
}
function hostingRaw(response = hostingResponse()) { return { exitCode: 0, stdout: JSON.stringify(response) }; }
function assertHostingFailure(raw, reason) {
  assert.throws(() => readCiOldHostingChannel(raw), error => {
    const result = ciReleasePreparationFailure(error);
    assert.deepEqual(result, { status: 'blocked', stage: 'preparation', reason, access: 'unknown', automaticRetry: false, automaticRollback: false });
    assert(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE'));
    return true;
  });
}
test('CI Hosting accepts exactly all nine project-ID/number/bare channel and version combinations', () => {
  for (const channelPrefix of hostingPrefixes) for (const versionPrefix of hostingPrefixes) {
    const response = hostingResponse(channelPrefix, versionPrefix);
    response.result.channels.push({ name: `${channelPrefix}/channels/synthetic.preview`, url: 'https://synthetic-preview.invalid', expireTime: '2026-10-07T00:00:00Z' });
    assert.deepEqual(readCiOldHostingChannel(hostingRaw(response)), response.result.channels[0]);
  }
});
test('CI Hosting diagnostic classes distinguish CLI failures and JSON/envelope schema without raw output', () => {
  for (const [raw, code] of [
    [null, 'cli-result'], [{ exitCode: 0, timedOut: true, signal: 'SYNTHETIC_PRIVATE' }, 'cli-timeout'],
    [{ exitCode: 0, signal: 'SYNTHETIC_PRIVATE' }, 'cli-signal'],
    [{ exitCode: 1, stdout: 'SYNTHETIC_PRIVATE', stderr: 'SYNTHETIC_PRIVATE' }, 'cli-exit'],
    [{ exitCode: null, stdout: 'SYNTHETIC_PRIVATE' }, 'cli-exit'],
    [{ exitCode: 0, stdout: 'SYNTHETIC_PRIVATE' }, 'json'], [{ exitCode: 0 }, 'json'],
    [hostingRaw(null), 'schema'], [hostingRaw([]), 'schema'],
    [hostingRaw({ status: 'SYNTHETIC_PRIVATE', result: {} }), 'response-status'],
    [hostingRaw({ status: 'success', result: null }), 'schema'],
    [hostingRaw({ status: 'success', result: { channels: {} } }), 'schema'],
  ]) assertHostingFailure(raw, `old-hosting-${code}`);
});
test('CI Hosting rejects foreign/malformed/ambiguous targets and unreviewed metadata with distinct safe reasons', () => {
  const cases = [
    [r => r.result.channels.push({ name: 'sites/foreign/channels/live' }), 'channel-schema'],
    [r => r.result.channels[0].name = `projects/foreign/sites/${S.project}/channels/live`, 'channel-schema'],
    [r => r.result.channels[0].name = `projects/${S.project}/sites/foreign/channels/live`, 'channel-schema'],
    [r => r.result.channels[0].name = `untrusted/${hostingPrefixes[0]}/channels/live`, 'channel-schema'],
    [r => r.result.channels[0].name += '/extra', 'channel-count'],
    [r => r.result.channels[0].name += '\n', 'channel-count'],
    [r => r.result.channels[0] = null, 'channel-schema'],
    [r => r.result.channels = [], 'channel-count'],
    [r => r.result.channels[0].name = `${hostingPrefixes[0]}/channels/preview`, 'channel-count'],
    [r => r.result.channels.push(structuredClone(r.result.channels[0])), 'channel-count'],
    [r => r.result.channels.push(hostingResponse(hostingPrefixes[1]).result.channels[0]), 'channel-count'],
    [r => r.result.channels[0].url += '/', 'url'],
    [r => r.result.channels[0].url = 'https://SYNTHETIC_PRIVATE.invalid', 'url'],
    [r => r.result.channels[0].expireTime = '2026-10-07T00:00:00Z', 'expiring-channel'],
    [r => delete r.result.channels[0].release, 'release-schema'],
    [r => r.result.channels[0].release.version = [], 'release-schema'],
    [r => r.result.channels[0].release.type = 'SITE_DISABLE', 'release-type'],
    [r => r.result.channels[0].release.version.status = 'DELETED', 'version-status'],
    [r => r.result.channels[0].release.version.name = 'sites/foreign/versions/synthetic', 'version-name'],
    [r => r.result.channels[0].release.version.name = `projects/foreign/${hostingPrefixes[0]}/versions/synthetic`, 'version-name'],
    [r => r.result.channels[0].release.version.name += '\n', 'version-name'],
    [r => r.result.channels[0].release.message = 'SYNTHETIC_PRIVATE', 'marker'],
    [r => r.result.channels[0].release.message += '\n', 'marker'],
  ];
  for (const [mutate, code] of cases) { const response = hostingResponse(); mutate(response); assertHostingFailure(hostingRaw(response), `old-hosting-${code}`); }
});
test('pinned official CLI preserves and paginates all three live-channel aliases; parser accepts its actual result', () => {
  // Isolated subprocess denies every network route before loading the official
  // command. Only Client.get is supplied with deterministic metadata pages.
  const source = `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { readCiOldHostingChannel } from './scripts/floating-garden-ci-release.mjs';
    const require = createRequire(import.meta.url);
    for (const name of ['node:http', 'node:https']) { const m = require(name); m.request = m.get = () => { throw Error('network forbidden'); }; }
    globalThis.fetch = () => { throw Error('network forbidden'); };
    const { Client } = require('firebase-tools/lib/apiv2');
    require('firebase-tools/lib/logger').logger.info = () => {};
    assert.equal(require('firebase-tools/package.json').version, '14.27.0');
    const { command } = require('firebase-tools/lib/commands/hosting-channel-list');
    const prefixes = ${JSON.stringify(hostingPrefixes)}, template = ${JSON.stringify(hostingResponse())};
    for (const prefix of prefixes) {
      const live = structuredClone(template.result.channels[0]); live.name = prefix + '/channels/live';
      let calls = 0;
      Client.prototype.get = async function(path, options) {
        assert.equal(path, '/projects/${S.project}/sites/${S.project}/channels');
        assert.equal(options.queryParams.pageSize, 10); calls++;
        if (calls === 1) { assert.equal(options.queryParams.pageToken, ''); return { body: { channels: [{ name: prefix + '/channels/preview' }], nextPageToken: 'synthetic-page-2' } }; }
        assert.equal(calls, 2); assert.equal(options.queryParams.pageToken, 'synthetic-page-2'); return { body: { channels: [live] } };
      };
      const result = await command.actionFn({ project: '${S.project}', site: '${S.project}' });
      assert.equal(calls, 2); assert.equal(result.channels.length, 2);
      assert.deepEqual(readCiOldHostingChannel({ exitCode: 0, stdout: JSON.stringify({ status: 'success', result }) }), live);
    }
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', source], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
});

test('CI preparation roster failures stop before all CLI reads and never disclose the pair', async () => {
  const original = review.testerUids.map(id => ({ id, active: false, expiresAtMillis: S.endsAtMillis }));
  const variants = [[], original.slice(1), [...original, { id: 'SYNTHETIC_PRIVATE_C', active: false, expiresAtMillis: S.endsAtMillis }],
    original.map((d, i) => i ? d : { ...d, active: true }), original.map((d, i) => i ? d : { ...d, expiresAtMillis: S.endsAtMillis + 1 }),
    original.map((d, i) => i ? d : { ...d, id: 'SYNTHETIC_PRIVATE/invalid' })];
  for (const [i, rows] of variants.entries()) {
    let calls = 0; const db = { collection: () => ({ limit: () => ({ get: async () => ({ docs: rows.map(d => ({ id: d.id, data: () => ({ active: d.active, expiresAtMillis: d.expiresAtMillis }) })) }) }) }) };
    await assert.rejects(prepareCiReleaseFiles({ db, workDir: join(dir, `invalid-roster-${i}`), toolingDir: tooling, runner: () => { calls++; throw Error('SYNTHETIC_PRIVATE'); }, now: () => NOW }), error => {
      assert.equal(ciReleasePreparationFailure(error).reason, 'closed-roster');
      assert(!JSON.stringify(ciReleasePreparationFailure(error)).includes('SYNTHETIC_')); return true;
    });
    assert.equal(calls, 0);
  }
});
test('CI Hosting spawn exception is classified without leaking command errors or retrying', async () => {
  let reads = 0; const db = { collection: () => ({ limit: () => ({ get: async () => ({ docs: review.testerUids.map(id => ({ id, data: () => ({ active: false, expiresAtMillis: S.endsAtMillis }) })) }) }) }) };
  const runner = (_, args) => { if (args.includes('--version')) return { exitCode: 0, stdout: '14.27.0' }; reads++; throw Error('SYNTHETIC_PRIVATE'); };
  await assert.rejects(prepareCiReleaseFiles({ db, workDir: join(dir, 'failed-hosting-spawn'), toolingDir: tooling, runner, now: () => NOW }), error => {
    assert.equal(ciReleasePreparationFailure(error).reason, 'old-hosting-cli-spawn'); assert(!JSON.stringify(ciReleasePreparationFailure(error)).includes('SYNTHETIC_PRIVATE')); return true;
  });
  assert.equal(reads, 1);
});

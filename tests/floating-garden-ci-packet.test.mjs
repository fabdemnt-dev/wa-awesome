// New, synthetic, offline CI-preparation tests only. No owner files or cloud SDK.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, lstat, chmod, symlink, link, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { prepareCiPacket, main } from '../scripts/prepare-floating-garden-ci-packet.mjs';
import { publicTrialConfig } from '../scripts/prepare-floating-garden-trial-operation.mjs';
import { ACTIVE_UPDATE_SCOPE as S } from '../scripts/floating-garden-active-update.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const NOW = S.startsAtMillis + 10000;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const review = () => ({ schemaVersion: 1, startsAtMillis: S.startsAtMillis, endsAtMillis: S.endsAtMillis,
  testerUids: ['SYNTHETIC_CI_PRIVATE_A', 'SYNTHETIC_CI_PRIVATE_B'], retainBuildArtifacts: false,
  allowInitialFunctionRecreate: false, approvePublicInvoker: false });
const json = async path => JSON.parse(await readFile(path, 'utf8'));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'garden-ci-packet-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reviewPath = join(root, 'private-review.json');
  await writeFile(reviewPath, JSON.stringify(review()), { mode: 0o600 });
  return { root, reviewPath, output: join(root, 'output'), now: () => NOW };
}
const prepare = h => prepareCiPacket({ reviewPath: h.reviewPath, output: h.output, now: h.now });
async function missing(path) { await assert.rejects(lstat(path), { code: 'ENOENT' }); }

test('exact deterministic full NPC packet, public config and bounded summary', async t => {
  const h = await fixture(t), first = await prepare(h);
  const packet = join(h.output, 'packet'), manifest = await json(join(packet, 'OPERATION-MANIFEST.json'));
  assert.equal(first.inventoryDigest, '41c44301490ecff08b0753d4af85679a04bfebdea8ad1981bd8a923c8a76a4ca');
  assert.equal(first.inventoryFileCount, 44);
  const files = Object.fromEntries(Object.keys(manifest.files).sort().map(key => [key, manifest.files[key]]));
  assert.equal(sha(JSON.stringify(files)), S.newInventory);
  for (const [name, expected] of Object.entries(files)) assert.equal(sha(await readFile(join(packet, name))), expected, name);
  assert.deepEqual(await json(join(h.output, 'CI-SUMMARY.json')), first);
  assert.deepEqual(first.trialWindow, { startsAtMillis: 1791157551472, endsAtMillis: 1791762351472 });
  assert.equal(first.project, S.project); assert.equal(first.site, S.project); assert.equal(first.region, S.region); assert.equal(first.origin, S.origin);
  const runtime = await readFile(join(packet, 'game/public/lab/floating-garden/trial/trialruntime.js'), 'utf8');
  assert.ok(runtime.includes(JSON.stringify(publicTrialConfig(review()), null, 2)));
  const admin = await json(join(packet, 'game/ADMIN-RECORDS-REVIEW.json'));
  assert.equal(admin['floatingGardenTrial/config'].enabled, false);
  assert.deepEqual(admin['floatingGardenTrial/config'].testerUids, []);
  assert.equal((await lstat(h.output)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(packet, 'private-review.json'))).mode & 0o777, 0o600);
  assert.equal((await lstat(join(h.output, 'CI-SUMMARY.json'))).mode & 0o777, 0o600);
  const different = { ...review(), testerUids: ['SYNTHETIC_OTHER_A', 'SYNTHETIC_OTHER_B'],
    retainBuildArtifacts: true, allowInitialFunctionRecreate: true, approvePublicInvoker: true };
  await writeFile(h.reviewPath, JSON.stringify(different));
  const second = await prepare({ ...h, output: join(h.root, 'second'), now: () => NOW + 1000 });
  assert.deepEqual(second, first);
  const summary = JSON.stringify(first);
  for (const forbidden of ['SYNTHETIC_', 'testerUids', 'retainBuildArtifacts', 'allowInitialFunctionRecreate', 'approvePublicInvoker',
    'reviewDigest', h.root, 'apiKey', 'siteKey', 'FLOATING_GARDEN_INVITE_HMAC_KEY']) assert.ok(!summary.includes(forbidden), forbidden);
});

test('commands are exact five named selectors, dedicated rules and dedicated hosting only', async t => {
  const h = await fixture(t), summary = await prepare(h);
  const names = ['floatingGardenCreateRoom', 'floatingGardenJoinRoom', 'floatingGardenStartMatch', 'floatingGardenGetSnapshot', 'floatingGardenSubmitAction'];
  const expected = (config, only) => ({ cwd: 'packet/game', argv: ['firebase', '--config', config, '--project',
    'wa-awesome-garden-stg', 'deploy', '--only', only] });
  assert.deepEqual(summary.commandsNotExecuted, {
    functions: expected('firebase.trial.json', names.map(name => `functions:floating-garden-trial:${name}`).join(',')),
    rules: expected('firebase.trial.json', 'firestore:rules'),
    hosting: expected('firebase.hosting-only.json', 'hosting:wa-awesome-garden-stg'),
  });
  const firebase = await json(join(h.output, 'packet/game/firebase.trial.json'));
  assert.deepEqual(Object.keys(firebase).sort(), ['firestore', 'functions', 'hosting']);
  assert.deepEqual(Object.keys(firebase.functions).sort(), ['codebase', 'ignore', 'source']);
  assert.ok(!JSON.stringify(summary.commandsNotExecuted).includes('--force'));
});

test('unknown fields, target/config overrides, malformed reviews and changed windows fail before output', async t => {
  const h = await fixture(t);
  const changes = [{ projectId: 'wa-awesome' }, { region: 'us-central1' }, { previewOrigin: 'https://example.invalid' },
    { config: {} }, { unknown: 'SYNTHETIC_SECRET' }, { startsAtMillis: S.startsAtMillis + 1, endsAtMillis: S.endsAtMillis + 1 },
    { endsAtMillis: S.endsAtMillis + 1 }, { schemaVersion: 2 }, { testerUids: ['same', 'same'] }, { approvePublicInvoker: 'true' }];
  for (const change of changes) {
    await writeFile(h.reviewPath, JSON.stringify({ ...review(), ...change }));
    await assert.rejects(prepare(h)); await missing(h.output);
  }
  for (const extra of [{ project: S.project }, { repositoryRoot: ROOT }, { config: publicTrialConfig(review()) }, { apply: true }]) {
    await assert.rejects(prepareCiPacket({ reviewPath: h.reviewPath, output: h.output, now: h.now, ...extra }));
  }
});

test('private regular input only, with bounded parsing and safe CLI errors', async t => {
  const h = await fixture(t), canary = 'SYNTHETIC_SECRET_NOT_FOR_OUTPUT';
  await writeFile(h.reviewPath, canary);
  const lines = [];
  assert.equal(await main(['--review', h.reviewPath, '--out', h.output], { log: value => lines.push(value), now: h.now }), 1);
  assert.equal(lines.length, 1); assert.ok(!lines[0].includes(canary)); assert.ok(!lines[0].includes(h.root));
  await missing(h.output);
  await writeFile(h.reviewPath, JSON.stringify(review())); await chmod(h.reviewPath, 0o644);
  await assert.rejects(prepare(h)); await chmod(h.reviewPath, 0o600);
  const symbolic = join(h.root, 'symbolic'), hard = join(h.root, 'hard');
  await symlink(h.reviewPath, symbolic); await assert.rejects(prepare({ ...h, reviewPath: symbolic }));
  await link(h.reviewPath, hard); await assert.rejects(prepare(h)); await rm(hard);
  await assert.rejects(prepare({ ...h, reviewPath: h.root }));
  await assert.rejects(prepare({ ...h, reviewPath: './private-review.json' }));
  await writeFile(h.reviewPath, ' '.repeat(8193)); await assert.rejects(prepare(h));
  await missing(h.output);
});

test('existing, repository, relative and symlink outputs never overwrite or create source artifacts', async t => {
  const h = await fixture(t);
  await mkdir(h.output); const canary = join(h.output, 'canary'); await writeFile(canary, 'KEEP');
  await assert.rejects(prepare(h)); assert.equal(await readFile(canary, 'utf8'), 'KEEP');
  const invalid = join(ROOT, 'invalid-ci-packet-output');
  await assert.rejects(prepare({ ...h, output: invalid })); await missing(invalid);
  await assert.rejects(prepare({ ...h, output: 'relative-output' }));
  const target = join(h.root, 'target'), symbolic = join(h.root, 'symbolic');
  await mkdir(target); await symlink(target, symbolic);
  await assert.rejects(prepare({ ...h, output: join(symbolic, 'output') })); assert.deepEqual(await readdir(target), []);
  const dangling = join(h.root, 'dangling'); await symlink(join(h.root, 'absent'), dangling);
  await assert.rejects(prepare({ ...h, output: dangling }));
});

test('original deadline is enforced initially and after generation; no late success marker', async t => {
  const h = await fixture(t);
  for (const time of [S.endsAtMillis, S.endsAtMillis + 1, S.startsAtMillis - 7 * 86400000 - 1, NaN, '1791157551472']) {
    await assert.rejects(prepare({ ...h, now: () => time })); await missing(h.output);
  }
  let calls = 0;
  await assert.rejects(prepare({ ...h, now: () => ++calls < 3 ? S.endsAtMillis - 1 : S.endsAtMillis }));
  await missing(join(h.output, 'CI-SUMMARY.json'));
  assert.ok(await lstat(join(h.output, 'packet/OPERATION-MANIFEST.json')));
  await assert.rejects(prepare(h)); // Incomplete output is not overwritten or retried.
});

test('source drift rejects the entire generated inventory before success', async t => {
  const h = await fixture(t), source = join(h.root, 'source');
  for (const part of ['scripts', 'lab/floating-garden', 'functions/floating-garden-trial', 'functions/floating-garden-online']) {
    await mkdir(dirname(join(source, part)), { recursive: true }); await cp(join(ROOT, part), join(source, part), { recursive: true });
  }
  await cp(join(ROOT, 'package.json'), join(source, 'package.json'));
  const changed = join(source, 'lab/floating-garden/online/controller.js');
  await writeFile(changed, `${await readFile(changed, 'utf8')}\n// Synthetic source drift.\n`);
  const copy = await import(pathToFileURL(join(source, 'scripts/prepare-floating-garden-ci-packet.mjs')));
  await assert.rejects(copy.prepareCiPacket({ reviewPath: h.reviewPath, output: h.output, now: h.now }), /CI packet blocked/);
  await missing(join(h.output, 'CI-SUMMARY.json'));
});

test('CLI rejects apply and unknown targets without reading inputs or logging their values', async () => {
  for (const args of [[], ['--plan']]) {
    const lines = []; assert.equal(await main(args, { log: value => lines.push(value) }), 0); assert.equal(lines.length, 1);
  }
  for (const args of [['--apply'], ['--project', 'SYNTHETIC_SECRET'], ['--review', '/absent', '--out', '/absent', '--force'],
    ['--out', '/absent', '--review', '/absent'], ['--review', '/absent', '--out', '/absent', '--now', String(NOW)]]) {
    const lines = []; assert.equal(await main(args, { log: value => lines.push(value) }), 1);
    assert.equal(lines.length, 1); assert.ok(!lines[0].includes('SYNTHETIC_SECRET')); assert.ok(!lines[0].includes('/absent'));
  }
});

test('fresh process has no HOME, PATH, SDK initialization, network or subprocess dependency', async t => {
  const h = await fixture(t);
  const code = `
    import Module from 'node:module';
    import { syncBuiltinESMExports } from 'node:module';
    import child from 'node:child_process';
    import net from 'node:net'; import http from 'node:http'; import https from 'node:https';
    const deny = () => { throw Error('Forbidden external capability'); };
    globalThis.fetch = deny;
    for (const key of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) child[key] = deny;
    net.connect = net.createConnection = http.request = http.get = https.request = https.get = deny;
    syncBuiltinESMExports();
    const load = Module._load;
    Module._load = function(name, ...rest) { if (/firebase-admin|firebase-tools|google-auth-library|@google-cloud/.test(name)) deny(); return load.call(this, name, ...rest); };
    const { main } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'scripts/prepare-floating-garden-ci-packet.mjs')).href)});
    process.exitCode = await main(${JSON.stringify(['--review', h.reviewPath, '--out', h.output])}, { now: () => ${NOW} });
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: h.root, env: { HOME: join(h.root, 'nonexistent-home'), PATH: '' }, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(JSON.parse(output).inventoryDigest, S.newInventory);
  assert.ok(!output.includes('SYNTHETIC_CI_PRIVATE')); await missing(join(h.root, 'nonexistent-home'));
});

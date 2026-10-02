import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { deployMaintenance, writeBundle, checkBundle, sitePresent, liveChannel, canonicalVersionName, PROJECT, PROJECT_NUMBER, ORIGIN, MESSAGE, HTML, CONFIG, CONFIG_FILE } from '../scripts/deploy-floating-garden-maintenance.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const site = { name: `projects/${PROJECT_NUMBER}/sites/${PROJECT}`, defaultUrl: ORIGIN };
const live = () => ({ name: `sites/${PROJECT}/channels/live`, url: ORIGIN });
const version = `sites/${PROJECT}/versions/safe-version-1`;
const released = () => ({ ...live(), release: { message: MESSAGE, type: 'DEPLOY', version: { name: version, status: 'FINALIZED' } } });
const manifests = {
  'package.json': readFileSync(join(root, 'tests/fixtures/floating-garden-maintenance-package.json')),
  'package-lock.json': readFileSync(join(root, 'package-lock.json')),
};
const success = (result) => JSON.stringify({ status: 'success', result });
function harness(t, options = {}) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'garden-maintenance-test-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  const commands = [], downloads = [], logs = [];
  let present = !options.missingSite, didDeploy = false, created = false, postCreateReads = 0;
  const waits = [];
  const fetchImpl = async (url, request) => {
    downloads.push({ url, request });
    const name = url.split('/').pop();
    const hosted = url.startsWith(`${ORIGIN}/`);
    let body = hosted ? HTML : manifests[name];
    if (options.wrongDeepLink && url === `${ORIGIN}/lab/floating-garden/trial/index.html`) body = 'game';
    if (options.badChecksum && name === 'package.json') body = Buffer.from('bad');
    if (options.wrongPage && url === `${ORIGIN}/`) body = 'different';
    assert.ok(body, `unexpected network target ${url}`);
    return new Response(body, { status: url === `${ORIGIN}/lab/floating-garden/trial/index.html` ? 404 : 200, headers: { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store, max-age=0', 'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } });
  };
  const run = (command, args, cwd, inherited) => {
    commands.push({ command, args, cwd, inherited });
    if (command === 'gcloud') {
      if (options.deniedRead) throw Error('permission denied');
      return args[0] === 'projects' ? `${PROJECT}\t${options.wrongProject ? '999' : PROJECT_NUMBER}\n` : (options.missingApi ? 'storage.googleapis.com' : 'firebasehosting.googleapis.com\nstorage.googleapis.com');
    }
    if (command === 'npm') return '';
    assert.ok(command.endsWith('/tooling/node_modules/.bin/firebase'));
    if (args[0] === '--version') return options.wrongCli ? '99.0.0' : '14.27.0\n';
    assert.deepEqual(args.slice(-4), ['--project', PROJECT, '--non-interactive', '--json']);
    assert.equal(args.at(-6), '--config');
    assert.equal(args.filter((arg) => arg === '--config').length, 1);
    assert.ok(args.at(-5).endsWith(`/bundle/${CONFIG_FILE}`));
    if (args[0] === 'hosting:sites:list') {
      if (created) postCreateReads++;
      if (created && options.malformedAfterCreate) return '{}';
      if (created && options.transientSiteRead && postCreateReads === 1) throw Error('not propagated');
      const visible = present && !(created && (options.neverReady || postCreateReads <= (options.siteDelay || 0)));
      return options.badInventory ? '{}' : success({ sites: visible ? [site] : [] });
    }
    if (args[0] === 'hosting:sites:create') { present = true; created = true; return success(options.wrongCreatedSite ? { ...site, defaultUrl: 'https://evil.example' } : site); }
    if (args[0] === 'hosting:channel:list') {
      if (created && postCreateReads <= (options.channelDelay || 0)) return success({ channels: [] });
      assert.equal(args[2], PROJECT);
      if (options.mutateBundle && !didDeploy) options.mutateBundle(dirname(args.at(-5)));
      if (didDeploy) return success({ channels: [options.wrongFinalVersion ? { ...released(), release: { ...released().release, version: { name: `sites/${PROJECT}/versions/other`, status: 'FINALIZED' } } } : (options.finalChannel || released())] });
      return success({ channels: options.existing ? [options.existing] : [live()] });
    }
    if (args[0] === 'deploy') {
      assert.deepEqual(args.slice(0, 3), ['deploy', '--only', `hosting:${PROJECT}`]);
      assert.equal(args[3], '--message'); assert.equal(args[4], MESSAGE);
      if (options.failDeploy) throw Error('deployment failed');
      didDeploy = true; return success({ hosting: options.deployVersion ?? version });
    }
    throw Error(`Unexpected command ${args[0]}`);
  };
  const perform = () => deployMaintenance({ approved: true, run, fetchImpl, tempRoot, log: (x) => logs.push(x), sleep: async (ms) => waits.push(ms) });
  const mutations = () => commands.filter((c) => ['deploy', 'hosting:sites:create'].includes(c.args[0]));
  return { perform, commands, downloads, logs, mutations, tempRoot, waits };
}
test('maintenance helper defaults to a non-mutating plan and rejects other flags', () => {
  const script = join(root, 'scripts/deploy-floating-garden-maintenance.mjs');
  assert.match(execFileSync(process.execPath, [script], { encoding: 'utf8' }), /No API enablement/);
  assert.throws(() => execFileSync(process.execPath, [script, '--project', 'wa-awesome'], { stdio: 'pipe' }));
});
test('maintenance helper requires explicit approval before any subprocess', async () => {
  await assert.rejects(deployMaintenance({ run: () => assert.fail('must not run') }), /Explicit/);
});
test('maintenance helper stops on wrong project, denied read or missing API before downloads/mutations', async (t) => {
  for (const options of [{ wrongProject: true }, { deniedRead: true }, { missingApi: true }]) {
    const h = harness(t, options); await assert.rejects(h.perform());
    assert.equal(h.downloads.length, 0); assert.equal(h.mutations().length, 0);
  }
});
test('maintenance helper pins dependency manifests and CLI version before cloud writes', async (t) => {
  for (const options of [{ badChecksum: true }, { wrongCli: true }]) {
    const h = harness(t, options); await assert.rejects(h.perform()); assert.equal(h.mutations().length, 0);
  }
});
test('maintenance helper publishes only a verified new garden live release and reads it back', async (t) => {
  const h = harness(t); assert.deepEqual(await h.perform(), { origin: ORIGIN, deployed: true });
  assert.equal(h.mutations().length, 1);
  assert.match(h.logs.at(-2), /Verified:/);
  assert.deepEqual(h.commands.find((c) => c.command === 'npm').args, ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  assert.equal(h.downloads.filter((d) => d.url === `${ORIGIN}/`).length, 1);
  assert.ok(h.downloads.every((d) => d.request.redirect === 'error'));
  const allArgs = h.commands.flatMap((c) => c.args);
  for (const forbidden of ['--force', '--dry-run', 'login', 'enable', 'functions', 'firestore:rules', 'iam', 'secrets', 'hosting:channel:deploy']) assert.ok(!allArgs.includes(forbidden));
});
test('maintenance helper creates only the exact missing site and re-reads it before deployment', async (t) => {
  const h = harness(t, { missingSite: true }); await h.perform();
  assert.equal(h.mutations().length, 2);
  assert.deepEqual(h.mutations()[0].args.slice(0, 2), ['hosting:sites:create', PROJECT]);
  assert.equal(h.commands.filter((c) => c.args[0] === 'hosting:sites:list').length, 2);
});
test('maintenance helper rejects malformed inventories and mismatched create result', async (t) => {
  for (const options of [{ badInventory: true }, { missingSite: true, wrongCreatedSite: true }]) {
    const h = harness(t, options); await assert.rejects(h.perform()); assert.equal(h.commands.filter((c) => c.args[0] === 'deploy').length, 0);
  }
});
test('maintenance helper refuses existing unrecognized live content rather than replacing it', async (t) => {
  const existing = released(); existing.release.message = 'some-other-application';
  const h = harness(t, { existing }); await assert.rejects(h.perform(), /not recognized/); assert.equal(h.mutations().length, 0);
});
test('maintenance helper is a read-only no-op for verified maintenance URLs with inventory limitation disclosed', async (t) => {
  const h = harness(t, { existing: released() });
  assert.deepEqual(await h.perform(), { origin: ORIGIN, deployed: false, existingReleaseInventoryVerified: false }); assert.equal(h.mutations().length, 0);
  assert.ok(h.logs.some((line) => /full existing release inventory was not audited/.test(line)));
  assert.equal(h.downloads.filter((d) => d.url.startsWith(ORIGIN)).length, 3);
});
test('maintenance helper does not retry writes after deploy failure, wrong release or wrong served bytes', async (t) => {
  for (const options of [{ failDeploy: true }, { wrongFinalVersion: true }, { wrongPage: true }, { wrongDeepLink: true }]) {
    const h = harness(t, options); await assert.rejects(h.perform()); assert.equal(h.mutations().length, 1);
    assert.ok(!h.logs.some((s) => s.startsWith('Verified:')));
  }
});
test('maintenance helper rejects hooks/rewrites, extra assets and symlinks immediately before deploy', async (t) => {
  for (const mutateBundle of [
    (dir) => { const config = JSON.parse(CONFIG); config.hosting.predeploy = 'touch /tmp/unsafe'; writeFileSync(join(dir, CONFIG_FILE), JSON.stringify(config)); },
    (dir) => { const config = JSON.parse(CONFIG); config.hosting.rewrites = [{ source: '**', function: 'other' }]; writeFileSync(join(dir, CONFIG_FILE), JSON.stringify(config)); },
    (dir) => writeFileSync(join(dir, 'public', 'extra.js'), 'alert(1)'),
    (dir) => { const html = join(dir, 'public/index.html'); rmSync(html); symlinkSync(join(dir, CONFIG_FILE), html); },
  ]) {
    const h = harness(t, { mutateBundle }); await assert.rejects(h.perform()); assert.equal(h.mutations().length, 0);
  }
});
test('maintenance static bundle has only reviewed files and cannot load active content', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'garden-maintenance-bundle-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeBundle(dir); checkBundle(dir);
  assert.deepEqual(Object.keys(JSON.parse(CONFIG)), ['hosting']);
  assert.doesNotMatch(HTML, /<script|<link|<iframe|\bon\w+\s*=|https?:/i);
  assert.ok(readdirSync(join(dir, 'public')).includes('index.html'));
});
test('maintenance metadata validators reject wrong origin, expiry, duplicates and malformed arrays', () => {
  assert.throws(() => sitePresent({ sites: [{ ...site, defaultUrl: 'https://wa-awesome.web.app' }] }));
  assert.throws(() => sitePresent({ sites: [site, site] }));
  assert.throws(() => sitePresent({}));
  assert.throws(() => liveChannel({ channels: [{ ...live(), expireTime: 'tomorrow' }] }));
  assert.throws(() => liveChannel({ channels: [{ ...live(), url: 'https://evil.example' }] }));
  assert.throws(() => liveChannel({ channels: [live(), live()] }));
  assert.throws(() => liveChannel({ channels: [] }));
  assert.throws(() => liveChannel({ channels: [{ ...live(), release: false }] }));
  assert.throws(() => liveChannel({ channels: [{ name: 'projects/wa-awesome/sites/wa-awesome/channels/live' }] }));
});

test('maintenance helper embeds the exact independently generated closed-live static bundle', async () => {
  const { CLOSED_LIVE_HTML, CLOSED_LIVE_CONFIG_JSON } = await import('../scripts/prepare-floating-garden-trial.mjs');
  assert.equal(HTML, CLOSED_LIVE_HTML); assert.equal(CONFIG, CLOSED_LIVE_CONFIG_JSON);
});

test('maintenance helper retries only inventory reads during verified new-site propagation', async (t) => {
  for (const options of [{ siteDelay: 2 }, { channelDelay: 2 }, { transientSiteRead: true }]) {
    const h = harness(t, { missingSite: true, ...options });
    assert.deepEqual(await h.perform(), { origin: ORIGIN, deployed: true });
    assert.equal(h.commands.filter((c) => c.args[0] === 'hosting:sites:create').length, 1);
    assert.equal(h.commands.filter((c) => c.args[0] === 'deploy').length, 1);
    assert.ok(h.waits.length >= 1 && h.waits.length <= 12);
    assert.ok(h.waits.every((ms) => ms === 15000));
  }
});
test('maintenance helper bounds new-site read retries without retrying a write or deploying', async (t) => {
  const h = harness(t, { missingSite: true, neverReady: true });
  await assert.rejects(h.perform(), /New site is not readable yet/);
  assert.equal(h.waits.length, 12);
  assert.equal(h.commands.filter((c) => c.args[0] === 'hosting:sites:create').length, 1);
  assert.equal(h.commands.filter((c) => c.args[0] === 'deploy').length, 0);
});

test('explicit helper config blocks ancestor Firebase configuration and project-alias discovery', (t) => {
  const require = createRequire(import.meta.url);
  const { detectProjectRoot } = require('firebase-tools/lib/detectProjectRoot');
  const { loadRC } = require('firebase-tools/lib/rc');
  const parent = mkdtempSync(join(tmpdir(), 'garden-ancestor-config-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  writeFileSync(join(parent, 'firebase.json'), JSON.stringify({ hosting: { site: 'wa-awesome', public: '.' } }));
  writeFileSync(join(parent, '.firebaserc'), JSON.stringify({ projects: { [PROJECT]: 'wa-awesome' } }));
  const bundle = mkdtempSync(join(parent, 'isolated-bundle-'));
  writeBundle(bundle);
  const options = { cwd: parent, configPath: join(bundle, CONFIG_FILE) };
  assert.equal(detectProjectRoot(options), bundle);
  assert.equal(loadRC(options).resolveAlias(PROJECT), PROJECT);
});

test('maintenance helper stops immediately on malformed new-site read results', async (t) => {
  const h = harness(t, { missingSite: true, malformedAfterCreate: true });
  await assert.rejects(h.perform(), /CLI did not confirm success/);
  assert.equal(h.waits.length, 0);
  assert.equal(h.mutations().length, 1);
  assert.equal(h.commands.filter((c) => c.args[0] === 'deploy').length, 0);
});

// Sanitized real API shape observed after the operator's 2026-10-02 deployment.
// Resource identities are exact; this synthetic version ID contains no user data.
function prefixedRelease(project = PROJECT) {
  return { name: `projects/${project}/sites/${PROJECT}/channels/live`, url: ORIGIN,
    release: { name: `projects/${project}/sites/${PROJECT}/channels/live/releases/fixture-release`,
      message: MESSAGE, type: 'DEPLOY', version: { name: `projects/${project}/${version}`, status: 'FINALIZED', fileCount: '2' } } };
}
test('maintenance version identity normalizes only exact dedicated project ID/number forms', () => {
  for (const input of [version, `projects/${PROJECT}/${version}`, `projects/${PROJECT_NUMBER}/${version}`]) assert.equal(canonicalVersionName(input), version);
  for (const input of [undefined, null, {}, '', `projects/wa-awesome/${version}`, `projects/999/${version}`, `projects/-/${version}`, `projects/${PROJECT}/sites/wa-awesome/versions/safe-version-1`, `${version}/`, `${version}?x=1`, `${version}#x`, `${version}\n`, `${version}\r\n`, `${version}/../other`, `/${version}`, `https://firebasehosting.googleapis.com/v1beta1/${version}`]) assert.throws(() => canonicalVersionName(input));
});
test('observed project-prefixed finalized maintenance release is a verified no-write outcome', async (t) => {
  for (const project of [PROJECT, PROJECT_NUMBER]) {
    const h = harness(t, { existing: prefixedRelease(project) });
    assert.deepEqual(await h.perform(), { origin: ORIGIN, deployed: false, existingReleaseInventoryVerified: false });
    assert.equal(h.mutations().length, 0);
    assert.equal(h.downloads.filter((d) => d.url.startsWith(ORIGIN)).length, 3);
  }
});
test('post-deploy identity comparison accepts equivalent API resource forms, never a different version', async (t) => {
  for (const deployVersion of [version, `projects/${PROJECT}/${version}`, `projects/${PROJECT_NUMBER}/${version}`]) {
    for (const finalChannel of [released(), prefixedRelease(PROJECT), prefixedRelease(PROJECT_NUMBER)]) {
      const h = harness(t, { deployVersion, finalChannel });
      assert.deepEqual(await h.perform(), { origin: ORIGIN, deployed: true });
      assert.equal(h.mutations().length, 1);
    }
  }
  for (const deployVersion of [`projects/other-project/${version}`, `projects/${PROJECT}/sites/other-site/versions/safe-version-1`, `projects/${PROJECT}/sites/${PROJECT}/versions/other-version`]) {
    const h = harness(t, { deployVersion, finalChannel: prefixedRelease() });
    await assert.rejects(h.perform()); assert.equal(h.mutations().length, 1);
    assert.ok(!h.logs.some((s) => s.startsWith('Verified:')));
  }
});
test('project prefix support does not relax marker, release type, finalized state or project/site guards', async (t) => {
  for (const mutate of [
    (r) => { r.release.message = 'unrecognized'; }, (r) => { r.release.type = 'ROLLBACK'; },
    (r) => { r.release.type = 'TYPE_UNSPECIFIED'; }, (r) => { delete r.release.type; },
    (r) => { r.release.version.status = 'CREATED'; }, (r) => { delete r.release.version.status; },
    (r) => { r.release.version.name = `projects/wa-awesome/${version}`; },
    (r) => { r.release.version.name = `projects/${PROJECT}/sites/wa-awesome/versions/safe-version-1`; },
  ]) {
    const existing = prefixedRelease(); mutate(existing); const h = harness(t, { existing });
    await assert.rejects(h.perform()); assert.equal(h.mutations().length, 0);
  }
});

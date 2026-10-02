import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, rm, writeFile, cp, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
const { calculateChannelExpireTTL } = createRequire(import.meta.url)('firebase-tools/lib/hosting/expireUtils.js');
import { join, resolve, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { prepareTrialBundle, prepareClosedPreview, prepareClosedLive, CLOSED_LIVE_HTML, CLOSED_LIVE_CONFIG_JSON, reviewPlan, previewExpiryMinutes, FUNCTION_NAMES } from '../scripts/prepare-floating-garden-trial.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const start = Date.parse('2026-10-02T00:00:00Z');
const configuration = () => ({ schemaVersion: 1, enabled: true, projectId: 'garden-trial-check', previewOrigin: 'https://garden-trial-check--garden-7day-a1b2c3.web.app', startsAtMillis: start, endsAtMillis: start + 7 * 86400000, region: 'asia-northeast1', maxTesters: 2, maxRooms: 20, firebase: { apiKey: 'AIza' + 'a'.repeat(35), authDomain: 'garden-trial-check.firebaseapp.com', projectId: 'garden-trial-check', appId: '1:123456789:web:abcdef0123456789' }, appCheck: { provider: 'recaptcha-enterprise', siteKey: '6L' + 'a'.repeat(38), verified: true } });
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const sourceFiles = [
  ...['engine.js', 'match-engine.js', 'session.js', 'view.js', 'match-rule-examples.js', 'style.css', 'match-style.css'].map((name) => `lab/floating-garden/${name}`),
  ...['controller.js', 'mount.js', 'view.js', 'style.css'].map((name) => `lab/floating-garden/online/${name}`),
  ...['index.html', 'app.js', 'bootstrap.js', 'config.js', 'firebase.js', 'style.css'].map((name) => `lab/floating-garden/trial/${name}`),
  ...['index.js', 'trial-handlers.js', 'config.js', 'package.json', 'package-lock.json'].map((name) => `functions/floating-garden-trial/${name}`),
  ...['handlers.js', 'contract.js', 'invite-code.js', 'core/engine.js', 'core/match-engine.js', 'core/package.json'].map((name) => `functions/floating-garden-online/${name}`),
].sort();
const generatedFiles = ['functions/trial-config.json', 'public/lab/floating-garden/trial/trialruntime.js', 'firestore.rules', 'firestore.indexes.json', 'firebase.trial.json', 'ADMIN-RECORDS-REVIEW.json', 'REVIEW-PLAN.json', 'SOURCE-SHA256.json'];
function outputPath(source) { return source.startsWith('lab/') ? 'public/' + source : source.replace('functions/floating-garden-trial/', 'functions/').replace('functions/floating-garden-online/', 'functions/online/'); }
async function sourceFixture(dir) {
  const source = join(dir, 'source');
  for (const path of [...sourceFiles, 'functions/floating-garden-trial/firestore.rules.template']) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await cp(join(root, path), join(source, path));
  }
  return source;
}
async function list(path, prefix = '') { const result = []; for (const item of await readdir(path, { withFileTypes: true })) { const part = prefix + item.name; if (item.isDirectory()) result.push(...await list(join(path, item.name), part + '/')); else result.push(part); } return result.sort(); }
async function temporary(t) { const path = await mkdtemp(join(tmpdir(), 'garden-trial-package-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }

test('trial bundle has one new project, exactly five isolated functions, complete public imports and immutable trusted core', async (t) => {
  const dir = await temporary(t), output = join(dir, 'bundle');
  const originalConfig = await readFile(join(root, 'firebase.json'));
  const originalRules = await readFile(join(root, 'firestore.rules'));
  const result = await prepareTrialBundle({ config: configuration(), output, now: start });
  const firebase = await json(join(output, 'firebase.trial.json'));
  assert.deepEqual(firebase.functions, { source: 'functions', codebase: 'floating-garden-trial', ignore: ['node_modules', '**/.*', '*-debug.log'] });
  assert.equal(firebase.hosting.site, configuration().projectId); assert.equal(firebase.hosting.public, 'public');
  assert.equal(Object.hasOwn(firebase, 'database'), false);
  const plan = await json(join(output, 'REVIEW-PLAN.json'));
  assert.deepEqual(plan.functionNames, FUNCTION_NAMES); assert.equal(plan.requiredNewDefaultDatabase.location, 'asia-northeast1');
  assert.equal(plan.mode, 'review-only-not-executed');
  for (const command of Object.values(plan.commandsNotExecuted)) {
    assert.equal(command[command.indexOf('--project') + 1], configuration().projectId);
    assert.ok(!command.includes('--force')); assert.ok(!command.includes('wa-awesome'));
  }
  assert.ok(plan.commandsNotExecuted.preview.includes('--no-authorized-domains'));
  assert.ok(plan.commandsNotExecuted.preview.includes('<RECALCULATE_AT_APPROVED_EXECUTION>m'));
  assert.equal(plan.previewExpiry.maxMinutesAtPreparation, 10080);
  assert.deepEqual(firebase.hosting.redirects, [{ source: '/', destination: '/lab/floating-garden/trial/index.html', type: 302 }]);
  assert.equal(Object.hasOwn(firebase.hosting, 'rewrites'), false);
  const pageURL = new URL(firebase.hosting.redirects[0].destination, configuration().previewOrigin);
  const entry = await readFile(join(output, 'public', pageURL.pathname), 'utf8');
  for (const [, ref] of entry.matchAll(/(?:src|href)=["'](\.\.?\/[^"']+)/g)) assert.ok((await stat(join(output, 'public', new URL(ref, pageURL).pathname))).isFile(), 'redirect resolves relative entry assets: ' + ref);
  assert.deepEqual(plan.secret.bindings, FUNCTION_NAMES.slice(0, 2));
  const names = await list(output);
  assert.equal(names.length, result.fileCount);
  assert.ok(!names.some((name) => /\.git|node_modules|mofumofu|\.env|\.secret|secret\.local/.test(name)));
  assert.ok(names.includes('public/lab/floating-garden/trial/bootstrap.js'));
  assert.ok(names.includes('public/lab/floating-garden/trial/style.css'));
  assert.ok(!names.includes('public/lab/floating-garden/online/app.js'));
  assert.ok(!names.includes('public/lab/floating-garden/online/firebase.js'));
  for (const name of ['engine.js', 'match-engine.js']) assert.deepEqual(await readFile(join(output, 'functions/online/core', name)), await readFile(join(root, 'lab/floating-garden', name)));
  for (const name of ['handlers.js', 'contract.js', 'invite-code.js']) assert.deepEqual(await readFile(join(output, 'functions/online', name)), await readFile(join(root, 'functions/floating-garden-online', name)));
  // Every relative JS/CSS/HTML dependency points to a copied public file. No bundle imports server code.
  for (const name of names.filter((name) => name.startsWith('public/') && /\.(js|html|css)$/.test(name))) {
    const content = await readFile(join(output, name), 'utf8');
    const refs = [...content.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|(?:src|href)=)["']([^"']+)/g)].map((m) => m[1]);
    for (const ref of refs) {
      if (ref.startsWith('#')) continue;
      if (ref.startsWith('https:')) {
        assert.equal(name, 'public/lab/floating-garden/trial/firebase.js', 'only the gated SDK loader can import external code');
        assert.match(ref, /^https:\/\/www\.gstatic\.com\/firebasejs\/10\.8\.0\/firebase-(?:app|app-check|auth|firestore|functions)\.js$/);
        continue;
      }
      assert.match(ref, /^\.\.?\//, `${name}: browser dependencies use explicit local paths`);
      const dependency = resolve(output, name, '..', ref.split(/[?#]/)[0]);
      assert.ok(!relative(join(output, 'public'), dependency).startsWith('..'), `${name}: no import outside hosted public files`);
      assert.ok((await stat(dependency)).isFile(), `${name} dependency ${ref}`);
    }
  }
  const admin = await json(join(output, 'ADMIN-RECORDS-REVIEW.json'));
  assert.equal(admin['floatingGardenTrial/config'].enabled, false); assert.deepEqual(admin['floatingGardenTrial/config'].testerUids, []);
  assert.equal(admin['floatingGardenTrial/usage'].createdRoomCount, 0);
  assert.equal(admin.testerDocumentTemplate.active, false);
  assert.ok(!(await readFile(join(output, 'firestore.rules'), 'utf8')).includes('__TRIAL_'));
  assert.deepEqual(await readFile(join(root, 'firebase.json')), originalConfig); assert.deepEqual(await readFile(join(root, 'firestore.rules')), originalRules);
});

test('invalid/disabled/production/mismatched/expired config creates no output and existing directories are not overwritten', async (t) => {
  const dir = await temporary(t);
  for (const [index, update] of [ { enabled: false }, { projectId: 'wa-awesome' }, { previewOrigin: 'https://wa-awesome-mofumofu-stg.web.app' }, { maxTesters: 3 }, { maxRooms: 21 }, { previewOrigin: 'https://garden-trial-check--different-a1b2c3.web.app' }, { endsAtMillis: start + 8 * 86400000 }, { extra: 'unknown' } ].entries()) {
    const output = join(dir, String(index));
    await assert.rejects(prepareTrialBundle({ config: { ...configuration(), ...update }, output, now: start }));
    await assert.rejects(stat(output), { code: 'ENOENT' });
  }
  await assert.rejects(prepareTrialBundle({ config: configuration(), output: join(dir, 'expired'), now: configuration().endsAtMillis }));
  await assert.rejects(prepareTrialBundle({ config: configuration(), output: dir, now: start }), /already exists/);
  await assert.rejects(prepareTrialBundle({ config: configuration(), output: join(dir, 'too-early'), now: start - 8 * 86400000 }));
});

test('closed-preview preparation is static and cannot initialize Auth or a backend', async (t) => {
  const dir = await temporary(t), output = join(dir, 'closed');
  await prepareClosedPreview({ project: 'garden-trial-check', output });
  const closedConfig = await json(join(output, 'firebase.preview-only.json'));
  assert.equal(Object.hasOwn(closedConfig.hosting, 'redirects'), false);
  assert.equal(Object.hasOwn(closedConfig.hosting, 'rewrites'), false);
  const html = await readFile(join(output, 'public/index.html'), 'utf8');
  assert.ok(!/<script|firebase|https?:\/\//i.test(html));
  assert.deepEqual((await list(output)), ['REVIEW-PLAN.json', 'firebase.preview-only.json', 'public/index.html']);
  const plan = await json(join(output, 'REVIEW-PLAN.json'));
  assert.ok(plan.commandNotExecuted.includes('--no-authorized-domains')); assert.ok(plan.commandNotExecuted.includes('7d'));
  for (const project of ['wa-awesome', 'wa-awesome-mofumofu-stg', 'demo-fake', '../escape', '']) await assert.rejects(prepareClosedPreview({ project, output: join(dir, 'invalid') }));
});

test('preview duration requires fresh execution time and uses CLI-supported minutes, not stale seconds', () => {
  const end = configuration().endsAtMillis;
  const plan = reviewPlan(configuration(), end - 600000);
  assert.ok(plan.commandsNotExecuted.preview.includes('<RECALCULATE_AT_APPROVED_EXECUTION>m'));
  assert.equal(plan.previewExpiry.mustRecalculateAtApprovedExecution, true);
  for (const now of [start, start + 3600000, end - 600000, end - 90000]) {
    const flag = `${previewExpiryMinutes(configuration(), now)}m`;
    const duration = calculateChannelExpireTTL(flag);
    assert.ok(duration <= end - now); assert.ok(duration <= 7 * 86400000);
  }
  assert.equal(previewExpiryMinutes(configuration(), start + 3600000), 10020);
  assert.throws(() => previewExpiryMinutes(configuration(), end - 59999));
  assert.throws(() => reviewPlan(configuration(), end));
  assert.throws(() => calculateChannelExpireTTL('604800s'));
});


test('bundle uses an exact allowlist and hashes every copied input, excluding credential/runtime/repository canaries', async (t) => {
  const dir = await temporary(t), source = await sourceFixture(dir), output = join(dir, 'bundle');
  const canary = 'LOCAL_TEST_CANARY_MUST_NEVER_BE_PACKAGED';
  for (const path of ['.git/config', '.firebaserc', 'firebase.json', 'functions/floating-garden-trial/.secret.local', 'functions/floating-garden-trial/.env', 'functions/floating-garden-trial/service-account.json', 'functions/floating-garden-trial/node_modules/canary.js', 'functions/floating-garden-online/index.js', 'lab/floating-garden/trial/trialruntime.js', 'lab/floating-garden/online/firebase.js']) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), canary);
  }
  await prepareTrialBundle({ config: configuration(), repositoryRoot: source, output, now: start });
  assert.deepEqual(await list(output), [...sourceFiles.map(outputPath), ...generatedFiles].sort());
  const manifest = await json(join(output, 'SOURCE-SHA256.json'));
  assert.deepEqual(Object.keys(manifest).sort(), sourceFiles);
  for (const name of sourceFiles) {
    const bytes = await readFile(join(source, name));
    assert.equal(manifest[name], createHash('sha256').update(bytes).digest('hex'), name);
    assert.deepEqual(await readFile(join(output, outputPath(name))), bytes, name);
  }
  for (const name of await list(output)) assert.equal((await readFile(join(output, name), 'utf8')).includes(canary), false, name);
  const deploymentPackage = await json(join(output, 'functions/package.json'));
  const lock = await json(join(output, 'functions/package-lock.json'));
  assert.equal(deploymentPackage.main, 'index.js');
  assert.deepEqual(deploymentPackage.engines, { node: '22' });
  assert.equal(Object.hasOwn(deploymentPackage, 'scripts'), false, 'no deployment lifecycle shell commands');
  assert.deepEqual(deploymentPackage.dependencies, { 'firebase-admin': '12.7.0', 'firebase-functions': '6.6.0' });
  assert.deepEqual(lock.packages[''].dependencies, deploymentPackage.dependencies);
  for (const [name, version] of Object.entries(deploymentPackage.dependencies)) assert.equal(lock.packages[`node_modules/${name}`].version, version);
  const backend = await json(join(output, 'functions/trial-config.json'));
  assert.deepEqual(Object.keys(backend).sort(), ['enabled', 'projectId', 'region', 'previewOrigin', 'startsAtMillis', 'endsAtMillis', 'maxRooms'].sort());
  assert.equal(Object.hasOwn(backend, 'firebase'), false);
  assert.equal(Object.hasOwn(backend, 'appCheck'), false);
});

test('all generated backend module paths stay inside the standalone functions source and only load approved SDKs', async (t) => {
  const dir = await temporary(t), output = join(dir, 'bundle');
  await prepareTrialBundle({ config: configuration(), output, now: start });
  const functions = join(output, 'functions');
  const external = new Set();
  for (const name of (await list(functions)).filter((name) => name.endsWith('.js'))) {
    const content = await readFile(join(functions, name), 'utf8');
    const refs = [...content.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)/g)].map((match) => match[1]);
    for (const ref of refs) {
      if (!ref.startsWith('.')) { external.add(ref); continue; }
      const resolved = resolve(functions, name, '..', ref.split(/[?#]/)[0]);
      assert.ok(!relative(functions, resolved).startsWith('..'), `${name}: import stays inside functions`);
      const target = /\.[cm]?js$/.test(resolved) ? resolved : resolved + '.js';
      assert.ok((await stat(target)).isFile(), `${name}: ${ref} exists in generated package`);
    }
  }
  assert.deepEqual([...external].sort(), ['node:crypto', 'node:fs', 'node:path', 'firebase-admin/app', 'firebase-admin/firestore', 'firebase-functions/v2/https', 'firebase-functions/params'].sort());
  assert.equal((await json(join(functions, 'online/core/package.json'))).type, 'module');
});

test('unsafe copied sources, missing files and changed trusted core fail before creating any output', async (t) => {
  const dir = await temporary(t);
  for (const fault of ['missing-entry', 'symlink-entry', 'changed-core']) {
    const caseDir = join(dir, fault);
    await mkdir(caseDir);
    const source = await sourceFixture(caseDir), output = join(caseDir, 'bundle');
    const entry = join(source, 'functions/floating-garden-trial/index.js');
    if (fault === 'missing-entry') await rm(entry);
    if (fault === 'symlink-entry') {
      const external = join(caseDir, 'outside.js');
      await cp(entry, external); await rm(entry); await symlink(external, entry);
    }
    if (fault === 'changed-core') await writeFile(join(source, 'functions/floating-garden-online/core/engine.js'), '// altered staged core');
    await assert.rejects(prepareTrialBundle({ config: configuration(), repositoryRoot: source, output, now: start }), fault === 'missing-entry' ? { code: 'ENOENT' } : fault === 'symlink-entry' ? /Unsafe source file/ : /Trusted staged core mismatch/);
    await assert.rejects(stat(output), { code: 'ENOENT' });
  }
});


test('fixed dedicated trial emits only exact-site Hosting commands and preserves stopped backend review gates', async (t) => {
  const dir = await temporary(t), output = join(dir, 'fixed');
  const config = configuration(); config.projectId = config.firebase.projectId = 'wa-awesome-garden-stg';
  config.firebase.authDomain = 'wa-awesome-garden-stg.firebaseapp.com'; config.previewOrigin = 'https://wa-awesome-garden-stg.web.app';
  const result = await prepareTrialBundle({ config, output, now: start });
  assert.equal((await list(output)).length, result.fileCount);
  assert.deepEqual((await list(output)), [...sourceFiles.map(outputPath), ...generatedFiles, 'firebase.hosting-only.json'].sort());
  const hostOnly = await json(join(output, 'firebase.hosting-only.json'));
  assert.deepEqual(Object.keys(hostOnly), ['hosting']);
  assert.equal(hostOnly.hosting.site, config.projectId);
  assert.equal(hostOnly.hosting.public, 'public');
  assert.equal(Object.hasOwn(hostOnly.hosting, 'rewrites'), false);
  assert.equal(Object.hasOwn(hostOnly.hosting, 'predeploy'), false);
  assert.equal(Object.hasOwn(hostOnly.hosting, 'postdeploy'), false);
  assert.deepEqual(result.plan.commandsNotExecuted.hosting, ['firebase', '--config', 'firebase.hosting-only.json', '--project', 'wa-awesome-garden-stg', 'deploy', '--only', 'hosting:wa-awesome-garden-stg']);
  assert.equal(Object.hasOwn(result.plan.commandsNotExecuted, 'preview'), false);
  assert.equal(Object.hasOwn(result.plan, 'previewExpiry'), false);
  assert.equal(result.plan.hostingExpiry, null);
  assert.equal(result.plan.hosting.mode, 'fixed-dedicated-live');
  assert.equal(result.plan.maxRooms, 20); assert.equal(result.plan.maxTesters, 2);
  assert.equal(result.plan.trialEndsAtMillis, config.endsAtMillis);
  const backend = await json(join(output, 'functions/trial-config.json'));
  assert.equal(backend.previewOrigin, config.previewOrigin); assert.equal(backend.endsAtMillis - backend.startsAtMillis, 7 * 86400000);
  const admin = await json(join(output, 'ADMIN-RECORDS-REVIEW.json'));
  assert.equal(admin['floatingGardenTrial/config'].enabled, false); assert.deepEqual(admin['floatingGardenTrial/config'].testerUids, []);
  assert.ok((await readFile(join(output, 'firestore.rules'), 'utf8')).includes(JSON.stringify(config.previewOrigin)));
});

test('closed-live bundle is deterministic exact-site Hosting-only maintenance, including inert deep-link fallback', async (t) => {
  const dir = await temporary(t), first = join(dir, 'first'), second = join(dir, 'second');
  const project = 'wa-awesome-garden-stg';
  const result = await prepareClosedLive({ project, output: first });
  await prepareClosedLive({ project, output: second });
  const expected = ['FILES-SHA256.json', 'REVIEW-PLAN.json', 'firebase.maintenance.json', 'public/404.html', 'public/index.html'];
  assert.deepEqual(await list(first), expected); assert.equal(result.fileCount, expected.length);
  for (const path of expected) assert.deepEqual(await readFile(join(first, path)), await readFile(join(second, path)), path);
  const config = await json(join(first, 'firebase.maintenance.json'));
  assert.deepEqual(Object.keys(config), ['hosting']);
  assert.deepEqual(Object.keys(config.hosting).sort(), ['headers', 'ignore', 'public', 'site']);
  assert.equal(config.hosting.site, project); assert.equal(config.hosting.public, 'public');
  assert.equal(await readFile(join(first, 'firebase.maintenance.json'), 'utf8'), CLOSED_LIVE_CONFIG_JSON);
  const headers = Object.fromEntries(config.hosting.headers[0].headers.map(({ key, value }) => [key, value]));
  assert.equal(headers['Content-Security-Policy'], "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  assert.equal(headers['Cache-Control'], 'no-store, max-age=0');
  for (const name of ['public/index.html', 'public/404.html']) {
    const html = await readFile(join(first, name), 'utf8');
    assert.equal(html, CLOSED_LIVE_HTML);
    assert.doesNotMatch(html, /<script|<link|<img|<iframe|<form|<object|<embed|\bon[a-z]+\s*=|\b(?:src|href|action)\s*=|firebase|https?:\/\//i);
    assert.match(html, /name="viewport"/);
  }
  const plan = await json(join(first, 'REVIEW-PLAN.json'));
  assert.equal(plan.enabled, false); assert.equal(plan.origin, 'https://wa-awesome-garden-stg.web.app');
  assert.deepEqual(plan.commandNotExecuted, ['firebase', '--config', 'firebase.maintenance.json', '--project', project, 'deploy', '--only', 'hosting:wa-awesome-garden-stg']);
  const { filterOnly } = createRequire(import.meta.url)('firebase-tools/lib/hosting/config.js');
  assert.deepEqual(filterOnly([config.hosting], plan.commandNotExecuted.at(-1)), [config.hosting]);
  const manifest = await json(join(first, 'FILES-SHA256.json'));
  assert.deepEqual(Object.keys(manifest).sort(), expected.filter((path) => path !== 'FILES-SHA256.json'));
  for (const [path, sha] of Object.entries(manifest)) assert.equal(sha, createHash('sha256').update(await readFile(join(first, path))).digest('hex'));
  await assert.rejects(prepareClosedLive({ project, output: first }), /already exists/);
});

test('closed-live refuses every unapproved project before creating output', async (t) => {
  const dir = await temporary(t);
  for (const [i, project] of ['wa-awesome', 'wa-awesome-mofumofu-stg', 'garden-trial-check', 'wa-awesome-garden-stg-other', 'WA-AWESOME-GARDEN-STG', 'https://wa-awesome-garden-stg.web.app', '../wa-awesome-garden-stg', '', undefined].entries()) {
    const output = join(dir, String(i));
    await assert.rejects(prepareClosedLive({ project, output }), /exact approved/);
    await assert.rejects(stat(output), { code: 'ENOENT' });
  }
});

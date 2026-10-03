import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildPayload, renderHelper, prepareConnection } from '../scripts/prepare-floating-garden-connection.mjs';
import { operate, prepareDependencies, writeBundle, checkBundle, validatePayload, validateEnvironment, validateConfiguration, validateWindow, canonicalVersionName, connectionMessage, payloadDigest, hostingConfig, runtimeConfig, PROJECT, PROJECT_NUMBER, ORIGIN, STARTS_AT, EXPIRES_AT, MAINTENANCE_MESSAGE, MAINTENANCE_CSP, CONNECTION_CSP, CONNECTION_DIGEST, CONNECTION_FILE_HASHES, ORIGINAL_CONNECTION_CSP, ORIGINAL_CONNECTION_DIGEST, ORIGINAL_CONNECTION_MESSAGE, PREVIOUS_CONNECTION_CSP, PREVIOUS_CONNECTION_DIGEST, PREVIOUS_CONNECTION_MESSAGE, PREVIOUS_CONNECTION_PAYLOAD, hash, CONFIG_FILE, CONNECTION_NAMES } from '../scripts/deploy-floating-garden-connection-template.mjs';
import { HTML, CONFIG } from '../scripts/deploy-floating-garden-maintenance.mjs';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const payload = buildPayload();
const success = (result) => JSON.stringify({ status: 'success', result });
const version = (n) => `sites/${PROJECT}/versions/version-${n}`;
const publicHeaders = (csp) => ({ 'cache-control': 'no-store, max-age=0', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow', 'content-security-policy': csp });
function temp(t) { const p = mkdtempSync(join(tmpdir(), 'connection-publisher-test-')); t.after(() => rmSync(p, { recursive: true, force: true })); return p; }
function fakeTooling(root) {
  const dir = join(root, 'tooling'); mkdirSync(join(dir, 'node_modules/firebase-tools/lib/bin'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), readFileSync(join(ROOT, 'tests/fixtures/floating-garden-maintenance-package.json')));
  writeFileSync(join(dir, 'package-lock.json'), readFileSync(join(ROOT, 'package-lock.json')));
  writeFileSync(join(dir, 'node_modules/firebase-tools/package.json'), JSON.stringify({ version: '14.27.0' }));
  writeFileSync(join(dir, 'node_modules/firebase-tools/lib/bin/firebase.js'), '// synthetic only'); return dir;
}
function harness(t, options = {}) {
  const root = temp(t), toolingDir = fakeTooling(root), commands = [], reads = [], logs = [];
  let kind = options.kind ?? 'maintenance', currentVersion = version(1), channelReads = 0, writes = 0, timeReads = 0;
  const metadata = () => ({ channels: [{ name: `sites/${PROJECT}/channels/live`, url: options.wrongOrigin ? 'https://wrong.example' : ORIGIN,
    release: { type: options.releaseType ?? 'DEPLOY', message: options.unknown ? 'unknown' : (!writes && options.releaseMessage) || (kind === 'maintenance' ? MAINTENANCE_MESSAGE : kind === 'original-connection' ? ORIGINAL_CONNECTION_MESSAGE : kind === 'previous-connection' ? PREVIOUS_CONNECTION_MESSAGE : connectionMessage(payload)), version: { name: options.releaseVersion ?? currentVersion, status: options.versionStatus ?? 'FINALIZED' } } }] });
  const run = (command, args, cwd) => {
    commands.push({ command, args, cwd });
    if (command === 'gcloud') {
      assert.ok(args.includes(`--project=${PROJECT}`)); assert.ok(args.includes('--format=json'));
      if (options.denied) throw Error('SECRET SHOULD NEVER ESCAPE');
      if (args[0] === 'config') return JSON.stringify(options.config ?? {});
      if (args[0] === 'projects') return JSON.stringify({ projectId: PROJECT, projectNumber: options.wrongProject ? '99' : PROJECT_NUMBER, lifecycleState: 'ACTIVE' });
      if (args[0] === 'services') return JSON.stringify([{ config: { name: options.missingApi ? 'other.googleapis.com' : 'firebasehosting.googleapis.com' } }]);
      assert.fail(`unexpected gcloud command ${args[0]}`);
    }
    assert.equal(command, process.execPath);
    if (args[1] === '--version') return options.wrongCli ? '99.0.0' : '14.27.0';
    const cmd = args[1];
    assert.deepEqual(args.slice(-4), ['--project', PROJECT, '--non-interactive', '--json']);
    assert.equal(args.at(-6), '--config');
    if (cmd === 'hosting:sites:list') return success({ sites: options.missingSite ? [] : [{ name: `projects/${PROJECT_NUMBER}/sites/${PROJECT}`, defaultUrl: ORIGIN }] });
    if (cmd === 'hosting:channel:list') {
      channelReads++;
      if ((options.race && channelReads === 2) || (options.postRace && channelReads === 4)) currentVersion = version(2);
      if (options.mutateBundle && channelReads === 2) options.mutateBundle(dirname(args.at(-5)));
      return success(metadata());
    }
    if (cmd === 'deploy') {
      writes++;
      assert.deepEqual(args.slice(2, 5), ['--only', `hosting:${PROJECT}`, '--message']);
      const msg = args[5]; assert.ok([MAINTENANCE_MESSAGE, connectionMessage(payload)].includes(msg));
      if (options.failDeploy) throw Error('SECRET TOKEN IN STDOUT MUST BE HIDDEN');
      kind = msg === MAINTENANCE_MESSAGE ? 'maintenance' : 'connection'; currentVersion = version(3);
      if (options.uncertain) throw Error('timeout after accepted write');
      return options.badResult ? '{bad' : success({ hosting: options.wrongReturnedVersion ? version(9) : currentVersion });
    }
    assert.fail(`unexpected CLI command ${cmd}`);
  };
  const fetchImpl = async (url, request) => {
    reads.push({ url, request, kind, writes }); assert.ok(url.startsWith(`${ORIGIN}/`));
    const path = new URL(url).pathname;
    const connection = path.startsWith('/connection-check/');
    let status = 200, body = HTML, csp = MAINTENANCE_CSP;
    if (connection && ['connection', 'previous-connection', 'original-connection'].includes(kind)) {
      const files = (kind === 'connection' || options.candidateAsPrevious) ? payload.connectionFiles : PREVIOUS_CONNECTION_PAYLOAD.connectionFiles;
      body = files[path.split('/').at(-1) || 'index.html']; csp = kind === 'original-connection' ? ORIGINAL_CONNECTION_CSP : CONNECTION_CSP;
    }
    else if (connection || path.startsWith('/lab/')) status = 404;
    if (options.badBytes || options.badPathBytes === path || (options.badPostBytes && writes)) body = 'wrong';
    if (options.driftPath === path) body += ' ';
    if (connection && options.connectionCsp !== undefined && !writes) csp = options.connectionCsp;
    const headers = publicHeaders(csp); if (options.badHeaders) headers['content-security-policy'] += '; script-src *';
    if (!writes) Object.assign(headers, options.headerOverrides);
    if (writes && options.badPostHeaders) headers['content-security-policy'] = ORIGINAL_CONNECTION_CSP;
    return new Response(body, { status, headers });
  };
  const perform = (mode = 'deploy') => operate({ mode, payload: options.payload ?? payload, toolingDir, run, fetchImpl, log: (s) => logs.push(s), tempRoot: root, env: options.env ?? {}, execArgv: [], now: () => options.times?.[timeReads++] ?? options.time ?? STARTS_AT + 60000 });
  return { root, toolingDir, commands, reads, logs, perform, writes: () => writes };
}
test('generator preserves exact maintenance, seven public files and standalone embedded runtime', (t) => {
  const dir = join(temp(t), 'generated'), result = prepareConnection({ output: dir });
  assert.equal(result.publicFiles, 7); assert.equal(payload.maintenanceHtml, HTML); assert.equal(payload.maintenanceConfig, CONFIG);
  checkBundle(join(dir, 'bundle'), payload);
  const helper = readFileSync(result.helper, 'utf8'); assert.equal(helper, renderHelper(payload)); assert.doesNotMatch(helper.split('\n').filter((line) => line.startsWith('import ')).join('\n'), /from ['"]\.\//);
  assert.match(execFileSync(process.execPath, [result.helper], { encoding: 'utf8' }), /PLAN_ONLY/);
  assert.throws(() => execFileSync(process.execPath, [result.helper, '--project', 'wa-awesome'], { stdio: 'pipe' }));
  assert.deepEqual(runtimeConfig().appCheck, { provider: 'recaptcha-enterprise', siteKey: '6Lc_LNwtAAAAADRAHvq10FwxirR3c5jZlxS9QpYw' });
  assert.equal(runtimeConfig().expiresAtMillis, EXPIRES_AT);
});
test('generator refuses in-repository, existing, symlinked or unreviewed source outputs', (t) => {
  const root = temp(t);
  assert.throws(() => prepareConnection({ output: ROOT }), /already exist/);
  assert.throws(() => prepareConnection({ output: join(ROOT, 'unsafe-generated') }), /outside/);
  assert.throws(() => prepareConnection({ output: join(ROOT, '..tricky') }), /outside/);
  const source = join(root, 'source'); mkdirSync(source);
  for (const name of ['app.js', 'connection.js', 'index.html', 'style.css']) writeFileSync(join(source, name), 'fixture');
  writeFileSync(join(source, 'extra.js'), 'extra'); assert.throws(() => buildPayload(source), /exactly/); rmSync(join(source, 'extra.js'));
  rmSync(join(source, 'app.js')); symlinkSync(join(source, 'connection.js'), join(source, 'app.js')); assert.throws(() => buildPayload(source), /Unsafe/);
  const linked = join(root, 'repo'); symlinkSync(ROOT, linked); assert.throws(() => prepareConnection({ output: join(linked, 'out') }), /outside/);
  assert.throws(() => buildPayload(join(linked, 'lab/floating-garden/connection-check')), /regular directory/);
});
test('configs are Hosting-only with disjoint CSP rules and no hooks/redirects/rewrites', () => {
  const cfg = hostingConfig(); assert.deepEqual(Object.keys(cfg), ['hosting']);
  assert.deepEqual(Object.keys(cfg.hosting), ['site', 'public', 'ignore', 'headers']);
  const policies = cfg.hosting.headers.filter((r) => r.headers.some((h) => h.key === 'Content-Security-Policy'));
  assert.deepEqual(policies.map((r) => r.source), ['/', '/index.html', '/404.html', '/lab/**', '/connection-check/**']);
  assert.ok(!cfg.hosting.headers[0].headers.some((h) => h.key === 'Content-Security-Policy'));
  assert.doesNotMatch(CONNECTION_CSP, /unsafe-|\*|firestore|cloudfunctions/);
});
test('original, fixed-CSP and diagnostic payload identities are distinct and independently pinned', () => {
  assert.equal(ORIGINAL_CONNECTION_DIGEST, 'd73fa35889621062065889b52242b37b052a81c375f78c208f80c5e4ddff3e2d');
  assert.equal(PREVIOUS_CONNECTION_DIGEST, '2303007a968a8e063f49275d120631a5fa08f91cf1a28ae771dda6ad8055123d');
  assert.equal(payloadDigest(PREVIOUS_CONNECTION_PAYLOAD), PREVIOUS_CONNECTION_DIGEST);
  const original = { ...PREVIOUS_CONNECTION_PAYLOAD, connectionConfig: PREVIOUS_CONNECTION_PAYLOAD.connectionConfig.replace(CONNECTION_CSP, ORIGINAL_CONNECTION_CSP) };
  assert.equal(payloadDigest(original), ORIGINAL_CONNECTION_DIGEST);
  assert.equal(PREVIOUS_CONNECTION_PAYLOAD.connectionConfig, original.connectionConfig.replace('https://firebaseappcheck.googleapis.com', 'https://content-firebaseappcheck.googleapis.com'));
  assert.equal(PREVIOUS_CONNECTION_PAYLOAD.connectionConfig, payload.connectionConfig);
  assert.equal(PREVIOUS_CONNECTION_PAYLOAD.connectionFiles['connection-runtime.js'], payload.connectionFiles['connection-runtime.js']);
  assert.equal(payloadDigest(payload), CONNECTION_DIGEST);
  assert.equal(new Set([CONNECTION_DIGEST, ORIGINAL_CONNECTION_DIGEST, PREVIOUS_CONNECTION_DIGEST]).size, 3);
  assert.equal(ORIGINAL_CONNECTION_MESSAGE, `garden-connection-static-v1:${ORIGINAL_CONNECTION_DIGEST}`);
  assert.equal(PREVIOUS_CONNECTION_MESSAGE, `garden-connection-static-v1:${PREVIOUS_CONNECTION_DIGEST}`);
  assert.equal(connectionMessage(payload), `garden-connection-static-v1:${CONNECTION_DIGEST}`);
  assert.deepEqual(Object.keys(CONNECTION_FILE_HASHES).sort(), CONNECTION_NAMES);
  for (const name of CONNECTION_NAMES) assert.equal(hash(payload.connectionFiles[name]), CONNECTION_FILE_HASHES[name]);
  assert.ok(Object.isFrozen(PREVIOUS_CONNECTION_PAYLOAD)); assert.ok(Object.isFrozen(PREVIOUS_CONNECTION_PAYLOAD.connectionFiles));
  assert.throws(() => { PREVIOUS_CONNECTION_PAYLOAD.connectionFiles['app.js'] = 'changed'; }, TypeError);
  assert.throws(() => validatePayload(PREVIOUS_CONNECTION_PAYLOAD), /reviewed/);
  assert.equal(PREVIOUS_CONNECTION_CSP, CONNECTION_CSP);
  const connect = CONNECTION_CSP.split('; ').find((part) => part.startsWith('connect-src '));
  assert.ok(connect.split(' ').includes('https://content-firebaseappcheck.googleapis.com'));
  assert.ok(!connect.split(' ').includes('https://firebaseappcheck.googleapis.com'));
  assert.equal(STARTS_AT, Date.parse('2026-10-03T02:15:00Z'));
  assert.equal(EXPIRES_AT, Date.parse('2026-10-04T03:00:00Z'));
});
test('explicit modes, project, existing site, API, gcloud routing and CLI version fail closed', async (t) => {
  for (const options of [{ wrongProject: true }, { missingApi: true }, { missingSite: true }, { wrongCli: true }, { denied: true }, { config: { auth: { impersonate_service_account: 'other' } } }, { unknown: true }, { wrongOrigin: true }]) {
    const h = harness(t, options); await assert.rejects(h.perform()); assert.equal(h.writes(), 0);
  }
  await assert.rejects(operate({ mode: 'anything', run: () => assert.fail('no subprocess') }), /mode/);
});
test('environment and configuration reject credential/proxy/TLS/token/route injection without bypass', () => {
  for (const env of [{ NODE_OPTIONS: '--require=evil' }, { HTTPS_PROXY: 'https://proxy' }, { CLOUDSDK_API_ENDPOINT_OVERRIDES_FIREBASEHOSTING: 'https://evil' }, { FIREBASE_TOKEN: 'secret' }, { GOOGLE_APPLICATION_CREDENTIALS: '/secret' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, { npm_config_strict_ssl: 'false' }, { NPM_CONFIG_PROXY: 'https://proxy' }, { npm_config_http_proxy: 'https://proxy' }, { NPM_CONFIG_CAFILE: '/tmp/ca' }]) assert.throws(() => validateEnvironment(env, []));
  for (const cfg of [{ proxy: { address: 'proxy' } }, { core: { universe_domain: 'evil' } }, { auth: { token_host: 'https://evil' } }, { core: { disable_ssl_validation: true } }]) assert.throws(() => validateConfiguration(cfg));
});
test('inspect installs nothing, performs only metadata/public reads and refuses changed bytes/headers', async (t) => {
  const h = harness(t); const result = await h.perform('inspect'); assert.equal(result.deployed, false); assert.equal(h.writes(), 0);
  assert.ok(!h.commands.some((c) => c.command === 'npm')); assert.ok(h.reads.every((r) => r.request.redirect === 'error' && r.request.cache === 'no-store'));
  for (const options of [{ badBytes: true }, { badHeaders: true }]) { const bad = harness(t, options); await assert.rejects(bad.perform()); assert.equal(bad.writes(), 0); }
});
test('deploy issues one exact Hosting write then verifies all seven files plus roots/old entry and returned version', async (t) => {
  const h = harness(t), result = await h.perform(); assert.equal(result.deployed, true); assert.equal(result.kind, 'connection'); assert.equal(h.writes(), 1);
  for (const name of CONNECTION_NAMES) assert.ok(h.reads.filter((r) => r.url === `${ORIGIN}/connection-check/${name}`).length >= 2);
  assert.ok(h.logs.some((line) => line.startsWith('VERIFIED:')));
  const allowed = ['config', 'projects', 'services', '--version', 'hosting:sites:list', 'hosting:channel:list', 'deploy'];
  for (const c of h.commands) assert.ok(allowed.includes(c.command === 'gcloud' ? c.args[0] : c.args[1]));
});
test('same recognized connection release is reverified without redeploy and stop restores exact maintenance after expiry', async (t) => {
  const same = harness(t, { kind: 'connection' }); assert.equal((await same.perform()).deployed, false); assert.equal(same.writes(), 0);
  const stopped = harness(t, { kind: 'connection', time: EXPIRES_AT + 100000 }); assert.equal((await stopped.perform('stop')).kind, 'maintenance'); assert.equal(stopped.writes(), 1);
  const already = harness(t, { time: EXPIRES_AT + 100000 }); assert.equal((await already.perform('stop')).deployed, false); assert.equal(already.writes(), 0);
});
test('the exact prior release migrates with one write, verifying old and current bytes and headers', async (t) => {
  const h = harness(t, { kind: 'previous-connection' }), result = await h.perform();
  assert.equal(result.deployed, true); assert.equal(result.kind, 'connection'); assert.equal(result.version, version(3)); assert.equal(h.writes(), 1);
  const paths = ['/', '/index.html', '/404.html', '/lab/floating-garden/trial/index.html', ...CONNECTION_NAMES.map((name) => `/connection-check/${name}`), '/connection-check/'];
  for (const path of paths) {
    assert.equal(h.reads.filter((r) => r.url === `${ORIGIN}${path}` && r.kind === 'previous-connection' && r.writes === 0).length, 1);
    assert.equal(h.reads.filter((r) => r.url === `${ORIGIN}${path}` && r.kind === 'connection' && r.writes === 1).length, 1);
  }
  const deployIndex = h.commands.findIndex((c) => c.args[1] === 'deploy');
  assert.equal(h.commands[deployIndex - 1].args[1], 'hosting:channel:list');
  assert.equal(h.commands[deployIndex].args[5], connectionMessage(payload));
  assert.ok(h.logs.some((s) => s.startsWith('VERIFIED:')));
});
test('prior-release inspect remains read-only and stop can restore maintenance after the unchanged expiry', async (t) => {
  const inspected = harness(t, { kind: 'previous-connection' });
  assert.equal((await inspected.perform('inspect')).kind, 'previous-connection'); assert.equal(inspected.writes(), 0);
  const stopped = harness(t, { kind: 'previous-connection', time: EXPIRES_AT + 100000 });
  assert.equal((await stopped.perform('stop')).kind, 'maintenance'); assert.equal(stopped.writes(), 1);
  assert.ok(stopped.reads.filter((r) => r.writes).every((r) => r.kind === 'maintenance'));
});
test('prior-release mismatched markers, all public bytes, CSP and remaining safety headers stop without a write', async (t) => {
  const paths = ['/', '/index.html', '/404.html', '/lab/floating-garden/trial/index.html', ...CONNECTION_NAMES.map((name) => `/connection-check/${name}`), '/connection-check/'];
  const mismatches = [
    { releaseMessage: 'garden-connection-static-v1:unknown' },
    { releaseMessage: connectionMessage(payload) },
    { releaseMessage: MAINTENANCE_MESSAGE },
    { connectionCsp: ORIGINAL_CONNECTION_CSP },
    { connectionCsp: `${PREVIOUS_CONNECTION_CSP}; connect-src *` },
    { releaseMessage: ORIGINAL_CONNECTION_MESSAGE },
    { candidateAsPrevious: true },
    { releaseType: 'ROLLBACK' },
    { versionStatus: 'CREATED' },
    { releaseVersion: 'sites/wa-awesome/versions/unrelated' },
    ...paths.map((path) => ({ badPathBytes: path })),
    ...paths.map((path) => ({ driftPath: path })),
    ...['cache-control', 'x-content-type-options', 'referrer-policy', 'x-robots-tag'].map((key) => ({ headerOverrides: { [key]: 'wrong' } })),
  ];
  for (const options of mismatches) {
    const h = harness(t, { kind: 'previous-connection', ...options }); await assert.rejects(h.perform()); assert.equal(h.writes(), 0);
  }
});
test('a modified candidate cannot redefine the known prior public bytes', async (t) => {
  for (const name of CONNECTION_NAMES) {
    const changed = structuredClone(payload); changed.connectionFiles[name] += '\n// unreviewed';
    const h = harness(t, { kind: 'previous-connection', payload: changed });
    await assert.rejects(h.perform()); assert.equal(h.writes(), 0); assert.equal(h.commands.length, 0);
  }
});
test('original pre-fix release is inspectable/stoppable but never silently migrates to diagnostics', async (t) => {
  const inspected = harness(t, { kind: 'original-connection' });
  assert.equal((await inspected.perform('inspect')).kind, 'original-connection'); assert.equal(inspected.writes(), 0);
  const blocked = harness(t, { kind: 'original-connection' });
  await assert.rejects(blocked.perform(), /cannot migrate directly/); assert.equal(blocked.writes(), 0);
  const stopped = harness(t, { kind: 'original-connection', time: EXPIRES_AT + 100000 });
  assert.equal((await stopped.perform('stop')).kind, 'maintenance'); assert.equal(stopped.writes(), 1);
  for (const options of [{ connectionCsp: CONNECTION_CSP }, { candidateAsPrevious: true }, { releaseMessage: PREVIOUS_CONNECTION_MESSAGE }, { releaseMessage: connectionMessage(payload) }]) {
    const invalid = harness(t, { kind: 'original-connection', ...options });
    await assert.rejects(invalid.perform('stop')); assert.equal(invalid.writes(), 0);
  }
});
test('recognized diagnostic release is never redeployed, but every byte/header and final identity are required', async (t) => {
  const exact = harness(t, { kind: 'connection' });
  assert.equal((await exact.perform()).deployed, false); assert.equal(exact.writes(), 0);
  for (const options of [{ race: true }, { badHeaders: true }, { connectionCsp: ORIGINAL_CONNECTION_CSP }, ...CONNECTION_NAMES.map((name) => ({ badPathBytes: `/connection-check/${name}` }))]) {
    const invalid = harness(t, { kind: 'connection', ...options });
    await assert.rejects(invalid.perform()); assert.equal(invalid.writes(), 0);
    assert.ok(!invalid.logs.some((s) => s.startsWith('ALREADY_VERIFIED:')));
  }
});
test('unknown and malformed release identities stop even when every public byte would match', async (t) => {
  for (const options of [{ releaseMessage: `garden-connection-static-v1:${'0'.repeat(64)}` }, { releaseMessage: `${PREVIOUS_CONNECTION_MESSAGE} ` }, { releaseMessage: `${connectionMessage(payload)}\n` }, { releaseType: 'ROLLBACK' }, { versionStatus: 'DELETED' }, { releaseVersion: 'sites/wa-awesome/versions/wrong' }]) {
    const invalid = harness(t, { kind: 'connection', ...options });
    await assert.rejects(invalid.perform()); assert.equal(invalid.writes(), 0); assert.equal(invalid.reads.length, 0);
  }
});
test('a raced prior release blocks migration, and a post-write race never reports completion', async (t) => {
  const raced = harness(t, { kind: 'previous-connection', race: true });
  await assert.rejects(raced.perform(), /changed before publication/); assert.equal(raced.writes(), 0);
  const postRaced = harness(t, { kind: 'previous-connection', postRace: true });
  await assert.rejects(postRaced.perform(), /changed during post-publication/); assert.equal(postRaced.writes(), 1);
  assert.ok(!postRaced.logs.some((s) => s.startsWith('VERIFIED:')));
});
test('uncertain prior-release migration is never retried and only metadata is read after the attempt', async (t) => {
  const h = harness(t, { kind: 'previous-connection', uncertain: true });
  await assert.rejects(h.perform()); assert.equal(h.writes(), 1);
  assert.equal(h.commands.at(-1).args[1], 'hosting:channel:list');
  assert.ok(h.reads.every((r) => r.writes === 0));
  assert.ok(h.logs.some((s) => s.startsWith('PARTIAL_STATE:')));
  assert.ok(h.logs.some((s) => s.startsWith('READBACK_ONLY:')));
  assert.ok(!h.logs.some((s) => s.startsWith('VERIFIED:')));
});
test('migration completion requires current public bytes, current headers and the acknowledged version', async (t) => {
  for (const options of [{ badPostBytes: true }, { badPostHeaders: true }, { wrongReturnedVersion: true }]) {
    const h = harness(t, { kind: 'previous-connection', ...options });
    await assert.rejects(h.perform()); assert.equal(h.writes(), 1); assert.ok(!h.logs.some((s) => s.startsWith('VERIFIED:')));
  }
});
test('fixed window never advances and requires ten minutes remaining before deploy', async (t) => {
  assert.doesNotThrow(() => validateWindow(EXPIRES_AT - 600000));
  for (const time of [STARTS_AT - 1, EXPIRES_AT - 599999, EXPIRES_AT, NaN]) { const h = harness(t, { time }); await assert.rejects(h.perform(), /window/); assert.equal(h.commands.length, 0); }
  const elapsed = harness(t, { kind: 'previous-connection', times: [STARTS_AT + 60000, EXPIRES_AT - 599999] });
  await assert.rejects(elapsed.perform(), /window/); assert.equal(elapsed.writes(), 0); assert.ok(elapsed.reads.length > 0);
});
test('race, extra upload, changed config and symlinks block the one write', async (t) => {
  const race = harness(t, { race: true }); await assert.rejects(race.perform(), /changed/); assert.equal(race.writes(), 0);
  for (const mutateBundle of [
    (dir) => writeFileSync(join(dir, 'public/extra.js'), 'unsafe'),
    (dir) => writeFileSync(join(dir, CONFIG_FILE), '{}'),
    (dir) => { const file = join(dir, 'public/connection-check/app.js'); rmSync(file); symlinkSync(join(dir, CONFIG_FILE), file); },
  ]) { const h = harness(t, { mutateBundle }); await assert.rejects(h.perform()); assert.equal(h.writes(), 0); }
});
test('uncertain/failed/malformed/wrong-version/post-byte deployment does not retry and reads metadata only', async (t) => {
  for (const options of [{ failDeploy: true }, { uncertain: true }, { badResult: true }, { wrongReturnedVersion: true }, { badPostBytes: true }]) {
    const h = harness(t, options); await assert.rejects(h.perform()); assert.equal(h.writes(), 1);
    assert.ok(h.logs.some((s) => s.startsWith('PARTIAL_STATE:'))); assert.ok(h.logs.some((s) => s.startsWith('READBACK_ONLY:'))); assert.ok(!h.logs.some((s) => s.startsWith('VERIFIED:')));
    assert.doesNotMatch(h.logs.join('\n'), /SECRET/);
  }
});
test('payload/config/runtime exact allowlist and version parser reject extra scope', () => {
  for (const mutate of [(p) => p.connectionFiles['game.js'] = 'game', (p) => p.connectionFiles['connection-runtime.js'] += 'bad', (p) => p.connectionConfig = '{}', (p) => p.extra = true, (p) => p.maintenanceHtml += ' ', (p) => p.maintenanceConfig += ' ']) { const p = structuredClone(payload); mutate(p); assert.throws(() => validatePayload(p)); }
  assert.equal(canonicalVersionName(`projects/${PROJECT_NUMBER}/sites/${PROJECT}/versions/a`), `sites/${PROJECT}/versions/a`);
  for (const v of [`sites/wa-awesome/versions/a`, `${version(1)}\n`, `${version(1)}/extra`, 'https://evil']) assert.throws(() => canonicalVersionName(v));
});
test('dependency preparation is local only, pinned official npm ignore-scripts, and rejects modified manifests', async (t) => {
  const root = temp(t), dir = join(root, 'prepared'), commands = [], urls = [];
  const run = (cmd, args) => {
    commands.push({ cmd, args });
    if (cmd === 'npm') { mkdirSync(join(dir, 'node_modules/firebase-tools/lib/bin'), { recursive: true }); writeFileSync(join(dir, 'node_modules/firebase-tools/lib/bin/firebase.js'), '// fixture'); writeFileSync(join(dir, 'node_modules/firebase-tools/package.json'), '{"version":"14.27.0"}'); return ''; }
    assert.equal(cmd, process.execPath); return '14.27.0';
  };
  const fetchImpl = async (url) => { urls.push(url); const file = url.endsWith('/package.json') ? 'tests/fixtures/floating-garden-maintenance-package.json' : 'package-lock.json'; return new Response(readFileSync(join(ROOT, file))); };
  await prepareDependencies({ dir, run, fetchImpl, env: {}, execArgv: [], log: () => {} });
  assert.notEqual(commands[0].args.find((arg) => arg.startsWith('--userconfig=')).split('=')[1], commands[0].args.find((arg) => arg.startsWith('--globalconfig=')).split('=')[1]);
  assert.ok(commands[0].args.includes('--ignore-scripts')); assert.ok(commands[0].args.includes('--registry=https://registry.npmjs.org/')); assert.ok(urls.every((u) => u.includes('/0404104414c1fb25a1248fc3a2fd0945f9478051/')));
  await assert.rejects(prepareDependencies({ dir: join(root, 'bad'), run: () => assert.fail('must not install'), fetchImpl: async () => new Response('{}'), env: {}, execArgv: [], log: () => {} }), /checksum/);
});

test('published standalone helper exactly matches reviewed current source and template', () => {
  assert.equal(readFileSync(join(ROOT, 'scripts/deploy-floating-garden-connection-check.mjs'), 'utf8'), renderHelper(buildPayload()));
});

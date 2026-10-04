import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapApis, parseBuildAccount, parseServices, selectBindings, validateConfiguration, APPROVED_APIS, PROJECT, PROJECT_NUMBER, REGION } from '../scripts/bootstrap-floating-garden-apis.mjs';
const identity = { projectId: PROJECT, projectNumber: PROJECT_NUMBER, lifecycleState: 'ACTIVE' };
const email = `${PROJECT_NUMBER}-compute@developer.gserviceaccount.com`;
const build = (account = email) => ({ name: `projects/${PROJECT}/locations/${REGION}/defaultServiceAccount`, serviceAccountEmail: `projects/${PROJECT}/serviceAccounts/${account}` });
function harness({ project = identity, apis = APPROVED_APIS, account = build(), policy = { bindings: [] }, fail = null, afterApis = null, propagateReads = 0 } = {}) {
  const commands = [], logs = []; let enabled = false, readsAfter = 0, waits = 0;
  const run = (args) => {
    commands.push(args);
    if (fail && fail(args)) throw Error('MOCK_FAILURE');
    if (args[0] === 'config') return '{}';
    if (args[0] === 'projects' && args[1] === 'describe') return JSON.stringify(project);
    if (args[0] === 'services' && args[1] === 'list') return (enabled && ++readsAfter > propagateReads ? (afterApis ?? [...new Set([...apis, ...APPROVED_APIS])]) : apis).join('\n');
    if (args[0] === 'services' && args[1] === 'enable') { enabled = true; return '{}'; }
    if (args[0] === 'builds') return JSON.stringify(account);
    if (args[0] === 'projects' && args[1] === 'get-iam-policy') return JSON.stringify(policy);
    throw Error(`Unexpected command ${args.join(' ')}`);
  };
  return { commands, logs, perform: (apply = false) => bootstrapApis({ apply, run, log: (v) => logs.push(v), sleep: () => { waits++; } }) };
}
test('bootstrap API allowlist exactly matches thirteen approved names', () => {
  assert.deepEqual([...APPROVED_APIS].sort(), ['cloudfunctions', 'cloudbuild', 'artifactregistry', 'run', 'eventarc', 'pubsub', 'storage', 'secretmanager', 'iam', 'firebaseappcheck', 'recaptchaenterprise', 'firebaserules', 'logging'].map((s) => `${s}.googleapis.com`).sort());
  assert.ok(Object.isFrozen(APPROVED_APIS));
});
test('default command is a plan without accessing gcloud', () => {
  const out = execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/bootstrap-floating-garden-apis.mjs', import.meta.url))], { encoding: 'utf8', env: { PATH: '' } });
  assert.match(out, /User Cloud Shell only/);
});
test('inspect lists missing approved APIs without enabling or guessing build identity', async () => {
  const h = harness({ apis: ['firestore.googleapis.com'] });
  assert.equal((await h.perform()).buildAccount, null);
  assert.equal(h.commands.length, 3);
  assert.ok(h.logs.some((s) => s.startsWith('BUILD_ACCOUNT_PENDING:')));
});
test('apply requests missing approved services once and reads actual build identity', async () => {
  const h = harness({ apis: ['firestore.googleapis.com', 'run.googleapis.com'] });
  const result = await h.perform(true);
  assert.equal(result.complete, true);
  const writes = h.commands.filter((a) => a[1] === 'enable');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], ['services', 'enable', ...APPROVED_APIS.filter((a) => a !== 'run.googleapis.com'), '--format=json']);
});
test('automatically enabled additional names are reported without selecting them in another write', async () => {
  const h = harness({ apis: [], afterApis: [...APPROVED_APIS, 'compute.googleapis.com'] });
  const result = await h.perform(true);
  assert.deepEqual(result.dependencies, ['compute.googleapis.com']);
  assert.ok(h.logs.includes('ADDITIONAL_API_NAMES: compute.googleapis.com'));
  assert.ok(h.logs.some((s) => s.includes('concurrent changes cannot be distinguished')));
  assert.equal(h.commands.filter((a) => a[1] === 'enable').length, 1);
  assert.ok(!h.commands.flat().includes('compute.googleapis.com'));
});
test('write failure stops with no automatic mutation retry or build read', async () => {
  const h = harness({ apis: [], fail: (a) => a[1] === 'enable' });
  await assert.rejects(h.perform(true));
  assert.equal(h.commands.length, 5);
  assert.ok(h.logs.some((s) => s.startsWith('API_CALL_RESULT_UNKNOWN')));
});
test('read-only propagation waits do not repeat enablement', async () => {
  const h = harness({ apis: [], propagateReads: 2 });
  await h.perform(true);
  assert.equal(h.commands.filter((a) => a[0] === 'services' && a[1] === 'list').length, 4);
  assert.equal(h.commands.filter((a) => a[1] === 'enable').length, 1);
});
test('incomplete readback stops at the documented bound without mutation retry', async () => {
  const h = harness({ apis: [], afterApis: [] });
  await assert.rejects(h.perform(true), /readback is incomplete/);
  assert.equal(h.commands.filter((a) => a[0] === 'services' && a[1] === 'list').length, 14);
  assert.equal(h.commands.filter((a) => a[1] === 'enable').length, 1);
  assert.ok(!h.commands.some((a) => a[0] === 'builds'));
});
test('already-enabled apply is read-only and reports actual account', async () => {
  const h = harness();
  const result = await h.perform(true);
  assert.equal(result.complete, true); assert.equal(result.buildAccount, email);
  assert.equal(h.commands.length, 5);
  assert.ok(h.commands.every((a) => !a.includes('enable')));
});
test('wrong project, number, inactive and malformed project stop before inventory', async () => {
  for (const project of [null, [], { ...identity, projectId: 'wa-awesome' }, { ...identity, projectNumber: '999' }, { ...identity, lifecycleState: 'DELETE_REQUESTED' }, { ...identity, lifecycleState: undefined }]) {
    const h = harness({ project }); await assert.rejects(h.perform(true)); assert.equal(h.commands.length, 2);
  }
});
test('service inventory rejects malformed lines and duplicate names', () => {
  for (const raw of ['{"wrong":"format"}', 'Enabled services:\nrun.googleapis.com', 'run.googleapis.com\nrun.googleapis.com', 'run.googleapis.com.evil', 'run.googleapis.com; true']) assert.throws(() => parseServices(raw));
  assert.equal(parseServices('run.googleapis.com\n').size, 1);
});
test('build identity accepts observed project ID/number resource forms and exact garden owners', () => {
  for (const id of [PROJECT, PROJECT_NUMBER]) for (const resource of [PROJECT, PROJECT_NUMBER]) for (const e of [email, `${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com`, `garden-custom-build@${PROJECT}.iam.gserviceaccount.com`]) {
    assert.equal(parseBuildAccount({ name: `projects/${id}/locations/${REGION}/defaultServiceAccount`, serviceAccountEmail: `projects/${resource}/serviceAccounts/${e}` }), e);
  }
});
test('build identity rejects empty, foreign, wildcard, wrong-region and display-only shapes', () => {
  for (const value of [null, [], email, { ...build(), serviceAccountEmail: '' }, { ...build(), serviceAccountEmail: email }, { ...build(), name: `projects/${PROJECT}/locations/global/defaultServiceAccount` }, build('999-compute@developer.gserviceaccount.com'), build('someone@example.com'), build(`garden-custom@evil@${PROJECT}.iam.gserviceaccount.com`), { ...build(), serviceAccountEmail: `projects/-/serviceAccounts/${email}` }, { ...build(), serviceAccountEmail: `projects/wa-awesome/serviceAccounts/${email}` }]) assert.throws(() => parseBuildAccount(value));
});
test('build IAM output preserves full condition but excludes unrelated members and user accounts', async () => {
  const condition = { title: 'limited', description: 'fixture', expression: 'resource.name == "fixture"' };
  const h = harness({ policy: { version: 3, bindings: [{ role: 'roles/logging.logWriter', members: [`serviceAccount:${email}`, 'user:unrelated@example.com'], condition }, { role: 'roles/owner', members: ['user:owner@example.com'] }] } });
  const result = await h.perform();
  assert.deepEqual(result.bindings, [{ role: 'roles/logging.logWriter', condition }]);
  assert.ok(!h.logs.join('\n').includes('owner@example.com'));
  assert.ok(h.logs.some((s) => s.includes('inherited/group/resource-level access is not audited')));
});
test('malformed IAM responses stop instead of reporting a complete inventory', () => {
  for (const p of [null, [], { bindings: {} }, { bindings: [{}] }, { bindings: [{ role: 'roles/x', members: [7] }] }, { bindings: [{ role: 'roles/x', members: [`serviceAccount:${email}`], condition: {} }] }]) assert.throws(() => selectBindings(p, email));
});
test('read failures are not retried and never turn into mutation attempts', async () => {
  for (const command of ['describe', 'list', 'get-default-service-account', 'get-iam-policy']) {
    const h = harness({ fail: (a) => a[1] === command }); await assert.rejects(h.perform());
    assert.equal(h.commands.filter((a) => a[1] === command).length, 1);
    assert.ok(!h.commands.some((a) => a.includes('enable')));
  }
});
test('invalid explicit CLI modes cannot invoke gcloud', () => {
  for (const flags of [['--enable-approved-apis-and-required-dependencies', '--force'], ['--project=wa-awesome'], ['--apply'], ['--inspect', '--inspect']]) assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/bootstrap-floating-garden-apis.mjs', import.meta.url)), ...flags], { env: { PATH: '' }, stdio: 'pipe' }));
});

test('configuration guard rejects endpoint, credential and universe overrides without changing them', () => {
  for (const config of [null, [], { api_endpoint_overrides: { cloudbuild: 'https://elsewhere.example' } }, { auth: { impersonate_service_account: 'admin@example.com' } }, { auth: { credential_file_override: '/some/path' } }, { auth: { access_token_file: '/some/path' } }, { core: { universe_domain: 'example.com' } }]) assert.throws(() => validateConfiguration(config));
  validateConfiguration({ core: { universe_domain: 'googleapis.com' }, api_endpoint_overrides: { cloudbuild: null }, auth: {} });
});

test('hidden legacy IAM conditions are rejected', () => {
  assert.throws(() => selectBindings({ bindings: [{ role: 'roles/viewer_withcond_abc123', members: [`serviceAccount:${email}`] }] }, email), /hidden/);
});
test('post-write read failure retains baseline and never repeats mutation', async () => {
  let reads = 0;
  const h = harness({ apis: [], fail: (a) => a[0] === 'services' && a[1] === 'list' && ++reads === 2 });
  await assert.rejects(h.perform(true));
  assert.ok(h.logs.some((s) => s.startsWith('ENABLED_APIS_BASELINE:')));
  assert.ok(h.logs.some((s) => s.startsWith('API_READBACK_UNAVAILABLE:')));
  assert.equal(h.commands.filter((a) => a[1] === 'enable').length, 1);
});
test('build or IAM failures after enablement retain API delta and never repeat mutation', async () => {
  for (const command of ['get-default-service-account', 'get-iam-policy']) {
    const h = harness({ apis: [], fail: (a) => a[1] === command });
    await assert.rejects(h.perform(true));
    assert.ok(h.logs.some((s) => s.startsWith('APIS_NEWLY_OBSERVED_ENABLED:')));
    assert.equal(h.commands.filter((a) => a[1] === 'enable').length, 1);
  }
});
test('malformed JSON stops without exposing raw response content', async () => {
  const calls = [];
  await assert.rejects(bootstrapApis({ run: (a) => { calls.push(a); return 'DO_NOT_DISPLAY_RESPONSE'; } }), (e) => /not JSON/.test(e.message) && !e.message.includes('DO_NOT_DISPLAY'));
  assert.equal(calls.length, 1);
});
test('real subprocess adapter uses exact project/billing, closed stdin and safe prompt/log options', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'garden-gcloud-adapter-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const record = join(dir, 'record.jsonl');
  const stub = `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
const stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({a,stdin,prompts:process.env.CLOUDSDK_CORE_DISABLE_PROMPTS,http:process.env.CLOUDSDK_CORE_LOG_HTTP,files:process.env.CLOUDSDK_CORE_DISABLE_FILE_LOGGING})+'\\n');
if(a[0]==='config') console.log('{}');
else if(a[0]==='projects') console.log(${JSON.stringify(JSON.stringify(identity))});
else if(a[0]==='services') console.log('firestore.googleapis.com');
else process.exit(3);
`;
  writeFileSync(join(dir, 'gcloud'), stub, { mode: 0o700 });
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/bootstrap-floating-garden-apis.mjs', import.meta.url)), '--inspect'], { encoding: 'utf8', env: { ...process.env, PATH: dir, CLOUDSDK_CORE_DISABLE_PROMPTS: '1', CLOUDSDK_CORE_LOG_HTTP: 'true' } });
  assert.match(output, /BUILD_ACCOUNT_PENDING/);
  const records = readFileSync(record, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 3);
  for (const item of records) {
    assert.ok(item.a.includes(`--project=${PROJECT}`));
    assert.ok(item.a.includes(`--billing-project=${PROJECT}`));
    assert.ok(!item.a.includes('--quiet'));
    assert.equal(item.stdin, ''); assert.equal(item.prompts, 'false'); assert.equal(item.http, 'false'); assert.equal(item.files, 'true');
  }
});

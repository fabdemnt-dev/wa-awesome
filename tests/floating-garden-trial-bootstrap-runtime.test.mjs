import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapRuntime, validateConfiguration, validateDatabase, validateAccount, validateRole, validateProjectPolicy, validateAccountPolicy, verifyUnrelatedPolicy, PROJECT, PROJECT_NUMBER, REGION, ACCOUNT_ID, ACCOUNT, MEMBER, ROLE_ID, ROLE, TITLE, PERMISSIONS, EXPRESSION, CONDITION } from '../scripts/bootstrap-floating-garden-runtime.mjs';
const path = fileURLToPath(new URL('../scripts/bootstrap-floating-garden-runtime.mjs', import.meta.url));
const project = { projectId: PROJECT, projectNumber: PROJECT_NUMBER, lifecycleState: 'ACTIVE' };
const account = () => ({ name: `projects/${PROJECT}/serviceAccounts/${ACCOUNT}`, projectId: PROJECT, email: ACCOUNT, uniqueId: '123456789012345678901', displayName: TITLE });
const role = () => ({ name: ROLE, title: TITLE, stage: 'GA', includedPermissions: [...PERMISSIONS] });
const binding = () => ({ role: ROLE, members: [MEMBER], condition: { ...CONDITION } });
const buildBinding = { role: 'roles/editor', members: [`serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com`] };
const database = { name: `projects/${PROJECT}/databases/(default)`, locationId: REGION, type: 'FIRESTORE_NATIVE' };
const apiInventory = ['iam.googleapis.com', 'firestore.googleapis.com', 'cloudresourcemanager.googleapis.com'].map((name) => ({ config: { name } }));
function harness(options = {}) {
  const commands = [], logs = [], waits = [];
  const state = { account: options.account ?? null, role: options.role ?? null, policy: options.policy ?? { version: 3, etag: 'fixture-etag', bindings: [structuredClone(buildBinding)] } };
  const writes = () => commands.filter((a) => a[2] === 'create' || a[1] === 'add-iam-policy-binding');
  const run = (a) => {
    commands.push(a);
    if (options.beforeCommand) options.beforeCommand(a, state);
    if (options.fail?.(a, state)) throw Error('FIXTURE_COMMAND_FAILURE');
    if (options.raw?.(a) !== undefined) return options.raw(a);
    if (a[0] === 'config') return JSON.stringify(options.config ?? {});
    if (a[0] === 'projects' && a[1] === 'describe') return JSON.stringify(options.project ?? project);
    if (a[0] === 'services') return JSON.stringify(options.apis ?? apiInventory);
    if (a[0] === 'firestore') return JSON.stringify(options.database ?? database);
    if (a[0] === 'iam' && a[1] === 'service-accounts') {
      if (a[2] === 'list') return JSON.stringify(options.accounts ?? (state.account ? [state.account] : []));
      if (a[2] === 'describe') { if (!state.account) throw Error('NOT_FOUND'); return JSON.stringify(state.account); }
      if (a[2] === 'keys') { assert.equal(a[3], 'list'); assert.ok(a.includes('--managed-by=user')); return JSON.stringify(options.keys ?? []); }
      if (a[2] === 'get-iam-policy') return JSON.stringify(options.accountPolicy ?? {});
      if (a[2] === 'create') { state.account = account(); return JSON.stringify(options.createdAccount ?? state.account); }
    }
    if (a[0] === 'iam' && a[1] === 'roles') {
      if (a[2] === 'list') { assert.ok(a.includes('--show-deleted')); return JSON.stringify(options.roles ?? (state.role ? [state.role] : [])); }
      if (a[2] === 'describe') { if (!state.role) throw Error('NOT_FOUND'); return JSON.stringify(state.role); }
      if (a[2] === 'create') { state.role = role(); return JSON.stringify(options.createdRole ?? state.role); }
    }
    if (a[0] === 'projects' && a[1] === 'get-iam-policy') return JSON.stringify(state.policy);
    if (a[0] === 'projects' && a[1] === 'add-iam-policy-binding') { state.policy.bindings.push(binding()); return JSON.stringify(options.bindingResult ?? state.policy); }
    throw Error(`UNEXPECTED: ${a.join(' ')}`);
  };
  return { commands, logs, waits, state, writes, perform: (apply = true) => bootstrapRuntime({ apply, run, log: (s) => logs.push(s), sleep: async (ms) => waits.push(ms) }) };
}
test('runtime scope is the exact approved project, account, role and four database permissions', () => {
  assert.equal(ACCOUNT, 'garden-trial-runtime@wa-awesome-garden-stg.iam.gserviceaccount.com');
  assert.equal(ROLE, 'projects/wa-awesome-garden-stg/roles/gardenTrialRuntime');
  assert.equal(EXPRESSION, 'resource.name == "projects/wa-awesome-garden-stg/databases/(default)"');
  assert.deepEqual([...PERMISSIONS].sort(), ['datastore.databases.get', 'datastore.entities.create', 'datastore.entities.get', 'datastore.entities.update']);
  assert.ok(Object.isFrozen(PERMISSIONS)); assert.ok(Object.isFrozen(CONDITION));
});
test('default and plan modes have no cloud subprocess', () => {
  for (const args of [[], ['--plan']]) assert.match(execFileSync(process.execPath, [path, ...args], { env: { PATH: '' }, encoding: 'utf8' }), /stage 2/);
});
test('unknown flags cannot access gcloud', () => {
  for (const args of [['--force'], ['--create-approved-runtime', '--force'], ['--project=wa-awesome'], ['--inspect', '--inspect']]) assert.throws(() => execFileSync(process.execPath, [path, ...args], { env: { PATH: '' }, stdio: 'pipe' }));
});
test('inspect reports missing targets without changing anything', async () => {
  const h = harness(); assert.equal((await h.perform(false)).complete, false); assert.equal(h.writes().length, 0); assert.equal(h.waits.length, 0);
});
test('new runtime uses three exact writes and preserves pre-existing build Editor unchanged', async () => {
  const h = harness(); assert.equal((await h.perform()).complete, true);
  assert.deepEqual(h.writes(), [
    ['iam', 'service-accounts', 'create', ACCOUNT_ID, `--display-name=${TITLE}`, '--description=', '--format=json'],
    ['iam', 'roles', 'create', ROLE_ID, `--title=${TITLE}`, '--description=', '--stage=GA', `--permissions=${PERMISSIONS.join(',')}`, '--format=json'],
    ['projects', 'add-iam-policy-binding', PROJECT, `--member=${MEMBER}`, `--role=${ROLE}`, `--condition=expression=${EXPRESSION},title=${CONDITION.title}`, '--format=json'],
  ]);
  assert.deepEqual(h.waits, [60000]); assert.deepEqual(h.state.policy.bindings[0], buildBinding);
  assert.ok(h.logs.some((s) => s.startsWith('RUNTIME_STAGE_VERIFIED:')));
  assert.ok(h.logs.some((s) => s.includes('effective data access are not fully audited')));
  assert.ok(!h.commands.some((a) => ['enable', 'delete', 'update', 'deploy', 'login', 'print-access-token'].some((x) => a.includes(x))));
});
test('pre-existing exact runtime is verified without mutations or delays', async () => {
  const h = harness({ account: account(), role: role(), policy: { bindings: [buildBinding, binding()] } });
  assert.equal((await h.perform()).complete, true); assert.equal(h.writes().length, 0); assert.equal(h.waits.length, 0);
});
test('missing binding on already-verified targets produces only the conditional grant', async () => {
  const h = harness({ account: account(), role: role() }); await h.perform(); assert.equal(h.writes().length, 1); assert.equal(h.writes()[0][1], 'add-iam-policy-binding');
});
test('wrong active project, number, database or missing API fails before every write', async () => {
  for (const options of [{ project: { ...project, projectId: 'wa-awesome' } }, { project: { ...project, projectNumber: '999' } }, { project: { ...project, lifecycleState: 'DELETE_REQUESTED' } }, { database: { ...database, locationId: 'us-central1' } }, { database: { ...database, name: `projects/${PROJECT}/databases/other` } }, { database: { ...database, type: 'DATASTORE_MODE' } }, { apis: [] }]) {
    const h = harness(options); await assert.rejects(h.perform()); assert.equal(h.writes().length, 0);
  }
});
test('a numeric projectNumber and numeric project reference for database are accepted', async () => {
  const h = harness({ project: { ...project, projectNumber: Number(PROJECT_NUMBER) }, database: { ...database, name: `projects/${PROJECT_NUMBER}/databases/(default)` } });
  await h.perform(false); assert.equal(h.writes().length, 0);
});
test('existing runtime metadata mismatch, disabled account, keys or account-level IAM stops before writes', async () => {
  for (const options of [{ account: { ...account(), projectId: 'wa-awesome' } }, { account: { ...account(), disabled: true } }, { account: { ...account(), displayName: 'Unrecognized' } }, { account: { ...account(), uniqueId: undefined } }, { account: account(), keys: [{ name: 'key-metadata-only' }] }, { account: account(), keys: {} }, { account: account(), accountPolicy: { bindings: [{ role: 'roles/iam.serviceAccountTokenCreator', members: ['user:someone@example.com'] }] } }]) {
    const h = harness(options); await assert.rejects(h.perform()); assert.equal(h.writes().length, 0);
  }
});
test('deleted, disabled, broader, missing-permission or duplicate-permission role stops before writes', async () => {
  for (const r of [{ ...role(), deleted: true }, { ...role(), stage: 'DISABLED' }, { ...role(), title: 'Unknown role' }, { ...role(), includedPermissions: [...PERMISSIONS, 'datastore.entities.delete'] }, { ...role(), includedPermissions: PERMISSIONS.slice(1) }, { ...role(), includedPermissions: [...PERMISSIONS.slice(1), PERMISSIONS[1]] }]) {
    const h = harness({ role: r }); await assert.rejects(h.perform()); assert.equal(h.writes().length, 0);
  }
});
test('existing project grants cannot broaden runtime or revive a deleted account', async () => {
  const unsafe = [
    { role: 'roles/editor', members: [MEMBER] }, { ...binding(), condition: undefined },
    { ...binding(), condition: { title: 'wide', expression: 'true' } }, { ...binding(), members: [MEMBER, 'user:someone@example.com'] },
    { role: 'roles/viewer', members: [`deleted:${MEMBER}?uid=123`] },
    { role: 'roles/viewer', members: ['allAuthenticatedUsers'] },
    { role: 'roles/viewer_withcond_abc', members: ['user:other@example.com'] },
  ];
  for (const b of unsafe) { const h = harness({ policy: { bindings: [b] } }); await assert.rejects(h.perform()); assert.equal(h.writes().length, 0); }
});
test('target binding without matching existing account and role stops before writes', async () => {
  for (const options of [{}, { account: account() }, { role: role() }]) { const h = harness({ ...options, policy: { bindings: [binding()] } }); await assert.rejects(h.perform()); assert.equal(h.writes().length, 0); }
});
test('duplicate target grants or malformed IAM cannot be silently normalized', () => {
  for (const p of [null, [], { bindings: {} }, { bindings: [{ role: 'roles/viewer' }] }, { bindings: [binding(), binding()] }]) assert.throws(() => validateProjectPolicy(p));
  validateAccountPolicy({}); assert.throws(() => validateAccountPolicy({ bindings: [binding()] }));
});
test('permission or inventory failures are never mistaken for missing resources', async () => {
  for (const target of ['account-list', 'role-list', 'account-describe', 'role-describe', 'keys']) {
    const h = harness({ account: account(), role: role(), fail: (a) => target === 'account-list' && a[1] === 'service-accounts' && a[2] === 'list' || target === 'role-list' && a[1] === 'roles' && a[2] === 'list' || target === 'account-describe' && a[1] === 'service-accounts' && a[2] === 'describe' || target === 'role-describe' && a[1] === 'roles' && a[2] === 'describe' || target === 'keys' && a[2] === 'keys' });
    await assert.rejects(h.perform()); assert.equal(h.writes().length, 0);
  }
});
test('each uncertain write is attempted only once; later writes stop', async () => {
  for (const target of ['service-accounts', 'roles', 'binding']) {
    const h = harness({ fail: (a) => a[2] === 'create' && a[1] === target || target === 'binding' && a[1] === 'add-iam-policy-binding' });
    await assert.rejects(h.perform());
    assert.equal(h.writes().length, ['service-accounts', 'roles', 'binding'].indexOf(target) + 1);
    assert.ok(!h.logs.some((s) => s.startsWith('RUNTIME_STAGE_VERIFIED:')));
  }
});
test('created response mismatches stop before granting or recreating', async () => {
  for (const options of [{ createdAccount: { ...account(), email: 'foreign@example.com' } }, { createdRole: { ...role(), includedPermissions: ['*'] } }, { bindingResult: {} }]) {
    const h = harness(options); await assert.rejects(h.perform()); assert.ok(!h.logs.some((s) => s.startsWith('RUNTIME_STAGE_VERIFIED:'))); assert.ok(h.writes().length <= 3);
  }
});
test('concurrent broad project grant before role creation stops after only account create', async () => {
  let checks = 0;
  const h = harness({ beforeCommand: (a, state) => { if (a[1] === 'get-iam-policy' && ++checks === 2) state.policy.bindings.push({ role: 'roles/editor', members: [MEMBER] }); } });
  await assert.rejects(h.perform()); assert.equal(h.writes().length, 1);
});
test('concurrent role widening before binding stops instead of granting', async () => {
  let descriptions = 0;
  const h = harness({ account: account(), role: role(), beforeCommand: (a, state) => { if (a[1] === 'roles' && a[2] === 'describe' && ++descriptions === 2) state.role.includedPermissions.push('datastore.entities.delete'); } });
  await assert.rejects(h.perform()); assert.equal(h.writes().length, 0);
});
test('configuration guards reject unexpected endpoint, credential and universe routing', () => {
  for (const c of [null, [], { auth: { credential_file_override: '/unknown' } }, { auth: { impersonate_service_account: 'admin@example.com' } }, { auth: { access_token_file: '/unknown' } }, { api_endpoint_overrides: { iam: 'https://example.com' } }, { core: { universe_domain: 'example.com' } }]) assert.throws(() => validateConfiguration(c));
  validateConfiguration({ core: { universe_domain: 'googleapis.com' }, api_endpoint_overrides: { iam: null } });
});
test('malformed JSON responses stop without exposing body contents', async () => {
  const h = harness({ raw: (a) => a[0] === 'config' ? 'PRIVATE_BODY_MUST_NOT_LEAK' : undefined });
  await assert.rejects(h.perform(), (e) => /invalid JSON/.test(e.message) && !e.message.includes('PRIVATE_BODY')); assert.equal(h.writes().length, 0);
});
test('production adapter is fixed-project, noninteractive, logging-disabled and sanitizes failures', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'garden-runtime-adapter-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const record = join(dir, 'record');
  const stub = `#!${process.execPath}
const fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(record)},JSON.stringify({a,stdin:fs.readFileSync(0,'utf8'),prompts:process.env.CLOUDSDK_CORE_DISABLE_PROMPTS,http:process.env.CLOUDSDK_CORE_LOG_HTTP,file:process.env.CLOUDSDK_CORE_DISABLE_FILE_LOGGING})+'\\n');
if(a[0]==='config') console.log('{}');else {console.error('PRIVATE_ERROR_BODY');process.exit(7);}
`;
  writeFileSync(join(dir, 'gcloud'), stub, { mode: 0o700 });
  assert.throws(() => execFileSync(process.execPath, [path, '--inspect'], { env: { ...process.env, PATH: dir, CLOUDSDK_CORE_DISABLE_PROMPTS: '1' }, stdio: 'pipe' }), (e) => /STOP: gcloud projects describe/.test(e.stderr.toString()) && !e.stderr.toString().includes('PRIVATE_ERROR_BODY'));
  const records = readFileSync(record, 'utf8').trim().split('\n').map(JSON.parse); assert.equal(records.length, 2);
  for (const r of records) { assert.ok(r.a.includes(`--project=${PROJECT}`)); assert.ok(r.a.includes(`--billing-project=${PROJECT}`)); assert.ok(!r.a.includes('--quiet')); assert.equal(r.stdin, ''); assert.equal(r.prompts, 'false'); assert.equal(r.http, 'false'); assert.equal(r.file, 'true'); }
});

test('account names/descriptions, role descriptions and condition metadata must exactly match', () => {
  for (const a of [{ ...account(), name: 'projects/foreign/serviceAccounts/foreign' }, { ...account(), description: 'unknown' }]) assert.throws(() => validateAccount(a));
  assert.throws(() => validateRole({ ...role(), description: 'unknown' }));
  for (const condition of [{ ...CONDITION, title: 'other-title' }, { ...CONDITION, description: 'unknown' }]) assert.throws(() => validateProjectPolicy({ bindings: [{ ...binding(), condition }] }));
  validateAccount({ ...account(), name: `projects/${PROJECT_NUMBER}/serviceAccounts/${account().uniqueId}`, description: '', disabled: false });
});
test('all validation failures after a write expose partial-state stop instructions', async () => {
  const h = harness({ createdAccount: { ...account(), email: 'wrong@example.com' } });
  await assert.rejects(h.perform());
  assert.ok(h.logs.some((s) => s.startsWith('PARTIAL_STATE:') && s.includes('DO_NOT_REAPPLY')));
});
test('runtime unique ID is pinned across the operation', async () => {
  let count = 0;
  const h = harness({ account: account(), role: role(), beforeCommand: (a, state) => { if (a[1] === 'service-accounts' && a[2] === 'describe' && ++count === 2) state.account.uniqueId = '999999999999999999999'; } });
  await assert.rejects(h.perform(), /unique ID changed/); assert.equal(h.writes().length, 0);
});
test('unrelated project bindings and auditConfigs are preserved semantically', () => {
  const before = { version: 3, etag: 'old', bindings: [buildBinding], auditConfigs: [{ service: 'allServices', auditLogConfigs: [{ logType: 'ADMIN_READ' }] }] };
  const after = { ...structuredClone(before), etag: 'new', bindings: [binding(), structuredClone(buildBinding)] };
  verifyUnrelatedPolicy(before, after);
  assert.throws(() => verifyUnrelatedPolicy(before, { ...after, bindings: [binding()] }));
  assert.throws(() => verifyUnrelatedPolicy(before, { ...after, auditConfigs: [] }));
  assert.throws(() => verifyUnrelatedPolicy(before, { ...after, bindings: [...after.bindings, { role: 'roles/viewer', members: ['user:other@example.com'] }] }));
});

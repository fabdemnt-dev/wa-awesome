// Synthetic fixtures only. NEVER run a real generator or secret/API operation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootstrapHmac, createSecretInUserShell, makeMetadataRunner, validateEnvironment, validateConfiguration, validateSecret, validateVersions, validateVersion, validateSecretPolicy, PROJECT, PROJECT_NUMBER, REGION, ACCOUNT, MEMBER, TITLE, ROLE, PERMISSIONS, CONDITION, SECRET, SECRET_ID, ACCESSOR } from '../scripts/bootstrap-floating-garden-hmac.mjs';
const path = fileURLToPath(new URL('../scripts/bootstrap-floating-garden-hmac.mjs', import.meta.url));
const copy = (v) => structuredClone(v);
const project = { projectId: PROJECT, projectNumber: PROJECT_NUMBER, lifecycleState: 'ACTIVE' };
const account = { name: `projects/${PROJECT}/serviceAccounts/${ACCOUNT}`, projectId: PROJECT, email: ACCOUNT, uniqueId: '123456789012345678901', displayName: TITLE };
const role = { name: ROLE, title: TITLE, stage: 'GA', includedPermissions: [...PERMISSIONS] };
const projectPolicy = { version: 3, etag: 'fixture', bindings: [{ role: ROLE, members: [MEMBER], condition: { ...CONDITION } }] };
const secret = { name: `projects/${PROJECT_NUMBER}/secrets/${SECRET_ID}`, createTime: '2026-10-02T00:00:00Z', etag: 'fixture-secret', replication: { userManaged: { replicas: [{ location: REGION }] } } };
const version = { name: `${secret.name}/versions/1`, state: 'ENABLED', createTime: '2026-10-02T00:00:01Z', etag: 'fixture-version', replicationStatus: { userManaged: { replicas: [{ location: REGION }] } } };
const binding = { role: ACCESSOR, members: [MEMBER] };
function harness(o = {}) {
  const commands = [], logs = []; let creations = 0, grants = 0;
  const state = { secret: o.existing ? copy(secret) : null, versions: o.existing ? copy(o.versions ?? [version]) : [], policy: copy(o.secretPolicy ?? {}) };
  const run = (a) => {
    commands.push(a); o.before?.(a, state);
    if (o.fail?.(a, state)) throw Error('MOCK_READ_FAILURE');
    if (a[0] === 'config') return JSON.stringify(o.config ?? {});
    if (a[0] === 'projects') return JSON.stringify(a[1] === 'describe' ? o.project ?? project : o.projectPolicy ?? projectPolicy);
    if (a[0] === 'services') return JSON.stringify(o.apis ?? ['secretmanager.googleapis.com', 'iam.googleapis.com', 'cloudresourcemanager.googleapis.com'].map((name) => ({ config: { name } })));
    if (a[0] === 'iam') {
      if (a[1] === 'roles') return JSON.stringify(o.role ?? role);
      if (a[2] === 'describe') return JSON.stringify(o.account ?? account);
      if (a[2] === 'keys') return JSON.stringify(o.keys ?? []);
      if (a[2] === 'get-iam-policy') return JSON.stringify(o.accountPolicy ?? {});
    }
    if (a[0] === 'secrets') {
      if (a[1] === 'list') return JSON.stringify(o.inventory ?? (state.secret ? [state.secret] : []));
      if (a[1] === 'describe') return JSON.stringify(state.secret);
      if (a[1] === 'versions') { assert.equal(a.length, 4); assert.equal(a[3], a[2] === 'list' ? SECRET : `${SECRET}/versions/1`); return JSON.stringify(a[2] === 'list' ? state.versions : o.version ?? state.versions[0]); }
      if (a[1] === 'get-iam-policy') return JSON.stringify(state.policy);
      if (a[1] === 'add-iam-policy-binding') { grants++; state.policy = { bindings: [copy(binding)] }; return JSON.stringify(o.grantResult ?? state.policy); }
    }
    throw Error('UNEXPECTED_MOCK_COMMAND');
  };
  const create = ({ onWrite }) => {
    creations++; onWrite(); state.secret = copy(o.newSecret ?? secret); state.versions = copy(o.newVersions ?? [version]);
    if (o.createFails) throw Error('MOCK_UNCERTAIN_CREATE');
  };
  return { commands, logs, state, counts: () => ({ creations, grants }), perform: (userOperated = true) => bootstrapHmac({ userOperated, env: o.env ?? {}, execArgv: [], run, create, log: (s) => logs.push(s) }) };
}
test('default and explicit plan require neither generator nor gcloud', () => {
  for (const args of [[], ['--plan']]) assert.match(execFileSync(process.execPath, [path, ...args], { env: { PATH: '' }, encoding: 'utf8' }), /USER-ONLY Cloud Shell/);
});
test('invalid CLI modes cannot enter the generation path', () => {
  for (const args of [['--create'], ['--user-create-new-hmac', '--force'], ['--project=wa-awesome']]) assert.throws(() => execFileSync(process.execPath, [path, ...args], { env: { PATH: '' }, stdio: 'pipe' }));
});
test('absent-secret inspection never generates or changes anything', async () => {
  const h = harness(); assert.deepEqual(await h.perform(false), { existing: false, created: false }); assert.deepEqual(h.counts(), { creations: 0, grants: 0 });
});
test('ANY existing secret refuses apply, even zero versions or incomplete prior setup', async () => {
  for (const versions of [[], [version], [{ ...version, state: 'DISABLED' }]]) {
    const h = harness({ existing: true, versions }); await assert.rejects(h.perform(), /Existing secret detected/); assert.deepEqual(h.counts(), { creations: 0, grants: 0 });
  }
});
test('existing-secret inspection reads metadata only and cannot grant missing access', async () => {
  const h = harness({ existing: true, versions: [] }); await h.perform(false);
  assert.deepEqual(h.counts(), { creations: 0, grants: 0 }); assert.ok(h.logs.includes('EXISTING_VERSION_STATES: none'));
  assert.ok(!h.commands.some((a) => a.includes('access')));
});
test('new-secret user flow performs one creator handoff and one exact secret-level grant', async () => {
  const h = harness(); assert.deepEqual(await h.perform(), { existing: false, created: true });
  assert.deepEqual(h.counts(), { creations: 1, grants: 1 });
  assert.deepEqual(h.commands.find((a) => a[1] === 'add-iam-policy-binding'), ['secrets', 'add-iam-policy-binding', SECRET, `--member=${MEMBER}`, `--role=${ACCESSOR}`, '--condition=None']);
  assert.ok(h.logs.some((s) => s.startsWith('HMAC_STAGE_VERIFIED')));
  assert.ok(h.logs.some((s) => s.includes('inherited administrator/group/impersonation')));
  assert.ok(!h.commands.some((a) => a.includes('access') || ['delete', 'add', 'enable', 'deploy', 'login', 'print-access-token'].some((v) => a.includes(v))));
});
test('failed creation never repeats generation, adds another version, grants or deletes', async () => {
  const h = harness({ createFails: true }); await assert.rejects(h.perform()); assert.deepEqual(h.counts(), { creations: 1, grants: 0 });
  assert.ok(h.logs.some((s) => s.startsWith('PARTIAL_STATE') && s.includes('DO_NOT_REAPPLY')));
});
test('wrong project, missing APIs or unsafe runtime fails before any generation', async () => {
  for (const o of [{ project: { ...project, projectId: 'wa-awesome' } }, { project: { ...project, projectNumber: '999' } }, { apis: [] }, { account: { ...account, disabled: true } }, { keys: [{}] }, { role: { ...role, includedPermissions: ['*'] } }, { projectPolicy: { bindings: [] } }, { accountPolicy: { bindings: [{ role: 'roles/iam.serviceAccountTokenCreator', members: ['user:other@example.com'] }] } }]) {
    const h = harness(o); await assert.rejects(h.perform()); assert.deepEqual(h.counts(), { creations: 0, grants: 0 });
  }
});
test('failed inventory never means absence', async () => {
  const h = harness({ fail: (a) => a[0] === 'secrets' && a[1] === 'list' }); await assert.rejects(h.perform()); assert.equal(h.counts().creations, 0);
  for (const inventory of [{}, [{ name: 'projects/foreign/secrets/name' }], [{ name: `${SECRET}/versions/1` }]]) { const h2 = harness({ inventory }); await assert.rejects(h2.perform()); assert.equal(h2.counts().creations, 0); }
});
test('secret appearing on second inventory stops before generation', async () => {
  let n = 0; const h = harness({ before: (a, state) => { if (a[0] === 'secrets' && a[1] === 'list' && ++n === 2) state.secret = copy(secret); } });
  await assert.rejects(h.perform(), /concurrently/); assert.equal(h.counts().creations, 0);
});
test('wrong replica, automatic replication and unexpected metadata cannot precede a grant', async () => {
  for (const newSecret of [{ ...secret, replication: { automatic: {} } }, { ...secret, replication: { userManaged: { replicas: [{ location: 'us-central1' }] } } }, { ...secret, topics: [{ name: 'unknown' }] }, { ...secret, versionAliases: { other: '1' } }, { ...secret, rotation: { rotationPeriod: '3600s' } }, { ...secret, expireTime: '2027-01-01T00:00:00Z' }]) {
    const h = harness({ newSecret }); await assert.rejects(h.perform()); assert.equal(h.counts().grants, 0);
  }
});
test('empty, extra, disabled, destroyed and foreign versions stop before granting', async () => {
  for (const newVersions of [[], [version, { ...version, name: `${secret.name}/versions/2` }], [{ ...version, state: 'DISABLED' }], [{ ...version, state: 'DESTROYED' }], [{ ...version, name: 'projects/foreign/secrets/unknown/versions/1' }]]) {
    const h = harness({ newVersions }); await assert.rejects(h.perform()); assert.equal(h.counts().grants, 0);
  }
});
test('unknown direct secret binding is never repaired or combined', async () => {
  for (const secretPolicy of [{ bindings: [{ role: ACCESSOR, members: ['allUsers'] }] }, { bindings: [binding] }, { bindings: [{ ...binding, condition: { expression: 'true' } }] }]) { const h = harness({ secretPolicy }); await assert.rejects(h.perform()); assert.equal(h.counts().grants, 0); }
});
test('runtime uniqueId and secret creation identity cannot change before grant', async () => {
  let n = 0; const h = harness({ before: (a, state) => { if (a[0] === 'secrets' && a[1] === 'describe' && ++n === 2) state.secret.createTime = '2026-10-03T00:00:00Z'; } });
  await assert.rejects(h.perform(), /replaced/); assert.equal(h.counts().grants, 0);
});
test('version/secret metadata validators reject unsafe or hidden states', () => {
  assert.throws(() => validateVersion({ ...version, replicationStatus: { automatic: {} } }));
  assert.throws(() => validateVersion({ ...version, destroyTime: '2026-10-03T00:00:00Z' }));
  assert.throws(() => validateVersions([{ ...version, state: 'UNKNOWN' }]));
  assert.throws(() => validateSecretPolicy({ bindings: [{ ...binding, role: `${ACCESSOR}_withcond_abc` }] }));
  validateSecret({ ...secret, labels: {}, annotations: {}, topics: [] });
});
test('environment/config guards reject proxy, debug, injection and credential/TLS overrides', () => {
  for (const env of [{ HTTP_PROXY: 'http://unknown' }, { REQUESTS_CA_BUNDLE: '/unknown' }, { NODE_EXTRA_CA_CERTS: '/unknown' }, { NODE_OPTIONS: '--inspect' }, { NODE_DEBUG: 'child_process' }, { OPENSSL_CONF: '/unknown' }, { CLOUDSDK_API_ENDPOINT_OVERRIDES_SECRETMANAGER: 'https://unknown' }, { CLOUDSDK_AUTH_ACCESS_TOKEN: 'synthetic' }]) assert.throws(() => validateEnvironment(env, []));
  assert.throws(() => validateEnvironment({}, ['--inspect']));
  for (const c of [{ proxy: { address: 'unknown' } }, { auth: { token_host: 'https://unknown' } }, { auth: { disable_credentials: 'true' } }, { core: { custom_ca_certs_file: '/unknown' } }, { regional: { endpoint_mode: 'regional' } }]) assert.throws(() => validateConfiguration(c));
  validateConfiguration({ auth: { disable_credentials: 'false', token_host: 'https://oauth2.googleapis.com/token' }, regional: { endpoint_mode: 'global' } });
});
test('production creator uses only synthetic injected bytes, stdin, suppressed output and owned-buffer clearing', () => {
  const raw = Buffer.from('a'.repeat(64) + '\n'); let calls = 0, inputView, notified = 0;
  const result = createSecretInUserShell({ env: {}, execArgv: [], onWrite: () => notified++, exec: (command, args, options) => {
    calls++;
    if (command === '/usr/bin/openssl') { assert.deepEqual(args, ['rand', '-hex', '32']); assert.equal(options.encoding, undefined); assert.deepEqual(options.stdio, ['ignore', 'pipe', 'ignore']); return raw; }
    assert.equal(command, 'gcloud'); inputView = options.input; assert.equal(inputView.length, 64); assert.ok(inputView.every((b) => b === 97));
    assert.deepEqual(args, ['secrets', 'create', SECRET, '--replication-policy=user-managed', `--locations=${REGION}`, '--data-file=-', '--format=none', `--project=${PROJECT}`, `--billing-project=${PROJECT}`, '--verbosity=error']);
    assert.deepEqual(options.stdio, ['pipe', 'ignore', 'ignore']); assert.equal(options.env.CLOUDSDK_CORE_LOG_HTTP, 'false'); assert.equal(options.env.CLOUDSDK_CORE_DISABLE_FILE_LOGGING, 'true');
    assert.ok(!args.join(' ').includes('a'.repeat(64))); assert.ok(!Object.values(options.env).includes('a'.repeat(64))); return undefined;
  } });
  assert.equal(result, undefined); assert.equal(calls, 2); assert.equal(notified, 1); assert.ok(raw.every((b) => b === 0)); assert.ok(inputView.every((b) => b === 0));
});
test('generator failure and malformed synthetic output never reach creation and never leak content', () => {
  for (const raw of [Buffer.from('a'.repeat(63) + '\n'), Buffer.from('z'.repeat(64) + '\n'), Buffer.from('a'.repeat(64)), Buffer.from('a'.repeat(64) + '\r\n')]) {
    let calls = 0; assert.throws(() => createSecretInUserShell({ env: {}, execArgv: [], exec: () => { calls++; return raw; } }), /invalid/); assert.equal(calls, 1); assert.ok(raw.every((b) => b === 0));
  }
  const stdout = Buffer.from('SYNTHETIC_PARTIAL_VALUE'); let calls = 0;
  assert.throws(() => createSecretInUserShell({ env: {}, execArgv: [], exec: () => { calls++; const error = new Error('PRIVATE_GENERATOR_DIAGNOSTIC'); error.stdout = stdout; throw error; } }), (e) => !e.message.includes('PRIVATE_GENERATOR') && /generation failed/.test(e.message));
  assert.equal(calls, 1); assert.ok(stdout.every((b) => b === 0));
});
test('uncertain creation wipes synthetic bytes and masks subprocess diagnostics without retry', () => {
  const raw = Buffer.from('b'.repeat(64) + '\n'); let n = 0;
  assert.throws(() => createSecretInUserShell({ env: {}, execArgv: [], exec: () => { if (++n === 1) return raw; throw new Error('PRIVATE_SECRET_DIAGNOSTIC'); } }), (e) => /uncertain/.test(e.message) && !e.message.includes('PRIVATE_SECRET'));
  assert.equal(n, 2); assert.ok(raw.every((b) => b === 0));
});
test('metadata subprocess fixes project/quota and suppresses raw error diagnostics', () => {
  const run = makeMetadataRunner({ env: {}, exec: (cmd, args, options) => { assert.equal(cmd, 'gcloud'); assert.ok(args.includes(`--project=${PROJECT}`)); assert.ok(args.includes(`--billing-project=${PROJECT}`)); assert.ok(args.includes('--format=json')); assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']); throw new Error('PRIVATE_DIAGNOSTIC'); } });
  assert.throws(() => run(['secrets', 'describe', SECRET]), (e) => !e.message.includes('PRIVATE_DIAGNOSTIC'));
});

test('documented proxy rdns default is harmless without a proxy route', () => { validateConfiguration({ proxy: { rdns: 'true', address: null, type: null } }); });
test('metadata etag changes before grant stop without automatic recovery', async () => {
  let n = 0; const h = harness({ before: (a, state) => { if (a[0] === 'secrets' && a[1] === 'describe' && ++n === 2) state.secret.etag = 'changed'; } });
  await assert.rejects(h.perform(), /replaced/); assert.equal(h.counts().grants, 0);
});
test('runtime uniqueId replacement before granting is rejected', async () => {
  const changingAccount = copy(account); let n = 0;
  const h = harness({ account: changingAccount, before: (a) => { if (a[0] === 'iam' && a[1] === 'service-accounts' && a[2] === 'describe' && ++n === 2) changingAccount.uniqueId = '999999999999999999999'; } });
  await assert.rejects(h.perform(), /uniqueId changed/); assert.equal(h.counts().grants, 0);
});
test('post-create metadata failure keeps existing partial resource and never retries on next apply', async () => {
  const h = harness({ fail: (a) => a[0] === 'secrets' && a[1] === 'describe' });
  await assert.rejects(h.perform()); assert.ok(h.state.secret); assert.deepEqual(h.counts(), { creations: 1, grants: 0 });
  await assert.rejects(h.perform(), /Existing secret detected/); assert.deepEqual(h.counts(), { creations: 1, grants: 0 });
});
test('IAM failure never regenerates or retries grant', async () => {
  const h = harness({ fail: (a) => a[0] === 'secrets' && a[1] === 'add-iam-policy-binding' });
  await assert.rejects(h.perform()); assert.equal(h.counts().creations, 1);
  assert.equal(h.commands.filter((a) => a[1] === 'add-iam-policy-binding').length, 1);
  assert.ok(h.logs.some((s) => s.startsWith('PARTIAL_STATE'))); assert.ok(!h.logs.some((s) => s.startsWith('HMAC_STAGE_VERIFIED')));
});
test('failed generator wipes all returned synthetic stdout/output buffers', () => {
  const one = Buffer.from('SYNTHETIC_PARTIAL_ONE'), two = Buffer.from('SYNTHETIC_PARTIAL_TWO');
  assert.throws(() => createSecretInUserShell({ env: {}, execArgv: [], exec: () => { const error = new Error('MASKED'); error.stdout = one; error.output = [null, two, null]; throw error; } }));
  assert.ok(one.every((b) => b === 0)); assert.ok(two.every((b) => b === 0));
});

test('a metadata-identical secret may have a new etag after the authorized IAM update', async () => {
  let n = 0; const h = harness({ before: (a, state) => { if (a[0] === 'secrets' && a[1] === 'describe' && ++n === 3) state.secret.etag = 'post-iam-etag'; } });
  assert.equal((await h.perform()).created, true); assert.equal(h.counts().grants, 1);
});
test('version metadata etag change before IAM is rejected', async () => {
  let n = 0; const h = harness({ before: (a, state) => { if (a[0] === 'secrets' && a[1] === 'versions' && a[2] === 'describe' && ++n === 2) state.versions[0].etag = 'changed'; } });
  await assert.rejects(h.perform(), /version metadata changed/); assert.equal(h.counts().grants, 0);
});
test('postgrant replacement or replication change still stops with partial-state warning', async () => {
  for (const change of [(s) => { s.createTime = '2026-10-03T00:00:00Z'; }, (s) => { s.replication.userManaged.replicas[0].location = 'us-central1'; }]) {
    let n = 0; const h = harness({ before: (a, state) => { if (a[0] === 'secrets' && a[1] === 'describe' && ++n === 3) change(state.secret); } });
    await assert.rejects(h.perform()); assert.equal(h.counts().grants, 1);
    assert.ok(h.logs.some((s) => s.startsWith('PARTIAL_STATE'))); assert.ok(!h.logs.some((s) => s.startsWith('HMAC_STAGE_VERIFIED')));
  }
});

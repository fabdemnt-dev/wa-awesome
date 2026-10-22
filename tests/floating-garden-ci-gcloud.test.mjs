import test from 'node:test';
import assert from 'node:assert/strict';
import { ciFunctionDeployArguments, classifyCiFunctionDeploy, GCLOUD_SOURCE_IGNORE } from '../scripts/floating-garden-ci-gcloud.mjs';
import { FUNCTION_NAMES } from '../scripts/prepare-floating-garden-trial.mjs';
import { ACTIVE_UPDATE_SCOPE as S } from '../scripts/floating-garden-active-update.mjs';
const fixture = (name = FUNCTION_NAMES[0]) => ({ name: `projects/${S.project}/locations/${S.region}/functions/${name}`, environment: 'GEN_2', state: 'ACTIVE',
  buildConfig: { entryPoint: name, runtime: 'nodejs22', serviceAccount: `projects/${S.project}/serviceAccounts/${S.projectNumber}-compute@developer.gserviceaccount.com` },
  serviceConfig: { serviceAccountEmail: `garden-trial-runtime@${S.project}.iam.gserviceaccount.com` } });
test('exact official Functions argv sets only source and same actual runtime/build identities', () => {
  for (const name of FUNCTION_NAMES) for (const project of [S.project, S.projectNumber]) {
    const fn = fixture(name); fn.buildConfig.serviceAccount = fn.buildConfig.serviceAccount.replace(`projects/${S.project}/`, `projects/${project}/`);
    const args = ciFunctionDeployArguments(fn, '/private/packet/game/functions', '/private/tooling/source.ignore');
    assert.deepEqual(args, ['functions', 'deploy', name, '--gen2', `--region=${S.region}`, `--project=${S.project}`, `--billing-project=${S.project}`,
      '--source=/private/packet/game/functions', '--ignore-file=/private/tooling/source.ignore', `--run-service-account=${fn.serviceConfig.serviceAccountEmail}`,
      `--build-service-account=${fn.buildConfig.serviceAccount}`, '--quiet', '--format=json', '--verbosity=error']);
    assert(!args.some(a => /stage-bucket|runtime=|entry-point|label|secret|env-vars|allow-unauthenticated|trigger|traffic/.test(a)));
  }
  assert(GCLOUD_SOURCE_IGNORE.includes('node_modules\n') && GCLOUD_SOURCE_IGNORE.includes('**/.[!.]*'));
});
test('missing/foreign/default Appspot identities and create-capable inputs fail closed', () => {
  for (const mutate of [fn => delete fn.buildConfig.serviceAccount,
    fn => fn.buildConfig.serviceAccount = `projects/${S.project}/serviceAccounts/${S.project}@appspot.gserviceaccount.com`,
    fn => fn.buildConfig.serviceAccount = `projects/${S.project}/serviceAccounts/garden-github-deployer@${S.project}.iam.gserviceaccount.com`,
    fn => fn.buildConfig.serviceAccount = 'projects/foreign/serviceAccounts/foreign@foreign.iam.gserviceaccount.com',
    fn => fn.serviceConfig.serviceAccountEmail = `${S.project}@appspot.gserviceaccount.com`,
    fn => fn.state = 'FAILED', fn => fn.environment = 'GEN_1', fn => fn.buildConfig.runtime = 'nodejs24',
    fn => fn.eventTrigger = {}, fn => fn.name += 'X', fn => fn.buildConfig.entryPoint = 'other']) {
    const fn = fixture(); mutate(fn); assert.throws(() => ciFunctionDeployArguments(fn, '/source', '/ignore'));
  }
  for (const p of ['relative', '/a/../b', '/a\nsecret']) assert.throws(() => ciFunctionDeployArguments(fixture(), p, '/ignore'));
});
test('only successful matching gcloud Function JSON is accepted, with independent readback still mandatory', () => {
  const fn = fixture(), valid = { exitCode: 0, stdout: JSON.stringify(fn) };
  assert.equal(classifyCiFunctionDeploy(valid, fn).kind, 'success');
  for (const raw of [{ ...valid, signal: true }, { ...valid, timedOut: true }, { ...valid, exitCode: 1 },
    { exitCode: 0, stdout: '' }, { exitCode: 0, stdout: '{"status":"success"}' },
    { exitCode: 0, stdout: JSON.stringify({ ...fn, state: 'FAILED' }) },
    { exitCode: 0, stdout: JSON.stringify({ ...fn, name: 'foreign' }) }, null]) assert.equal(classifyCiFunctionDeploy(raw, fn).kind, 'unknown');
});

// Small well-formed ZIP writer for adversarial directory-entry guards; real
// SDK ZIP acceptance is separately exercised by the integration entry.
import { validateSourceArchive } from '../scripts/floating-garden-trial-cloud-adapter.mjs';
function storedZip(entries) {
  const locals = [], central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), bytes = Buffer.from(entry.bytes || ''); let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, bytes);
    const dir = entry.directory ?? entry.name.endsWith('/'), mode = entry.mode ?? (dir ? 0o40755 : 0o100644);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(0x314, 4); c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(bytes.length, 20); c.writeUInt32LE(bytes.length, 24); c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(((mode << 16) | (dir ? 0x10 : 0)) >>> 0, 38); c.writeUInt32LE(offset, 42); central.push(c, name);
    offset += local.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
test('CI ZIP directory option permits only payload-free exact ancestors and unchanged source files', () => {
  const files = { 'index.js': 'root', 'online/handler.js': 'inner' }, fileEntries = Object.entries(files).map(([name, bytes]) => ({ name, bytes }));
  const dir = { name: 'online/' }, valid = [dir, ...fileEntries];
  assert.deepEqual(validateSourceArchive(storedZip(valid), files, { allowDirectoryEntries: true }), { verified: true, fileCount: 2 });
  assert.throws(() => validateSourceArchive(storedZip(valid), files));
  for (const entries of [[{ ...dir, bytes: 'payload' }, ...fileEntries], [{ name: 'empty/' }, ...fileEntries],
    [{ name: 'online/empty/' }, ...fileEntries], [{ name: '../' }, ...fileEntries], [{ name: './' }, ...fileEntries],
    [dir, dir, ...fileEntries], [dir, fileEntries[0]], [dir, { ...fileEntries[0], mode: 0o120777 }, fileEntries[1]],
    [{ ...dir, mode: 0o120777 }, ...fileEntries], [{ ...dir, mode: 0o100644 }, ...fileEntries],
    [dir, ...fileEntries, { name: '.env', bytes: 'private' }], [dir, ...fileEntries, { name: 'gha-creds-synthetic.json', bytes: 'private' }],
    [dir, { ...fileEntries[0], bytes: 'changed' }, fileEntries[1]]]) {
    assert.throws(() => validateSourceArchive(storedZip(entries), files, { allowDirectoryEntries: true }));
  }
});

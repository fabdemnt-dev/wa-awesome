// Local-only proof: real pinned SDK parsing/construction/initialization, synthetic
// ADC, and every network/socket/process route denied. No WIF exchange, IAM grant,
// Firestore document operation or deployment is proved by this test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Module, { createRequire, syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';

const require = createRequire(import.meta.url);
// Override points only to an already installed local pinned SDK tree. No install.
const sdkPackageJson = process.env.GARDEN_CI_CLIENT_TEST_SDK_PACKAGE_JSON ||
  fileURLToPath(new URL('../functions/floating-garden-trial/package.json', import.meta.url));
let root, env, adc, sdk, factory, policyModule, legacyGuard, originalEnv;
const restores = [], attemptedIo = [], sdkLoads = [];
function replace(object, key, fn) {
  const original = object[key];
  if (typeof original !== 'function') return;
  object[key] = fn;
  restores.push(() => { object[key] = original; });
}
function deny(object, key) {
  replace(object, key, () => { attemptedIo.push(key); throw new Error('offline_test_io_denied'); });
}
function saveAdc(value = adc) {
  fs.writeFileSync(env.GOOGLE_APPLICATION_CREDENTIALS, JSON.stringify(value), { mode: 0o600 });
}
const options = extra => ({ env, now: () => 1791240000000, sdkPackageJson, execArgv: [], ...extra });

test.before(async () => {
  // Guard BEFORE importing the subject or loading either real SDK.
  for (const object of [http, https]) for (const key of ['request', 'get']) deny(object, key);
  deny(http2, 'connect'); deny(net, 'connect'); deny(net, 'createConnection');
  deny(net.Socket.prototype, 'connect'); deny(net.Server.prototype, 'listen');
  deny(tls, 'connect'); deny(dgram, 'createSocket');
  for (const object of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype])
    for (const key of Object.getOwnPropertyNames(object))
    if (/^(lookup|resolve|reverse)/.test(key)) deny(object, key);
  for (const key of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) deny(childProcess, key);
  deny(globalThis, 'fetch'); deny(globalThis, 'WebSocket');
  const load = Module._load;
  replace(Module, '_load', function (id, ...args) {
    if (/firebase-admin/.test(id)) throw new Error('firebase_admin_path_forbidden');
    if (id === '@google-cloud/firestore' || id === 'google-auth-library') sdkLoads.push(id);
    return load.call(this, id, ...args);
  });
  syncBuiltinESMExports();
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'garden-ci-clients-offline-')));
  const path = join(root, 'gha-creds-0123456789abcxyz.json');
  env = { CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push',
    GITHUB_REPOSITORY_ID: '1321198654', GITHUB_REPOSITORY: 'fabdemnt-dev/wa-awesome',
    GITHUB_REPOSITORY_OWNER_ID: '312340196',
    GITHUB_REF: 'refs/heads/release/garden-trial',
    GITHUB_WORKFLOW_REF: 'fabdemnt-dev/wa-awesome/.github/workflows/deploy-floating-garden-trial.yml@refs/heads/release/garden-trial',
    GITHUB_WORKSPACE: root, GOOGLE_CLOUD_PROJECT: 'wa-awesome-garden-stg',
    GOOGLE_APPLICATION_CREDENTIALS: path, GOOGLE_GHA_CREDS_PATH: path,
    CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: path, HOME: root, PATH: process.env.PATH };
  originalEnv = process.env; process.env = { ...env };
  factory = await import('../scripts/floating-garden-ci-clients.mjs');
  policyModule = await import('../scripts/floating-garden-ci-auth-policy.mjs');
  assert.deepEqual(sdkLoads, [], 'import is inert and loads no SDK');
  ({ validateEnvironment: legacyGuard } = await import('../scripts/deploy-floating-garden-connection-template.mjs'));
  const S = factory.CI_CLIENT_SCOPE;
  adc = { type: 'external_account', audience: S.audience,
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    token_url: 'https://sts.googleapis.com/v1/token',
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${S.serviceAccount}:generateAccessToken`,
    credential_source: { url: 'https://pipelines.actions.githubusercontent.com/synthetic/oidc',
      headers: { Authorization: 'Bearer SYNTHETIC_NOT_A_TOKEN' },
      format: { type: 'json', subject_token_field_name: 'value' } } };
  saveAdc();
});
test.after(() => {
  try { assert.deepEqual(attemptedIo, [], 'zero network, DNS, socket, or process attempts'); }
  finally {
    for (const restore of restores.reverse()) restore();
    syncBuiltinESMExports();
    if (originalEnv) process.env = originalEnv;
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CI/project/ref/workflow/deadline/path/debug guards run before SDK loading', async () => {
  for (const [key, value] of Object.entries({ CI: 'false', GITHUB_ACTIONS: 'false',
    GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY_ID: '1', GITHUB_REF: 'refs/heads/main',
    GITHUB_REPOSITORY: 'synthetic-owner/another-repo', GITHUB_REPOSITORY_OWNER_ID: '1',
    GITHUB_WORKFLOW_REF: env.GITHUB_WORKFLOW_REF.replace('deploy-', 'other-'),
    GOOGLE_CLOUD_PROJECT: 'other-project', GOOGLE_CLOUD_QUOTA_PROJECT: 'other-project',
    GOOGLE_APPLICATION_CREDENTIALS: '/unreadable/real-adc-must-not-be-opened.json',
    GOOGLE_GHA_CREDS_PATH: '/other', CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '/other',
    GITHUB_WORKSPACE: resolve(root, '..'), NODE_OPTIONS: '--require=anything', DEBUG: '*',
    FIRESTORE_EMULATOR_HOST: 'localhost:8080', HTTPS_PROXY: 'https://example.invalid',
    GOOGLE_API_USE_MTLS_ENDPOINT: 'always', RUNNER_DEBUG: '1', ACTIONS_STEP_DEBUG: 'true',
  })) {
    await assert.rejects(factory.createCiClients(options({ env: { ...env, [key]: value } })), /^Error: ci_clients_guard$/);
  }
  for (const now of [() => factory.CI_CLIENT_SCOPE.expiresAtMillis, () => NaN, () => -1])
    await assert.rejects(factory.createCiClients(options({ now })), /^Error: ci_clients_guard$/);
  await assert.rejects(factory.createCiClients(options({ execArgv: ['--inspect'] })), /^Error: ci_clients_guard$/);
  assert.deepEqual(sdkLoads, []);
});

test('only the fixed external-account identity and action-shaped ADC are accepted', async () => {
  for (const patch of [{ type: 'service_account' }, { audience: adc.audience + '-other' },
    { token_url: 'https://example.invalid/token' }, { service_account_impersonation_url: 'https://example.invalid/impersonate' },
    { private_key: 'SYNTHETIC_NOT_A_KEY' }, { quota_project_id: 'other-project' },
    { credential_source: { executable: { command: 'must-not-run' } } },
    { credential_source: { ...adc.credential_source, url: 'https://example.invalid/token' } },
  ]) {
    saveAdc({ ...adc, ...patch });
    await assert.rejects(factory.createCiClients(options()), /^Error: ci_clients_guard$/);
  }
  fs.writeFileSync(env.GOOGLE_APPLICATION_CREDENTIALS, 'SYNTHETIC_PRIVATE_ERROR_MARKER');
  await assert.rejects(factory.createCiClients(options()), /^Error: ci_clients_guard$/);
  saveAdc();
  assert.deepEqual(sdkLoads, []);
});

test('symlinked ADC paths are rejected before loading SDKs', async () => {
  const path = env.GOOGLE_APPLICATION_CREDENTIALS, target = join(root, 'synthetic.json');
  fs.renameSync(path, target); fs.symlinkSync(target, path);
  try { await assert.rejects(factory.createCiClients(options()), /^Error: ci_clients_guard$/); }
  finally { fs.unlinkSync(path); fs.renameSync(target, path); }
  assert.deepEqual(sdkLoads, []);
});

test('missing, hard-linked, or oversized ADC files fail closed before loading SDKs', async () => {
  const path = env.GOOGLE_APPLICATION_CREDENTIALS, link = join(root, 'synthetic-hard-link.json');
  fs.unlinkSync(path);
  await assert.rejects(factory.createCiClients(options()), /^Error: ci_clients_guard$/);
  saveAdc(); fs.linkSync(path, link);
  try { await assert.rejects(factory.createCiClients(options()), /^Error: ci_clients_guard$/); }
  finally { fs.unlinkSync(link); }
  fs.writeFileSync(path, 'x'.repeat(65537));
  await assert.rejects(factory.createCiClients(options()), /^Error: ci_clients_guard$/);
  saveAdc();
  assert.deepEqual(sdkLoads, []);
});

test('real GoogleAuth 9.15.1 loads synthetic external_account ADC without exchange', async () => {
  sdk = createRequire(sdkPackageJson);
  assert.equal(sdk('@google-cloud/firestore/package.json').version, '7.11.6');
  assert.equal(sdk('google-auth-library/package.json').version, '9.15.1');
  const { db, requestClient, environmentPolicy } = await factory.createCiClients(options());
  try {
    const policy = policyModule.requireCiAuthPolicy(environmentPolicy);
    assert.equal(policy.validateEnvironment(env, []), true);
    assert.equal(policy.validateConfiguration({ core: { project: factory.CI_CLIENT_SCOPE.project },
      auth: { credential_file_override: env.GOOGLE_APPLICATION_CREDENTIALS } }), true);
    assert.throws(() => policyModule.requireCiAuthPolicy({ ...environmentPolicy }), /^Error: ci_auth_policy_guard$/);
    const { IdentityPoolClient } = sdk('google-auth-library');
    assert(requestClient instanceof IdentityPoolClient);
    assert.equal(requestClient.getServiceAccountEmail(), factory.CI_CLIENT_SCOPE.serviceAccount);
    assert.equal(requestClient.forceRefreshOnFailure, false);
    assert.equal(requestClient.transporter.defaults.retry, false);
    assert.equal(requestClient.transporter.defaults.retryConfig.retry, 0);
    assert.equal(requestClient.transporter.defaults.maxRedirects, 0);
    assert.deepEqual(requestClient.credentials, {}, 'no actual access token acquired');
    assert.equal(db.projectId, factory.CI_CLIENT_SCOPE.project);
    assert.equal(db.databaseId, '(default)');
    assert.equal(typeof db.runTransaction, 'function');
    assert.equal(db.doc('floatingGardenTrial/config').path, 'floatingGardenTrial/config');
  } finally { await db.terminate(); }
});

test('default public factory anchor loads the installed pinned functions SDK and returns its bound policy', async () => {
  const { db, requestClient, environmentPolicy } = await factory.createCiClients({
    env, now: () => 1791240000000, execArgv: [],
  });
  try {
    assert.equal(db.projectId, factory.CI_CLIENT_SCOPE.project);
    assert.equal(requestClient.getServiceAccountEmail(), factory.CI_CLIENT_SCOPE.serviceAccount);
    const policy = policyModule.requireCiAuthPolicy(environmentPolicy);
    assert.equal(policy.validateEnvironment(env, []), true);
    env.CLOUDSDK_AUTH_ACCESS_TOKEN = 'SYNTHETIC_UNTRUSTED_TOKEN';
    try { assert.throws(() => policy.validateConfiguration({}), /^Error: ci_auth_policy_guard$/); }
    finally { delete env.CLOUDSDK_AUTH_ACCESS_TOKEN; }
    assert.equal(policy.validateEnvironment(env, []), true);
  } finally { await db.terminate(); }
});

test('real Firestore/GAPIC initialization accepts WIF ADC and preserves empty Commit retry codes', async () => {
  const { db } = await factory.createCiClients(options());
  try {
    // The high-level client has no public initialize method. This test-only
    // pool hook obtains the exact GAPIC created from its public constructor
    // settings. Production code does not access any SDK private member.
    await db._clientPool.run('synthetic-offline-init', false, async gapic => {
      assert.equal(await gapic.getProjectId(), factory.CI_CLIENT_SCOPE.project);
      const stub = await gapic.initialize(); // Real SDK; no mocked auth or stub construction.
      const authClient = await gapic.auth.getClient();
      assert(authClient instanceof sdk('google-auth-library').IdentityPoolClient);
      assert.deepEqual(authClient.credentials, {});
      assert.equal(authClient.getServiceAccountEmail(), factory.CI_CLIENT_SCOPE.serviceAccount);
      assert.deepEqual(gapic._defaults.commit.retry.retryCodes, []);
      assert.equal(gapic._opts.keyFilename, env.GOOGLE_APPLICATION_CREDENTIALS);
      // Only this transport method is stubbed: prove the real GAPIC wrapper
      // makes one attempt on UNAVAILABLE, without issuing a document RPC.
      let commits = 0;
      stub.commit = (_request, _metadata, _options, callback) => {
        commits++;
        callback(Object.assign(new Error('synthetic unavailable'), { code: 14 }));
        return { cancel() {} };
      };
      await assert.rejects(gapic.commit({ database: `projects/${factory.CI_CLIENT_SCOPE.project}/databases/(default)`, writes: [] }), { code: 14 });
      assert.equal(commits, 1);
    });
  } finally { await db.terminate(); }
  assert.equal(Object.keys(require.cache).some(path => /[/\\]firebase-admin[/\\]/.test(path)), false);
  assert.deepEqual(attemptedIo, []);
});

test('legacy owner guards still reject CI ADC; explicit branded CI integration is required', () => {
  assert.throws(() => legacyGuard(env, []), /credential/);
});

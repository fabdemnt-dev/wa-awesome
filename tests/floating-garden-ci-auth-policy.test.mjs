// Local-only tests. All credentials and GitHub context are synthetic. No token
// exchange, cloud call, login, mutation, or deployment is authorized/proved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CI_CLIENT_SCOPE as S, assertCiClientEnvironment, createCiAuthPolicy, requireCiAuthPolicy }
  from '../scripts/floating-garden-ci-auth-policy.mjs';
import { validateEnvironment as legacyEnvironment, validateConfiguration as legacyConfiguration }
  from '../scripts/deploy-floating-garden-connection-template.mjs';

const NOW = 1791240000000;
const rejected = /^Error: ci_auth_policy_guard$/;
function fixture(t) {
  const workspace = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'garden-ci-auth-policy-')));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const path = join(workspace, 'gha-creds-0123456789abcdef.json');
  const env = { CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push',
    GITHUB_REPOSITORY_ID: S.repositoryId, GITHUB_REPOSITORY: S.repository,
    GITHUB_REPOSITORY_OWNER_ID: S.repositoryOwnerId, GITHUB_REF: S.ref,
    GITHUB_WORKFLOW_REF: `${S.repository}/${S.workflow}@${S.ref}`, GITHUB_WORKSPACE: workspace,
    GOOGLE_CLOUD_PROJECT: S.project, GOOGLE_APPLICATION_CREDENTIALS: path,
    GOOGLE_GHA_CREDS_PATH: path, CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: path };
  const adc = { type: 'external_account', audience: S.audience,
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt', token_url: 'https://sts.googleapis.com/v1/token',
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${S.serviceAccount}:generateAccessToken`,
    credential_source: { url: 'https://pipelines.actions.githubusercontent.com/synthetic/oidc',
      headers: { Authorization: 'Bearer SYNTHETIC_NOT_A_TOKEN' },
      format: { type: 'json', subject_token_field_name: 'value' } } };
  const save = (value = adc) => fs.writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  save();
  const options = { env, now: () => NOW, execArgv: [] };
  return { workspace, path, env, adc, save, options,
    create: extra => createCiAuthPolicy({ ...options, ...extra }) };
}

test('standalone policy is opaque and branded, with frozen validated methods', t => {
  const f = fixture(t), before = JSON.stringify(f.env), policy = f.create();
  assert(Object.isFrozen(policy));
  assert.deepEqual(Object.keys(policy), []);
  const validators = requireCiAuthPolicy(policy);
  assert(Object.isFrozen(validators));
  assert.deepEqual(Object.keys(validators), ['validateEnvironment', 'validateConfiguration']);
  assert.equal(validators.validateEnvironment(f.env, []), true);
  assert.equal(validators.validateConfiguration({ core: { project: S.project }, auth: { credential_file_override: f.path } }), true);
  assert.equal(JSON.stringify(f.env), before, 'no environment stripping, masking, or mutation');
});

test('fabricated, copied, inherited, proxy, and callback policies cannot bypass branding', t => {
  const policy = fixture(t).create(); let callbackCalls = 0;
  for (const invalid of [undefined, null, true, 'ci', {}, { ...policy }, Object.create(policy),
    new Proxy(policy, {}), { validateEnvironment() { callbackCalls++; }, validateConfiguration() { callbackCalls++; } }])
    assert.throws(() => requireCiAuthPolicy(invalid), rejected);
  assert.equal(callbackCalls, 0);
});

test('repository, owner, event, exact branch, workflow, and deadline are required', t => {
  const f = fixture(t);
  for (const [key, value] of Object.entries({ CI: 'false', GITHUB_ACTIONS: 'false',
    GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY_ID: '1', GITHUB_REPOSITORY: 'other/repository',
    GITHUB_REPOSITORY_OWNER_ID: '1', GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: `${S.repository}/.github/workflows/other.yml@${S.ref}` })) {
    assert.throws(() => f.create({ env: { ...f.env, [key]: value } }), rejected, key);
    const missing = { ...f.env }; delete missing[key];
    assert.throws(() => f.create({ env: missing }), rejected, key);
  }
  for (const time of [-1, NaN, Infinity, S.expiresAtMillis, S.expiresAtMillis + 1])
    assert.throws(() => f.create({ now: () => time }), rejected);
  // The signed environment claim must be enforced by WIF, not a fabricated
  // default GITHUB_ENVIRONMENT variable. This known-good fixture lacks one.
  assert.equal(Object.hasOwn(f.env, 'GITHUB_ENVIRONMENT'), false);
  assert.equal(assertCiClientEnvironment(f.env, NOW, []), f.path);
});

test('project aliases and credential path aliases cannot redirect the fixed scope', t => {
  const f = fixture(t);
  for (const key of ['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'GCP_PROJECT', 'CLOUDSDK_CORE_PROJECT',
    'GOOGLE_CLOUD_QUOTA_PROJECT', 'CLOUDSDK_BILLING_QUOTA_PROJECT']) {
    assert.throws(() => f.create({ env: { ...f.env, [key]: 'other-project' } }), rejected, key);
    assert.doesNotThrow(() => f.create({ env: { ...f.env, [key]: S.project } }));
  }
  for (const key of ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_GHA_CREDS_PATH', 'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE'])
    assert.throws(() => f.create({ env: { ...f.env, [key]: '/synthetic-wrong-credential-path' } }), rejected, key);
  for (const workspace of ['relative', `${f.workspace}/.`, `${f.workspace}/..`])
    assert.throws(() => f.create({ env: { ...f.env, GITHUB_WORKSPACE: workspace } }), rejected);
});

test('token, proxy, TLS, endpoint, emulator, npm, impersonation and debug overrides fail closed', t => {
  const f = fixture(t);
  for (const key of ['DEBUG', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'NODE_OPTIONS', 'NODE_V8_COVERAGE',
    'GRPC_TRACE', 'GRPC_VERBOSITY', 'GOOGLE_SDK_NODE_LOGGING',
    'GRPC_DEFAULT_SSL_ROOTS_FILE_PATH', 'GRPC_SSL_CIPHER_SUITES', 'GCE_METADATA_HOST', 'GCE_METADATA_IP',
    'GCE_METADATA_ROOT', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'SSL_CERT_FILE',
    'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'GCLOUD_ACCESS_TOKEN',
    'GOOGLE_OAUTH_ACCESS_TOKEN', 'GOOGLE_API_KEY', 'GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES',
    'CLOUDSDK_API_ENDPOINT_OVERRIDES_FIRESTORE', 'FIREBASE_TOKEN', 'FIRESTORE_EMULATOR_HOST',
    'GOOGLE_API_USE_MTLS_ENDPOINT', 'GOOGLE_CLOUD_UNIVERSE_DOMAIN', 'CLOUDSDK_AUTH_ACCESS_TOKEN',
    'CLOUDSDK_AUTH_ACCESS_TOKEN_FILE', 'CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT',
    'CLOUDSDK_AUTH_TOKEN_HOST', 'CLOUDSDK_AUTH_AUTH_HOST', 'CLOUDSDK_AUTH_LOGIN_CONFIG_FILE',
    'CLOUDSDK_PROXY_ADDRESS', 'CLOUDSDK_PROXY_PASSWORD', 'CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE',
    'npm_config_proxy', 'NPM_CONFIG_REGISTRY', 'npm_config_userconfig', 'npm_config__authToken'])
    assert.throws(() => f.create({ env: { ...f.env, [key]: 'synthetic-override' } }), rejected, key);
  for (const key of ['RUNNER_DEBUG', 'ACTIONS_STEP_DEBUG', 'ACTIONS_RUNNER_DEBUG',
    'CLOUDSDK_AUTH_DISABLE_CREDENTIALS', 'CLOUDSDK_AUTH_DISABLE_SSL_VALIDATION',
    'CLOUDSDK_CORE_DISABLE_SSL_VALIDATION', 'CLOUDSDK_CORE_LOG_HTTP'])
    for (const value of ['true', '1', 'unexpected'])
      assert.throws(() => f.create({ env: { ...f.env, [key]: value } }), rejected, key);
  for (const [key, value] of [['CLOUDSDK_CORE_VERBOSITY', 'debug'], ['CLOUDSDK_CORE_UNIVERSE_DOMAIN', 'other'],
    ['CLOUDSDK_REGIONAL_ENDPOINT_MODE', 'regional'], ['CLOUDSDK_CORE_ACCOUNT', 'other@example.invalid']])
    assert.throws(() => f.create({ env: { ...f.env, [key]: value } }), rejected, key);
  for (const arg of ['--inspect', '--trace-warnings', '--require=module', '--import=module'])
    assert.throws(() => f.create({ execArgv: [arg] }), rejected);
});

test('safe false values and default configuration settings do not cause false stops', t => {
  const f = fixture(t);
  const safeEnv = { ...f.env, RUNNER_DEBUG: '0', ACTIONS_STEP_DEBUG: 'false', ACTIONS_RUNNER_DEBUG: 'false',
    CLOUDSDK_AUTH_DISABLE_CREDENTIALS: 'false', CLOUDSDK_AUTH_DISABLE_SSL_VALIDATION: '0',
    CLOUDSDK_CORE_DISABLE_SSL_VALIDATION: 'false', CLOUDSDK_CORE_LOG_HTTP: 'false',
    CLOUDSDK_CORE_VERBOSITY: 'warning', CLOUDSDK_CORE_UNIVERSE_DOMAIN: 'googleapis.com',
    CLOUDSDK_REGIONAL_ENDPOINT_MODE: 'global', CLOUDSDK_CORE_ACCOUNT: S.serviceAccount };
  const validators = requireCiAuthPolicy(f.create({ env: safeEnv }));
  for (const value of [false, 'false', 0, '0', null, '']) assert.equal(validators.validateConfiguration({
    core: { project: S.project, account: S.serviceAccount, universe_domain: 'googleapis.com',
      custom_ca_certs_file: null, disable_ssl_validation: value, log_http: value, verbosity: 'warning' },
    auth: { credential_file_override: f.path, disable_credentials: value, disable_ssl_validation: value,
      token_host: 'https://oauth2.googleapis.com/token', auth_host: 'https://accounts.google.com/o/oauth2/auth',
      impersonate_service_account: null, access_token: null, access_token_file: null, login_config_file: null },
    proxy: { rdns: 'true', address: null, type: null, port: null, username: null, password: null },
    regional: { endpoint_mode: 'global' }, billing: { quota_project: S.project },
    api_endpoint_overrides: { firestore: null, run: '' },
  }), true);
  assert.equal(validators.validateConfiguration({}), true, 'explicit fixed-project command flags cover an unset project');
});

test('gcloud configuration permits only the checked ADC path, fixed scope, and safe routes', t => {
  const f = fixture(t), validators = requireCiAuthPolicy(f.create());
  const invalid = [null, [], { core: [] }, { auth: null }, { proxy: 'proxy' }, { regional: [] },
    { api_endpoint_overrides: [] }, { billing: null }, { core: { project: 'other' } },
    { billing: { quota_project: 'other' } }, { core: { account: 'other@example.invalid' } },
    { core: { universe_domain: 'other' } }, { regional: { endpoint_mode: 'regional' } },
    { core: { custom_ca_certs_file: '/synthetic-ca' } }, { core: { log_http: true } },
    { core: { verbosity: 'debug' } }, { auth: { token_host: 'https://example.invalid/token' } },
    { auth: { auth_host: 'https://example.invalid/auth' } },
    { auth: { credential_file_override: `${f.path}.other` } },
    { api_endpoint_overrides: { firestore: 'https://example.invalid' } }];
  for (const key of ['type', 'address', 'port', 'username', 'password']) invalid.push({ proxy: { [key]: 'synthetic' } });
  for (const key of ['impersonate_service_account', 'access_token', 'access_token_file', 'login_config_file'])
    invalid.push({ auth: { [key]: 'synthetic' } });
  for (const section of ['auth', 'core']) for (const key of ['disable_ssl_validation', ...(section === 'auth' ? ['disable_credentials'] : [])])
    for (const value of [true, 'true', '1', 'unknown']) invalid.push({ [section]: { [key]: value } });
  for (const config of invalid) assert.throws(() => validators.validateConfiguration(config), rejected);
});

test('malformed and alternate credential sources are rejected without leaking contents', t => {
  const f = fixture(t);
  for (const patch of [{ type: 'service_account' }, { audience: `${S.audience}-other` },
    { subject_token_type: 'other' }, { token_url: 'https://example.invalid/token' },
    { service_account_impersonation_url: 'https://example.invalid/impersonate' }, { universe_domain: 'other' },
    { private_key: 'SYNTHETIC_PRIVATE_KEY_MARKER' }, { quota_project_id: 'other' },
    { credential_source: { file: '/synthetic-token-file' } },
    { credential_source: { executable: { command: 'synthetic-command' } } },
    { credential_source: { ...f.adc.credential_source, headers: { Authorization: 'Bearer SYNTHETIC', Other: 'unexpected' } } },
    { credential_source: { ...f.adc.credential_source, format: { type: 'text' } } }]) {
    f.save({ ...f.adc, ...patch }); assert.throws(() => f.create(), rejected);
  }
  for (const url of ['http://pipelines.actions.githubusercontent.com/token', 'https://example.invalid/token',
    'https://actions.githubusercontent.com/token', 'https://pipelines.actions.githubusercontent.com.evil.invalid/token',
    'https://user@pipelines.actions.githubusercontent.com/token',
    'https://pipelines.actions.githubusercontent.com:8443/token', 'https://pipelines.actions.githubusercontent.com/token#fragment']) {
    f.save({ ...f.adc, credential_source: { ...f.adc.credential_source, url } });
    assert.throws(() => f.create(), rejected);
  }
  fs.writeFileSync(f.path, 'SYNTHETIC_PARSE_ERROR_SECRET_MARKER');
  assert.throws(() => f.create(), rejected);
});

test('ADC regular-file, single-link, canonical workspace, filename, and size limits are enforced', t => {
  const f = fixture(t), link = join(f.workspace, 'synthetic-link.json');
  fs.linkSync(f.path, link); assert.throws(() => f.create(), rejected); fs.unlinkSync(link);
  fs.renameSync(f.path, link); fs.symlinkSync(link, f.path);
  assert.throws(() => f.create(), rejected); fs.unlinkSync(f.path); fs.renameSync(link, f.path);
  for (const text of ['', 'x'.repeat(65537)]) { fs.writeFileSync(f.path, text); assert.throws(() => f.create(), rejected); }
  f.save();
  const alias = join(f.workspace, 'workspace-alias'); fs.symlinkSync(f.workspace, alias);
  const aliasPath = join(alias, 'gha-creds-0123456789abcdef.json');
  assert.throws(() => f.create({ env: { ...f.env, GITHUB_WORKSPACE: alias,
    GOOGLE_APPLICATION_CREDENTIALS: aliasPath, GOOGLE_GHA_CREDS_PATH: aliasPath,
    CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: aliasPath } }), rejected);
  fs.unlinkSync(f.path); assert.throws(() => f.create(), rejected);
});

test('each policy entry rechecks the bound environment and argv, even with a clean caller copy', t => {
  const f = fixture(t), policy = f.create(), validators = requireCiAuthPolicy(policy), clean = { ...f.env };
  f.env.HTTPS_PROXY = 'https://example.invalid';
  assert.throws(() => requireCiAuthPolicy(policy), rejected);
  assert.throws(() => validators.validateEnvironment(clean, []), rejected);
  assert.throws(() => validators.validateConfiguration({}), rejected);
  delete f.env.HTTPS_PROXY;
  f.options.execArgv.push('--inspect');
  assert.throws(() => validators.validateEnvironment(clean, []), rejected);
  assert.throws(() => validators.validateConfiguration({}), rejected);
});

test('policy cannot be rebound to a different valid action ADC path or environment', t => {
  const f = fixture(t), policy = f.create(), validators = requireCiAuthPolicy(policy);
  const other = join(f.workspace, 'gha-creds-fedcba9876543210.json'); fs.copyFileSync(f.path, other);
  const moved = { ...f.env, GOOGLE_APPLICATION_CREDENTIALS: other, GOOGLE_GHA_CREDS_PATH: other,
    CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: other };
  assert.throws(() => validators.validateEnvironment(moved, []), rejected);
  assert.throws(() => validators.validateConfiguration({ auth: { credential_file_override: other } }), rejected);
  Object.assign(f.env, moved);
  assert.throws(() => requireCiAuthPolicy(policy), rejected);
});

test('bound ADC byte changes and identical-content inode replacement invalidate existing policies', t => {
  const f = fixture(t), first = f.create(), firstValidators = requireCiAuthPolicy(first);
  f.save({ ...f.adc, credential_source: { ...f.adc.credential_source,
    headers: { Authorization: 'Bearer SYNTHETIC_CHANGED_TOKEN' } } });
  assert.throws(() => firstValidators.validateEnvironment(f.env, []), rejected);
  assert.throws(() => firstValidators.validateConfiguration({}), rejected);
  f.save();
  const next = f.create(), bytes = fs.readFileSync(f.path), replacement = join(f.workspace, 'synthetic-replacement');
  fs.writeFileSync(replacement, bytes); fs.renameSync(replacement, f.path);
  assert.throws(() => requireCiAuthPolicy(next), rejected);
});

test('expiry is rechecked before each later environment or configuration validation', t => {
  const f = fixture(t); let time = NOW;
  const policy = f.create({ now: () => time }), validators = requireCiAuthPolicy(policy);
  time = S.expiresAtMillis;
  for (const action of [() => requireCiAuthPolicy(policy), () => validators.validateEnvironment(f.env, []),
    () => validators.validateConfiguration({})]) assert.throws(action, rejected);
});

test('legacy owner environment and configuration guards still reject official CI ADC', t => {
  const f = fixture(t);
  assert.throws(() => legacyEnvironment(f.env, []), /credential/);
  assert.throws(() => legacyConfiguration({ auth: { credential_file_override: f.path } }), /[Cc]redential/);
});


test('accessor, proxy and inherited input objects are rejected without invoking hooks', t => {
  const f = fixture(t); let hooks = 0;
  const inherited = Object.create(f.env);
  const accessor = { ...f.env };
  Object.defineProperty(accessor, 'CI', { get() { hooks++; return 'true'; }, enumerable: true });
  const argv = [];
  Object.defineProperty(argv, '0', { get() { hooks++; return '--inspect'; }, enumerable: true });
  for (const env of [inherited, accessor, new Proxy(f.env, { get() { hooks++; } })])
    assert.throws(() => f.create({ env }), rejected);
  assert.throws(() => f.create({ execArgv: argv }), rejected);
  const validators = requireCiAuthPolicy(f.create());
  for (const config of [Object.create({ core: { project: 'other' } }),
    { get auth() { hooks++; return {}; } }, new Proxy({}, { get() { hooks++; } })])
    assert.throws(() => validators.validateConfiguration(config), rejected);
  assert.equal(hooks, 0);
});

test('default process environment and argv bindings reject replacement after construction', t => {
  const f = fixture(t), originalEnv = process.env, originalArgv = process.execArgv;
  try {
    process.env = f.env; process.execArgv = [];
    const policy = createCiAuthPolicy({ now: () => NOW });
    const validators = requireCiAuthPolicy(policy);
    process.env = { ...f.env };
    assert.throws(() => validators.validateEnvironment(f.env, []), rejected);
    process.env = f.env;
    process.execArgv = [];
    assert.throws(() => validators.validateConfiguration({}), rejected);
  } finally { process.env = originalEnv; process.execArgv = originalArgv; }
});

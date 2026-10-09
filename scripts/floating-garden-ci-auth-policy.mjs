// CI-only validation policy. This module is Node-only, inert on import, and
// never loads SDKs, exchanges credentials, logs ADC content, or changes env.
import { constants, openSync, closeSync, readSync, lstatSync, fstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { types } from 'node:util';

export const CI_CLIENT_SCOPE = Object.freeze({
  project: 'wa-awesome-garden-stg', projectNumber: '120030709276', databaseId: '(default)',
  expiresAtMillis: 1791762351472, repositoryId: '1321198654',
  repository: 'fabdemnt-dev/wa-awesome', repositoryOwnerId: '312340196', environment: 'garden-trial',
  ref: 'refs/heads/release/garden-trial', workflow: '.github/workflows/deploy-floating-garden-trial.yml',
  audience: '//iam.googleapis.com/projects/120030709276/locations/global/workloadIdentityPools/garden-github/providers/wa-awesome-release',
  serviceAccount: 'garden-github-deployer@wa-awesome-garden-stg.iam.gserviceaccount.com',
});
const S = CI_CLIENT_SCOPE;
const guard = () => new Error('ci_auth_policy_guard');
const need = condition => { if (!condition) throw guard(); };
const present = value => value !== undefined && value !== null && value !== '';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && !types.isProxy(value);
const dataObject = value => plain(value) && (value === process.env ||
  [null, Object.prototype].includes(Object.getPrototypeOf(value))) && Object.values(Object.getOwnPropertyDescriptors(value))
  .every(descriptor => Object.hasOwn(descriptor, 'value'));
const only = (value, keys) => dataObject(value) && Object.keys(value).every(key => keys.includes(key));
const disabled = value => !present(value) || [false, 'false', 0, '0'].includes(value);
const quiet = value => !present(value) || ['none', 'critical', 'error', 'warning'].includes(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function boundary(fn) { try { return fn(); } catch { throw guard(); } }

// This local check does not prove signed OIDC claims or IAM grants. The WIF
// provider must independently enforce the repository, workflow, ref, push event,
// and signed environment claim "garden-trial". GitHub supplies no standard
// environment-name variable; inventing one here would provide no such proof.
export function assertCiClientEnvironment(env, now = Date.now(), execArgv = process.execArgv) {
  return boundary(() => {
    need(dataObject(env) && Array.isArray(execArgv) && !types.isProxy(execArgv) &&
      Object.values(Object.getOwnPropertyDescriptors(execArgv)).every(descriptor => Object.hasOwn(descriptor, 'value')) &&
      execArgv.every(arg => typeof arg === 'string'));
    need(Number.isSafeInteger(now) && now >= 0 && now < S.expiresAtMillis);
    need(env.CI === 'true' && env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'push' &&
      env.GITHUB_REPOSITORY_ID === S.repositoryId && env.GITHUB_REF === S.ref &&
      env.GITHUB_REPOSITORY === S.repository && env.GITHUB_REPOSITORY_OWNER_ID === S.repositoryOwnerId &&
      env.GITHUB_WORKFLOW_REF === `${S.repository}/${S.workflow}@${S.ref}`);
    need(env.GOOGLE_CLOUD_PROJECT === S.project);
    for (const key of ['GCLOUD_PROJECT', 'GCP_PROJECT', 'CLOUDSDK_CORE_PROJECT', 'GOOGLE_CLOUD_QUOTA_PROJECT',
      'CLOUDSDK_BILLING_QUOTA_PROJECT']) need(!present(env[key]) || env[key] === S.project);
    for (const key of ['DEBUG', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'NODE_OPTIONS', 'NODE_V8_COVERAGE',
      'GRPC_TRACE', 'GRPC_VERBOSITY', 'GOOGLE_SDK_NODE_LOGGING',
      'GRPC_DEFAULT_SSL_ROOTS_FILE_PATH', 'GRPC_SSL_CIPHER_SUITES',
      'GCE_METADATA_HOST', 'GCE_METADATA_IP', 'GCE_METADATA_ROOT',
      'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
      'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
      'NODE_TLS_REJECT_UNAUTHORIZED', 'GCLOUD_ACCESS_TOKEN', 'GOOGLE_OAUTH_ACCESS_TOKEN',
      'GOOGLE_API_KEY', 'GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES']) need(!present(env[key]));
    need(disabled(env.RUNNER_DEBUG) && disabled(env.ACTIONS_STEP_DEBUG) && disabled(env.ACTIONS_RUNNER_DEBUG));
    need(disabled(env.CLOUDSDK_CORE_LOG_HTTP) && quiet(env.CLOUDSDK_CORE_VERBOSITY));
    need(!execArgv.some(arg => /inspect|trace|heap|prof|report|require|import/i.test(arg)));
    for (const [key, value] of Object.entries(env)) if (present(value)) {
      need(!/^npm_config_(?:proxy|http_proxy|https_proxy|noproxy|cafile|ca|cert|key|strict_ssl|registry|userconfig|globalconfig|node_options|_auth|_authToken)$/i.test(key));
      need(!key.startsWith('CLOUDSDK_API_ENDPOINT_OVERRIDES_') && !key.startsWith('FIREBASE_') &&
        !/_EMULATOR_HOST$/.test(key) && !/^GOOGLE_(API_USE|CLOUD_UNIVERSE_DOMAIN)/.test(key) &&
        !/^CLOUDSDK_AUTH_(ACCESS_TOKEN|ACCESS_TOKEN_FILE|IMPERSONATE_SERVICE_ACCOUNT|TOKEN_HOST|AUTH_HOST|LOGIN_CONFIG_FILE)$/.test(key) &&
        !/^CLOUDSDK_PROXY_(TYPE|ADDRESS|PORT|USERNAME|PASSWORD)$/.test(key) &&
        !/^CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE$/.test(key));
      if (/^CLOUDSDK_(AUTH_DISABLE_CREDENTIALS|AUTH_DISABLE_SSL_VALIDATION|CORE_DISABLE_SSL_VALIDATION)$/.test(key))
        need(disabled(value));
      if (key === 'CLOUDSDK_CORE_UNIVERSE_DOMAIN') need(value === 'googleapis.com');
      if (key === 'CLOUDSDK_REGIONAL_ENDPOINT_MODE') need(value === 'global');
      if (key === 'CLOUDSDK_CORE_ACCOUNT') need(value === S.serviceAccount);
    }
    const path = env.GOOGLE_APPLICATION_CREDENTIALS, workspace = env.GITHUB_WORKSPACE;
    need(typeof workspace === 'string' && isAbsolute(workspace) && workspace === resolve(workspace) &&
      typeof path === 'string' && isAbsolute(path) && dirname(path) === workspace && path === resolve(path) &&
      /^gha-creds-[a-z0-9]{16}\.json$/.test(basename(path)) &&
      env.GOOGLE_GHA_CREDS_PATH === path && env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE === path);
    return path;
  });
}

function checkAdcFile(path, workspace) {
  need(realpathSync(workspace) === workspace && lstatSync(workspace).isDirectory() && realpathSync(path) === path);
  const before = lstatSync(path);
  need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size > 0 && before.size <= 65536);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes, after;
  try {
    const opened = fstatSync(fd);
    need(opened.isFile() && opened.nlink === 1 && opened.dev === before.dev && opened.ino === before.ino);
    const buffer = Buffer.alloc(65537);
    let length = 0, count;
    while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null))) length += count;
    need(length > 0 && length <= 65536);
    bytes = buffer.subarray(0, length);
    after = fstatSync(fd);
    need(after.dev === before.dev && after.ino === before.ino && after.nlink === 1 && after.size === length &&
      after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs);
  } finally { closeSync(fd); }
  const atPath = lstatSync(path);
  need(atPath.isFile() && !atPath.isSymbolicLink() && atPath.nlink === 1 &&
    atPath.dev === after.dev && atPath.ino === after.ino && atPath.size === after.size &&
    atPath.mtimeMs === after.mtimeMs && atPath.ctimeMs === after.ctimeMs && realpathSync(path) === path);
  const adc = JSON.parse(bytes.toString('utf8'));
  need(only(adc, ['type', 'audience', 'subject_token_type', 'token_url', 'service_account_impersonation_url',
    'credential_source', 'universe_domain']) && adc.type === 'external_account' && adc.audience === S.audience &&
    adc.subject_token_type === 'urn:ietf:params:oauth:token-type:jwt' &&
    adc.token_url === 'https://sts.googleapis.com/v1/token' &&
    adc.service_account_impersonation_url === `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${S.serviceAccount}:generateAccessToken` &&
    (adc.universe_domain === undefined || adc.universe_domain === 'googleapis.com'));
  const source = adc.credential_source;
  need(only(source, ['url', 'headers', 'format']) && typeof source.url === 'string' &&
    only(source.headers, ['Authorization']) && typeof source.headers.Authorization === 'string' &&
    /^Bearer [^\s]+$/.test(source.headers.Authorization) &&
    only(source.format, ['type', 'subject_token_field_name']) && source.format.type === 'json' &&
    source.format.subject_token_field_name === 'value');
  const url = new URL(source.url);
  need(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash &&
    url.hostname.endsWith('.actions.githubusercontent.com'));
  // Only a digest and filesystem identity survive parsing in this policy.
  return `${after.dev}:${after.ino}:${after.size}:${digest(bytes)}`;
}

function checkConfiguration(config, path) {
  need(dataObject(config));
  for (const section of ['core', 'auth', 'proxy', 'regional', 'api_endpoint_overrides', 'billing'])
    need(config[section] === undefined || dataObject(config[section]));
  need(!Object.values(config.api_endpoint_overrides ?? {}).some(present) &&
    !['type', 'address', 'port', 'username', 'password'].some(key => present(config.proxy?.[key])));
  for (const key of ['impersonate_service_account', 'access_token_file', 'access_token', 'login_config_file'])
    need(!present(config.auth?.[key]));
  need(!present(config.auth?.credential_file_override) || config.auth.credential_file_override === path);
  need(disabled(config.auth?.disable_credentials) && disabled(config.auth?.disable_ssl_validation) &&
    disabled(config.core?.disable_ssl_validation) && !present(config.core?.custom_ca_certs_file));
  need(disabled(config.core?.log_http) && quiet(config.core?.verbosity));
  need(!present(config.core?.project) || config.core.project === S.project);
  need(!present(config.billing?.quota_project) || config.billing.quota_project === S.project);
  need(!present(config.core?.account) || config.core.account === S.serviceAccount);
  need(!present(config.auth?.token_host) || ['https://oauth2.googleapis.com/token', 'https://accounts.google.com/o/oauth2/token'].includes(config.auth.token_host));
  need(!present(config.auth?.auth_host) || ['https://accounts.google.com/o/oauth2/auth', 'https://accounts.google.com/o/oauth2/v2/auth'].includes(config.auth.auth_host));
  need(!present(config.core?.universe_domain) || config.core.universe_domain === 'googleapis.com');
  need(!present(config.regional?.endpoint_mode) || config.regional.endpoint_mode === 'global');
  return true;
}

// Opaque identity branding: caller-provided validator callbacks, copied objects,
// prototypes and proxies cannot select or replace this policy's implementation.
const policies = new WeakMap();
export function createCiAuthPolicy({ env = process.env, now = Date.now, execArgv = process.execArgv } = {}) {
  return boundary(() => {
    need(typeof now === 'function');
    const processBound = env === process.env, argvBound = execArgv === process.execArgv;
    const path = assertCiClientEnvironment(env, now(), execArgv), workspace = env.GITHUB_WORKSPACE;
    const identity = checkAdcFile(path, workspace);
    const recheck = () => {
      need((!processBound || env === process.env) && (!argvBound || execArgv === process.execArgv));
      need(assertCiClientEnvironment(env, now(), execArgv) === path && env.GITHUB_WORKSPACE === workspace);
      need(checkAdcFile(path, workspace) === identity);
    };
    const validators = Object.freeze({
      validateEnvironment(candidate = env, args = execArgv) {
        return boundary(() => {
          recheck();
          need(assertCiClientEnvironment(candidate, now(), args) === path && candidate.GITHUB_WORKSPACE === workspace);
          return true;
        });
      },
      validateConfiguration(config) { return boundary(() => { recheck(); return checkConfiguration(config, path); }); },
    });
    const policy = Object.freeze(Object.create(null));
    policies.set(policy, { validators, recheck });
    return policy;
  });
}
export function requireCiAuthPolicy(policy) {
  return boundary(() => {
    const entry = policies.get(policy);
    need(entry !== undefined);
    entry.recheck();
    return entry.validators;
  });
}

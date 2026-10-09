#!/usr/bin/env node
// USER-ONLY Cloud Shell handoff. The agent must never run the real generation path.
// Tests inject synthetic non-secret bytes and fake subprocesses. Default is a plan.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const PROJECT = 'wa-awesome-garden-stg';
export const PROJECT_NUMBER = '120030709276';
export const REGION = 'asia-northeast1';
export const ACCOUNT_ID = 'garden-trial-runtime';
export const ACCOUNT = `${ACCOUNT_ID}@${PROJECT}.iam.gserviceaccount.com`;
export const MEMBER = `serviceAccount:${ACCOUNT}`;
export const ROLE_ID = 'gardenTrialRuntime';
export const ROLE = `projects/${PROJECT}/roles/${ROLE_ID}`;
export const TITLE = 'Garden trial runtime';
export const PERMISSIONS = Object.freeze(['datastore.databases.get', 'datastore.entities.get', 'datastore.entities.create', 'datastore.entities.update']);
export const EXPRESSION = `resource.name == "projects/${PROJECT}/databases/(default)"`;
export const CONDITION = Object.freeze({ title: 'garden_trial_default_database', expression: EXPRESSION });
const stop = (message) => { throw new Error(message); };
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => Array.isArray(a) && a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
export const SECRET_ID = 'FLOATING_GARDEN_INVITE_HMAC_KEY';
export const SECRET = `projects/${PROJECT}/secrets/${SECRET_ID}`;
export const ACCESSOR = 'roles/secretmanager.secretAccessor';
export function validateAccount(account) {
  if (!plain(account) || account.email !== ACCOUNT || account.projectId !== PROJECT || account.displayName !== TITLE || account.disabled !== undefined && account.disabled !== false || !/^\d+$/.test(account.uniqueId ?? '')) stop('Runtime service-account identity, enabled state or metadata mismatch.');
  if ((account.description ?? '') !== '' || ![PROJECT, PROJECT_NUMBER].some((p) => [ACCOUNT, account.uniqueId].some((id) => account.name === `projects/${p}/serviceAccounts/${id}`))) stop('Runtime service-account resource name or description mismatch.');
  return account;
}
export function validateRole(role) {
  if (!plain(role) || ![PROJECT, PROJECT_NUMBER].some((p) => role.name === `projects/${p}/roles/${ROLE_ID}`) || role.title !== TITLE || (role.description ?? '') !== '' || role.stage !== 'GA' || role.deleted !== undefined && role.deleted !== false || !same(role.includedPermissions, PERMISSIONS)) stop('Existing/custom role is deleted, disabled or differs from the exact four approved permissions. No role update allowed.');
  return role;
}
function policyBindings(policy) {
  if (!plain(policy) || policy.bindings !== undefined && !Array.isArray(policy.bindings)) stop('Invalid IAM policy response.');
  for (const b of policy.bindings ?? []) if (!plain(b) || typeof b.role !== 'string' || !Array.isArray(b.members) || b.members.some((m) => typeof m !== 'string') || b.role.includes('_withcond_')) stop('Malformed IAM binding or hidden legacy condition.');
  return policy.bindings ?? [];
}
export function validateProjectPolicy(policy) {
  const targets = [];
  for (const b of policyBindings(policy)) {
    if (b.members.some((m) => ['allUsers', 'allAuthenticatedUsers'].includes(m))) stop('Unexpected public project IAM binding. Stop for review.');
    if (b.members.some((m) => m.startsWith(`deleted:${MEMBER}?`))) stop('Deleted runtime principal is present. Stop; do not recreate it automatically.');
    const roleMatches = [ROLE, `projects/${PROJECT_NUMBER}/roles/${ROLE_ID}`].includes(b.role);
    if (roleMatches && b.members.some((m) => m !== MEMBER)) stop('Dedicated runtime role is already assigned to another principal. Stop for review.');
    if (b.members.includes(MEMBER)) {
      if (!roleMatches || !plain(b.condition) || b.condition.expression !== EXPRESSION || b.condition.title !== CONDITION.title || (b.condition.description ?? '') !== '') stop('Runtime has an unexpected or unbounded project grant. Stop; do not broaden or revoke it.');
      targets.push(b);
    }
  }
  if (targets.length > 1) stop('Duplicate/ambiguous runtime grants. Stop for review.');
  return targets.length === 1;
}
export function validateAccountPolicy(policy) {
  if (policyBindings(policy).length) stop('Runtime account has explicit access/impersonation bindings. Stop before reusing it.');
}
function json(raw) { try { return JSON.parse(raw); } catch { stop('Metadata response is invalid JSON. No response body is displayed.'); } }
const present = (value) => value !== undefined && value !== null && value !== '';
const enabled = (value) => value === true || ['true', '1'].includes(String(value).toLowerCase());
export function validateEnvironment(env, execArgv = process.execArgv) {
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'NODE_OPTIONS', 'NODE_V8_COVERAGE', 'OPENSSL_CONF', 'OPENSSL_MODULES', 'OPENSSL_ENGINES', 'RANDFILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']) if (present(env[key])) stop('Environment has proxy, debug, Node or crypto configuration overrides. Stop without bypassing them.');
  if (execArgv.some((arg) => /inspect|trace|heap|prof|report|require|import/i.test(arg))) stop('Node inspection/diagnostic/injection options are not allowed for the user secret handoff.');
  for (const [key, value] of Object.entries(env)) if (present(value) && (key.startsWith('CLOUDSDK_API_ENDPOINT_OVERRIDES_') || /^CLOUDSDK_AUTH_(ACCESS_TOKEN|ACCESS_TOKEN_FILE|CREDENTIAL_FILE_OVERRIDE|IMPERSONATE_SERVICE_ACCOUNT|TOKEN_HOST|AUTH_HOST)$/.test(key))) stop('Environment has credential or API route overrides. Stop without changing them.');
  for (const key of ['CLOUDSDK_AUTH_DISABLE_CREDENTIALS', 'CLOUDSDK_AUTH_DISABLE_SSL_VALIDATION', 'CLOUDSDK_CORE_DISABLE_SSL_VALIDATION']) if (enabled(env[key])) stop('Environment weakens authentication or TLS. Stop.');
}
export function validateConfiguration(config) {
  if (!plain(config)) stop('Could not verify existing gcloud configuration.');
  if (Object.values(config.api_endpoint_overrides ?? {}).some(present) || ['type', 'address', 'port', 'username', 'password'].some((key) => present(config.proxy?.[key]))) stop('Custom API endpoint or proxy configuration. Stop without bypassing it.');
  for (const key of ['impersonate_service_account', 'credential_file_override', 'access_token_file', 'access_token']) if (present(config.auth?.[key])) stop('Credential or impersonation override. Stop.');
  if (enabled(config.auth?.disable_credentials) || enabled(config.auth?.disable_ssl_validation) || enabled(config.core?.disable_ssl_validation) || present(config.core?.custom_ca_certs_file)) stop('Authentication/TLS configuration is not the reviewed default.');
  if (present(config.auth?.token_host) && !['https://oauth2.googleapis.com/token', 'https://accounts.google.com/o/oauth2/token'].includes(config.auth.token_host)) stop('Nonstandard token endpoint.');
  if (present(config.auth?.auth_host) && !['https://accounts.google.com/o/oauth2/auth', 'https://accounts.google.com/o/oauth2/v2/auth'].includes(config.auth.auth_host)) stop('Nonstandard authentication endpoint.');
  if (present(config.core?.universe_domain) && config.core.universe_domain !== 'googleapis.com') stop('Nonstandard cloud universe.');
  if (present(config.regional?.endpoint_mode) && config.regional.endpoint_mode !== 'global') stop('Regional endpoint override is not allowed for this global secret resource.');
}
const secretNames = [PROJECT, PROJECT_NUMBER].map((p) => `projects/${p}/secrets/${SECRET_ID}`);
export function validateSecret(secret) {
  if (!plain(secret) || !secretNames.includes(secret.name) || !plain(secret.replication) || Object.keys(secret.replication).join() !== 'userManaged') stop('Secret identity or replication policy mismatch.');
  const replicas = secret.replication.userManaged?.replicas;
  if (!Array.isArray(replicas) || replicas.length !== 1 || !plain(replicas[0]) || Object.keys(replicas[0]).join() !== 'location' || replicas[0].location !== REGION) stop('Secret is not Google-encrypted with one Tokyo replica.');
  for (const key of ['rotation', 'versionAliases', 'labels', 'annotations']) if (secret[key] !== undefined && (!plain(secret[key]) || Object.keys(secret[key]).length)) stop('Secret has unapproved metadata, aliases or rotation.');
  if (present(secret.expireTime) || present(secret.ttl) || secret.topics !== undefined && (!Array.isArray(secret.topics) || secret.topics.length) || present(secret.versionDestroyTtl) && secret.versionDestroyTtl !== '0s') stop('Secret expiration, notifications or destruction settings differ from approved defaults.');
  if (typeof secret.createTime !== 'string' || !Number.isFinite(Date.parse(secret.createTime))) stop('Secret creation identity is missing.');
  if (typeof secret.etag !== 'string' || !secret.etag) stop('Secret metadata etag is missing.');
  return JSON.stringify([secret.createTime, secret.etag]);
}
export function validateVersions(versions, requireOne = true) {
  if (!Array.isArray(versions)) stop('Invalid version metadata inventory.');
  for (const v of versions) if (!plain(v) || !secretNames.some((s) => typeof v.name === 'string' && new RegExp(`^${s}/versions/[1-9][0-9]*$`).test(v.name)) || !['ENABLED', 'DISABLED', 'DESTROYED'].includes(v.state)) stop('Unexpected version metadata identity/state.');
  if (requireOne && (versions.length !== 1 || !secretNames.some((s) => versions[0].name === `${s}/versions/1`) || versions[0].state !== 'ENABLED')) stop('Exactly one ENABLED initial version was not verified. Do not add/regenerate a version.');
  return versions;
}
export function validateVersion(version) {
  validateVersions([version]);
  const replicas = version.replicationStatus?.userManaged?.replicas;
  if (!plain(version.replicationStatus) || Object.keys(version.replicationStatus).join() !== 'userManaged' || !Array.isArray(replicas) || replicas.length !== 1 || !plain(replicas[0]) || Object.keys(replicas[0]).join() !== 'location' || replicas[0].location !== REGION || present(version.destroyTime)) stop('Initial version Tokyo replication metadata was not verified.');
  if (typeof version.createTime !== 'string' || !Number.isFinite(Date.parse(version.createTime))) stop('Initial version creation identity is missing.');
  if (typeof version.etag !== 'string' || !version.etag) stop('Version metadata etag is missing.');
  return JSON.stringify([version.createTime, version.etag]);
}
export function validateSecretPolicy(policy) {
  const bindings = policyBindings(policy);
  if (bindings.length > 1) stop('Unexpected direct secret IAM bindings. Stop without revoking anyone.');
  if (!bindings.length) return false;
  const b = bindings[0];
  if (b.role !== ACCESSOR || !same(b.members, [MEMBER]) || present(b.condition)) stop('Secret IAM is not the exact sole direct runtime accessor binding.');
  return true;
}
function environment(env) { return { ...env, CLOUDSDK_CORE_DISABLE_PROMPTS: 'false', CLOUDSDK_CORE_LOG_HTTP: 'false', CLOUDSDK_CORE_DISABLE_FILE_LOGGING: 'true', NO_COLOR: '1' }; }
function argsWithProject(args) { return [...args, `--project=${PROJECT}`, `--billing-project=${PROJECT}`, '--verbosity=error']; }
export function makeMetadataRunner({ exec = execFileSync, env = process.env } = {}) {
  return (args) => {
    try { return exec('gcloud', argsWithProject([...args, '--format=json']), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024, timeout: 5 * 60 * 1000, env: environment(env) }); }
    catch { stop('Metadata or IAM command failed. Raw stdout/stderr is suppressed. Inspect before further changes.'); }
  };
}
// This function is ONLY run by the human's explicit Cloud Shell handoff.
// Tests must inject exec: they must NEVER invoke a real generator or cloud write.
export function createSecretInUserShell({ exec = execFileSync, env = process.env, onWrite = () => {}, execArgv = process.execArgv } = {}) {
  validateEnvironment(env, execArgv);
  let raw;
  try {
    try { raw = exec('/usr/bin/openssl', ['rand', '-hex', '32'], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1024, timeout: 10000, env: environment(env) }); }
    catch (error) { for (const buffer of [error.stdout, error.stderr, ...(Array.isArray(error.output) ? error.output : [])]) if (Buffer.isBuffer(buffer)) buffer.fill(0); stop('User-local generation failed; no secret creation was attempted. No generator diagnostics are displayed.'); }
    if (!Buffer.isBuffer(raw) || raw.length !== 65 || raw[64] !== 10 || !raw.subarray(0, 64).every((b) => b >= 48 && b <= 57 || b >= 97 && b <= 102)) stop('User-local generator output was invalid; no secret creation was attempted.');
    // A view, not a plaintext JavaScript string or file. Never print or return it.
    const input = raw.subarray(0, 64);
    onWrite();
    try { exec('gcloud', argsWithProject(['secrets', 'create', SECRET, '--replication-policy=user-managed', `--locations=${REGION}`, '--data-file=-', '--format=none']), { input, stdio: ['pipe', 'ignore', 'ignore'], timeout: 5 * 60 * 1000, env: environment(env) }); }
    catch { stop('Secret create/initial-version result is uncertain. Do not recreate, add a version, delete or retry. No secret output is displayed.'); }
  } finally { if (Buffer.isBuffer(raw)) raw.fill(0); }
}
async function runHmac({ userOperated, run, create, log, env, execArgv, progress }) {
  if (Number(process.versions.node.split('.')[0]) < 20 || typeof userOperated !== 'boolean') stop('Node 20+ and a valid mode are required.');
  validateEnvironment(env, execArgv);
  const read = (args) => json(run(args));
  validateConfiguration(read(['config', 'list', '--all']));
  const project = read(['projects', 'describe', PROJECT]);
  if (!plain(project) || project.projectId !== PROJECT || String(project.projectNumber) !== PROJECT_NUMBER || project.lifecycleState !== 'ACTIVE') stop('Exact active project ID/number was not verified.');
  log(`PROJECT_OK: ${PROJECT} / ${PROJECT_NUMBER}`);
  const apis = read(['services', 'list', '--enabled']);
  if (!Array.isArray(apis) || apis.some((a) => !plain(a) || !plain(a.config)) || !['secretmanager.googleapis.com', 'iam.googleapis.com', 'cloudresourcemanager.googleapis.com'].every((name) => apis.some((a) => a.config.name === name))) stop('Required APIs are not already enabled; none will be enabled here.');
  let runtimeId;
  const checkRuntime = () => {
    const a = validateAccount(read(['iam', 'service-accounts', 'describe', ACCOUNT]));
    if (runtimeId && a.uniqueId !== runtimeId) stop('Runtime uniqueId changed; stop before granting a replacement account.');
    runtimeId = a.uniqueId;
    const keys = read(['iam', 'service-accounts', 'keys', 'list', `--iam-account=${ACCOUNT}`, '--managed-by=user']);
    if (!Array.isArray(keys) || keys.length) stop('Runtime has user-managed keys or invalid key metadata.');
    validateAccountPolicy(read(['iam', 'service-accounts', 'get-iam-policy', ACCOUNT]));
    validateRole(read(['iam', 'roles', 'describe', ROLE_ID]));
    if (!validateProjectPolicy(read(['projects', 'get-iam-policy', PROJECT]))) stop('Exact runtime database binding is not present.');
  };
  checkRuntime();
  const inventory = () => {
    const values = read(['secrets', 'list']);
    if (!Array.isArray(values) || values.some((s) => !plain(s) || typeof s.name !== 'string' || ![PROJECT, PROJECT_NUMBER].some((p) => new RegExp(`^projects/${p}/secrets/[A-Za-z0-9_-]+$`).test(s.name)))) stop('Secret inventory failed or was not project-global; absence was not established.');
    return values.some((s) => secretNames.includes(s.name));
  };
  const policy = () => read(['secrets', 'get-iam-policy', SECRET]);
  const metadata = () => read(['secrets', 'describe', SECRET]);
  const versions = () => read(['secrets', 'versions', 'list', SECRET]);
  if (inventory()) {
    log('SECRET_ALREADY_EXISTS: no generation, overwrite, new version or IAM change is allowed by this creation helper.');
    if (userOperated) stop('Existing secret detected. Use metadata-only inspection and review; do not rerun creation.');
    validateSecret(metadata());
    const list = validateVersions(versions(), false);
    log(`EXISTING_VERSION_STATES: ${list.map((v) => v.state).join(',') || 'none'}`);
    log(`DIRECT_RUNTIME_ACCESSOR: ${validateSecretPolicy(policy()) ? 'present' : 'absent'}`);
    log('INSPECT_COMPLETE: existing metadata only; payload was not accessed.');
    return { existing: true, created: false };
  }
  log('SECRET_ABSENT: exact global secret is not in the successful project inventory.');
  if (!userOperated) { log('INSPECT_COMPLETE: no generation or changes.'); return { existing: false, created: false }; }
  // Recheck immediately before the human-only creation path. Create itself also
  // rejects AlreadyExists, so this cannot add a version to an existing secret.
  if (inventory()) stop('Secret appeared concurrently. No generation or overwrite.');
  log('USER_HANDOFF_CREATE_ONCE: nonprinting user-local generation and initial registration.');
  create({ env, execArgv, onWrite: () => { progress.issued = true; } });
  log('CREATE_CALL_RETURNED: checking metadata only; no value is read back.');
  const firstSecret = metadata();
  const createdAt = validateSecret(firstSecret);
  const secretCreateTime = firstSecret.createTime;
  validateVersions(versions());
  const versionAt = validateVersion(read(['secrets', 'versions', 'describe', `${SECRET}/versions/1`]));
  checkRuntime();
  const before = policy();
  if (validateSecretPolicy(before)) stop('A direct binding appeared before this helper granted it. Stop for review.');
  if (validateSecret(metadata()) !== createdAt) stop('Secret was replaced before IAM grant.');
  validateVersions(versions());
  if (validateVersion(read(['secrets', 'versions', 'describe', `${SECRET}/versions/1`])) !== versionAt) stop('Initial version metadata changed before IAM grant.');
  progress.issued = true;
  const result = read(['secrets', 'add-iam-policy-binding', SECRET, `--member=${MEMBER}`, `--role=${ACCESSOR}`, '--condition=None']);
  if (!validateSecretPolicy(result) || JSON.stringify(result.auditConfigs ?? []) !== JSON.stringify(before.auditConfigs ?? [])) stop('Secret-level IAM result or audit settings mismatch.');
  checkRuntime();
  const finalSecret = metadata(); validateSecret(finalSecret);
  // IAM policy is a separate resource; do not assume its update leaves the
  // parent Secret.etag unchanged. Creation identity and strict settings remain fixed.
  if (finalSecret.createTime !== secretCreateTime) stop('Secret creation identity changed.');
  validateVersions(versions());
  if (validateVersion(read(['secrets', 'versions', 'describe', `${SECRET}/versions/1`])) !== versionAt || !validateSecretPolicy(policy())) stop('Final version/secret IAM metadata mismatch.');
  log(`HMAC_SECRET: ${SECRET}`);
  log(`HMAC_REPLICA: ${REGION}`);
  log('HMAC_VERSION: 1 / ENABLED');
  log(`HMAC_DIRECT_ACCESSOR: ${ACCOUNT}`);
  log('HMAC_STAGE_VERIFIED: secret/version/Tokyo/direct IAM metadata verified; no payload readback.');
  log('ACCESS_LIMIT: only the new direct secret grant is runtime-only; inherited administrator/group/impersonation access is not fully audited.');
  log('STOP_HERE: no App Check, build IAM, deployment, tester or trial-clock changes.');
  return { existing: false, created: true };
}
export async function bootstrapHmac({ userOperated = false, env = process.env, run = makeMetadataRunner({ env }), create = createSecretInUserShell, log = console.log, execArgv = process.execArgv } = {}) {
  const progress = { issued: false };
  try { return await runHmac({ userOperated, run, create, log, env, execArgv, progress }); }
  catch (error) {
    if (progress.issued) log('PARTIAL_STATE: a cloud write was issued; some changes may have succeeded. DO_NOT_REAPPLY. Inspect metadata and review. Never delete, regenerate or add a version automatically.');
    throw error;
  }
}
export const PLAN = `Target: ${PROJECT} / ${PROJECT_NUMBER}\nUSER-ONLY Cloud Shell handoff: create new ${SECRET_ID}, one initial version, only Tokyo replication; grant only the dedicated runtime a direct secretAccessor binding.\nDefault plan and --inspect NEVER generate/read a value.\n--user-create-new-hmac is for the human's own Cloud Shell only, after approval. The agent must not run this mode.\nExisting secret/version stops creation. The helper issues no automatic write retries or rollback. Values stay in transient user-process memory and stdin, never a file, terminal output, command argument, environment variable or chat. Owned buffers are cleared; this does not guarantee erasure of every subprocess/OS copy.\nNo authentication flow, API enable, build IAM, App Check or deployment.`;
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.length || args.length === 1 && args[0] === '--plan') console.log(PLAN);
  else if (args.length === 1 && ['--inspect', '--user-create-new-hmac'].includes(args[0])) {
    try { await bootstrapHmac({ userOperated: args[0] === '--user-create-new-hmac' }); }
    catch (error) { console.error(`STOP: ${error.message}`); process.exitCode = 1; }
  } else { console.error('STOP: use --plan, --inspect or the human-only --user-create-new-hmac.'); process.exitCode = 1; }
}

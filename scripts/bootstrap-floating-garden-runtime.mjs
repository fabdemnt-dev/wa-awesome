#!/usr/bin/env node
// USER-operated Cloud Shell stage 2. No login, keys, secret, API enable or deploy.
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
function json(raw, stage) { try { return JSON.parse(raw); } catch { stop(`${stage}: invalid JSON response. No automatic mutation retry.`); } }
export function validateConfiguration(config) {
  if (!plain(config)) stop('Could not verify existing gcloud configuration.');
  if (Object.values(config.api_endpoint_overrides ?? {}).some((v) => v != null && v !== '')) stop('Custom API endpoint override. Stop without changing it.');
  for (const key of ['impersonate_service_account', 'credential_file_override', 'access_token_file', 'access_token']) if (config.auth?.[key]) stop('Credential or impersonation override. Stop without changing authentication.');
  if (config.core?.universe_domain && config.core.universe_domain !== 'googleapis.com') stop('Nonstandard cloud universe.');
}
export function validateDatabase(db) {
  if (!plain(db) || ![PROJECT, PROJECT_NUMBER].some((p) => db.name === `projects/${p}/databases/(default)`) || db.locationId !== REGION || db.type !== 'FIRESTORE_NATIVE') stop('Exact Tokyo default native Firestore database was not verified.');
}
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
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
}
export function verifyUnrelatedPolicy(before, after) {
  const unrelated = (policy) => ({
    bindings: policyBindings(policy).filter((b) => !b.members.includes(MEMBER)),
    auditConfigs: policy.auditConfigs ?? [],
  });
  if (JSON.stringify(canonical(unrelated(before))) !== JSON.stringify(canonical(unrelated(after)))) stop('Unrelated project bindings or audit configuration changed during the grant. Stop for review; do not repair or retry.');
}
function defaultRun(args) {
  try { return execFileSync('gcloud', [...args, `--project=${PROJECT}`, `--billing-project=${PROJECT}`, '--verbosity=error'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024, timeout: 5 * 60 * 1000,
    env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: 'false', CLOUDSDK_CORE_LOG_HTTP: 'false', CLOUDSDK_CORE_DISABLE_FILE_LOGGING: 'true', NO_COLOR: '1' } }); }
  catch { stop(`gcloud ${args.slice(0, 3).join(' ')} failed or timed out. A prior write may have succeeded. Do not rerun apply; use --inspect and report the short STOP/stage lines. No helper mutation retry.`); }
}
async function runBootstrapRuntime({ apply = false, run = defaultRun, log = console.log, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), mutationState } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 20 || typeof apply !== 'boolean') stop('Node 20+ and a valid mode are required.');
  const read = (args, stage) => {
    if (args[2] === 'create' || args[1] === 'add-iam-policy-binding') mutationState.push(stage);
    return json(run([...args, '--format=json']), stage);
  };
  let expectedUniqueId;
  const verifyAccount = (value) => {
    validateAccount(value);
    if (expectedUniqueId && value.uniqueId !== expectedUniqueId) stop('Runtime unique ID changed during this operation. Stop without granting access to a replacement.');
    expectedUniqueId = value.uniqueId; return value;
  };
  validateConfiguration(read(['config', 'list', '--all'], 'Configuration'));
  const p = read(['projects', 'describe', PROJECT], 'Project');
  if (!plain(p) || p.projectId !== PROJECT || String(p.projectNumber) !== PROJECT_NUMBER || p.lifecycleState !== 'ACTIVE') stop('Exact active project ID/number was not verified.');
  log(`PROJECT_OK: ${PROJECT} / ${PROJECT_NUMBER}`);
  const apis = read(['services', 'list', '--enabled'], 'API inventory');
  if (!Array.isArray(apis) || apis.some((s) => !plain(s) || !plain(s.config) || typeof s.config.name !== 'string') || !['iam.googleapis.com', 'firestore.googleapis.com', 'cloudresourcemanager.googleapis.com'].every((name) => apis.some((s) => s.config.name === name))) stop('Required APIs are not already enabled; this stage enables none.');
  validateDatabase(read(['firestore', 'databases', 'describe', '--database=(default)'], 'Database'));
  const accountList = read(['iam', 'service-accounts', 'list'], 'Account inventory');
  if (!Array.isArray(accountList) || accountList.some((s) => !plain(s) || typeof s.email !== 'string')) stop('Invalid service-account inventory.');
  const accounts = accountList.filter((s) => s.email === ACCOUNT);
  if (accounts.length > 1) stop('Duplicate runtime accounts.');
  let account = accounts[0] ? verifyAccount(read(['iam', 'service-accounts', 'describe', ACCOUNT], 'Existing account')) : null;
  const checkKeyless = () => {
    const keys = read(['iam', 'service-accounts', 'keys', 'list', `--iam-account=${ACCOUNT}`, '--managed-by=user'], 'User-managed key inventory');
    if (!Array.isArray(keys) || keys.length) stop('Runtime has user-managed keys or the key inventory was invalid. No key is read, created or deleted.');
    validateAccountPolicy(read(['iam', 'service-accounts', 'get-iam-policy', ACCOUNT], 'Account IAM'));
  };
  if (account) checkKeyless();
  const roleList = read(['iam', 'roles', 'list', '--show-deleted'], 'Role inventory');
  if (!Array.isArray(roleList) || roleList.some((r) => !plain(r) || typeof r.name !== 'string')) stop('Invalid custom-role inventory.');
  const roles = roleList.filter((r) => [ROLE, `projects/${PROJECT_NUMBER}/roles/${ROLE_ID}`].includes(r.name));
  if (roles.length > 1 || roles.some((r) => r.deleted)) stop('Deleted/duplicate dedicated role. Stop; do not recreate it.');
  let role = roles[0] ? validateRole(read(['iam', 'roles', 'describe', ROLE_ID], 'Existing role')) : null;
  const readPolicy = () => read(['projects', 'get-iam-policy', PROJECT], 'Project IAM');
  let bound = validateProjectPolicy(readPolicy());
  if (bound && (!account || !role)) stop('A runtime binding exists without matching live resources. Stop for review.');
  log(`RUNTIME_BASELINE: account=${account ? 'verified' : 'missing'},role=${role ? 'verified' : 'missing'},binding=${bound ? 'verified' : 'missing'}`);
  if (!apply) {
    log('ACCESS_LIMIT: direct metadata inspection only; inherited/group/resource policies and effective data access remain unverified.');
    log(`INSPECT_COMPLETE: ${account && role && bound ? 'runtime metadata matches approved configuration' : 'runtime setup is incomplete'}; no changes.`);
    return { complete: Boolean(account && role && bound), account: Boolean(account), role: Boolean(role), bound };
  }
  if (!account) {
    log(`WRITE_ONCE: create keyless ${ACCOUNT}`);
    account = verifyAccount(read(['iam', 'service-accounts', 'create', ACCOUNT_ID, `--display-name=${TITLE}`, '--description='], 'Created account'));
    log('ACCOUNT_CREATE_CONFIRMED: waiting 60 seconds for Google IAM propagation before further writes.');
    await sleep(60000);
    account = verifyAccount(read(['iam', 'service-accounts', 'describe', ACCOUNT], 'New account readback'));
    checkKeyless();
    log('ACCOUNT_VERIFIED: no user-managed keys and no explicit account-level IAM binding.');
  }
  if (!role) {
    // Re-read the project policy after account propagation and before creating a
    // role: a concurrent pregrant must not gain permissions through role creation.
    bound = validateProjectPolicy(readPolicy());
    if (bound) stop('Unexpected concurrent runtime grant before role creation. Stop for review.');
    log(`WRITE_ONCE: create ${ROLE} with four permissions`);
    role = validateRole(read(['iam', 'roles', 'create', ROLE_ID, `--title=${TITLE}`, '--description=', '--stage=GA', `--permissions=${PERMISSIONS.join(',')}`], 'Created role'));
    validateRole(read(['iam', 'roles', 'describe', ROLE_ID], 'New role readback'));
    log('ROLE_VERIFIED: exact approved four-permission custom role.');
  }
  // Revalidate all target security metadata immediately before the only grant.
  verifyAccount(read(['iam', 'service-accounts', 'describe', ACCOUNT], 'Account before grant')); checkKeyless();
  validateRole(read(['iam', 'roles', 'describe', ROLE_ID], 'Role before grant'));
  const beforeGrant = readPolicy();
  bound = validateProjectPolicy(beforeGrant);
  if (!bound) {
    log(`WRITE_ONCE: grant dedicated role only with ${EXPRESSION}`);
    const result = read(['projects', 'add-iam-policy-binding', PROJECT, `--member=${MEMBER}`, `--role=${ROLE}`, `--condition=expression=${EXPRESSION},title=${CONDITION.title}`], 'Binding result');
    verifyUnrelatedPolicy(beforeGrant, result);
    if (!validateProjectPolicy(result)) stop('Binding command returned without the exact runtime grant. Inspect; do not retry.');
  }
  verifyAccount(read(['iam', 'service-accounts', 'describe', ACCOUNT], 'Final account')); checkKeyless();
  validateRole(read(['iam', 'roles', 'describe', ROLE_ID], 'Final role'));
  const finalPolicy = readPolicy(); verifyUnrelatedPolicy(beforeGrant, finalPolicy);
  if (!validateProjectPolicy(finalPolicy)) stop('Final exact runtime binding was not observed. Inspect; do not retry.');
  log(`RUNTIME_ACCOUNT: ${ACCOUNT}`);
  log(`RUNTIME_ROLE: ${ROLE}`);
  log(`RUNTIME_PERMISSIONS: ${PERMISSIONS.join(',')}`);
  log(`RUNTIME_CONDITION: ${EXPRESSION}`);
  log('RUNTIME_STAGE_VERIFIED: expected account, no user-managed keys, exact role and direct project binding metadata match.');
  log('ACCESS_LIMIT: database-wide permissions bypass client Rules; this is not collection isolation. Inherited/group/resource policies and effective data access are not fully audited or tested. IAM propagation can take several minutes.');
  log('STOP_HERE: no build-account permissions, HMAC, App Check, deployment, tester enrollment or trial-clock changes.');
  return { complete: true, account: true, role: true, bound: true };
}
export async function bootstrapRuntime(options = {}) {
  const mutationState = [];
  try { return await runBootstrapRuntime({ ...options, mutationState }); }
  catch (error) {
    if (mutationState.length) (options.log ?? console.log)(`PARTIAL_STATE: write requests issued for ${mutationState.join(',')}; some may have succeeded. DO_NOT_REAPPLY: inspect and review before further changes. No automatic repair or rollback.`);
    throw error;
  }
}
export const PLAN = `Target: ${PROJECT} / ${PROJECT_NUMBER}\nUser Cloud Shell stage 2: keyless ${ACCOUNT}; ${ROLE}; four permissions ${PERMISSIONS.join(',')}; condition ${EXPRESSION}.\nDefault: plan only. --inspect: read-only. Approved user operation: --create-approved-runtime.\nChecks all existing resources before writes. Existing mismatches/keys/grants stop without overwrite or revocation. Creates only missing account/role and one exact conditional binding, without automatic write retries. A confirmed new account waits 60 seconds for propagation.\nNo API enablement, login, credential/key generation, HMAC, build identity changes, App Check or deployment. Database-wide access, not collection isolation.\nOn STOP, preserve summary lines and inspect instead of repeating apply.`;
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.length || args.length === 1 && args[0] === '--plan') console.log(PLAN);
  else if (args.length === 1 && ['--inspect', '--create-approved-runtime'].includes(args[0])) {
    try { await bootstrapRuntime({ apply: args[0] === '--create-approved-runtime' }); }
    catch (error) { console.error(`STOP: ${error.message}`); process.exitCode = 1; }
  } else { console.error('STOP: use --plan, --inspect or --create-approved-runtime only.'); process.exitCode = 1; }
}

#!/usr/bin/env node
// Importing this file is inert. Only the explicit CI entry point loads GoogleAuth.
// Application-call budget: 11 fixed calls + up to 5 derived build-account tests.
// Normal SDK credential exchange is separate from that budget. No cloud writes,
// payload access, document reads, policy reads, paging, retries or redirects.
import { resolve, dirname, basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCOPE = Object.freeze({
  project: 'wa-awesome-garden-stg', number: '120030709276', region: 'asia-northeast1',
  repositoryId: '1321198654', ref: 'refs/heads/verify/garden-ci-access-20261006',
});
export const LIMITS = Object.freeze({ requests: 16, timeout: 10_000, bytes: 262_144 });
export const FUNCTIONS = Object.freeze([
  'floatingGardenCreateRoom', 'floatingGardenJoinRoom', 'floatingGardenStartMatch',
  'floatingGardenGetSnapshot', 'floatingGardenSubmitAction',
]);
const { project, number, region } = SCOPE;
const runtime = `garden-trial-runtime@${project}.iam.gserviceaccount.com`;
const secret = `projects/${project}/secrets/FLOATING_GARDEN_INVITE_HMAC_KEY`;
const apis = Object.freeze([
  'cloudfunctions.googleapis.com', 'cloudbuild.googleapis.com', 'artifactregistry.googleapis.com',
  'run.googleapis.com', 'eventarc.googleapis.com', 'pubsub.googleapis.com', 'storage.googleapis.com',
  'secretmanager.googleapis.com', 'iam.googleapis.com', 'firebaseappcheck.googleapis.com',
  'recaptchaenterprise.googleapis.com', 'firebaserules.googleapis.com', 'logging.googleapis.com',
  'cloudbilling.googleapis.com', 'firebaseextensions.googleapis.com', 'firestore.googleapis.com',
  'firebasehosting.googleapis.com', 'firebase.googleapis.com', 'runtimeconfig.googleapis.com',
]);
const accountPermissions = Object.freeze(['iam.serviceAccounts.get', 'iam.serviceAccounts.actAs', 'iam.serviceAccounts.getIamPolicy']);
const projectPermissions = Object.freeze([
  'resourcemanager.projects.get', 'firebase.projects.get', 'cloudfunctions.functions.get', 'cloudfunctions.functions.list',
  'cloudfunctions.functions.update', 'cloudfunctions.functions.sourceCodeSet', 'cloudfunctions.operations.get',
  'cloudbuild.builds.create', 'cloudbuild.builds.get', 'run.services.get', 'run.services.update',
  'artifactregistry.repositories.get', 'artifactregistry.repositories.downloadArtifacts',
  'artifactregistry.repositories.uploadArtifacts', 'firebaserules.releases.get',
  'firebaserules.releases.update', 'firebaserules.releases.create', 'firebaserules.rulesets.create',
  'firebaserules.rulesets.get', 'firebaserules.rulesets.test',
  'firebasehosting.sites.get', 'firebasehosting.sites.update', 'serviceusage.services.get', 'serviceusage.services.list',
  'serviceusage.services.use', 'datastore.databases.getMetadata', 'datastore.entities.get', 'datastore.entities.list',
]);
const get = (stage, url, fields, query = {}) => Object.freeze({
  stage, method: 'GET', url: `${url}?${new URLSearchParams({ ...query, fields })}`,
});
const iam = (stage, url, permissions) => Object.freeze({
  stage, method: 'POST', url, permissions,
});
const accountTest = (stage, email) => iam(stage,
  `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts/${email}:testIamPermissions`, accountPermissions);
export const FIXED_REQUESTS = Object.freeze([
  get('project_metadata', `https://cloudresourcemanager.googleapis.com/v1/projects/${project}`, 'projectId,projectNumber,lifecycleState'),
  iam('project_permissions', `https://cloudresourcemanager.googleapis.com/v1/projects/${project}:testIamPermissions`, projectPermissions),
  get('function_inventory', `https://cloudfunctions.googleapis.com/v2/projects/${project}/locations/${region}/functions`,
    'functions(name,environment,state,buildConfig(serviceAccount),serviceConfig(serviceAccountEmail)),nextPageToken,unreachable', { pageSize: '100' }),
  accountTest('runtime_permissions', runtime),
  accountTest('appspot_permissions', `${project}@appspot.gserviceaccount.com`),
  get('hmac_version_metadata', `https://secretmanager.googleapis.com/v1/${secret}/versions/latest`, 'name,state'),
  iam('hmac_permissions', `https://secretmanager.googleapis.com/v1/${secret}:testIamPermissions`, Object.freeze([
    'secretmanager.secrets.get', 'secretmanager.versions.get', 'secretmanager.versions.access',
  ])),
  get('hosting_metadata', `https://firebasehosting.googleapis.com/v1beta1/projects/${project}/sites/${project}`, 'name'),
  get('rules_release_metadata', `https://firebaserules.googleapis.com/v1/projects/${project}/releases/cloud.firestore`, 'name,rulesetName'),
  get('enabled_apis', `https://serviceusage.googleapis.com/v1/projects/${number}/services`,
    'services(config(name),state),nextPageToken', { filter: 'state:ENABLED', pageSize: '200' }),
  get('database_metadata', `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)`, 'name,type,locationId'),
]);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const need = condition => { if (!condition) throw new Error('probe_guard'); };
const statusOf = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : 0;
const projectNames = suffix => [project, number].map(id => `projects/${id}/${suffix}`);
const projectName = (value, suffix) => projectNames(suffix).includes(value);

function exactFunctions(data) {
  return plain(data) && !data.nextPageToken && (!data.unreachable || Array.isArray(data.unreachable) && data.unreachable.length === 0) &&
    Array.isArray(data.functions) && data.functions.length === FUNCTIONS.length &&
    FUNCTIONS.every(name => data.functions.filter(item => plain(item) &&
      projectName(item.name, `locations/${region}/functions/${name}`)).length === 1);
}
function sameProjectBuildAccount(identity) {
  if (typeof identity !== 'string') return null;
  const match = identity.match(/^projects\/([^/]+)\/serviceAccounts\/([^/]+)$/);
  if (!match || ![project, number].includes(match[1])) return null;
  const email = match[2];
  const ownCustom = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@wa-awesome-garden-stg\.iam\.gserviceaccount\.com$/.test(email);
  return ownCustom || [`${number}-compute@developer.gserviceaccount.com`, `${number}@cloudbuild.gserviceaccount.com`].includes(email) ? email : null;
}
function buildAccounts(data) {
  if (!exactFunctions(data)) return [];
  return [...new Set(data.functions.map(item => sameProjectBuildAccount(item.buildConfig?.serviceAccount)).filter(Boolean))].sort();
}
function buildIdentitySummary(data) {
  const trusted = exactFunctions(data);
  const values = trusted ? data.functions.map(item => item.buildConfig?.serviceAccount) : [];
  return {
    build_inventory_trusted: trusted,
    build_identity_fields_missing: values.filter(value => value === undefined).length,
    build_identity_fields_supported: values.filter(value => sameProjectBuildAccount(value)).length,
    build_identity_fields_unsupported: values.filter(value => value !== undefined && !sameProjectBuildAccount(value)).length,
    distinct_supported_build_accounts: buildAccounts(data).length,
    build_identity_compute_count: values.filter(value => sameProjectBuildAccount(value) === `${number}-compute@developer.gserviceaccount.com`).length,
    build_identity_legacy_count: values.filter(value => sameProjectBuildAccount(value) === `${number}@cloudbuild.gserviceaccount.com`).length,
    build_identity_custom_count: values.filter(value => sameProjectBuildAccount(value)?.endsWith(`@${project}.iam.gserviceaccount.com`)).length,
  };
}

// Accept stage names only: no caller-supplied method, URL, headers or body.
// Derived stages can be registered only from the exact five-function inventory.
export function createProbeTransport({ request }) {
  need(typeof request === 'function');
  const entries = new Map(FIXED_REQUESTS.map(entry => [entry.stage, entry]));
  let count = 0, registered = false;
  return {
    get count() { return count; },
    registerBuildAccounts(data) {
      need(!registered); registered = true;
      const accounts = buildAccounts(data);
      accounts.forEach((email, index) => entries.set(`build_permissions_${index + 1}`, accountTest(`build_permissions_${index + 1}`, email)));
      return accounts.map((_, index) => `build_permissions_${index + 1}`);
    },
    async read(stage) {
      const entry = entries.get(stage);
      need(entry && count < LIMITS.requests);
      count++;
      const options = {
        url: entry.url, method: entry.method,
        ...(entry.permissions ? { data: { permissions: [...entry.permissions] } } : {}),
        retry: false, retryConfig: { retry: 0 }, maxRedirects: 0,
        timeout: LIMITS.timeout, maxContentLength: LIMITS.bytes,
        responseType: 'text', validateStatus: () => true,
      };
      try {
        const response = await request(options);
        const status = statusOf(response?.status);
        if (status !== 200) return { ok: false, status };
        if (typeof response.data !== 'string' || Buffer.byteLength(response.data) > LIMITS.bytes) return { ok: false, status: 200 };
        const data = JSON.parse(response.data);
        if (!plain(data)) return { ok: false, status: 200 };
        return { ok: true, status, data, permissions: entry.permissions };
      } catch (error) {
        return { ok: false, status: statusOf(error?.response?.status) };
      }
    },
  };
}
function metadataSummary(stage, data) {
  switch (stage) {
    case 'project_metadata': return { identity_matches: data.projectId === project && String(data.projectNumber) === number, active: data.lifecycleState === 'ACTIVE' };
    case 'function_inventory': return {
      exact_inventory: exactFunctions(data),
      ...buildIdentitySummary(data),
      function_count: Array.isArray(data.functions) ? Math.min(data.functions.length, 100) : 0,
      all_active: exactFunctions(data) && data.functions.every(item => item.state === 'ACTIVE'),
      all_gen2: exactFunctions(data) && data.functions.every(item => item.environment === 'GEN_2'),
      all_dedicated_runtime: exactFunctions(data) && data.functions.every(item => item.serviceConfig?.serviceAccountEmail === runtime),
    };
    case 'hmac_version_metadata': return {
      latest_is_original_version_1: projectName(data.name, 'secrets/FLOATING_GARDEN_INVITE_HMAC_KEY/versions/1'),
      same_secret_numeric_version: typeof data.name === 'string' && projectNames('secrets/FLOATING_GARDEN_INVITE_HMAC_KEY/versions/').some(prefix => data.name.startsWith(prefix) && /^[1-9][0-9]*$/.test(data.name.slice(prefix.length))),
      enabled: data.state === 'ENABLED',
    };
    case 'hosting_metadata': return { identity_matches: projectName(data.name, `sites/${project}`) };
    case 'rules_release_metadata': return {
      identity_matches: projectName(data.name, 'releases/cloud.firestore'),
      ruleset_present: typeof data.rulesetName === 'string' && projectNames('rulesets/').some(prefix => data.rulesetName.startsWith(prefix) && /^[a-zA-Z0-9_-]+$/.test(data.rulesetName.slice(prefix.length))),
    };
    case 'enabled_apis': {
      const services = Array.isArray(data.services) ? data.services : [];
      return {
        inventory_complete: Array.isArray(data.services) && !data.nextPageToken,
        known_enabled_count: apis.filter(api => services.some(item => item?.config?.name === api && item.state === 'ENABLED')).length,
        known_api_count: apis.length,
        ...Object.fromEntries(apis.map(api => [api, services.some(item => item?.config?.name === api && item.state === 'ENABLED')])),
      };
    }
    case 'database_metadata': return { identity_matches: projectName(data.name, 'databases/(default)'), native: data.type === 'FIRESTORE_NATIVE', tokyo: data.locationId === region };
    default: throw new Error('probe_guard');
  }
}
export async function runProbe({ request, log = console.log }) {
  const transport = createProbeTransport({ request });
  const records = []; let derived = [], successfulHttpCount = 0, failureCount = 0, rejectedResponseCount = 0;
  log('permission_tests informational=true resource_conditional_grants_may_be_unreported=true deployment_authorized=false');
  log('account_permission_tests describe_caller_only=true runtime_appspot_build_roles_not_inspected=true');
  async function inspect(stage) {
    const result = await transport.read(stage);
    if (result.status === 200) successfulHttpCount++; else failureCount++;
    if (!result.ok && result.status === 200) rejectedResponseCount++;
    if (!result.ok) {
      log(`${stage} http_status=${result.status}`);
      records.push({ stage, http_status: result.status });
      return;
    }
    let summary;
    if (result.permissions) {
      const returned = result.data.permissions;
      const valid = returned === undefined || Array.isArray(returned) && returned.every(value => typeof value === 'string' && result.permissions.includes(value));
      summary = { response_valid: valid };
      if (!valid) rejectedResponseCount++;
      if (valid) for (const permission of result.permissions) summary[permission] = (returned ?? []).includes(permission);
    } else summary = metadataSummary(stage, result.data);
    records.push({ stage, ...summary });
    log(`${stage} ${JSON.stringify(summary)}`);
    if (stage === 'function_inventory') derived = transport.registerBuildAccounts(result.data);
  }
  for (const { stage } of FIXED_REQUESTS) await inspect(stage);
  for (const stage of derived) await inspect(stage);
  const result = { logicalRequestCount: transport.count, successfulHttpCount, failureCount, rejectedResponseCount,
    buildTests: derived.length, deploymentAuthorized: false, cloudWrites: 0 };
  log(`CI_ACCESS_RESULT ${JSON.stringify(result)}`);
  return { records, applicationRequests: transport.count, buildAccountsTested: derived.length, result };
}

export function assertCiEnvironment(env) {
  need(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY_ID === SCOPE.repositoryId &&
    env.GITHUB_REF === SCOPE.ref && env.GITHUB_EVENT_NAME === 'push' &&
    env.GITHUB_RUN_NUMBER === '1' && env.GITHUB_RUN_ATTEMPT === '1');
  need(!env.DEBUG && !env.NODE_DEBUG && !env.NODE_OPTIONS && env.RUNNER_DEBUG !== '1' &&
    env.ACTIONS_STEP_DEBUG !== 'true' && env.ACTIONS_RUNNER_DEBUG !== 'true');
  const path = env.GOOGLE_APPLICATION_CREDENTIALS;
  need(typeof path === 'string' && isAbsolute(path) && typeof env.GITHUB_WORKSPACE === 'string' &&
    dirname(path) === resolve(env.GITHUB_WORKSPACE) && /^gha-creds-[a-z0-9]{16}\.json$/.test(basename(path)) &&
    env.GOOGLE_GHA_CREDS_PATH === path && env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE === path &&
    env.GOOGLE_CLOUD_PROJECT === project);
}
async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--run-ci-read-only') {
    console.log('plan_only cloud_requests=0 cloud_writes=0'); return;
  }
  try {
    assertCiEnvironment(process.env);
    const { GoogleAuth, JWT } = await import('google-auth-library');
    // The official action owns the temporary ADC file and post-action cleanup.
    // Only the SDK reads it. Explicit keyFilename + projectId prevents ADC fallback.
    const auth = new GoogleAuth({ keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      projectId: project, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    need(client instanceof JWT);
    client.forceRefreshOnFailure = false;
    client.transporter.defaults = { ...client.transporter.defaults, retry: false,
      retryConfig: { retry: 0 }, maxRedirects: 0, timeout: LIMITS.timeout, maxContentLength: LIMITS.bytes };
    // validateStatus accepts 401/403 too, preventing request replay on auth errors.
    await runProbe({ request: options => client.request(options) });
  } catch {
    console.log('ci_probe completed=false'); process.exitCode = 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  SCOPE, LIMITS, FUNCTIONS, FIXED_REQUESTS,
  createProbeTransport, runProbe, assertCiEnvironment,
} from '../scripts/floating-garden-ci-access-check.mjs';

const scriptUrl = new URL('../scripts/floating-garden-ci-access-check.mjs', import.meta.url);
const workflowUrl = new URL('../.github/workflows/garden-ci-access-check.yml', import.meta.url);
const marker = 'PRIVATE_VALUE_MUST_NEVER_APPEAR';
const runtime = `garden-trial-runtime@${SCOPE.project}.iam.gserviceaccount.com`;
const functionData = (identities = []) => ({ functions: FUNCTIONS.map((name, index) => ({
  name: `projects/${SCOPE.project}/locations/${SCOPE.region}/functions/${name}`,
  state: 'ACTIVE', environment: 'GEN_2',
  serviceConfig: { serviceAccountEmail: runtime, environmentVariables: { SECRET: marker } },
  buildConfig: { serviceAccount: identities[index] },
})) });
const account = name => `projects/${SCOPE.project}/serviceAccounts/${name}@${SCOPE.project}.iam.gserviceaccount.com`;
const fixtures = (functions = functionData()) => ({
  project_metadata: { projectId: SCOPE.project, projectNumber: SCOPE.number, lifecycleState: 'ACTIVE', secret: marker },
  project_permissions: { permissions: ['resourcemanager.projects.get'], secret: marker },
  function_inventory: functions,
  runtime_permissions: { permissions: ['iam.serviceAccounts.actAs'] },
  appspot_permissions: {},
  hmac_version_metadata: { name: `projects/${SCOPE.number}/secrets/FLOATING_GARDEN_INVITE_HMAC_KEY/versions/1`, state: 'ENABLED', payload: marker },
  hmac_permissions: {},
  hosting_metadata: { name: `projects/${SCOPE.project}/sites/${SCOPE.project}` },
  rules_release_metadata: { name: `projects/${SCOPE.project}/releases/cloud.firestore`, rulesetName: `projects/${SCOPE.project}/rulesets/rules-v1`, uid: marker },
  enabled_apis: { services: [{ config: { name: 'cloudfunctions.googleapis.com' }, state: 'ENABLED' }] },
  database_metadata: { name: `projects/${SCOPE.project}/databases/(default)`, type: 'FIRESTORE_NATIVE', locationId: SCOPE.region },
});
function responder(data = fixtures(), calls = []) {
  return async options => {
    calls.push(options);
    const entry = FIXED_REQUESTS.find(item => item.url === options.url);
    return { status: 200, data: JSON.stringify(entry ? data[entry.stage] : { permissions: ['iam.serviceAccounts.actAs'] }) };
  };
}
const ciEnv = () => ({
  GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY_ID: SCOPE.repositoryId, GITHUB_REF: SCOPE.ref,
  GITHUB_EVENT_NAME: 'push', GITHUB_RUN_NUMBER: '1', GITHUB_RUN_ATTEMPT: '1',
  GITHUB_WORKSPACE: '/workspace/repo', GOOGLE_CLOUD_PROJECT: SCOPE.project,
  GOOGLE_APPLICATION_CREDENTIALS: '/workspace/repo/gha-creds-0123456789abcdef.json',
  GOOGLE_GHA_CREDS_PATH: '/workspace/repo/gha-creds-0123456789abcdef.json',
  CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '/workspace/repo/gha-creds-0123456789abcdef.json',
});

test('fixed plan contains exactly 11 metadata GET / testIamPermissions POST calls', () => {
  assert.equal(FIXED_REQUESTS.length, 11);
  assert.equal(new Set(FIXED_REQUESTS.map(item => item.stage)).size, 11);
  for (const entry of FIXED_REQUESTS) {
    const url = new URL(entry.url);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.username + url.password + url.hash + url.port, '');
    assert.ok(new Set([
      'cloudresourcemanager.googleapis.com', 'cloudfunctions.googleapis.com', 'iam.googleapis.com',
      'secretmanager.googleapis.com', 'firebasehosting.googleapis.com', 'firebaserules.googleapis.com',
      'serviceusage.googleapis.com', 'firestore.googleapis.com',
    ]).has(url.hostname));
    assert.ok(url.pathname.includes(SCOPE.project) || url.pathname.includes(SCOPE.number));
    assert.ok(!/\/documents(?:\/|$)|:access(?:\?|$)|getIamPolicy|setIamPolicy|:enable|generateUploadUrl/.test(entry.url));
    assert.ok(entry.method === 'GET' || entry.method === 'POST' && url.pathname.endsWith(':testIamPermissions'));
    if (entry.method === 'GET') assert.equal(entry.permissions, undefined);
    else assert.ok(entry.permissions.length > 0);
  }
  assert.ok(Object.isFrozen(FIXED_REQUESTS));
  assert.ok(FIXED_REQUESTS.every(Object.isFrozen));
});

test('stage-only transport rejects arbitrary URLs, write methods and data', async () => {
  let calls = 0;
  const transport = createProbeTransport({ request: async () => { calls++; return { status: 200, data: '{}' }; } });
  for (const value of [
    'https://example.com', 'https://firestore.googleapis.com/v1/projects/other/databases/(default)/documents',
    'projects_permissions', '__proto__', 'build_permissions_1', null,
    ...['POST', 'PUT', 'PATCH', 'DELETE'].map(method => ({ method, url: FIXED_REQUESTS[0].url, data: { marker } })),
  ]) await assert.rejects(transport.read(value), /probe_guard/);
  assert.equal(calls, 0);
});

test('every application call disables retries and redirects and has time/size limits', async () => {
  const calls = [], logs = [];
  await runProbe({ request: responder(fixtures(), calls), log: line => logs.push(line) });
  assert.equal(calls.length, 11);
  for (const options of calls) {
    assert.equal(options.retry, false);
    assert.deepEqual(options.retryConfig, { retry: 0 });
    assert.equal(options.maxRedirects, 0);
    assert.equal(options.timeout, LIMITS.timeout);
    assert.equal(options.maxContentLength, LIMITS.bytes);
    assert.equal(options.responseType, 'text');
    for (const status of [200, 302, 401, 403, 429, 500]) assert.equal(options.validateStatus(status), true);
    assert.equal(options.headers, undefined);
    if (options.method === 'POST') assert.deepEqual(Object.keys(options.data), ['permissions']);
  }
  assert.ok(!logs.join('\n').includes(marker));
  assert.ok(!logs.join('\n').includes('@'));
  assert.ok(!logs.join('\n').includes('https://'));
});

test('at most five build identities are derived from exact inventory; total budget is 16', async () => {
  const identities = ['builder-one', 'builder-two', 'builder-three', 'builder-four', 'builder-five'].map(account);
  const calls = [];
  const result = await runProbe({ request: responder(fixtures(functionData(identities)), calls), log: () => {} });
  assert.equal(result.applicationRequests, 16);
  assert.equal(result.buildAccountsTested, 5);
  assert.equal(calls.length, 16);
  for (const item of calls.slice(11)) {
    assert.equal(item.method, 'POST');
    assert.ok(item.url.startsWith(`https://iam.googleapis.com/v1/projects/${SCOPE.project}/serviceAccounts/`));
    assert.ok(item.url.endsWith(':testIamPermissions'));
    assert.deepEqual(item.data.permissions, ['iam.serviceAccounts.get', 'iam.serviceAccounts.actAs', 'iam.serviceAccounts.getIamPolicy']);
  }
  const transport = createProbeTransport({ request: responder() });
  for (let index = 0; index < 16; index++) await transport.read('project_metadata');
  await assert.rejects(transport.read('project_metadata'), /probe_guard/);
  assert.equal(transport.count, 16);
});

test('build identities accept only same-project resources and deduplicate', () => {
  const transport = createProbeTransport({ request: responder() });
  const derived = transport.registerBuildAccounts(functionData([
    account('builder-one'), account('builder-one'),
    `projects/${SCOPE.number}/serviceAccounts/${SCOPE.number}-compute@developer.gserviceaccount.com`,
    `projects/${SCOPE.project}/serviceAccounts/${SCOPE.number}@cloudbuild.gserviceaccount.com`,
    'projects/other/serviceAccounts/builder-one@other.iam.gserviceaccount.com',
  ]));
  assert.equal(derived.length, 3);
  assert.throws(() => transport.registerBuildAccounts(functionData()), /probe_guard/);
  for (const identity of [
    'https://example.com/secret', `projects/${SCOPE.project}/serviceAccounts/123-compute@developer.gserviceaccount.com`,
    `projects/${SCOPE.project}/serviceAccounts/builder-one@other.iam.gserviceaccount.com`,
    `projects/-/serviceAccounts/builder-one@${SCOPE.project}.iam.gserviceaccount.com`,
    `${SCOPE.number}@cloudbuild.gserviceaccount.com`,
    `projects/${SCOPE.project}/serviceAccounts/builder-one@${SCOPE.project}.iam.gserviceaccount.com?redirect=evil`,
  ]) assert.deepEqual(createProbeTransport({ request: responder() }).registerBuildAccounts(functionData([identity])), []);
});

test('incomplete, extra, duplicate, foreign or paged inventory never authorizes build tests', async () => {
  const base = () => functionData([account('builder-one')]);
  const variants = [
    {}, { ...base(), nextPageToken: marker }, { ...base(), unreachable: [SCOPE.region] },
    { functions: base().functions.slice(1) },
    { functions: [...base().functions, base().functions[0]] },
    { functions: [...base().functions.slice(1), base().functions[1]] },
    { functions: base().functions.map(item => ({ ...item, name: item.name.replace(SCOPE.project, 'other') })) },
  ];
  for (const variant of variants) {
    const calls = [], logs = [];
    const result = await runProbe({ request: responder(fixtures(variant), calls), log: line => logs.push(line) });
    assert.equal(result.applicationRequests, 11);
    assert.equal(result.buildAccountsTested, 0);
    assert.equal(result.records.find(item => item.stage === 'function_inventory').exact_inventory, false);
    assert.ok(!logs.join('\n').includes(marker));
  }
});

test('HTTP errors, redirections and thrown errors never retry, follow or print raw response', async () => {
  for (const status of [302, 401, 403, 404, 429, 500]) {
    let calls = 0; const logs = [];
    const result = await runProbe({ request: async () => {
      calls++; return { status, data: marker, headers: { location: `https://example.com/${marker}` } };
    }, log: line => logs.push(line) });
    assert.equal(calls, 11);
    assert.equal(result.applicationRequests, 11);
    assert.ok(logs.includes(`project_metadata http_status=${status}`));
    assert.ok(!logs.join('\n').includes(marker));
  }
  const logs = [];
  const result = await runProbe({ request: async () => { throw Object.assign(new Error(marker), { response: { status: 403, data: marker } }); }, log: line => logs.push(line) });
  assert.equal(result.applicationRequests, 11);
  assert.ok(logs.includes('project_metadata http_status=403'));
  assert.ok(!logs.join('\n').includes(marker));
});

test('unexpected response shapes, permissions and over-limit bodies are redacted', async () => {
  for (const data of [marker, 'null', '[]', '{}'.padEnd(LIMITS.bytes + 1), { secret: marker }]) {
    const logs = [];
    await runProbe({ request: async () => ({ status: 200, data }), log: line => logs.push(line) });
    assert.ok(!logs.join('\n').includes(marker));
  }
  const data = fixtures();
  data.project_permissions = { permissions: [marker, 'resourcemanager.projects.get'], token: marker };
  const logs = [];
  const result = await runProbe({ request: responder(data), log: line => logs.push(line) });
  assert.deepEqual(result.records.find(item => item.stage === 'project_permissions'), { stage: 'project_permissions', response_valid: false });
  assert.ok(!logs.join('\n').includes(marker));
  assert.ok(!JSON.stringify(result).includes(marker));
});

test('independent fixed reads continue after one failed stage, without fake missing-permission claims', async () => {
  const calls = [], logs = [], normal = responder(fixtures(), calls);
  const result = await runProbe({ request: async options => {
    if (options.url === FIXED_REQUESTS[1].url) { calls.push(options); throw new Error(marker); }
    return normal(options);
  }, log: line => logs.push(line) });
  assert.equal(calls.length, 11);
  assert.equal(result.records.at(-1).stage, 'database_metadata');
  assert.deepEqual(result.records[1], { stage: 'project_permissions', http_status: 0 });
  assert.ok(logs[0].includes('resource_conditional_grants_may_be_unreported=true'));
  assert.ok(logs[0].includes('deployment_authorized=false'));
  assert.ok(!logs.join('\n').includes('permissions_missing'));
  assert.deepEqual(result.result, { logicalRequestCount: 11, successfulHttpCount: 10, failureCount: 1, rejectedResponseCount: 0, buildTests: 0, deploymentAuthorized: false, cloudWrites: 0 });
});

test('CI guard rejects alternate runs, repos, refs, debug and ADC fallbacks', () => {
  assert.doesNotThrow(() => assertCiEnvironment(ciEnv()));
  const nonHexPath = '/workspace/repo/gha-creds-abcdefghijklmnoz.json';
  assert.doesNotThrow(() => assertCiEnvironment({ ...ciEnv(), GOOGLE_APPLICATION_CREDENTIALS: nonHexPath, GOOGLE_GHA_CREDS_PATH: nonHexPath, CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: nonHexPath }));
  for (const [key, value] of Object.entries({
    GITHUB_ACTIONS: 'false', GITHUB_REPOSITORY_ID: '1', GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_NUMBER: '2', GITHUB_RUN_ATTEMPT: '2',
    GITHUB_WORKSPACE: '/other', GOOGLE_CLOUD_PROJECT: 'wa-awesome',
    GOOGLE_APPLICATION_CREDENTIALS: '/tmp/private.json', GOOGLE_GHA_CREDS_PATH: '',
    CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '', DEBUG: '*', NODE_DEBUG: 'https', NODE_OPTIONS: '--inspect',
    RUNNER_DEBUG: '1', ACTIONS_STEP_DEBUG: 'true', ACTIONS_RUNNER_DEBUG: 'true',
  })) assert.throws(() => assertCiEnvironment({ ...ciEnv(), [key]: value }), /probe_guard/, key);
  for (const key of Object.keys(ciEnv())) {
    const env = ciEnv(); delete env[key];
    assert.throws(() => assertCiEnvironment(env), /probe_guard/, key);
  }
});

test('import and default CLI do not initialize SDK, read ADC or make requests', async () => {
  const source = await readFile(scriptUrl, 'utf8');
  assert.ok(!/^import .*['"](?:google-auth-library|gaxios)['"]/m.test(source));
  assert.equal(source.match(/await import\('google-auth-library'\)/g)?.length, 1);
  assert.ok(!/readFile|readFileSync|spawn|execFile|fetch\(/.test(source));
  const env = { PATH: process.env.PATH, GOOGLE_APPLICATION_CREDENTIALS: '/unreadable/should-not-be-read' };
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(scriptUrl.href)});`], { env, encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout + imported.stderr, '');
  const plan = spawnSync(process.execPath, [fileURLToPath(scriptUrl)], { env, encoding: 'utf8' });
  assert.equal(plan.status, 0);
  assert.equal(plan.stdout.trim(), 'plan_only cloud_requests=0 cloud_writes=0');
  const blocked = spawnSync(process.execPath, [fileURLToPath(scriptUrl), '--run-ci-read-only'], { env, encoding: 'utf8' });
  assert.equal(blocked.status, 1);
  assert.equal(blocked.stdout.trim(), 'ci_probe completed=false');
  assert.equal(blocked.stderr, '');
});

test('workflow is exact one-time push, pinned, read-only and tests before auth', async () => {
  const text = await readFile(workflowUrl, 'utf8');
  const trigger = text.slice(text.indexOf('\non:'), text.indexOf('\npermissions:'));
  assert.equal((trigger.match(/^  [a-z_]+:/gm) ?? []).length, 1);
  assert.ok(trigger.includes("branches: ['verify/garden-ci-access-20261006']"));
  assert.deepEqual([...trigger.matchAll(/^      - '([^']+)'$/gm)].map(match => match[1]), [
    '.github/workflows/garden-ci-access-check.yml', 'scripts/floating-garden-ci-access-check.mjs',
    'tests/floating-garden-ci-access-check.test.mjs',
  ]);
  for (const guard of [
    "github.repository_id == '1321198654'", "github.ref == 'refs/heads/verify/garden-ci-access-20261006'",
    "github.event_name == 'push'", 'github.run_number == 1', 'github.run_attempt == 1',
  ]) assert.ok(text.includes(guard), guard);
  assert.ok(text.includes('permissions:\n  contents: read\n'));
  assert.ok(text.includes('cancel-in-progress: false'));
  assert.deepEqual([...text.matchAll(/uses: ([^\n]+)/g)].map(match => match[1]), [
    'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
    'google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093',
  ]);
  const install = text.indexOf('run: npm ci --ignore-scripts --no-audit --no-fund');
  const tests = text.indexOf('run: node --test tests/floating-garden-ci-access-check.test.mjs');
  const secretGuard = text.indexOf("if [ \"$EXISTING_SECRET_PRESENT\" != 'true' ]; then");
  const auth = text.indexOf('uses: google-github-actions/auth@');
  assert.ok(install > 0 && tests > install && secretGuard > tests && auth > secretGuard);
  assert.ok(text.slice(secretGuard, auth).includes('exit 1'));
  assert.ok(text.includes("EXISTING_SECRET_PRESENT: ${{ secrets.FIREBASE_SERVICE_ACCOUNT_JSON != '' }}"));
  assert.equal((text.match(/credentials_json: \$\{\{ secrets\.FIREBASE_SERVICE_ACCOUNT_JSON \}\}/g) ?? []).length, 1);
  for (const line of ['persist-credentials: false', 'create_credentials_file: true', 'export_environment_variables: true', 'cleanup_credentials: true']) assert.ok(text.includes(line));
  assert.ok(!/pull_request|workflow_dispatch|schedule:|id-token|upload-artifact|cache:|token_format|access_token|id_token|always\(\)|continue-on-error/.test(text));
  assert.ok(!/firebase deploy|gcloud|--dry-run/.test(text));
});

test('version 1, known API booleans, identity counts and result summarize without secrets', async () => {
  const data = fixtures(functionData([
    account('builder-one'), undefined, 'projects/other/serviceAccounts/unsupported@other.iam.gserviceaccount.com',
    undefined, account('builder-one'),
  ]));
  data.hmac_version_metadata.name = `projects/${SCOPE.number}/secrets/FLOATING_GARDEN_INVITE_HMAC_KEY/versions/2`;
  const logs = [];
  const result = await runProbe({ request: responder(data), log: line => logs.push(line) });
  const inventory = result.records.find(item => item.stage === 'function_inventory');
  assert.equal(inventory.build_inventory_trusted, true);
  assert.equal(inventory.build_identity_fields_missing, 2);
  assert.equal(inventory.build_identity_fields_supported, 2);
  assert.equal(inventory.build_identity_fields_unsupported, 1);
  assert.equal(inventory.distinct_supported_build_accounts, 1);
  assert.equal(inventory.build_identity_compute_count, 0);
  assert.equal(inventory.build_identity_legacy_count, 0);
  assert.equal(inventory.build_identity_custom_count, 2);
  const version = result.records.find(item => item.stage === 'hmac_version_metadata');
  assert.equal(version.latest_is_original_version_1, false);
  assert.equal(version.same_secret_numeric_version, true);
  const apis = result.records.find(item => item.stage === 'enabled_apis');
  assert.equal(apis['cloudfunctions.googleapis.com'], true);
  for (const name of ['cloudbilling.googleapis.com', 'firebaseextensions.googleapis.com', 'firestore.googleapis.com', 'firebasehosting.googleapis.com']) assert.equal(apis[name], false);
  const permissions = FIXED_REQUESTS.find(item => item.stage === 'project_permissions').permissions;
  for (const name of ['firebase.projects.get', 'datastore.databases.getMetadata', 'firebasehosting.sites.update', 'cloudfunctions.operations.get', 'firebaserules.rulesets.get', 'firebaserules.rulesets.test', 'firebaserules.releases.create', 'datastore.entities.get', 'datastore.entities.list']) assert.ok(permissions.includes(name));
  assert.ok(!permissions.some(name => name.startsWith('firebasehosting.versions.')));
  assert.deepEqual(result.result, { logicalRequestCount: 12, successfulHttpCount: 12, failureCount: 0, rejectedResponseCount: 0, buildTests: 1, deploymentAuthorized: false, cloudWrites: 0 });
  assert.equal(logs.at(-1), `CI_ACCESS_RESULT ${JSON.stringify(result.result)}`);
  assert.ok(logs.includes('account_permission_tests describe_caller_only=true runtime_appspot_build_roles_not_inspected=true'));
  assert.ok(!logs.join('\n').includes('@'));
  assert.ok(!logs.join('\n').includes(marker));
});

test('reviewed SDK versions stay locked and auth replay is disabled', async () => {
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.packages['node_modules/google-auth-library'].version, '9.15.1');
  assert.equal(lock.packages['node_modules/gaxios'].version, '6.7.1');
  const source = await readFile(scriptUrl, 'utf8');
  assert.ok(source.includes('client.forceRefreshOnFailure = false'));
  assert.ok(source.includes('need(client instanceof JWT)'));
  assert.ok(source.includes('keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS'));
});

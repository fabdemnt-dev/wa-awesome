import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bootstrapAppCheck, makeMetadataRunner, validateKey, validateEnvironment, validateConfiguration, PROJECT, PROJECT_NUMBER, APP_ID, DOMAIN, DISPLAY_NAME, TOKEN_TTL, SCORE_THRESHOLD } from '../scripts/bootstrap-floating-garden-appcheck.mjs';
const path = fileURLToPath(new URL('../scripts/bootstrap-floating-garden-appcheck.mjs', import.meta.url));
const project = { projectId: PROJECT, projectNumber: PROJECT_NUMBER, lifecycleState: 'ACTIVE' };
const apis = ['recaptchaenterprise.googleapis.com', 'firebaseappcheck.googleapis.com', 'cloudresourcemanager.googleapis.com'].map((name) => ({ config: { name } }));
const key = () => ({ name: `projects/${PROJECT}/keys/synthetic-public-site-key`, displayName: DISPLAY_NAME, createTime: '2026-10-03T00:00:00Z', webSettings: { allowedDomains: [DOMAIN], integrationType: 'SCORE' } });
function harness(options = {}) {
  const commands = [], logs = [];
  const state = { keys: structuredClone(options.keys ?? []) };
  const run = (args) => {
    commands.push(args); options.before?.(args, state);
    if (options.fail?.(args, state)) throw Error('PRIVATE_RAW_FAILURE');
    if (options.raw?.(args) !== undefined) return options.raw(args);
    if (args[0] === 'config') return JSON.stringify(options.config ?? {});
    if (args[0] === 'projects') return JSON.stringify(options.project ?? project);
    if (args[0] === 'services') return JSON.stringify(options.apis ?? apis);
    assert.deepEqual(args.slice(0, 2), ['recaptcha', 'keys']);
    if (args[2] === 'list') return JSON.stringify(options.inventory ?? state.keys);
    if (args[2] === 'describe') return JSON.stringify(options.described ?? state.keys.find((k) => k.name.endsWith('/' + args[3])));
    if (args[2] === 'list-ip-overrides') return JSON.stringify(options.overrides ?? []);
    if (args[2] === 'create') { const created = options.created ?? key(); state.keys.push(created); return JSON.stringify(created); }
    throw Error('UNEXPECTED_COMMAND');
  };
  return { commands, logs, state, writes: () => commands.filter((a) => a[2] === 'create'), perform: (create = true) => bootstrapAppCheck({ create, run, log: (s) => logs.push(s), env: options.env ?? {}, execArgv: options.execArgv ?? [] }) };
}
test('scope is fixed to garden project, app, domain and documented App Check defaults', () => {
  assert.equal(PROJECT, 'wa-awesome-garden-stg'); assert.equal(PROJECT_NUMBER, '120030709276');
  assert.equal(APP_ID, '1:120030709276:web:015f4e996b7c42a4e801d9');
  assert.equal(DOMAIN, 'wa-awesome-garden-stg.web.app'); assert.equal(TOKEN_TTL, '3600s'); assert.equal(SCORE_THRESHOLD, 0.5);
});
test('default and plan run offline even without gcloud', () => {
  for (const args of [[], ['--plan']]) assert.match(execFileSync(process.execPath, [path, ...args], { env: { PATH: '' }, encoding: 'utf8' }), /plan only; no subprocess\/network/);
});
test('unknown/repeated/overriding flags fail before cloud access', () => {
  for (const args of [['--force'], ['--project=wa-awesome'], ['--inspect', '--inspect'], ['--create-approved-key', '--force'], ['--apply']]) assert.throws(() => execFileSync(process.execPath, [path, ...args], { env: { PATH: '' }, stdio: 'pipe' }));
});
test('inspect with no key has no mutations and does not claim Firebase success', () => {
  const h = harness(); assert.deepEqual(h.perform(false), { present: false, created: false }); assert.equal(h.writes().length, 0);
  assert.ok(h.logs.some((s) => s.includes('registration/enforcement and live attestation remain unverified')));
});
test('creation issues exactly one fixed SCORE request and verifies key metadata and IP overrides twice', () => {
  const h = harness(); assert.deepEqual(h.perform(), { present: true, created: true, siteKey: 'synthetic-public-site-key' });
  assert.deepEqual(h.writes(), [['recaptcha', 'keys', 'create', `--display-name=${DISPLAY_NAME}`, '--web', '--integration-type=score', `--domains=${DOMAIN}`]]);
  assert.equal(h.commands.filter((a) => a[2] === 'list').length, 3);
  assert.equal(h.commands.filter((a) => a[2] === 'list-ip-overrides').length, 2);
  assert.ok(h.logs.some((s) => s.startsWith('RECAPTCHA_METADATA_VERIFIED:')));
  assert.ok(h.logs.some((s) => s.includes('subdomains'))); assert.ok(h.logs.some((s) => s.startsWith('NOT_VERIFIED:')));
  assert.ok(!h.commands.some((a) => a.some((s) => /token|secret|delete|update|patch|deploy|login|enable|iam|testing|allow-all|limit|filter|page-size/.test(s) && s !== '--enabled')));
});
test('matching existing key is reused in both modes with no writes', () => {
  for (const create of [false, true]) { const h = harness({ keys: [key()] }); assert.equal(h.perform(create).created, false); assert.equal(h.writes().length, 0); }
});
test('key appearing before create is verified and reused without another key', () => {
  let n = 0; const h = harness({ before: (a, state) => { if (a[2] === 'list' && ++n === 2) state.keys.push(key()); } });
  assert.equal(h.perform().created, false); assert.equal(h.writes().length, 0);
});
test('duplicate or unrelated keys stop before mutation', () => {
  for (const keys of [[key(), key()], [{ ...key(), displayName: 'Other key' }], [{ ...key(), name: 'projects/foreign/keys/other' }]]) {
    const h = harness({ keys }); assert.throws(() => h.perform()); assert.equal(h.writes().length, 0);
  }
});
test('unknown project, wrong project number, inactive state and missing APIs stop', () => {
  for (const options of [{ project: { ...project, projectId: 'wa-awesome' } }, { project: { ...project, projectNumber: '99' } }, { project: { ...project, lifecycleState: 'DELETE_REQUESTED' } }, { apis: [] }, { apis: [{}] }]) {
    const h = harness(options); assert.throws(() => h.perform()); assert.equal(h.writes().length, 0);
  }
});
test('numeric project number and numeric resource project are semantically equivalent', () => {
  const k = key(); k.name = k.name.replace(PROJECT, PROJECT_NUMBER);
  const h = harness({ project: { ...project, projectNumber: Number(PROJECT_NUMBER) }, keys: [k] }); assert.equal(h.perform().present, true); assert.equal(h.writes().length, 0);
});
test('REST envelopes, invalid or malformed list are not mistaken for empty inventory', () => {
  for (const inventory of [{ keys: [], nextPageToken: 'more' }, {}, 'bad', [null], [{ name: 'invalid' }]]) {
    const h = harness({ inventory }); assert.throws(() => h.perform()); assert.equal(h.writes().length, 0);
  }
});
test('read failures and invalid JSON never cause creation or leak response content', () => {
  for (const stage of ['config', 'projects', 'services', 'recaptcha']) {
    const h = harness({ fail: (a) => a[0] === stage }); assert.throws(() => h.perform(), (e) => !e.message.includes('PRIVATE_RAW')); assert.equal(h.writes().length, 0);
  }
  const h = harness({ raw: () => 'PRIVATE_BAD_JSON' }); assert.throws(() => h.perform(), (e) => /invalid JSON/.test(e.message) && !e.message.includes('PRIVATE_BAD')); assert.equal(h.writes().length, 0);
});
test('domains must be the exact single listed hostname', () => {
  for (const domains of [[], ['localhost'], ['web.app'], [DOMAIN, 'localhost'], [DOMAIN, DOMAIN], ['https://' + DOMAIN], ['*.' + DOMAIN], [DOMAIN + '.evil']]) {
    const k = key(); k.webSettings.allowedDomains = domains; assert.throws(() => validateKey(k));
  }
});
test('checkbox, unspecified and future integration enums are rejected', () => {
  for (const integrationType of ['CHECKBOX', 'INVISIBLE', 'POLICY_BASED_CHALLENGE', 'INTEGRATION_TYPE_UNSPECIFIED', 'score', undefined]) {
    const k = key(); k.webSettings.integrationType = integrationType; assert.throws(() => validateKey(k));
  }
});
test('default false omission is accepted but true, null, strings and malformed booleans fail', () => {
  for (const property of ['allowAllDomains', 'allowAmpTraffic']) {
    const k = key(); k.webSettings[property] = false; validateKey(k);
    for (const value of [true, null, 'false', 'true', 0, 1, {}, []]) { k.webSettings[property] = value; assert.throws(() => validateKey(k)); }
  }
});
test('testing, WAF, other platforms, unknown fields and challenge settings fail closed', () => {
  for (const property of ['testingOptions', 'wafSettings', 'androidSettings', 'iosSettings', 'expressSettings', 'universalSettings', 'futureConfig']) {
    for (const value of [{}, null, false]) assert.throws(() => validateKey({ ...key(), [property]: value }));
  }
  for (const [property, value] of [['challengeSettings', {}], ['futureConfig', {}], ['challengeSecurityPreference', 'USABILITY'], ['challengeSecurityPreference', null]]) {
    const k = key(); k.webSettings[property] = value; assert.throws(() => validateKey(k));
  }
  const k = key(); k.webSettings.challengeSecurityPreference = 'CHALLENGE_SECURITY_PREFERENCE_UNSPECIFIED'; validateKey(k);
});
test('resource identity, labels, createTime and display name are strict', () => {
  for (const k of [null, [], { ...key(), displayName: 'Unknown' }, { ...key(), labels: { unknown: 'value' } }, { ...key(), labels: [] }, { ...key(), createTime: '1' }, { ...key(), createTime: null }, { ...key(), name: 'projects/wa-awesome/keys/other' }, { ...key(), name: key().name + '/nested' }]) assert.throws(() => validateKey(k));
  validateKey({ ...key(), labels: {} });
});
test('IP bypass inventory must be a successfully read empty array', () => {
  for (const overrides of [[{ ip: '192.0.2.1', overrideType: 'ALLOW' }], {}, null, 'unknown']) {
    const h = harness({ keys: [key()], raw: (a) => a[2] === 'list-ip-overrides' ? JSON.stringify(overrides) : undefined });
    assert.throws(() => h.perform()); assert.equal(h.writes().length, 0);
  }
  const h = harness({ keys: [key()], fail: (a) => a[2] === 'list-ip-overrides' }); assert.throws(() => h.perform()); assert.equal(h.writes().length, 0);
});
test('uncertain create is issued only once and gives partial-state warning without raw error', () => {
  const h = harness({ fail: (a) => a[2] === 'create' }); assert.throws(() => h.perform(), (e) => !e.message.includes('PRIVATE_RAW'));
  assert.equal(h.writes().length, 1); assert.ok(h.logs.some((s) => s.includes('DO_NOT_RECREATE'))); assert.ok(!h.logs.some((s) => s.startsWith('RECAPTCHA_METADATA_VERIFIED')));
});
test('invalid creation response leaves resource untouched and does not retry', () => {
  const h = harness({ created: { ...key(), testingOptions: { testingScore: 1 } } }); assert.throws(() => h.perform()); assert.equal(h.writes().length, 1);
  assert.ok(h.logs.some((s) => s.startsWith('PARTIAL_STATE'))); assert.equal(h.state.keys.length, 1);
});
test('concurrent duplicate creation is detected after write without deletion', () => {
  let n = 0; const h = harness({ before: (a, state) => { if (a[2] === 'list' && ++n === 3) state.keys.push({ ...key(), name: `projects/${PROJECT}/keys/second-key` }); } });
  assert.throws(() => h.perform(), /Multiple/); assert.equal(h.writes().length, 1); assert.equal(h.state.keys.length, 2);
});
test('disappearance, replacement or creation identity drift after write stops', () => {
  for (const mutate of [(state) => { state.keys = []; }, (state) => { state.keys[0].name += '-replacement'; }, (state) => { state.keys[0].createTime = '2026-10-03T01:00:00Z'; }]) {
    let n = 0; const h = harness({ before: (a, state) => { if (a[2] === 'list' && ++n === 3) mutate(state); } });
    assert.throws(() => h.perform()); assert.equal(h.writes().length, 1); assert.ok(!h.logs.some((s) => s.startsWith('RECAPTCHA_METADATA_VERIFIED')));
  }
});
test('metadata drift in final describe fails closed', () => {
  let n = 0; const h = harness({ keys: [key()], before: (a, state) => { if (a[2] === 'describe' && ++n === 2) state.keys[0].webSettings.allowAllDomains = true; } });
  assert.throws(() => h.perform()); assert.equal(h.writes().length, 0);
});
test('environment overrides stop before any subprocess and are never removed', () => {
  for (const env of [{ HTTPS_PROXY: 'https://unknown' }, { NODE_OPTIONS: '--require unknown' }, { NODE_DEBUG: 'child_process' }, { SSL_CERT_FILE: '/unknown' }, { CLOUDSDK_API_ENDPOINT_OVERRIDES_RECAPTCHA: 'https://unknown' }, { CLOUDSDK_AUTH_ACCESS_TOKEN: 'synthetic' }, { CLOUDSDK_AUTH_DISABLE_SSL_VALIDATION: 'true' }]) {
    const h = harness({ env }); assert.throws(() => h.perform()); assert.equal(h.commands.length, 0);
  }
  assert.throws(() => validateEnvironment({}, ['--inspect']));
});
test('configuration credential, proxy, authentication and TLS overrides fail', () => {
  for (const config of [null, [], { core: [] }, { auth: null }, { api_endpoint_overrides: 'unknown' }, { proxy: { address: 'unknown' } }, { auth: { access_token: 'synthetic' } }, { auth: { impersonate_service_account: 'unknown' } }, { core: { custom_ca_certs_file: '/unknown' } }, { core: { universe_domain: 'unknown' } }, { regional: { endpoint_mode: 'regional' } }, { api_endpoint_overrides: { recaptcha: 'https://unknown' } }, { auth: { token_host: 'https://unknown' } }]) assert.throws(() => validateConfiguration(config));
  validateConfiguration({ proxy: { rdns: 'true', address: null }, auth: { disable_credentials: 'false' }, regional: { endpoint_mode: 'global' } });
});
test('production adapter is fixed-project, does not feed prompts and suppresses credential-bearing diagnostics', () => {
  let calls = 0; const run = makeMetadataRunner({ env: {}, exec: (command, args, options) => {
    calls++; assert.equal(command, 'gcloud'); assert.ok(args.includes(`--project=${PROJECT}`)); assert.ok(args.includes(`--billing-project=${PROJECT}`));
    assert.ok(args.includes('--format=json')); assert.ok(!args.includes('--quiet')); assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(options.env.CLOUDSDK_CORE_DISABLE_PROMPTS, 'false'); assert.equal(options.env.CLOUDSDK_CORE_LOG_HTTP, 'false'); assert.equal(options.env.CLOUDSDK_CORE_DISABLE_FILE_LOGGING, 'true');
    throw Error('PRIVATE_DIAGNOSTIC');
  } });
  assert.throws(() => run(['recaptcha', 'keys', 'list']), (e) => !e.message.includes('PRIVATE_DIAGNOSTIC')); assert.equal(calls, 1);
});
test('post-write read failures never turn into success or another write', () => {
  const h = harness({ fail: (a) => a[2] === 'describe' }); assert.throws(() => h.perform()); assert.equal(h.writes().length, 1);
  assert.ok(h.logs.some((s) => s.startsWith('PARTIAL_STATE'))); assert.ok(!h.logs.some((s) => s.startsWith('RECAPTCHA_METADATA_VERIFIED')));
});
test('source and documentation preserve manual Firebase and live-attestation boundary', () => {
  const source = readFileSync(path, 'utf8');
  assert.ok(!source.includes('print-access-token')); assert.ok(!source.includes('fetch(')); assert.ok(!source.includes('https.request'));
  const doc = readFileSync(new URL('../docs/floating-garden-phone-appcheck.md', import.meta.url), 'utf8');
  const inspectAt = doc.indexOf('保存や入力をする前に、登録済みかを確認する');
  const registerAt = doc.indexOf('4. reCAPTCHA Enterpriseを選び');
  assert.ok(inspectAt >= 0 && registerAt >= 0 && inspectAt < registerAt);
  assert.ok(doc.includes('以下の登録・保存は、未登録と確認できた上記Web Appだけ'));
  const workflow = readFileSync(new URL('../.github/workflows/floating-garden-trial-prep-tests.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes("'docs/floating-garden-phone-appcheck.md'"));
  for (const phrase of ['1:120030709276:web:015f4e996b7c42a4e801d9', '0.5', '1時間', 'Firestore', 'subdomain', '実機', 'REVIEWED_SHA256']) assert.ok(doc.includes(phrase));
});

#!/usr/bin/env node
// User-operated reCAPTCHA metadata helper. Firebase App Check is configured in Console.
// No token extraction, secret access, IAM/API changes, deployment or attestation.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const PROJECT = 'wa-awesome-garden-stg';
export const PROJECT_NUMBER = '120030709276';
export const APP_ID = '1:120030709276:web:015f4e996b7c42a4e801d9';
export const DOMAIN = 'wa-awesome-garden-stg.web.app';
export const DISPLAY_NAME = 'Garden trial App Check';
export const TOKEN_TTL = '3600s';
export const SCORE_THRESHOLD = 0.5;
class SafeStop extends Error {}
const stop = (message) => { throw new SafeStop(message); };
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const present = (value) => value !== undefined && value !== null && value !== '';
const enabled = (value) => value === true || ['true', '1'].includes(String(value).toLowerCase());
export function validateEnvironment(env, execArgv = process.execArgv) {
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'NODE_OPTIONS', 'NODE_V8_COVERAGE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']) if (present(env[key])) stop('Environment has proxy, debug, Node or TLS overrides. Stop without bypassing them.');
  if (execArgv.some((arg) => /inspect|trace|heap|prof|report|require|import/i.test(arg))) stop('Node inspection/diagnostic/injection options are not allowed.');
  for (const [key, value] of Object.entries(env)) if (present(value) && (key.startsWith('CLOUDSDK_API_ENDPOINT_OVERRIDES_') || /^CLOUDSDK_AUTH_(ACCESS_TOKEN|ACCESS_TOKEN_FILE|CREDENTIAL_FILE_OVERRIDE|IMPERSONATE_SERVICE_ACCOUNT|TOKEN_HOST|AUTH_HOST)$/.test(key))) stop('Environment has credential or API route overrides. Stop without changing them.');
  for (const key of ['CLOUDSDK_AUTH_DISABLE_CREDENTIALS', 'CLOUDSDK_AUTH_DISABLE_SSL_VALIDATION', 'CLOUDSDK_CORE_DISABLE_SSL_VALIDATION']) if (enabled(env[key])) stop('Environment weakens authentication or TLS.');
}
export function validateConfiguration(config) {
  if (!plain(config)) stop('Could not verify existing gcloud configuration.');
  for (const section of ['core', 'auth', 'proxy', 'regional', 'api_endpoint_overrides']) if (config[section] !== undefined && !plain(config[section])) stop('Malformed gcloud configuration section.');
  if (Object.values(config.api_endpoint_overrides ?? {}).some(present) || ['type', 'address', 'port', 'username', 'password'].some((key) => present(config.proxy?.[key]))) stop('Custom API endpoint or proxy configuration. Stop without bypassing it.');
  for (const key of ['impersonate_service_account', 'credential_file_override', 'access_token_file', 'access_token']) if (present(config.auth?.[key])) stop('Credential or impersonation override.');
  if (enabled(config.auth?.disable_credentials) || enabled(config.auth?.disable_ssl_validation) || enabled(config.core?.disable_ssl_validation) || present(config.core?.custom_ca_certs_file)) stop('Authentication/TLS configuration is not the reviewed default.');
  if (present(config.auth?.token_host) && !['https://oauth2.googleapis.com/token', 'https://accounts.google.com/o/oauth2/token'].includes(config.auth.token_host)) stop('Nonstandard token endpoint.');
  if (present(config.auth?.auth_host) && !['https://accounts.google.com/o/oauth2/auth', 'https://accounts.google.com/o/oauth2/v2/auth'].includes(config.auth.auth_host)) stop('Nonstandard authentication endpoint.');
  if (present(config.core?.universe_domain) && config.core.universe_domain !== 'googleapis.com') stop('Nonstandard cloud universe.');
  if (present(config.regional?.endpoint_mode) && config.regional.endpoint_mode !== 'global') stop('Regional endpoint override is not allowed for this global key.');
}
function keyId(name) {
  if (typeof name !== 'string') stop('reCAPTCHA resource name is missing.');
  const match = name.match(/^projects\/([^/]+)\/keys\/([A-Za-z0-9_-]+)$/);
  if (!match || ![PROJECT, PROJECT_NUMBER].includes(match[1])) stop('reCAPTCHA key belongs to an unexpected project or has an invalid name.');
  return match[2];
}
export function validateKey(key) {
  if (!plain(key)) stop('Invalid reCAPTCHA key metadata.');
  const id = keyId(key.name);
  const allowed = ['name', 'displayName', 'webSettings', 'labels', 'createTime'];
  if (Object.keys(key).some((k) => !allowed.includes(k))) stop('Key contains unreviewed, testing, WAF or non-web settings. No automatic repair.');
  if (key.displayName !== DISPLAY_NAME || typeof key.createTime !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(key.createTime) || !Number.isFinite(Date.parse(key.createTime))) stop('Key display name or creation identity does not match.');
  if (key.labels !== undefined && (!plain(key.labels) || Object.keys(key.labels).length)) stop('Unapproved key labels.');
  const web = key.webSettings;
  if (!plain(web) || Object.keys(web).some((k) => !['integrationType', 'allowedDomains', 'allowAllDomains', 'allowAmpTraffic', 'challengeSecurityPreference'].includes(k))) stop('Unreviewed web settings.');
  if (web.integrationType !== 'SCORE' || !Array.isArray(web.allowedDomains) || web.allowedDomains.length !== 1 || web.allowedDomains[0] !== DOMAIN) stop('Key must be SCORE with exactly the approved listed domain.');
  // Protobuf JSON omits false/default fields. Omitted is the documented false default.
  for (const k of ['allowAllDomains', 'allowAmpTraffic']) if (web[k] !== undefined && web[k] !== false) stop('All-domain bypass or AMP is enabled/uncertain.');
  if (web.challengeSecurityPreference !== undefined && web.challengeSecurityPreference !== 'CHALLENGE_SECURITY_PREFERENCE_UNSPECIFIED') stop('Unexpected challenge security configuration for a SCORE key.');
  return { id, creation: key.createTime };
}
export function makeMetadataRunner({ exec = execFileSync, env = process.env } = {}) {
  return (args) => {
    try { return exec('gcloud', [...args, `--project=${PROJECT}`, `--billing-project=${PROJECT}`, '--format=json', '--verbosity=error'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024, timeout: 5 * 60 * 1000,
      env: { ...env, CLOUDSDK_CORE_DISABLE_PROMPTS: 'false', CLOUDSDK_CORE_LOG_HTTP: 'false', CLOUDSDK_CORE_DISABLE_FILE_LOGGING: 'true', NO_COLOR: '1' } }); }
    catch { stop('gcloud failed or timed out; raw diagnostics suppressed. Do not repeat creation. Inspect metadata before deciding what happened.'); }
  };
}
export function bootstrapAppCheck({ create = false, run = makeMetadataRunner(), log = console.log, env = process.env, execArgv = process.execArgv } = {}) {
  let issued = false;
  try {
    if (Number(process.versions.node.split('.')[0]) < 20 || typeof create !== 'boolean') stop('Node 20+ and a valid mode are required.');
    validateEnvironment(env, execArgv);
    const read = (args, stage) => {
      let raw;
      try { raw = run(args); } catch { stop(`${stage}: command failed or result uncertain. Raw diagnostics suppressed.`); }
      try { return JSON.parse(raw); } catch { stop(`${stage}: invalid JSON response. Raw response suppressed.`); }
    };
    validateConfiguration(read(['config', 'list', '--all'], 'Configuration'));
    const p = read(['projects', 'describe', PROJECT], 'Project');
    if (!plain(p) || p.projectId !== PROJECT || String(p.projectNumber) !== PROJECT_NUMBER || p.lifecycleState !== 'ACTIVE') stop('Exact active project ID/number was not verified.');
    log(`PROJECT_OK: ${PROJECT} / ${PROJECT_NUMBER}`);
    const apis = read(['services', 'list', '--enabled'], 'API inventory');
    if (!Array.isArray(apis) || apis.some((a) => !plain(a) || !plain(a.config) || typeof a.config.name !== 'string') || !['recaptchaenterprise.googleapis.com', 'firebaseappcheck.googleapis.com', 'cloudresourcemanager.googleapis.com'].every((name) => apis.some((a) => a.config.name === name))) stop('Required APIs are not already enabled. This helper enables none.');
    const inventory = () => {
      // No filter, limit or page-size override: gcloud follows every list page.
      const keys = read(['recaptcha', 'keys', 'list'], 'Key inventory');
      if (!Array.isArray(keys) || keys.some((k) => !plain(k))) stop('Invalid complete key inventory. Absence is not established.');
      for (const key of keys) keyId(key.name);
      if (keys.length > 1) stop('Multiple/duplicate keys in this dedicated project. Stop for review; do not select, delete or create another.');
      return keys.length ? keys[0] : null;
    };
    const describe = (key) => {
      const expected = validateKey(key);
      const result = validateKey(read(['recaptcha', 'keys', 'describe', expected.id], 'Key readback'));
      if (expected.id !== result.id || expected.creation !== result.creation) stop('Key identity changed during inspection.');
      const overrides = read(['recaptcha', 'keys', 'list-ip-overrides', expected.id], 'IP override inventory');
      if (!Array.isArray(overrides) || overrides.length) stop('IP override inventory is invalid or nonempty. No override bypass is accepted.');
      return result;
    };
    let existing = inventory();
    if (!existing) {
      log('RECAPTCHA_KEY_ABSENT: successful complete project inventory has no key.');
      if (!create) { log('INSPECT_COMPLETE: no changes; Firebase registration/enforcement and live attestation remain unverified.'); return { present: false, created: false }; }
      // This check narrows a race but cannot provide a lock or idempotency token.
      // reCAPTCHA allocates the ID; concurrent creation can still make duplicates.
      existing = inventory();
      if (!existing) {
        log(`WRITE_ONCE: create SCORE web key with listed domain ${DOMAIN}; no testing options.`);
        issued = true;
        existing = read(['recaptcha', 'keys', 'create', `--display-name=${DISPLAY_NAME}`, '--web', '--integration-type=score', `--domains=${DOMAIN}`], 'Create key');
        validateKey(existing);
      } else { log('KEY_APPEARED: verifying without creation.'); }
    }
    const verified = describe(existing);
    const final = inventory();
    if (!final) stop('Key disappeared during inspection.');
    const finalIdentity = describe(final);
    if (verified.id !== finalIdentity.id || verified.creation !== finalIdentity.creation) stop('Key was replaced during inspection.');
    log(`RECAPTCHA_METADATA_VERIFIED: listed-domain=${DOMAIN}; SCORE; domain validation enabled; no testing options or IP overrides.`);
    log(`PUBLIC_SITE_KEY: ${verified.id}`);
    log(`CONSOLE_NEXT: verify Web App ${APP_ID}; reCAPTCHA Enterprise; threshold ${SCORE_THRESHOLD}; TTL ${TOKEN_TTL}; project Firestore enforcement.`);
    log('LIMIT: reCAPTCHA permits subdomains of the listed domain. Exact client/backend Origin guards remain required.');
    log('NOT_VERIFIED: Firebase provider registration, Firestore enforcement, debug-token inventory, billing tier/usage and real-device attestation.');
    return { present: true, created: issued, siteKey: verified.id };
  } catch (error) {
    if (issued) log('PARTIAL_STATE: create was issued; the key may exist. DO_NOT_RECREATE. Inspect only; no automatic retry, delete or rollback.');
    if (error instanceof SafeStop) throw error;
    stop('Unexpected metadata validation failure. Raw diagnostics suppressed; stop for review.');
  }
}
export function plan(log = console.log) {
  log(`Garden App Check stage 4: plan only; no subprocess/network. Project ${PROJECT} / ${PROJECT_NUMBER}.`);
  log(`User-only --inspect reads metadata. --create-approved-key requests at most one SCORE web key for listed domain ${DOMAIN}; existing exact key is reused.`);
  log(`Firebase Console: exact Web App ${APP_ID}, reCAPTCHA Enterprise, threshold ${SCORE_THRESHOLD}, TTL ${TOKEN_TTL}, project-wide Firestore enforcement.`);
  log('No token extraction, secret, IAM/API changes, debug bypass, Firebase write, deployment, tester enrollment or trial start. Live attestation remains a separate stage.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.length || args.length === 1 && args[0] === '--plan') plan();
  else if (args.length === 1 && ['--inspect', '--create-approved-key'].includes(args[0])) {
    try { bootstrapAppCheck({ create: args[0] === '--create-approved-key' }); }
    catch (error) { console.error(`STOP: ${error.message}`); process.exitCode = 1; }
  } else { console.error('STOP: use --plan, --inspect or --create-approved-key only.'); process.exitCode = 1; }
}

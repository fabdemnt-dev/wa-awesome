#!/usr/bin/env node
// USER-operated Cloud Shell stage 1. No login, token handling, install or deploy.
// Default mode is a local plan. Mutations require the exact, explicit apply flag.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT = 'wa-awesome-garden-stg';
export const PROJECT_NUMBER = '120030709276';
export const REGION = 'asia-northeast1';
export const APPROVED_APIS = Object.freeze([
  'cloudfunctions.googleapis.com', 'cloudbuild.googleapis.com',
  'artifactregistry.googleapis.com', 'run.googleapis.com',
  'eventarc.googleapis.com', 'pubsub.googleapis.com', 'storage.googleapis.com',
  'secretmanager.googleapis.com', 'iam.googleapis.com',
  'firebaseappcheck.googleapis.com', 'recaptchaenterprise.googleapis.com',
  'firebaserules.googleapis.com', 'logging.googleapis.com',
]);
const stop = (message) => { throw new Error(message); };
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function json(raw, stage) {
  let value;
  try { value = JSON.parse(raw); } catch { stop(`${stage}: response was not JSON; stop and inspect, without rerunning changes.`); }
  return value;
}
export function parseServices(raw) {
  const values = raw.trim() ? raw.trim().split(/\s+/) : [];
  if (values.some((v) => !/^[a-z][a-z0-9-]*\.googleapis\.com$/.test(v)) || new Set(values).size !== values.length) stop('Unexpected enabled-service inventory. No further changes.');
  return new Set(values);
}
export function parseBuildAccount(value) {
  if (!plain(value) || ![PROJECT, PROJECT_NUMBER].some((p) => value.name === `projects/${p}/locations/${REGION}/defaultServiceAccount`)) stop('Default build resource identity was not verified. No build permissions changed.');
  const match = typeof value.serviceAccountEmail === 'string' && value.serviceAccountEmail.match(/^projects\/([^/]+)\/serviceAccounts\/([^/]+)$/);
  if (!match || ![PROJECT, PROJECT_NUMBER].includes(match[1])) stop('Default build account is empty or unrecognized. Do not guess an account or start a build.');
  const email = match[2];
  const allowed = email === `${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com` || email === `${PROJECT_NUMBER}-compute@developer.gserviceaccount.com` || new RegExp(`^[a-z][a-z0-9-]{4,28}[a-z0-9]@${PROJECT}\\.iam\\.gserviceaccount\\.com$`).test(email);
  if (!allowed) stop('Default build account does not belong to the exact garden project. No build permissions changed.');
  return email;
}
export function selectBindings(policy, email) {
  if (!plain(policy) || policy.bindings !== undefined && !Array.isArray(policy.bindings)) stop('Unexpected project IAM response. No IAM was changed.');
  const selected = [];
  for (const binding of policy.bindings ?? []) {
    if (!plain(binding) || typeof binding.role !== 'string' || !Array.isArray(binding.members) || binding.members.some((m) => typeof m !== 'string')) stop('Malformed IAM binding. No IAM was changed.');
    if (binding.role.includes('_withcond_')) stop('IAM conditions were hidden by a legacy response. Stop instead of treating them as unconditional.');
    if (binding.members.includes(`serviceAccount:${email}`)) {
      if (binding.condition !== undefined && (!plain(binding.condition) || typeof binding.condition.expression !== 'string')) stop('Malformed IAM condition. No IAM was changed.');
      selected.push({ role: binding.role, condition: binding.condition ?? null });
    }
  }
  return selected;
}
export function validateConfiguration(config) {
  if (!plain(config)) stop('Could not verify the existing gcloud configuration. No cloud changes.');
  if (Object.values(config.api_endpoint_overrides ?? {}).some((v) => v != null && v !== '')) stop('Custom API endpoint override detected. Stop; do not change or bypass it automatically.');
  for (const key of ['impersonate_service_account', 'credential_file_override', 'access_token_file', 'access_token']) {
    if (config.auth?.[key]) stop('Credential or impersonation override detected. Use the reviewed existing user session; do not change authentication automatically.');
  }
  if (config.core?.universe_domain && config.core.universe_domain !== 'googleapis.com') stop('Nonstandard Google Cloud universe detected. No changes.');
}
function reportChanges(before, after, log) {
  const added = [...after].filter((api) => !before.has(api)).sort();
  const dependencies = added.filter((api) => !APPROVED_APIS.includes(api));
  log(`APIS_NEWLY_OBSERVED_ENABLED: ${added.length ? added.join(',') : 'none'}`);
  log(`ADDITIONAL_API_NAMES: ${dependencies.length ? dependencies.join(',') : 'none'}`);
  if (dependencies.length) log('ADDITION_SCOPE: stable Google enablement may add required dependencies; concurrent changes cannot be distinguished from this inventory. No extra API name was manually selected.');
  return { added, dependencies };
}
function defaultRun(args) {
  // No shell, stdin, token printing, HTTP logging or inherited command output.
  // Stop on errors instead of echoing gcloud diagnostics or automatically retrying.
  try {
    return execFileSync('gcloud', [...args, `--project=${PROJECT}`, `--billing-project=${PROJECT}`, '--verbosity=error'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
      env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: 'false', CLOUDSDK_CORE_LOG_HTTP: 'false', CLOUDSDK_CORE_DISABLE_FILE_LOGGING: 'true', NO_COLOR: '1' },
    });
  } catch { stop(`gcloud ${args.slice(0, 3).join(' ')} failed or timed out. Earlier changes may have succeeded. Do not rerun apply; use --inspect and report only the short STOP line. No explicit login or IAM-grant command was issued.`); }
}
export async function bootstrapApis({ apply = false, run = defaultRun, log = console.log, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 20) stop('Node 20 or newer is required; nothing changed.');
  if (typeof apply !== 'boolean') stop('Invalid apply mode');
  validateConfiguration(json(run(['config', 'list', '--all', '--format=json']), 'Configuration read'));
  const identity = json(run(['projects', 'describe', PROJECT, '--format=json(projectId,projectNumber,lifecycleState)']), 'Project read');
  if (!plain(identity) || identity.projectId !== PROJECT || String(identity.projectNumber) !== PROJECT_NUMBER || identity.lifecycleState !== 'ACTIVE') stop('Exact active project ID/number was not verified. Nothing was changed.');
  log(`PROJECT_OK: ${PROJECT} / ${PROJECT_NUMBER}`);
  const list = () => parseServices(run(['services', 'list', '--enabled', '--format=value(config.name)']));
  const before = list();
  log(`ENABLED_APIS_BASELINE: ${[...before].sort().join(',') || 'none'}`);
  const missing = APPROVED_APIS.filter((api) => !before.has(api));
  log(`APPROVED_APIS_MISSING: ${missing.length ? missing.join(',') : 'none'}`);
  let after = before;
  if (apply && missing.length) {
    log('ENABLING_ONCE: requesting only the missing approved names. Google-required dependency APIs and managed service identities may also be enabled. This may take a few minutes.');
    try { run(['services', 'enable', ...missing, '--format=json']); }
    catch (error) {
      log('API_CALL_RESULT_UNKNOWN: changes may have succeeded. Only one diagnostic read follows; no mutation retry.');
      try { reportChanges(before, list(), log); } catch { log('API_READBACK_UNAVAILABLE: keep the baseline above for read-only comparison.'); }
      throw error;
    }
    // Only successful enablement followed by read-only propagation checks.
    // A failed write is never retried. No service-identity or IAM write is made.
    for (let attempt = 0; attempt <= 12; attempt++) {
      try { after = list(); } catch (error) { log('API_READBACK_UNAVAILABLE: enablement returned successfully; keep the baseline above and inspect later.'); throw error; }
      // The approved request also permits mandatory Google-managed dependencies.
      // Extra names are observed additions, not proof of cause or necessity.
      // Never issue a second enable call selecting these extra names.
      if (APPROVED_APIS.every((api) => after.has(api))) break;
      if (attempt === 12) { reportChanges(before, after, log); stop('API enable command returned, but readback is incomplete. Do not rerun apply; use --inspect later.'); }
      await sleep(10000);
    }
  }
  const { added, dependencies } = reportChanges(before, after, log);
  const remaining = APPROVED_APIS.filter((api) => !after.has(api));
  log(`APPROVED_APIS_ENABLED: ${APPROVED_APIS.length - remaining.length}/${APPROVED_APIS.length}`);
  if (!after.has('cloudbuild.googleapis.com')) {
    log('BUILD_ACCOUNT_PENDING: Cloud Build is disabled; no account was guessed.');
    return { complete: false, remaining, buildAccount: null, added, dependencies };
  }
  const build = parseBuildAccount(json(run(['builds', 'get-default-service-account', `--region=${REGION}`, '--format=json']), 'Build account read'));
  const bindings = selectBindings(json(run(['projects', 'get-iam-policy', PROJECT, '--format=json']), 'Project IAM read'), build);
  log(`ACTUAL_BUILD_ACCOUNT: ${build}`);
  log(`BUILD_PROJECT_BINDINGS: ${JSON.stringify(bindings)}`);
  log('BUILD_IAM_SCOPE: direct project bindings only; inherited/group/resource-level access is not audited. No build permissions changed.');
  log(remaining.length ? 'INSPECT_COMPLETE: some approved APIs are still disabled. No changes in inspect mode.' : 'API_STAGE_VERIFIED: all 13 approved APIs are enabled and the actual default build account was read.');
  log('STOP_HERE: runtime, HMAC, App Check, game deployment and trial start are separate stages. Share only these summary lines, never credentials or debug logs.');
  return { complete: remaining.length === 0, remaining, buildAccount: build, bindings, added, dependencies };
}
export const PLAN = `Target: ${PROJECT} / ${PROJECT_NUMBER}\nUser Cloud Shell only. Uses existing gcloud authentication; never starts login.\nStage 1 changes: request missing services from this fixed list once, including their mandatory automatically enabled Google dependencies:\n${APPROVED_APIS.join('\n')}\nMandatory dependency APIs and Google-managed identities/standard service-agent roles can be incidental to enablement. Exact added API names are reported after reading back. No explicit IAM or build-account grant is made.\nThen read the actual Tokyo default build identity and its direct project IAM bindings.\nNo runtime creation, key generation, secret access, App Check settings, Hosting/Rules/Functions deployment or 7-day timer.\nRead only: node garden-bootstrap-apis.mjs --inspect\nApproved user operation: node garden-bootstrap-apis.mjs --enable-approved-apis-and-required-dependencies\nIf any step stops, do not rerun apply. Inspect read-only and ask for review.\nUnexpected terms, permissions, unrelated API requests or unverified results require review before continuing.`;
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.length || args.length === 1 && args[0] === '--plan') console.log(PLAN);
  else if (args.length === 1 && ['--inspect', '--enable-approved-apis-and-required-dependencies'].includes(args[0])) {
    try { await bootstrapApis({ apply: args[0] === '--enable-approved-apis-and-required-dependencies' }); }
    catch (error) { console.error(`STOP: ${error.message}`); process.exitCode = 1; }
  } else { console.error('STOP: use --plan, --inspect, or --enable-approved-apis-and-required-dependencies only.'); process.exitCode = 1; }
}

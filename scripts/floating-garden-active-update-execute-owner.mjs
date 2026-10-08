#!/usr/bin/env node
// One-shot owner execution for the explicitly approved first-NPC update.
// This is separate from the read-only inspector, which remains unchanged.
// No install/login, credential/IAM change, room creation, retry or rollback.
import { mkdir, lstat, realpath, readFile, open, writeFile } from 'node:fs/promises';
import { resolve, join, dirname, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const INSPECTION_ENTRY_COMMIT = '4f8de18a01572cf338baa421b3a3841e4f41d7e9';
export const INSPECTION_ENTRY_SHA256 = '96577b1c372a599d934ae18d7a0f528f3f923beef61b33f14a3e1bea77c02b54';
export const EXECUTION_SOURCE_COMMIT = 'b7dd16da4fdbb19e401423beb42a3da5c49e75d1';
export const EXECUTION_PREPARATION_NAME = 'garden-active-update-41c44301490e-iam-read-v2';
export const EXECUTION_GUARD_NAME = 'garden-active-update-41c44301490e-execute-v1';
const START = 1791157551472, END = 1791762351472, MAX_BYTES = 4 * 1024 * 1024;
const INSPECTOR_URL = `https://raw.githubusercontent.com/fabdemnt-dev/wa-awesome/${INSPECTION_ENTRY_COMMIT}/scripts/floating-garden-active-update-owner.mjs`;
const HEX = /^[a-f0-9]{64}$/;
const STAGES = new Set(['owner-paths', 'one-shot-guard', 'inspector-download', 'local-verification', 'baseline-read', 'approval-binding', 'journal', 'apply']);
const need = value => { if (!value) throw Error('Owner execution stopped.'); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function directory(path, privateMode = false) {
  need(typeof path === 'string' && path === resolve(path));
  let current = sep;
  for (const part of path.split(sep).filter(Boolean)) {
    current = join(current, part); const info = await lstat(current);
    need(info.isDirectory() && !info.isSymbolicLink());
  }
  need(await realpath(path) === path && (!privateMode || ((await lstat(path)).mode & 0o077) === 0));
}
async function privateFile(path, limit = MAX_BYTES) {
  await directory(dirname(path), true); const info = await lstat(path);
  need(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= limit && (info.mode & 0o077) === 0);
  return readFile(path);
}
async function syncDirectory(path) {
  const file = await open(path, 'r'); try { await file.sync(); } finally { await file.close(); }
}
async function durableExclusive(path, value) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); } finally { await file.close(); }
  await syncDirectory(dirname(path));
}
function environment(env, execArgv) {
  need(Number(process.versions.node.split('.')[0]) >= 20);
  need(!execArgv.some(value => /inspect|trace|heap|prof|report|require|import/i.test(value)));
  const present = value => value !== undefined && value !== null && value !== '';
  const enabled = value => value === true || ['true', '1'].includes(String(value).toLowerCase());
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
    'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'NODE_OPTIONS', 'NODE_V8_COVERAGE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'GOOGLE_APPLICATION_CREDENTIALS',
    'GCLOUD_ACCESS_TOKEN', 'GOOGLE_OAUTH_ACCESS_TOKEN', 'DEBUG', 'GRPC_TRACE', 'GRPC_VERBOSITY', 'GOOGLE_SDK_NODE_LOGGING']) need(!present(env[key]));
  for (const [key, value] of Object.entries(env)) if (present(value)) {
    need(!/^npm_config_(?:proxy|http_proxy|https_proxy|noproxy|cafile|ca|cert|key|strict_ssl|registry|userconfig|globalconfig|node_options|_auth|_authToken)$/i.test(key));
    need(!key.startsWith('CLOUDSDK_API_ENDPOINT_OVERRIDES_') && !key.startsWith('FIREBASE_') && !/_EMULATOR_HOST$/.test(key) &&
      !/^GOOGLE_(API_USE|CLOUD_UNIVERSE_DOMAIN)/.test(key) &&
      !/^CLOUDSDK_AUTH_(ACCESS_TOKEN|ACCESS_TOKEN_FILE|CREDENTIAL_FILE_OVERRIDE|IMPERSONATE_SERVICE_ACCOUNT|TOKEN_HOST|AUTH_HOST)$/.test(key));
  }
  for (const key of ['CLOUDSDK_AUTH_DISABLE_CREDENTIALS', 'CLOUDSDK_AUTH_DISABLE_SSL_VALIDATION', 'CLOUDSDK_CORE_DISABLE_SSL_VALIDATION']) need(!enabled(env[key]));
}
async function downloadInspector(path, fetchImpl) {
  const response = await fetchImpl(INSPECTOR_URL, { redirect: 'error', credentials: 'omit', cache: 'no-store',
    headers: { Accept: 'application/octet-stream' }, signal: AbortSignal.timeout(30000) });
  need(response.status === 200 && response.url === INSPECTOR_URL && response.redirected !== true && response.body?.getReader);
  const length = response.headers.get('content-length');
  if (length !== null) need(/^[0-9]+$/.test(length) && Number(length) <= MAX_BYTES);
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; need(size <= MAX_BYTES); chunks.push(Buffer.from(item.value)); }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const bytes = Buffer.concat(chunks); need(hash(bytes) === INSPECTION_ENTRY_SHA256);
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  need(hash(await privateFile(path)) === INSPECTION_ENTRY_SHA256);
}
function approvedBaseline(value) {
  // The approved scope is the existing two rooms and cumulative usage of two.
  // Legitimate moves may have added receipts since the earlier inspection;
  // all current records are freshly snapshotted and preserved by the provider.
  need(value?.kind === 'baseline' && HEX.test(value.fingerprint) && value.createdRoomCount === 2 && value.roomCount === 2 &&
    Number.isSafeInteger(value.documentCount) && value.documentCount >= 4 && value.documentCount <= 10000);
  return value;
}
function safeOutcome(value, plan) {
  if (value?.status === 'active-updated') {
    need(value.access === 'open' && value.preservedTesterCount === 2 && value.endsAtMillis === END && value.usageWritten === false);
    return { status: 'active-updated', access: 'open', preservedTesterCount: 2, endsAtMillis: END, maxRooms: 20,
      usageWritten: false, automaticRetry: false, automaticRollback: false,
      oldManifestDigest: plan.oldManifestDigest, newManifestDigest: plan.newManifestDigest };
  }
  need(value?.status === 'blocked' && plan.phases.includes(value.stage) && /^[a-z][a-z-]{0,63}$/.test(value.reason) &&
    ['open', 'closed', 'unknown'].includes(value.access));
  return { status: 'blocked', stage: value.stage, reason: value.reason, access: value.access,
    ...(typeof value.providerStage === 'string' && /^[a-z][a-z-]{0,63}$/.test(value.providerStage) ? { providerStage: value.providerStage } : {}),
    ...(Number.isInteger(value.completedFunctionCount) && value.completedFunctionCount >= 0 && value.completedFunctionCount <= 5
      ? { completedFunctionCount: value.completedFunctionCount } : {}), automaticRetry: false, automaticRollback: false };
}

/** Test-only capability injection is not reachable through CLI flags. Native
 * execution always uses the existing owner home, HTTPS and pinned provider. */
export async function executeOwnerActiveUpdate({ approved = false, playersStopped = false, exclusiveMaintenance = false, home = homedir(), fetchImpl = fetch,
  env = process.env, execArgv = process.execArgv, now = Date.now, log = console.log, createProvider } = {}) {
  let stage = 'owner-paths', active, cloud, plan, journal, applyStarted = false;
  const stopped = (reason = 'unclassified', access = 'unknown') => ({ status: 'blocked', stage: STAGES.has(stage) ? stage : 'owner-paths',
    reason, access, cloudChangesAttempted: applyStarted, automaticRetry: false, automaticRollback: false });
  try {
    need(approved === true && playersStopped === true && exclusiveMaintenance === true); environment(env, execArgv); await directory(home);
    const clock = now(); need(Number.isSafeInteger(clock) && clock >= START && clock < END);
    const prepared = join(home, EXECUTION_PREPARATION_NAME), source = join(prepared, 'source');
    await directory(prepared, true); await privateFile(join(prepared, 'PREPARATION.json'), 16384);
    const guard = join(home, EXECUTION_GUARD_NAME);
    stage = 'one-shot-guard';
    // Exclusive mkdir is the cross-process admission guard. Never remove,
    // overwrite or reuse it, even after a read/download failure or interruption.
    await mkdir(guard, { mode: 0o700 }); await syncDirectory(home);
    await durableExclusive(join(guard, 'EXECUTION.json'), { schemaVersion: 1, sourceCommit: EXECUTION_SOURCE_COMMIT,
      preparation: EXECUTION_PREPARATION_NAME, createdAtMillis: clock, automaticRetry: false });
    const inspectorPath = join(guard, 'read-only-owner.mjs');
    stage = 'inspector-download'; await downloadInspector(inspectorPath, fetchImpl);
    stage = 'local-verification'; const owner = await import(pathToFileURL(inspectorPath).href);
    need(owner.OWNER_SOURCE_COMMIT === EXECUTION_SOURCE_COMMIT && owner.OWNER_PREPARATION_NAME === EXECUTION_PREPARATION_NAME);
    let options, constructions = 0;
    const captureProvider = input => {
      need(++constructions === 1); options = input; plan = input.plan;
      // The pinned inspector has verified its complete source/import closure
      // before reaching this factory. Initialization is lazy and read-only.
      return { inspect: async () => {
        active = await import(pathToFileURL(join(source, 'scripts/floating-garden-active-update.mjs')).href);
        const provider = await import(pathToFileURL(join(source, 'scripts/floating-garden-active-update-provider.mjs')).href);
        const actual = (createProvider ?? provider.createActiveUpdateProvider)(input);
        cloud = Object.freeze({ ...actual, inspect: async () => {
          const value = await actual.inspect();
          if (value?.createdRoomCount !== 2 || value?.roomCount !== 2) throw active.activeUpdateFailure('admin-state');
          return approvedBaseline(value);
        } });
        return cloud.inspect();
      } };
    };
    stage = 'baseline-read'; log('UPDATE_PROGRESS: read-only-baseline');
    const baseline = await owner.inspectOwnerActiveUpdate({ home, env, execArgv, now,
      // Execution never repairs or generates a preparation and never downloads
      // its 64 source files. An absent/partial cache fails closed.
      fetchImpl: async () => { throw Error('Existing preparation required.'); }, log: () => {}, createProvider: captureProvider });
    if (baseline.status === 'blocked') {
      const outcome = stopped(/^[a-z][a-z-]{0,63}$/.test(baseline.reason) ? baseline.reason : 'unclassified');
      if (['owner-paths', 'source-download', 'source-verification', 'operation-selection', 'target-preparation', 'runtime-reuse', 'local-readiness', 'baseline-read'].includes(baseline.stage)) outcome.inspectionStage = baseline.stage;
      log('UPDATE_RESULT: ' + JSON.stringify(outcome)); return outcome;
    }
    need(baseline.status === 'baseline-read-only' && baseline.preparedTargetReused === true && baseline.cloudWrites === 0 &&
      baseline.sourceCommit === EXECUTION_SOURCE_COMMIT && baseline.createdRoomCount === 2 && baseline.roomCount === 2 &&
      baseline.endsAtMillis === END && baseline.maxRooms === 20 && constructions === 1 && cloud && options);
    active = await import(pathToFileURL(join(source, 'scripts/floating-garden-active-update.mjs')).href);
    stage = 'approval-binding'; await active.recheckActiveUpdatePlan(plan);
    need(plan.project === 'wa-awesome-garden-stg' && plan.preservedTesterCount === 2 && plan.maxRooms === 20 &&
      plan.startsAtMillis === START && plan.endsAtMillis === END && HEX.test(plan.oldManifestDigest) && HEX.test(plan.newManifestDigest) &&
      plan.oldManifestDigest === baseline.oldManifestDigest && plan.newManifestDigest === baseline.newManifestDigest);
    const approval = Object.freeze({ oldManifestDigest: plan.oldManifestDigest, newManifestDigest: plan.newManifestDigest,
      pauseExistingPair: true, updateFiveFunctionSources: true, updateDedicatedRules: true, updateExactHosting: true,
      reopenExistingPair: true, retainAllData: true, preserveExistingIam: true, exclusiveMaintenance: true });
    active.validateActiveUpdateApproval(approval, plan); active.proveOldInvocationIsolation(plan);
    stage = 'journal'; journal = await active.createActiveUpdateJournal({ plan, now });
    // The journal helper fsyncs file contents. Persist its new directory entry
    // before any cloud mutation as well; the sibling admission guard is durable.
    await syncDirectory(join(prepared, 'operation'));
    const progress = Object.freeze({ ...journal,
      issued: async name => { await journal.issued(name); log(`UPDATE_PROGRESS: ${name}`); },
      verified: async name => { await journal.verified(name); log(`UPDATE_VERIFIED: ${name}`); },
    });
    stage = 'apply'; applyStarted = true;
    const outcome = safeOutcome(await active.executeActiveUpdate({ plan, mode: 'apply', approval, cloud, journal: progress, now }), plan);
    log('UPDATE_RESULT: ' + JSON.stringify(outcome)); return outcome;
  } catch (error) {
    let access = 'unknown';
    if (applyStarted && cloud?.readAccess) try { const value = await cloud.readAccess(); if (['open', 'closed', 'unknown'].includes(value?.access)) access = value.access; } catch { /* Read failure stays unknown. */ }
    const reason = active ? active.activeUpdateReason(error) : 'unclassified';
    if (journal && !applyStarted) try { await journal.fail('read-only-baseline', reason, access); } catch { /* Retain the one-shot guard. */ }
    const outcome = stopped(/^[a-z][a-z-]{0,63}$/.test(reason) ? reason : 'unclassified', access);
    log('UPDATE_RESULT: ' + JSON.stringify(outcome)); return outcome;
  }
}
export const OWNER_EXECUTION_PLAN = 'UPDATE_PLAN_ONLY: one approved first-NPC update of the existing Garden trial. Preserve both rooms, usage 2/20, the same two testers, fixed expiry and all data. Both players and other deployments must be stopped before execution. Failure may leave access closed or uncertain; no retry or rollback.';
export async function main(args = process.argv.slice(2), capabilities = {}) {
  const log = capabilities.log ?? console.log;
  if (!args.length || args.length === 1 && args[0] === '--plan') { log(OWNER_EXECUTION_PLAN); return 0; }
  if (args.length === 3 && args[0] === '--apply-approved-update' && args[1] === '--players-stopped' && args[2] === '--exclusive-maintenance') {
    const result = await executeOwnerActiveUpdate({ ...capabilities, approved: true, playersStopped: true, exclusiveMaintenance: true });
    return result.status === 'active-updated' ? 0 : 1;
  }
  log('UPDATE_STOP: explicit approved-update, players-stopped and exclusive-maintenance flags are required. No work started.'); return 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let code = 1;
  try { code = await main(); } catch { process.stdout.write('UPDATE_RESULT: {"status":"blocked","stage":"local-entry","access":"unknown","automaticRetry":false}\n'); }
  await new Promise(done => process.stdout.write('', done)); await new Promise(done => process.stderr.write('', done)); process.exit(code);
}

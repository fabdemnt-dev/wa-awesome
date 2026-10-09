#!/usr/bin/env node
// One renewed owner attempt, exclusively for the retained pre-pause/no-write
// failure. The old operation, source cache, guard and journal are never changed.
// Import/default/--plan is inert. No retry, reset, general resume or rollback.
import { mkdir, lstat, realpath, readFile, open, readdir } from 'node:fs/promises';
import { resolve, join, dirname, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Independently verified published verifier bytes; the execution provider/core
// remain pinned to the unchanged b7dd16d source closure.
export const RECOVERY_VERIFIER_COMMIT = 'b19172f53f68d4bfb9e6a0f6d8563055b22d7798';
export const RECOVERY_VERIFIER_SHA256 = 'e7a8544d8d6d1bcc54ba001022b81dec8f566ad6638cb20cd05068b951d9a4dc';
export const RECOVERY_SOURCE_COMMIT = 'b7dd16da4fdbb19e401423beb42a3da5c49e75d1';
export const RECOVERY_PREPARATION_NAME = 'garden-active-update-41c44301490e-iam-read-v2';
export const RECOVERY_PRIOR_GUARD_NAME = 'garden-active-update-41c44301490e-execute-v1';
export const RECOVERY_GUARD_NAME = 'garden-active-update-41c44301490e-recovery-v1';
const START = 1791157551472, END = 1791762351472, MAX_BYTES = 4 * 1024 * 1024;
const HEX = /^[a-f0-9]{64}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const need = value => { if (!value) throw Error('Owner recovery stopped.'); };
const owned = info => typeof process.getuid !== 'function' || info.uid === process.getuid();
const METHODS = Object.freeze(['inspect', 'pause', 'assertClosed', 'updateFunctions', 'verifyFunctions', 'updateRules', 'verifyRules',
  'updateHosting', 'verifyHosting', 'verifyPreservation', 'reopen', 'verifyReopened', 'readAccess']);
async function directory(path, privateMode = false) {
  need(typeof path === 'string' && path === resolve(path));
  let current = sep;
  for (const part of path.split(sep).filter(Boolean)) {
    current = join(current, part); const info = await lstat(current);
    need(info.isDirectory() && !info.isSymbolicLink());
  }
  const info = await lstat(path);
  need(await realpath(path) === path && owned(info) && (!privateMode || (info.mode & 0o077) === 0));
}
async function privateFile(path, limit = MAX_BYTES) {
  await directory(dirname(path), true); const info = await lstat(path);
  need(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && owned(info) && info.size <= limit && (info.mode & 0o077) === 0);
  return readFile(path);
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
const clockInWindow = now => { const value = now(); need(Number.isSafeInteger(value) && value >= START && value < END); return value; };
async function downloadVerifier(path, fetchImpl, pin, sync) {
  const url = `https://raw.githubusercontent.com/fabdemnt-dev/wa-awesome/${pin.commit}/scripts/floating-garden-active-update-diagnose-owner.mjs`;
  const response = await fetchImpl(url, { redirect: 'error', credentials: 'omit', cache: 'no-store',
    headers: { Accept: 'application/octet-stream' }, signal: AbortSignal.timeout(30000) });
  need(response.status === 200 && response.url === url && response.redirected !== true && response.body?.getReader);
  const length = response.headers.get('content-length');
  if (length !== null) need(/^[0-9]+$/.test(length) && Number(length) <= MAX_BYTES);
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try { for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; need(size <= MAX_BYTES); chunks.push(Buffer.from(item.value)); } }
  catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const bytes = Buffer.concat(chunks); need(hash(bytes) === pin.sha256);
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(bytes); await sync(file, { kind: 'verifier-file' }); } finally { await file.close(); }
  need(hash(await privateFile(path)) === pin.sha256);
}
async function syncDirectory(path, sync, kind) {
  const file = await open(path, 'r'); try { await sync(file, { kind }); } finally { await file.close(); }
}
async function exclusiveMarker(path, value, sync) {
  const bytes = Buffer.from(JSON.stringify(value) + '\n'), file = await open(path, 'wx', 0o600);
  try { await file.writeFile(bytes); await sync(file, { kind: 'marker-file' }); } finally { await file.close(); }
  await syncDirectory(dirname(path), sync, 'marker-directory'); return bytes;
}
function approvalFor(plan) {
  return Object.freeze({ oldManifestDigest: plan.oldManifestDigest, newManifestDigest: plan.newManifestDigest,
    pauseExistingPair: true, updateFiveFunctionSources: true, updateDedicatedRules: true, updateExactHosting: true,
    reopenExistingPair: true, retainAllData: true, preserveExistingIam: true, exclusiveMaintenance: true });
}

/** A fresh, exclusive durable journal. Core phases are once-only. Provider
 * upload rows intentionally are NOT deduplicated: multiple Hosting files use
 * the same hosting-file-upload/hosting/0 tuple. */
async function recoveryJournal({ path, context, recheck, now, sync, closeJournal, diagnostics, capture, log, onMutation }) {
  const { plan, active } = context; let file, expected = Buffer.alloc(0), failed = false, terminal = false;
  const issued = new Set();
  const check = (condition, reason = 'journal') => active.requireActiveUpdate(condition, reason);
  const protect = (method, fn) => async (...args) => {
    try { return await fn(...args); }
    catch (error) { capture('journalFailure', method, error); throw error; }
  };
  try { file = await open(path, 'wx', 0o600); }
  catch (error) { capture('journalFailure', 'create', error); throw active.activeUpdateFailure('journal'); }
  const identity = await file.stat();
  async function append(value) {
    check(!failed && !terminal);
    try {
      const info = await lstat(path);
      check(info.dev === identity.dev && info.ino === identity.ino && (await privateFile(path)).equals(expected));
      const atMillis = clockInWindow(now), bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, atMillis, ...value }) + '\n');
      await file.writeFile(bytes); await sync(file, { kind: 'journal-file', event: value.event, stage: value.stage });
      await syncDirectory(dirname(path), sync, 'journal-directory'); expected = Buffer.concat([expected, bytes]);
    } catch (error) { failed = true; capture('journalFailure', 'append', error); throw active.activeUpdateFailure('journal'); }
  }
  try {
    await append({ event: 'created', oldManifestDigest: plan.oldManifestDigest, newManifestDigest: plan.newManifestDigest,
      priorExecutionDigest: context.priorExecutionDigest, priorJournalDigest: context.priorJournalDigest,
      preparationDigest: context.preparationDigest, inspectorDigest: context.inspectorDigest, retainedFingerprint: context.retainedFingerprint });
  } catch (error) { await file.close().catch(() => {}); throw error; }
  return Object.freeze({
    issued: protect('issued', async stage => {
      check(plan.phases.includes(stage) && !issued.has(stage), 'unsafe-retry');
      await recheck(); issued.add(stage); await append({ event: 'issued', stage }); log(`RECOVERY_PROGRESS: ${stage}`);
    }),
    providerStep: protect('providerStep', async step => {
      check(step && active.PROVIDER_STAGES.includes(step.stage) && ['functions', 'rules', 'hosting'].includes(step.resourceKind) &&
        Number.isInteger(step.index) && step.index >= 0 && step.index < 5);
      await recheck(); await append({ event: 'provider-issued', stage: step.stage, resourceKind: step.resourceKind, index: step.index }); onMutation();
    }),
    verified: protect('verified', async stage => {
      check(issued.has(stage), 'stage-order'); await append({ event: 'verified', stage }); log(`RECOVERY_VERIFIED: ${stage}`);
    }),
    finish: protect('finish', async () => {
      // Recheck INSIDE finish, before emitting success, including changes made
      // during the final provider verification. No post-success recheck gap.
      await recheck(); await append({ event: 'finished', status: 'active-updated' }); terminal = true;
      // The verified terminal row and directory are durable. A close-only
      // cleanup failure cannot reverse that committed outcome or trigger
      // reconciliation. Preserve success with a separate sanitized warning.
      try { await closeJournal(file, { event: 'finished' }); }
      catch (error) { capture('cleanupWarning', 'journal-close-after-success', error); }
    }),
    fail: protect('fail', async (stage, reason, access) => {
      try { await append({ event: 'blocked', stage: plan.phases.includes(stage) ? stage : 'read-only-baseline',
        reason: active.activeUpdateReason(active.activeUpdateFailure(reason)), access: ['open', 'closed', 'unknown'].includes(access) ? access : 'unknown', ...diagnostics() }); }
      finally { terminal = true; await closeJournal(file, { event: 'blocked' }); }
    }),
    async close() { if (!terminal) { terminal = true; await closeJournal(file, { event: 'abandoned' }); } },
  });
}

/** Capability injection is exclusively for offline tests; no CLI option can
 * alter pins, paths, module identities, journal, clock or provider factory. */
export async function recoverOwnerActiveUpdate({ renewedApproval = false, playersStopped = false, exclusiveMaintenance = false,
  home = homedir(), env = process.env, execArgv = process.execArgv, now = Date.now, log = console.log, fetchImpl = fetch,
  createProvider, verifierPin = { commit: RECOVERY_VERIFIER_COMMIT, sha256: RECOVERY_VERIFIER_SHA256 },
  sync = async file => file.sync(), closeJournal = async file => file.close() } = {}) {
  let stage = 'owner-paths', verifier, context, journal, cloud, enteredCore = false, cloudChangesAttempted = false;
  const failures = {};
  const capture = (kind, method, error) => {
    if (!Object.hasOwn(failures, kind)) failures[kind] = { method,
      classification: verifier ? verifier.classifyDiagnosticFailure(error, context ?? {}) : { kind: 'unclassified' } };
  };
  const diagnostics = () => ({ ...failures });
  const finish = async value => {
    if (journal) try { await journal.close(); } catch (error) {
      capture('cleanupWarning', 'journal-close', error);
      // Keep any original blocked stage/reason. This cleanup cannot promote a
      // pre-durable failure to success. Durable finish already closes once.
      if (value.status !== 'blocked') value = { status: 'blocked', stage, reason: 'journal', access: value.access ?? 'unknown' };
    }
    const result = { ...value, ...diagnostics(), cloudChangesAttempted, automaticRetry: false, automaticRollback: false };
    log('RECOVERY_RESULT: ' + JSON.stringify(result)); return result;
  };
  try {
    need(renewedApproval === true && playersStopped === true && exclusiveMaintenance === true);
    environment(env, execArgv); await directory(home); const clock = clockInWindow(now);
    need(/^[a-f0-9]{40}$/.test(verifierPin.commit) && HEX.test(verifierPin.sha256));
    await directory(join(home, RECOVERY_PREPARATION_NAME), true); await directory(join(home, RECOVERY_PRIOR_GUARD_NAME), true);
    stage = 'one-shot-guard'; const guard = join(home, RECOVERY_GUARD_NAME);
    // Never remove/reuse this directory, including any interrupted attempt.
    await mkdir(guard, { mode: 0o700 }); await syncDirectory(home, sync, 'guard-parent');
    const markerPath = join(guard, 'RECOVERY.json');
    const markerBytes = await exclusiveMarker(markerPath, { schemaVersion: 1, sourceCommit: RECOVERY_SOURCE_COMMIT,
      preparation: RECOVERY_PREPARATION_NAME, priorGuard: RECOVERY_PRIOR_GUARD_NAME, createdAtMillis: clock,
      verifierCommit: verifierPin.commit, verifierSha256: verifierPin.sha256, renewedApproval: true, automaticRetry: false }, sync);
    stage = 'verifier-download'; const verifierPath = join(guard, 'verified-failed-update.mjs');
    await downloadVerifier(verifierPath, fetchImpl, verifierPin, sync); await syncDirectory(guard, sync, 'verifier-directory');
    stage = 'local-verification'; verifier = await import(pathToFileURL(verifierPath).href);
    need(verifier.DIAGNOSTIC_SOURCE_COMMIT === RECOVERY_SOURCE_COMMIT && verifier.DIAGNOSTIC_PREPARATION_NAME === RECOVERY_PREPARATION_NAME &&
      verifier.DIAGNOSTIC_GUARD_NAME === RECOVERY_PRIOR_GUARD_NAME && typeof verifier.loadVerifiedFailedUpdateContext === 'function' &&
      typeof verifier.classifyDiagnosticFailure === 'function');
    context = await verifier.loadVerifiedFailedUpdateContext({ home, env, execArgv, now, onStage: value => { stage = value; } });
    const { plan, active, provider } = context;
    need(plan.project === 'wa-awesome-garden-stg' && plan.preservedTesterCount === 2 && plan.maxRooms === 20 &&
      plan.startsAtMillis === START && plan.endsAtMillis === END && HEX.test(plan.oldManifestDigest) && HEX.test(plan.newManifestDigest));
    for (const name of ['priorExecutionDigest', 'priorJournalDigest', 'preparationDigest', 'inspectorDigest', 'retainedFingerprint']) need(HEX.test(context[name]));
    const recheck = async () => {
      environment(env, execArgv); clockInWindow(now); await directory(home); await directory(guard, true);
      need((await privateFile(markerPath)).equals(markerBytes) && hash(await privateFile(verifierPath)) === verifierPin.sha256);
      need((await readdir(guard)).sort().join(',') === ['ACTIVE-UPDATE-JOURNAL.jsonl', 'RECOVERY.json', 'verified-failed-update.mjs'].sort().join(','));
      await context.recheck();
    };
    stage = 'approval-binding'; const approval = approvalFor(plan);
    active.validateActiveUpdateApproval(approval, plan); active.proveOldInvocationIsolation(plan); await context.recheck();
    stage = 'journal'; journal = await recoveryJournal({ path: join(guard, 'ACTIVE-UPDATE-JOURNAL.jsonl'), context, recheck, now, sync, closeJournal,
      diagnostics, capture, log, onMutation: () => { cloudChangesAttempted = true; } });
    await recheck();
    stage = 'provider-construction';
    const actual = (createProvider ?? provider.createActiveUpdateProvider)({ plan, toolingDir: context.toolingDir, env, execArgv, now });
    need(actual && typeof actual.bindJournal === 'function' && METHODS.every(method => typeof actual[method] === 'function'));
    let inspections = 0;
    cloud = { bindJournal: value => actual.bindJournal(value) };
    for (const method of METHODS) cloud[method] = async (...args) => {
      try {
        if (method !== 'readAccess') await recheck();
        if (method === 'inspect') active.requireActiveUpdate(++inspections === 1, 'unsafe-retry');
        if (method === 'pause' || method === 'reopen') cloudChangesAttempted = true;
        const value = await actual[method](...args);
        if (method === 'inspect') active.requireActiveUpdate(value?.kind === 'baseline' && HEX.test(value.fingerprint) &&
          value.createdRoomCount === 2 && value.roomCount === 2 && Number.isSafeInteger(value.documentCount) &&
          value.documentCount >= 4 && value.documentCount <= 10000, 'admin-state');
        return value;
      } catch (error) { capture(method === 'readAccess' ? 'accessFailure' : 'operationFailure', method, error); throw error; }
    };
    Object.freeze(cloud); stage = 'apply'; enteredCore = true;
    // No preliminary inspect: the unchanged core owns the ONE fresh baseline.
    const value = await active.executeActiveUpdate({ plan, mode: 'apply', approval, cloud, journal, now });
    if (value?.status === 'active-updated') {
      need(value.access === 'open' && value.preservedTesterCount === 2 && value.endsAtMillis === END && value.usageWritten === false);
      return finish({ status: 'active-updated', access: 'open', preservedTesterCount: 2, endsAtMillis: END, maxRooms: 20,
        usageWritten: false, oldManifestDigest: plan.oldManifestDigest, newManifestDigest: plan.newManifestDigest });
    }
    need(value?.status === 'blocked' && plan.phases.includes(value.stage) && ['open', 'closed', 'unknown'].includes(value.access));
    return finish({ status: 'blocked', stage: value.stage, reason: active.activeUpdateReason(active.activeUpdateFailure(value.reason)), access: value.access,
      ...(active.PROVIDER_STAGES.includes(value.providerStage) ? { providerStage: value.providerStage } : {}),
      ...(Number.isInteger(value.completedFunctionCount) && value.completedFunctionCount >= 0 && value.completedFunctionCount <= 5 ? { completedFunctionCount: value.completedFunctionCount } : {}) });
  } catch (error) {
    capture('entryFailure', stage, error); let access = 'unknown';
    if (enteredCore && cloud) try { const value = await cloud.readAccess(); if (['open', 'closed', 'unknown'].includes(value?.access)) access = value.access; } catch { /* Secondary safe failure captured by wrapper. */ }
    const reason = context?.active.activeUpdateReason(error) ?? 'unclassified';
    if (journal) try { await journal.fail('read-only-baseline', reason, access); } catch { /* Retain new guard and original evidence. */ }
    return finish({ status: 'blocked', stage, reason, access });
  }
}
export const OWNER_RECOVERY_PLAN = 'RECOVERY_PLAN_ONLY: one separately approved renewed attempt for the exact retained pre-pause/no-write failure. Preserve the old guard/journal/source, both rooms, usage 2/20, the same testers, expiry and all data. A new durable recovery guard can never be reused. Both players and other deployments must be stopped. No automatic retry or rollback.';
export async function main(args = process.argv.slice(2), capabilities = {}) {
  const log = capabilities.log ?? console.log;
  if (!args.length || args.length === 1 && args[0] === '--plan') { log(OWNER_RECOVERY_PLAN); return 0; }
  if (args.length === 3 && args[0] === '--apply-approved-recovery' && args[1] === '--players-stopped' && args[2] === '--exclusive-maintenance') {
    const result = await recoverOwnerActiveUpdate({ ...capabilities, renewedApproval: true, playersStopped: true, exclusiveMaintenance: true });
    return result.status === 'active-updated' ? 0 : 1;
  }
  log('RECOVERY_STOP: renewed recovery approval, players-stopped and exclusive-maintenance flags are required. No work started.'); return 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let code = 1;
  try { code = await main(); } catch { process.stdout.write('RECOVERY_RESULT: {"status":"blocked","stage":"local-entry","access":"unknown","automaticRetry":false,"automaticRollback":false}\n'); }
  await new Promise(done => process.stdout.write('', done)); await new Promise(done => process.stderr.write('', done)); process.exit(code);
}

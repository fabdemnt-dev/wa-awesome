#!/usr/bin/env node
// Bounded post-failure diagnosis only. Importing this entry or --plan is inert.
// Reuse immutable owner outputs; never create, clear, bind or append a journal,
// retry execution, download/prepare sources, install, log in or change IAM.
import { readFile, lstat, realpath, readdir } from 'node:fs/promises';
import { resolve, join, dirname, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, types } from 'node:util';

export const DIAGNOSTIC_INSPECTOR_SHA256 = '96577b1c372a599d934ae18d7a0f528f3f923beef61b33f14a3e1bea77c02b54';
export const DIAGNOSTIC_SOURCE_COMMIT = 'b7dd16da4fdbb19e401423beb42a3da5c49e75d1';
export const DIAGNOSTIC_SOURCE_TREE = 'ad707eca475b0477dccf4094a442dd31aede54fc';
export const DIAGNOSTIC_PREPARATION_NAME = 'garden-active-update-41c44301490e-iam-read-v2';
export const DIAGNOSTIC_GUARD_NAME = 'garden-active-update-41c44301490e-execute-v1';
const START = 1791157551472, END = 1791762351472, MAX_BYTES = 4 * 1024 * 1024;
const HEX = /^[a-f0-9]{64}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const need = value => { if (!value) throw Error('Owner diagnosis stopped.'); };
const owned = info => typeof process.getuid !== 'function' || info.uid === process.getuid();
const exactKeys = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype &&
  isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
async function directory(path, privateMode = false) {
  need(typeof path === 'string' && path === resolve(path));
  let current = sep;
  for (const part of path.split(sep).filter(Boolean)) {
    current = join(current, part); const info = await lstat(current);
    need(info.isDirectory() && !info.isSymbolicLink());
  }
  const info = await lstat(path);
  need(await realpath(path) === path && (!privateMode || ((info.mode & 0o077) === 0 && owned(info))));
}
async function regularFile(path, { privateMode = true, limit = MAX_BYTES } = {}) {
  await directory(dirname(path), privateMode); const info = await lstat(path);
  need(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= limit && owned(info) &&
    (!privateMode || (info.mode & 0o077) === 0));
  return readFile(path);
}
async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function inventory(source, files) {
  await directory(source, true); need(Object.keys(files).length === 64);
  const found = []; let directories = 0;
  async function visit(path, prefix = '') {
    await directory(path, true);
    for (const name of await readdir(path)) {
      const full = join(path, name), key = prefix + name, info = await lstat(full);
      need(!info.isSymbolicLink());
      if (info.isDirectory()) {
        need(++directories <= 128 && Object.keys(files).some(file => file.startsWith(key + '/')));
        await visit(full, key + '/');
      } else { need(info.isFile() && found.length < 64); found.push(key); }
    }
  }
  await visit(source); need(isDeepStrictEqual(found.sort(), Object.keys(files).sort()));
  for (const [path, digest] of Object.entries(files)) need(HEX.test(digest) && hash(await regularFile(join(source, path))) === digest);
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
async function validateRuntime(packet) {
  const root = join(packet.gameDir, 'functions'), modules = join(root, 'node_modules'); await directory(modules);
  for (const [name, version] of [['firebase-admin', '12.7.0'], ['firebase-functions', '6.6.0'], ['google-auth-library', '9.15.1'], ['@google-cloud/firestore', '7.11.6']]) {
    need(JSON.parse(await regularFile(join(modules, name, 'package.json'), { privateMode: false })).version === version);
  }
  const req = createRequire(join(root, 'package.json'));
  for (const name of ['firebase-admin/app', 'firebase-admin/firestore', 'firebase-functions/v2/https', 'google-auth-library']) {
    const selected = req.resolve(name); need((await realpath(selected)).startsWith(modules + sep));
    await regularFile(selected, { privateMode: false });
  }
  for (const [parent, dependency, version] of [['google-auth-library', 'gaxios', '6.7.1'], ['firebase-admin/firestore', '@google-cloud/firestore', '7.11.6']]) {
    const path = createRequire(req.resolve(parent)).resolve(`${dependency}/package.json`);
    need((await realpath(path)).startsWith(modules + sep) && JSON.parse(await regularFile(path, { privateMode: false })).version === version);
  }
}
function clockInWindow(clock) { need(Number.isSafeInteger(clock) && clock >= START && clock < END); return clock; }
function verifyExecution(bytes, now) {
  const value = JSON.parse(bytes);
  need(exactKeys(value, ['schemaVersion', 'sourceCommit', 'preparation', 'createdAtMillis', 'automaticRetry']) &&
    value.schemaVersion === 1 && value.sourceCommit === DIAGNOSTIC_SOURCE_COMMIT && value.preparation === DIAGNOSTIC_PREPARATION_NAME &&
    value.automaticRetry === false && clockInWindow(value.createdAtMillis) <= now && bytes.equals(Buffer.from(JSON.stringify(value) + '\n')));
  return value;
}
function verifyJournal(bytes, plan, execution, now) {
  const text = bytes.toString('utf8'); need(Buffer.from(text).equals(bytes) && text.endsWith('\n'));
  const lines = text.slice(0, -1).split('\n'); need(lines.length === 2);
  const entries = lines.map(line => { const value = JSON.parse(line); need(JSON.stringify(value) === line); return value; });
  const [created, blocked] = entries;
  need(exactKeys(created, ['schemaVersion', 'atMillis', 'event', 'oldManifestDigest', 'newManifestDigest']) &&
    created.schemaVersion === 1 && created.event === 'created' && created.oldManifestDigest === plan.oldManifestDigest && created.newManifestDigest === plan.newManifestDigest);
  need(exactKeys(blocked, ['schemaVersion', 'atMillis', 'event', 'stage', 'reason', 'access']) &&
    blocked.schemaVersion === 1 && blocked.event === 'blocked' && blocked.stage === 'read-only-baseline' && blocked.reason === 'unclassified' && blocked.access === 'open');
  need(clockInWindow(created.atMillis) >= execution.createdAtMillis && clockInWindow(blocked.atMillis) >= created.atMillis && blocked.atMillis <= now);
}
const GRPC_NAMES = Object.freeze(['OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND',
  'ALREADY_EXISTS', 'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED']);
const SYSTEM_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE']);
// Retain the cached WeakMap brands even when local verification rejects before
// the complete context can be returned. No paths, bytes or error text escape.
const verifiedFailureModules = new WeakMap();
function ownValue(value, key) {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}
// Neither error messages/stacks nor provider properties are trusted diagnostic
// strings. Legacy and current reasons originate only in verified WeakMap brands.
export function classifyDiagnosticFailure(error, { active, adapter } = {}) {
  const retained = verifiedFailureModules.get(error);
  active ??= retained?.active; adapter ??= retained?.adapter;
  const legacy = adapter?.describeAdapterFailure(error);
  if (legacy && (legacy.reason !== 'unclassified' || Number.isInteger(legacy.httpStatus))) return {
    kind: 'legacy-adapter', reason: legacy.reason,
    ...(Number.isInteger(legacy.httpStatus) && legacy.httpStatus >= 100 && legacy.httpStatus <= 599 ? { httpStatus: legacy.httpStatus } : {}),
  };
  const reason = active?.activeUpdateReason(error);
  if (reason && reason !== 'unclassified') return { kind: 'active-update', reason };
  const code = ownValue(error, 'code');
  if (types.isNativeError(error) && Number.isInteger(code) && code >= 1 && code <= 16) return { kind: 'grpc', code, name: GRPC_NAMES[code] };
  if (types.isNativeError(error) && SYSTEM_CODES.has(code)) return { kind: 'system-code', code };
  if (types.isNativeError(error)) {
    const prototype = Object.getPrototypeOf(error);
    const entry = [[TypeError, 'TypeError'], [RangeError, 'RangeError'], [SyntaxError, 'SyntaxError'], [ReferenceError, 'ReferenceError'],
      [URIError, 'URIError'], [EvalError, 'EvalError'], [AggregateError, 'AggregateError']].find(([type]) => prototype === type.prototype);
    return { kind: 'error-class', name: entry ? entry[1] : 'Error' };
  }
  return { kind: 'unclassified' };
}
/** Verify retained owner evidence using local reads only; never construct a provider. */
export async function loadVerifiedFailedUpdateContext({ home = homedir(), env = process.env, execArgv = process.execArgv,
  now = Date.now, onStage = () => {} } = {}) {
  let active, adapter;
  const retainFailure = error => {
    if (error && (typeof error === 'object' || typeof error === 'function') && !types.isProxy(error)) {
      verifiedFailureModules.set(error, { active, adapter });
    }
    throw error;
  };
  try {
    onStage('owner-paths'); environment(env, execArgv); await directory(home);
    const clock = clockInWindow(now()), base = join(home, DIAGNOSTIC_PREPARATION_NAME), source = join(base, 'source');
    const guard = join(home, DIAGNOSTIC_GUARD_NAME), executionPath = join(guard, 'EXECUTION.json'), inspectorPath = join(guard, 'read-only-owner.mjs');
    const verifyGuard = async () => {
      await directory(guard, true);
      need(isDeepStrictEqual((await readdir(guard)).sort(), ['EXECUTION.json', 'read-only-owner.mjs']));
    };
    onStage('guard-verification'); await verifyGuard();
    const executionBytes = await regularFile(executionPath, { limit: 16384 }), execution = verifyExecution(executionBytes, clock);
    const inspectorBytes = await regularFile(inspectorPath); need(hash(inspectorBytes) === DIAGNOSTIC_INSPECTOR_SHA256);
    // This saved 4f8de18 inspector is used for public constants ONLY. Calling its
    // inspect entry would reject the journal and cannot authorize a retry.
    const owner = await import(pathToFileURL(inspectorPath).href);
    need(owner.OWNER_SOURCE_COMMIT === DIAGNOSTIC_SOURCE_COMMIT && owner.OWNER_SOURCE_TREE === DIAGNOSTIC_SOURCE_TREE && owner.OWNER_PREPARATION_NAME === DIAGNOSTIC_PREPARATION_NAME);
    const verifyBase = async () => {
      await directory(base, true);
      need(isDeepStrictEqual((await readdir(base)).sort(), ['PREPARATION.json', 'operation', 'source']));
    };
    onStage('source-verification'); await verifyBase();
    await inventory(source, owner.OWNER_SOURCE_FILES);
    // No cached nonbuiltin source has been imported before full closure checks.
    const load = path => import(pathToFileURL(join(source, 'scripts', path)).href);
    const setup = await load('deploy-floating-garden-connection-template.mjs'); setup.validateEnvironment(env, execArgv);
    const operator = await load('operate-floating-garden-trial.mjs');
    active = await load('floating-garden-active-update.mjs'); adapter = await load('floating-garden-trial-cloud-adapter.mjs');
    const provider = await load('floating-garden-active-update-provider.mjs');
    onStage('operation-selection');
    const original = join(home, 'garden-final-reviewed-v1'), updated = join(home, 'garden-lobby-entry-reviewed-v1');
    const selectOperation = async () => {
      need(await exists(original) || await exists(updated));
      for (const path of [original, updated]) if (await exists(path)) { await directory(path, true); await directory(join(path, 'operation'), true); }
      const selected = await operator.selectVerifiedHostingOperation(join(original, 'operation'), join(updated, 'operation'));
      need([join(original, 'operation'), join(updated, 'operation')].includes(selected)); return selected;
    };
    const selected = await selectOperation(), output = join(base, 'operation');
    const verifyOutput = async () => {
      await directory(output, true);
      need(isDeepStrictEqual((await readdir(output)).sort(), ['ACTIVE-UPDATE-JOURNAL.jsonl', 'OPERATION-MANIFEST.json', 'OPERATION-PLAN.json', 'game', 'private-review.json', 'stopped']));
    };
    await verifyOutput();
    const previous = await operator.readOperationPacket(selected), next = await operator.readOperationPacket(output);
    onStage('preparation-binding');
    const markerPath = join(base, 'PREPARATION.json'), markerBytes = await regularFile(markerPath, { limit: 16384 }), marker = JSON.parse(markerBytes);
    need(isDeepStrictEqual(marker, { schemaVersion: 1, sourceCommit: DIAGNOSTIC_SOURCE_COMMIT, sourceTree: DIAGNOSTIC_SOURCE_TREE,
      previousOutput: previous.packet.output, previousManifestDigest: previous.packet.manifestDigest,
      targetManifestDigest: next.packet.manifestDigest, reviewDigest: next.packet.reviewDigest }));
    const plan = await active.prepareActiveUpdatePlan({ previousOutput: selected, nextOutput: output });
    need(plan.project === 'wa-awesome-garden-stg' && plan.preservedTesterCount === 2 && plan.maxRooms === 20 &&
      plan.startsAtMillis === START && plan.endsAtMillis === END && HEX.test(plan.oldManifestDigest) && HEX.test(plan.newManifestDigest) &&
      plan.oldManifestDigest === previous.packet.manifestDigest && plan.newManifestDigest === next.packet.manifestDigest);
    onStage('journal-verification');
    const journalPath = join(output, 'ACTIVE-UPDATE-JOURNAL.jsonl'), journalBytes = await regularFile(journalPath, { limit: 16384 });
    verifyJournal(journalBytes, plan, execution, clock);
    onStage('runtime-verification'); await validateRuntime(next.packet);
    const toolingDir = join(home, 'garden-trial-f0bc4eb0', 'tooling'); await directory(toolingDir);
    // The byte buffers and private packets stay inside this closure. The public
    // context holds only the existing branded plan, exact module identities,
    // required local source/tooling paths and non-sensitive evidence digests.
    const retained = [[executionPath, executionBytes], [inspectorPath, inspectorBytes], [markerPath, markerBytes], [journalPath, journalBytes]];
    const recheck = async () => {
      try {
        environment(env, execArgv); const current = clockInWindow(now()); await directory(home);
        await verifyGuard(); await verifyBase(); await verifyOutput();
        for (const [path, before] of retained) need((await regularFile(path)).equals(before));
        const retainedExecution = verifyExecution(executionBytes, current);
        verifyJournal(journalBytes, plan, retainedExecution, current);
        need(await selectOperation() === selected);
        await active.recheckActiveUpdatePlan(plan);
        await validateRuntime(next.packet); await directory(toolingDir);
        await inventory(source, owner.OWNER_SOURCE_FILES);
        // Do not authorize the next step after local reads cross the fixed end.
        clockInWindow(now()); return true;
      } catch (error) { return retainFailure(error); }
    };
    await recheck();
    const priorExecutionDigest = hash(executionBytes), priorJournalDigest = hash(journalBytes),
      preparationDigest = hash(markerBytes), inspectorDigest = hash(inspectorBytes);
    const retainedFingerprint = hash(JSON.stringify({ priorExecutionDigest, priorJournalDigest, preparationDigest, inspectorDigest,
      oldManifestDigest: plan.oldManifestDigest, newManifestDigest: plan.newManifestDigest }));
    return Object.freeze({ plan, active, adapter, provider, toolingDir, source, priorExecutionDigest, priorJournalDigest,
      preparationDigest, inspectorDigest, retainedFingerprint, recheck });
  } catch (error) { return retainFailure(error); }
}
const notRun = () => ({ status: 'not-run' });
/** Capability injection is for offline tests, unavailable from CLI flags. */
export async function diagnoseOwnerActiveUpdate({ enabled = false, home = homedir(), env = process.env, execArgv = process.execArgv,
  now = Date.now, log = console.log, createProvider } = {}) {
  let stage = 'owner-paths', active, adapter;
  const outcome = { status: 'blocked', stage, pass1: notRun(), pass2: notRun(), readAccess: 'unknown',
    originalCause: 'unknown', cloudWrites: 0, automaticRetry: false, automaticRollback: false, executionRetryAuthorized: false };
  const finish = () => { log('DIAGNOSTIC_RESULT: ' + JSON.stringify(outcome)); return outcome; };
  try {
    need(enabled === true);
    const context = await loadVerifiedFailedUpdateContext({ home, env, execArgv, now, onStage: value => { stage = value; } });
    const { plan, provider, toolingDir } = context; ({ active, adapter } = context);
    stage = 'provider-construction';
    const cloud = (createProvider ?? provider.createActiveUpdateProvider)({ plan, toolingDir, env, execArgv, now });
    need(typeof cloud?.inspect === 'function' && typeof cloud?.readAccess === 'function');
    stage = 'read-only-diagnosis';
    for (const key of ['pass1', 'pass2']) {
      try {
        clockInWindow(now());
        const value = await cloud.inspect();
        if (!(value?.kind === 'baseline' && HEX.test(value.fingerprint) && value.createdRoomCount === 2 && value.roomCount === 2 &&
          Number.isSafeInteger(value.documentCount) && value.documentCount >= 4 && value.documentCount <= 10000)) throw active.activeUpdateFailure('admin-state');
        outcome[key] = { status: 'passed', createdRoomCount: 2, roomCount: 2, maxRooms: 20, endsAtMillis: END };
      } catch (error) { outcome[key] = { status: 'failed', classification: classifyDiagnosticFailure(error, { active, adapter }) }; }
    }
    try { const access = ownValue(await cloud.readAccess(), 'access'); if (['open', 'closed', 'unknown'].includes(access)) outcome.readAccess = access; }
    catch (error) { outcome.accessFailure = classifyDiagnosticFailure(error, { active, adapter }); }
    stage = 'local-recheck';
    await context.recheck();
    outcome.status = 'diagnosed'; outcome.stage = 'read-only-diagnosis'; outcome.savedStateUnchanged = true;
    outcome.finding = outcome.pass1.status === 'passed' && outcome.pass2.status === 'passed' ? 'not-reproduced' : 'current-read-failure';
    return finish();
  } catch (error) {
    outcome.stage = stage; outcome.classification = classifyDiagnosticFailure(error, { active, adapter }); return finish();
  }
}
export const OWNER_DIAGNOSTIC_PLAN = 'DIAGNOSTIC_PLAN_ONLY: verify the retained failed-update guard, pinned inspector/source, preparation and exact pre-mutation journal; perform two sequential read-only inspections and one access read. No cloud writes, execution retry, journal changes, downloads, preparation, install, login or IAM changes. Current failures do not prove the original cause.';
export async function main(args = process.argv.slice(2), capabilities = {}) {
  const log = capabilities.log ?? console.log;
  if (!args.length || args.length === 1 && args[0] === '--plan') { log(OWNER_DIAGNOSTIC_PLAN); return 0; }
  if (args.length === 1 && args[0] === '--diagnose-failed-update') {
    const result = await diagnoseOwnerActiveUpdate({ ...capabilities, enabled: true });
    return result.status === 'diagnosed' && result.finding === 'not-reproduced' ? 0 : 1;
  }
  log('DIAGNOSTIC_STOP: only --diagnose-failed-update enables bounded reads. No work started.'); return 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let code = 1;
  try { code = await main(); } catch { process.stdout.write('DIAGNOSTIC_RESULT: {"status":"blocked","stage":"local-entry","cloudWrites":0,"automaticRetry":false,"executionRetryAuthorized":false}\n'); }
  await new Promise(done => process.stdout.write('', done)); await new Promise(done => process.stderr.write('', done)); process.exit(code);
}

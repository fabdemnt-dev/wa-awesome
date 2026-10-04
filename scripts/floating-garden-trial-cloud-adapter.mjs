// Provider boundary for the separately reviewed trial operator. Importing this
// module, and constructing an adapter, performs no SDK setup or cloud operation.
// Never print returned admin data, provider errors, SDK objects or CLI output.
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { inflateRawSync } from 'node:zlib';
import { isDeepStrictEqual, stripVTControlCharacters, types } from 'node:util';
import { fileURLToPath } from 'node:url';
import { FUNCTION_NAMES } from './prepare-floating-garden-trial.mjs';
import { validateOperationReview, publicTrialConfig } from './prepare-floating-garden-trial-operation.mjs';
import { PROJECT, PROJECT_NUMBER, ORIGIN, EMBEDDED as CONNECTION_PAYLOAD,
  checkTooling, validateEnvironment, validateConfiguration, canonicalVersionName,
  liveChannel, sitePresent, releaseIdentity, verifyPublic, CONNECTION_NAMES,
} from './deploy-floating-garden-connection-check.mjs';
import { APPROVED_APIS, bootstrapApis } from './bootstrap-floating-garden-apis.mjs';
import { bootstrapRuntime } from './bootstrap-floating-garden-runtime.mjs';
import { bootstrapHmac, validateSecret, validateVersions, validateVersion,
  validateSecretPolicy, SECRET, SECRET_ID } from './bootstrap-floating-garden-hmac.mjs';

export const REGION = 'asia-northeast1';
export const CODEBASE = 'floating-garden-trial';
export const RUNTIME_ACCOUNT = `garden-trial-runtime@${PROJECT}.iam.gserviceaccount.com`;
export const ADMIN_PATHS = Object.freeze({ gate: 'floatingGardenTrial/config', usage: 'floatingGardenTrial/usage', testers: 'floatingGardenTrialTesters' });
export const REQUIRED_APIS = Object.freeze([...new Set([...APPROVED_APIS,
  'firebase.googleapis.com', 'firebasehosting.googleapis.com', 'firestore.googleapis.com',
  'identitytoolkit.googleapis.com', 'serviceusage.googleapis.com', 'cloudresourcemanager.googleapis.com'])]);
export const CLEANUP_WARNING = `Functions successfully deployed but could not set up cleanup policy in location ${REGION}. Pass the --force option to automatically set up a cleanup policy or run 'firebase functions:artifacts:setpolicy' to manually set up a cleanup policy.`;
export const CLI_EFFECTS = Object.freeze({
  version: '14.27.0', serviceIdentityGeneration: ['pubsub.googleapis.com', 'eventarc.googleapis.com'],
  initialFunctionRecreate: true, publicInvoker: true, retainBuildArtifacts: true,
  warning: 'The untouched CLI may internally retry provider operations, recreate a just-created function after a capacity error, and generate Pub/Sub/Eventarc service identities. It writes private local debug files. None of this text grants execution approval.',
});
// maxAttempts limits whole transactions. This separate GAPIC setting also
// disables wire-level Commit retries in the pinned Firestore 7.11.6 dependency.
export const FIRESTORE_CLIENT_CONFIG = Object.freeze({ interfaces: {
  'google.firestore.v1.Firestore': { retry_codes: { operator_no_retry: [] },
    methods: { Commit: { retry_codes_name: 'operator_no_retry' } } },
} });
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_BYTES = 16 * 1024 * 1024;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = isDeepStrictEqual;
// The Console formats the same closed Rules differently from the file. Compare
// lexical tokens, preserving identifiers, quoted strings and every punctuation
// token. This accepts whitespace only, not comments, extra clauses or grants.
export function sameDenyAllRules(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || actual.length > 16384 || expected.length > 16384) return false;
  const tokens = (text) => text.match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z_0-9]*|\*\*|[^\s]/g) ?? [];
  return same(tokens(actual), tokens(expected));
}
// This finite vocabulary is the complete diagnostic persistence boundary. A
// reason is a conservative category/check, never an assertion of root cause.
const FAILURE_REASONS = new Set([
  'unclassified', 'cli-json-unavailable', 'cli-result-unrecognized', 'invalid-filter', 'missing-sdk-binary', 'source-analysis', 'missing-dependencies',
  'authentication', 'permission', 'billing', 'quota', 'build', 'network', 'timeout', 'process-interrupted',
  'admin-activation', 'admin-app-collision', 'admin-concurrent-change', 'admin-create-mode', 'admin-create-precondition',
  'admin-gate', 'admin-gate-preservation', 'admin-initial', 'admin-initial-empty', 'admin-read', 'admin-shape', 'admin-stop',
  'admin-tester', 'admin-tester-preservation', 'admin-update-mode', 'admin-usage-untouched', 'admin-window',
  'apis-already-enabled', 'artifact-retention', 'build-account', 'cli-effects-review', 'deployment-config', 'diagnostic-environment',
  'function-duplicate-service', 'function-identity', 'function-inventory', 'function-resource-limits', 'function-run-revision',
  'function-run-service', 'function-runtime-labels', 'function-secret-bindings', 'function-secret-environment', 'function-source-provenance',
  'functions-already-present', 'functions-concurrent-change', 'functions-deploy-mode', 'functions-initial-empty', 'hmac-metadata', 'hmac-policy',
  'hosting-bytes', 'hosting-cli-read', 'hosting-concurrent-change', 'hosting-config', 'hosting-deploy-mode', 'hosting-headers',
  'hosting-headers-config', 'hosting-initial-release', 'hosting-kind', 'hosting-migration-release', 'hosting-private-gate', 'hosting-release',
  'hosting-response-size', 'hosting-root-config', 'hosting-root-redirect', 'hosting-status', 'hosting-stopped-config', 'hosting-target',
  'invalid-provider-json', 'local-file', 'local-path', 'metadata-command', 'metadata-http', 'metadata-size', 'node-version',
  'packet-extra-file', 'packet-file-digest', 'packet-file-name', 'packet-layout', 'packet-manifest', 'preflight-mode', 'preflight-required',
  'project-identity', 'provider-or-local-check', 'read-url', 'rules-bytes', 'rules-concurrent-change', 'rules-deploy-mode',
  'rules-initial-deny-all', 'rules-release', 'rules-source', 'run-generation', 'run-initial-empty', 'run-invoker-policy',
  'run-latest-traffic', 'run-public-invoker', 'run-ready-latest', 'run-resource-limits', 'runtime-metadata', 'sdk-local-resolution', 'sdk-version',
  'source-archive-bytes', 'source-archive-compression', 'source-archive-crc', 'source-archive-descriptor', 'source-archive-directory',
  'source-archive-entry', 'source-archive-local-entry', 'source-archive-overlap', 'source-archive-path', 'source-archive-size',
  'source-bucket-owner', 'source-dependencies', 'source-five-exports', 'source-object-identity', 'source-runtime',
]);
function ownValue(value, key) {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}
const numericStatus = (value, min, max) => Number.isInteger(value) && value >= min && value <= max ? value : null;
export function normalizeFailureDiagnostic(value) {
  const reason = ownValue(value, 'reason'), httpStatus = numericStatus(ownValue(value, 'httpStatus'), 100, 599);
  return Object.freeze({ reason: FAILURE_REASONS.has(reason) ? reason : 'unclassified',
    exitCode: numericStatus(ownValue(value, 'exitCode'), 0, 255), timedOut: ownValue(value, 'timedOut') === true,
    ...(httpStatus === null ? {} : { httpStatus }) });
}
// WeakMap identity branding prevents forged prototypes/properties, getters or
// provider exceptions from becoming trusted diagnostic messages.
const adapterFailures = new WeakMap();
class AdapterStop extends Error {
  constructor(code, diagnostic) {
    const reason = FAILURE_REASONS.has(code) ? code : 'unclassified';
    super(`STOP: ${reason}. Raw provider diagnostics are suppressed; inspect before any further write.`);
    this.code = reason;
    adapterFailures.set(this, normalizeFailureDiagnostic(diagnostic ?? { reason }));
  }
}
export function describeAdapterFailure(error) {
  return adapterFailures.get(error) ?? normalizeFailureDiagnostic(null);
}
const safe = (code, diagnostic) => new AdapterStop(code, diagnostic);
function requireThat(test, code) { if (!test) throw safe(code); }
function parse(text) { try { return JSON.parse(text); } catch { throw safe('invalid-provider-json'); } }
function result(kind) { return Object.freeze({ kind }); }

// Reviewed literals from CLI 14.27.0 filterTargets, prepare, Node runtime
// discovery/versioning, requireAuth/auth, checkIam/requirePermissions and
// ensureApiEnabled. Provider status labels are categories, not inferred HTTP
// numbers. Never extract an identifier, path, service name or error suffix.
const CLI_FAILURE_SIGNATURES = [
  ['invalid-filter', /No function matches given --only filters\. Aborting deployment\.|Cannot understand what targets to deploy\/serve\./],
  ['missing-sdk-binary', /Failed to find location of Firebase Functions SDK\./],
  ['missing-dependencies', /Couldn't find firebase-functions package in your source code\.|Cannot find module ['"]|No npm package found in functions source directory /],
  ['source-analysis', /Functions codebase could not be analyzed successfully\.|Failed to load function definition from source:|Failed to parse build specification|User code failed to load\. Cannot determine backend specification\.|Discovery process completed but no function manifest was found|Failed to read or parse manifest file:|Discovery process failed:/],
  ['authentication', /Failed to authenticate, have you run |Command requires authentication, please run |Authentication Error: Your credentials are no longer valid\.|\bUNAUTHENTICATED\b/],
  ['permission', /Missing permissions required for functions deploy\.|Missing required permission on project |Authorization failed\. This account is missing the following required permissions|Permissions denied enabling |\bPERMISSION_DENIED\b/],
  ['billing', /must be on the Blaze \(pay-as-you-go\) plan to complete this command\.|\bBILLING_DISABLED\b|\bUREQ_PROJECT_BILLING_NOT_FOUND\b/],
  ['quota', /\bRESOURCE_EXHAUSTED\b|\bQUOTA_EXCEEDED\b|\bQuota exceeded\b/],
  ['build', /\bBuild failed with status:|\bBuild failed:|\bCloud Build failed\b/],
  ['network', /\bECONNRESET\b|\bECONNREFUSED\b|\bENOTFOUND\b|\bEAI_AGAIN\b/],
];
function diagnosticText(value) { return typeof value === 'string' && value.length <= MAX_BYTES ? stripVTControlCharacters(value) : ''; }
function cliFailureDiagnostic(raw, parsed) {
  const timedOut = ownValue(raw, 'timedOut') === true;
  let reason = timedOut ? 'timeout' : ownValue(raw, 'signal') ? 'process-interrupted' : 'unclassified';
  if (reason === 'unclassified') {
    const error = ownValue(parsed, 'error');
    const finalMessage = diagnosticText(typeof error === 'string' ? error : ownValue(error, 'message'));
    // Prefer the CLI's terminal JSON message. Only if it is unclassified, look
    // at the captured streams; neither stream crosses this function boundary.
    for (const text of [finalMessage, diagnosticText(ownValue(raw, 'stderr')), diagnosticText(ownValue(raw, 'stdout'))]) {
      const match = CLI_FAILURE_SIGNATURES.find(([, pattern]) => pattern.test(text));
      if (match) { reason = match[0]; break; }
    }
  }
  return normalizeFailureDiagnostic({ reason, exitCode: ownValue(raw, 'exitCode'), timedOut });
}
function failedResult(kind, raw, parsed, fallback = 'unclassified') {
  const diagnostic = cliFailureDiagnostic(raw, parsed);
  return Object.freeze({ kind, diagnostic: diagnostic.reason === 'unclassified' ? normalizeFailureDiagnostic({ ...diagnostic, reason: fallback }) : diagnostic });
}

/** A cleanup message is ONLY a classification, never proof of deployment.
 * A failed function deployment can be masked by the CLI's later cleanup error.
 */
export function classifyDeployResult(raw, { allowCleanupWarning = false } = {}) {
  const exitCode = numericStatus(ownValue(raw, 'exitCode'), 0, 255);
  if (ownValue(raw, 'signal') || ownValue(raw, 'timedOut') === true || exitCode === null) return failedResult('unknown', raw);
  let value;
  try { value = JSON.parse(diagnosticText(ownValue(raw, 'stdout'))); } catch { return failedResult(exitCode === 0 ? 'unknown' : 'failed', raw, undefined, 'cli-json-unavailable'); }
  if (exitCode === 0 && value?.status === 'success') return result('success');
  const error = typeof value?.error === 'string' ? value.error : value?.error?.message;
  if (allowCleanupWarning && exitCode !== 0 && value?.status === 'error' && error === CLEANUP_WARNING) return result('cleanup-warning');
  const recognizedFailure = exitCode !== 0 && value?.status === 'error';
  return failedResult(exitCode === 0 ? 'unknown' : 'failed', raw, value, recognizedFailure ? 'unclassified' : 'cli-result-unrecognized');
}

export function validateFunctionMetadata(fn, name) {
  requireThat(FUNCTION_NAMES.includes(name) && plain(fn), 'function-identity');
  requireThat(fn.name === `projects/${PROJECT}/locations/${REGION}/functions/${name}` && fn.environment === 'GEN_2' && fn.state === 'ACTIVE' && !fn.eventTrigger, 'function-identity');
  requireThat(fn.buildConfig?.runtime === 'nodejs22' && fn.buildConfig?.entryPoint === name &&
    fn.labels?.['firebase-functions-codebase'] === CODEBASE && fn.labels?.['deployment-callable'] === 'true', 'function-runtime-labels');
  const c = fn.serviceConfig;
  requireThat(plain(c) && c.serviceAccountEmail === RUNTIME_ACCOUNT && c.availableMemory === '256Mi' && String(c.availableCpu) === '1' &&
    c.maxInstanceRequestConcurrency === 1 && (c.minInstanceCount ?? 0) === 0 && c.maxInstanceCount === 1 && c.timeoutSeconds === 30 &&
    c.ingressSettings === 'ALLOW_ALL' && c.allTrafficOnLatestRevision === true, 'function-resource-limits');
  requireThat(Array.isArray(c.secretEnvironmentVariables ?? []) && !(c.secretVolumes?.length), 'function-secret-bindings');
  const secrets = c.secretEnvironmentVariables ?? [];
  if (FUNCTION_NAMES.slice(0, 2).includes(name)) {
    requireThat(secrets.length === 1 && secrets[0].key === SECRET_ID && secrets[0].secret === SECRET_ID &&
      [PROJECT, PROJECT_NUMBER].includes(String(secrets[0].projectId)) && String(secrets[0].version) === '1', 'function-secret-bindings');
  } else requireThat(secrets.length === 0, 'function-secret-bindings');
  requireThat(!Object.hasOwn(c.environmentVariables ?? {}, SECRET_ID), 'function-secret-environment');
  const service = c.service;
  requireThat(typeof service === 'string' && new RegExp(`^projects/(?:${PROJECT}|${PROJECT_NUMBER})/locations/${REGION}/services/[a-z][a-z0-9-]{0,62}$`).test(service), 'function-run-service');
  const source = fn.buildConfig?.sourceProvenance?.resolvedStorageSource;
  requireThat(plain(source) && source.bucket === `gcf-v2-sources-${PROJECT_NUMBER}-${REGION}` &&
    typeof source.object === 'string' && /^[A-Za-z0-9_./-]{1,1024}$/.test(source.object) &&
    !source.object.split('/').some((s) => !s || s === '.' || s === '..') && /^[1-9][0-9]*$/.test(String(source.generation)), 'function-source-provenance');
  requireThat(typeof c.revision === 'string' && (c.revision.startsWith(`${service}/revisions/`) || /^[a-z][a-z0-9-]{0,62}$/.test(c.revision)), 'function-run-revision');
  const revision = c.revision.includes('/') ? c.revision : `${service}/revisions/${c.revision}`;
  return { service, revision, source: { bucket: source.bucket, object: source.object, generation: String(source.generation) } };
}

/** Cloud Run v2 resource obtained via the function's returned service identity. */
export function validateRunService(service, expectedName, expectedRevision) {
  requireThat(plain(service) && service.name === expectedName && !service.reconciling && !service.deleteTime &&
    service.terminalCondition?.state === 'CONDITION_SUCCEEDED' && service.terminalCondition?.type === 'Ready' &&
    typeof service.latestCreatedRevision === 'string' && service.latestCreatedRevision === service.latestReadyRevision &&
    service.latestReadyRevision.startsWith(`${expectedName}/revisions/`) &&
    (expectedRevision === undefined || service.latestReadyRevision === expectedRevision), 'run-ready-latest');
  requireThat(service.observedGeneration === service.generation && /^[1-9][0-9]*$/.test(String(service.generation)), 'run-generation');
  requireThat(service.template?.serviceAccount === RUNTIME_ACCOUNT &&
    (service.template?.scaling?.minInstanceCount ?? 0) === 0 && service.template?.scaling?.maxInstanceCount === 1 &&
    service.template?.maxInstanceRequestConcurrency === 1 && service.template?.timeout === '30s', 'run-resource-limits');
  const containers = service.template?.containers;
  requireThat(Array.isArray(containers) && containers.length === 1 && containers[0].resources?.limits?.memory === '256Mi' &&
    String(containers[0].resources?.limits?.cpu) === '1', 'run-resource-limits');
  const traffic = service.trafficStatuses;
  requireThat(Array.isArray(traffic) && traffic.length === 1 && traffic[0].percent === 100 &&
    traffic[0].revision === service.latestReadyRevision, 'run-latest-traffic');
  return true;
}
export function validateInvokerPolicy(policy) {
  requireThat(plain(policy) && Array.isArray(policy.bindings), 'run-invoker-policy');
  requireThat(policy.bindings.every((b) => plain(b) && typeof b.role === 'string' && !b.role.includes('_withcond_') && Array.isArray(b.members)), 'run-invoker-policy');
  requireThat(policy.bindings.some((b) => b.role === 'roles/run.invoker' && b.condition === undefined && b.members.includes('allUsers')), 'run-public-invoker');
  return true;
}

// Strict bounded ZIP reader. No extraction, filesystem traversal, duplicate names,
// symlinks, ZIP64, encrypted entries, non-file entries, or extra source files.
// Compare every uncompressed byte against the checked local source inventory.
export function validateSourceArchive(input, expected) {
  const b = Buffer.from(input);
  requireThat(b.length >= 22 && b.length <= MAX_BYTES && plain(expected) && Object.keys(expected).length > 0, 'source-archive-size');
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (b.readUInt32LE(i) === 0x06054b50 && i + 22 + b.readUInt16LE(i + 20) === b.length) { end = i; break; }
  requireThat(end >= 0, 'source-archive-directory');
  const count = b.readUInt16LE(end + 10), length = b.readUInt32LE(end + 12), offset = b.readUInt32LE(end + 16);
  requireThat(!b.readUInt16LE(end + 4) && !b.readUInt16LE(end + 6) && b.readUInt16LE(end + 8) === count &&
    count === Object.keys(expected).length && count <= 128 && offset + length === end, 'source-archive-directory');
  const seen = new Set(), extents = []; let at = offset, total = 0;
  for (let n = 0; n < count; n++) {
    requireThat(at + 46 <= end && b.readUInt32LE(at) === 0x02014b50, 'source-archive-entry');
    const flags = b.readUInt16LE(at + 8), method = b.readUInt16LE(at + 10), crc = b.readUInt32LE(at + 16);
    const packed = b.readUInt32LE(at + 20), size = b.readUInt32LE(at + 24), nl = b.readUInt16LE(at + 28), el = b.readUInt16LE(at + 30), cl = b.readUInt16LE(at + 32);
    const mode = (b.readUInt32LE(at + 38) >>> 16) & 0xf000, local = b.readUInt32LE(at + 42);
    requireThat(at + 46 + nl + el + cl <= end && !(flags & ~0x808) && [0, 8].includes(method) &&
      !b.readUInt16LE(at + 34) && [0, 0x8000].includes(mode) && !(b.readUInt32LE(at + 38) & 0x10), 'source-archive-entry');
    const nameBytes = b.subarray(at + 46, at + 46 + nl), name = nameBytes.toString('utf8');
    requireThat(/^[A-Za-z0-9_./-]+$/.test(name) && !name.startsWith('/') && !name.split('/').some((s) => !s || s === '.' || s === '..') &&
      !seen.has(name) && Object.hasOwn(expected, name) && Buffer.from(name).equals(nameBytes), 'source-archive-path');
    requireThat(size <= 4 * 1024 * 1024 && (total += size) <= MAX_BYTES && local + 30 <= offset && b.readUInt32LE(local) === 0x04034b50 &&
      b.readUInt16LE(local + 6) === flags && b.readUInt16LE(local + 8) === method, 'source-archive-local-entry');
    const lnl = b.readUInt16LE(local + 26), lel = b.readUInt16LE(local + 28), start = local + 30 + lnl + lel;
    requireThat(start + packed <= offset && b.subarray(local + 30, local + 30 + lnl).equals(nameBytes), 'source-archive-local-entry');
    if (!(flags & 8)) requireThat(b.readUInt32LE(local + 14) === crc && b.readUInt32LE(local + 18) === packed && b.readUInt32LE(local + 22) === size, 'source-archive-local-entry');
    let bytes;
    try { bytes = method === 0 ? b.subarray(start, start + packed) : inflateRawSync(b.subarray(start, start + packed), { maxOutputLength: 4 * 1024 * 1024 }); }
    catch { throw safe('source-archive-compression'); }
    requireThat(bytes.length === size && bytes.equals(Buffer.from(expected[name])), 'source-archive-bytes');
    // CRC is also checked, rather than trusting two matching forged ZIP headers.
    let actual = 0xffffffff;
    for (const byte of bytes) { actual ^= byte; for (let bit = 0; bit < 8; bit++) actual = (actual >>> 1) ^ ((actual & 1) ? 0xedb88320 : 0); }
    requireThat(((actual ^ 0xffffffff) >>> 0) === crc, 'source-archive-crc');
    let last = start + packed;
    if (flags & 8) {
      requireThat(last + 12 <= offset, 'source-archive-descriptor');
      if (b.readUInt32LE(last) === 0x08074b50) last += 4;
      requireThat(last + 12 <= offset && b.readUInt32LE(last) === crc && b.readUInt32LE(last + 4) === packed && b.readUInt32LE(last + 8) === size, 'source-archive-descriptor');
      last += 12;
    }
    extents.push([local, last]); seen.add(name); at += 46 + nl + el + cl;
  }
  extents.sort((a, c) => a[0] - c[0]);
  requireThat(at === end && extents[0][0] === 0 && extents.at(-1)[1] === offset && extents.every((e, i) => i === 0 || extents[i - 1][1] === e[0]), 'source-archive-overlap');
  return { verified: true, fileCount: seen.size };
}

export function makeCloudRunner({ exec = execFileSync, env = process.env } = {}) {
  return (command, args, cwd) => {
    try { return { exitCode: 0, stdout: exec(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: MAX_BYTES, timeout: 15 * 60 * 1000, env: { ...env, NO_COLOR: '1', FORCE_COLOR: '0', CI: 'true',
        CLOUDSDK_CORE_DISABLE_PROMPTS: 'true', CLOUDSDK_CORE_LOG_HTTP: 'false', CLOUDSDK_CORE_DISABLE_FILE_LOGGING: 'true' } }) || '', stderr: '' }; }
    catch (error) {
      // Captured streams live only in process memory until classification. Do
      // not print, persist or attach this internal runner result to the journal.
      const stream = (key) => {
        const value = ownValue(error, key);
        if (typeof value === 'string') return value.length <= MAX_BYTES ? value : '';
        if (!types.isProxy(value) && Buffer.isBuffer(value) && value.length <= MAX_BYTES) return value.toString('utf8');
        return '';
      };
      return { exitCode: numericStatus(ownValue(error, 'status'), 0, 255), stdout: stream('stdout'), stderr: stream('stderr'),
        signal: ownValue(error, 'signal') ? true : null, timedOut: ownValue(error, 'code') === 'ETIMEDOUT' };
    }
  };
}
function normalizeRun(value) { return typeof value === 'string' ? { exitCode: 0, stdout: value } : value; }
function checkedDirectory(dir) {
  requireThat(typeof dir === 'string' && resolve(dir) === dir, 'local-path');
  let current = sep;
  for (const part of dir.split(sep).filter(Boolean)) { current = join(current, part); const s = lstatSync(current); requireThat(s.isDirectory() && !s.isSymbolicLink(), 'local-path'); }
  requireThat(realpathSync(dir) === dir, 'local-path');
}
function checkedFile(path) { const s = lstatSync(path); requireThat(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size <= 4 * 1024 * 1024, 'local-file'); return readFileSync(path); }

export function createCloudAdapter({ packet, review, toolingDir, runner = makeCloudRunner(), requestClient,
  db: injectedDb, now = Date.now, fetchImpl = fetch, env = process.env, execArgv = process.execArgv } = {}) {
  let firebase, auth, database = injectedDb, manifest, expectedSource, readyMode, localReady = false;
  let attemptedFunctions = false, attemptedRules = false, attemptedHosting = false, attemptedCreate = false;
  const checkedReview = () => {
    // Inspection and stopping remain possible after expiry; no time extension.
    publicTrialConfig(review);
    return review;
  };
  const rawRun = (command, args, cwd) => {
    try { return normalizeRun(runner(command, args, cwd)); }
    catch { return { exitCode: null, stdout: '', signal: 'runner-result-unknown' }; }
  };
  const runText = (command, args, cwd) => {
    const r = rawRun(command, args, cwd);
    if (r?.exitCode !== 0 || r.signal || r.timedOut || typeof r.stdout !== 'string') {
      const diagnostic = cliFailureDiagnostic(r);
      throw safe('metadata-command', { ...diagnostic, reason: diagnostic.reason === 'unclassified' ? 'metadata-command' : diagnostic.reason });
    }
    return r.stdout;
  };
  const gcloudText = (args) => runText('gcloud', [...args, `--project=${PROJECT}`, `--billing-project=${PROJECT}`, '--verbosity=error'], packet.gameDir);
  const gcloud = (args) => parse(gcloudText([...args, '--format=json']));
  async function boundary(fn) { try { return await fn(); } catch (e) { if (adapterFailures.has(e)) throw e; throw safe('provider-or-local-check'); } }
  function localScope() {
    checkedReview(); validateEnvironment(env, execArgv);
    for (const key of ['DEBUG', 'GRPC_TRACE', 'GRPC_VERBOSITY', 'GOOGLE_SDK_NODE_LOGGING']) requireThat(!env[key], 'diagnostic-environment');
    requireThat(Number(process.versions.node.split('.')[0]) >= 20, 'node-version');
    checkedDirectory(packet.output); checkedDirectory(packet.gameDir); checkedDirectory(packet.stoppedDir);
    requireThat(packet.gameDir === join(packet.output, 'game') && packet.stoppedDir === join(packet.output, 'stopped') &&
      packet.manifestPath === join(packet.output, 'OPERATION-MANIFEST.json') && packet.reviewPath === join(packet.output, 'private-review.json'), 'packet-layout');
    manifest = parse(checkedFile(packet.manifestPath).toString());
    requireThat(manifest.schemaVersion === 1 && manifest.projectId === PROJECT && manifest.origin === ORIGIN && plain(manifest.files) && Object.keys(manifest.files).length <= 128 &&
      sha(checkedFile(packet.reviewPath)) === manifest.reviewDigest && same(parse(checkedFile(packet.reviewPath).toString()), review), 'packet-manifest');
    if (packet.manifestDigest) requireThat(sha(checkedFile(packet.manifestPath)) === packet.manifestDigest, 'packet-manifest');
    for (const [path, hash] of Object.entries(manifest.files)) {
      requireThat(/^(?:game|stopped)\/[A-Za-z0-9_./-]+$/.test(path) || path === 'OPERATION-PLAN.json', 'packet-file-name');
      requireThat(!path.split('/').some((p) => !p || p === '.' || p === '..') && /^[a-f0-9]{64}$/.test(hash), 'packet-file-name');
      checkedDirectory(resolve(packet.output, path, '..'));
      requireThat(sha(checkedFile(join(packet.output, path))) === hash, 'packet-file-digest');
    }
    for (const dir of ['game/functions', 'game/public', 'stopped/public']) {
      const visit = (at, prefix) => { for (const name of readdirSync(at)) {
        if (prefix === 'game/functions' && name === 'node_modules') { checkedDirectory(join(at, name)); continue; }
        const path = join(at, name), key = `${prefix}/${name}`, s = lstatSync(path);
        requireThat(!s.isSymbolicLink(), 'packet-extra-file');
        if (s.isDirectory()) visit(path, key); else requireThat(Object.hasOwn(manifest.files, key), 'packet-extra-file');
      } }; visit(join(packet.output, dir), dir);
    }
    const config = parse(checkedFile(join(packet.gameDir, 'firebase.trial.json')).toString());
    requireThat(same(config.functions, { source: 'functions', codebase: CODEBASE, ignore: ['node_modules', '**/.*', '*-debug.log'] }) &&
      same(config.firestore, { rules: 'firestore.rules', indexes: 'firestore.indexes.json' }), 'deployment-config');
    expectedSource = Object.fromEntries(Object.keys(manifest.files).filter((p) => p.startsWith('game/functions/')).map((p) => [p.slice(15), checkedFile(join(packet.output, p))]));
    requireThat(parse(expectedSource['package.json'].toString()).engines?.node === '22', 'source-runtime');
    const pkg = parse(expectedSource['package.json'].toString());
    requireThat(same(pkg.dependencies, { 'firebase-admin': '12.7.0', 'firebase-functions': '6.6.0' }), 'source-dependencies');
    for (const kind of ['game', 'stopped']) {
      const cfg = hostingConfig(kind);
      requireThat(Object.keys(cfg).length === 1 && cfg.hosting?.site === PROJECT && cfg.hosting.public === 'public' && !cfg.hosting.target && !cfg.hosting.rewrites, 'hosting-config');
    }
    localReady = true;
  }
  function setupTooling() { if (!firebase) firebase = checkTooling(toolingDir, runText); }
  function requireLocal() { requireThat(localReady, 'preflight-required'); localScope(); }
  function sdkRequire() {
    requireLocal();
    const modules = join(packet.gameDir, 'functions/node_modules'); checkedDirectory(modules);
    for (const [name, version] of [['firebase-admin', '12.7.0'], ['firebase-functions', '6.6.0'], ['google-auth-library', '9.15.1'], ['@google-cloud/firestore', '7.11.6']]) {
      checkedDirectory(join(modules, name)); requireThat(parse(checkedFile(join(modules, name, 'package.json')).toString()).version === version, 'sdk-version');
    }
    const req = createRequire(join(packet.gameDir, 'functions/package.json'));
    for (const name of ['firebase-admin/app', 'firebase-admin/firestore', 'firebase-functions/v2/https', 'google-auth-library']) requireThat(realpathSync(req.resolve(name)).startsWith(`${modules}/`), 'sdk-local-resolution');
    return req;
  }
  async function client() {
    if (requestClient) return requestClient;
    if (!auth) { const { GoogleAuth } = sdkRequire()('google-auth-library'); auth = new GoogleAuth({ projectId: PROJECT, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }); }
    return auth;
  }
  async function request(url, { bytes = false } = {}) {
    const u = new URL(url);
    requireThat(u.protocol === 'https:' && !u.username && !u.password && ['cloudfunctions.googleapis.com', 'run.googleapis.com', 'firebaserules.googleapis.com', 'storage.googleapis.com'].includes(u.hostname), 'read-url');
    // Only GETs use this boundary; no extracted token, user-selected URL or retry.
    const c = await client();
    let response;
    try {
      response = await c.request({ url, method: 'GET', responseType: bytes ? 'arraybuffer' : 'json', timeout: 30000,
        retry: false, maxRedirects: 0, maxContentLength: MAX_BYTES, maxBodyLength: MAX_BYTES });
    } catch (error) {
      const observed = ownValue(error, 'response');
      const httpStatus = numericStatus(ownValue(observed, 'status'), 100, 599) ?? numericStatus(ownValue(observed, 'statusCode'), 100, 599);
      // Never use FirebaseError.status (which defaults to 500), a gRPC code,
      // or a number parsed from an error message as an HTTP response status.
      throw safe('metadata-http', { reason: 'metadata-http', httpStatus });
    }
    if (response?.status !== 200 || response.data === undefined) throw safe('metadata-http', { reason: 'metadata-http', httpStatus: ownValue(response, 'status') });
    if (bytes) { const b = Buffer.from(response.data); requireThat(b.length <= MAX_BYTES, 'metadata-size'); return b; }
    return response.data;
  }
  async function getDb() {
    requireLocal();
    if (!database) {
      const req = sdkRequire(), appSdk = req('firebase-admin/app'), firestore = req('firebase-admin/firestore');
      const name = 'floating-garden-reviewed-operator';
      requireThat(!appSdk.getApps().some((app) => app.name === name), 'admin-app-collision');
      const app = appSdk.initializeApp({ projectId: PROJECT, credential: appSdk.applicationDefault() }, name);
      database = firestore.getFirestore(app); database.settings({ ignoreUndefinedProperties: false, clientConfig: FIRESTORE_CLIENT_CONFIG });
    }
    return database;
  }
  const refs = (db) => [db.doc(ADMIN_PATHS.gate), db.doc(ADMIN_PATHS.usage), ...review.testerUids.map((uid) => db.doc(`${ADMIN_PATHS.testers}/${uid}`))];
  const data = (snapshot) => snapshot.exists ? snapshot.data() : null;
  async function readAdmin() { return boundary(async () => { const db = await getDb(); const s = await db.getAll(...refs(db)); requireThat(s.length === 4, 'admin-read'); return { gate: data(s[0]), usage: data(s[1]), testers: s.slice(2).map(data) }; }); }
  function assertRecords(records, initial = false) {
    requireThat(plain(records) && Array.isArray(records.testers) && records.testers.length === 2, 'admin-shape');
    const config = publicTrialConfig(review), gate = records.gate;
    if (gate !== null) {
      requireThat(plain(gate) && typeof gate.enabled === 'boolean', 'admin-gate');
      for (const key of ['projectId', 'region', 'previewOrigin', 'startsAtMillis', 'endsAtMillis', 'maxRooms']) requireThat(gate[key] === config[key], 'admin-gate');
      requireThat(same(gate.testerUids, gate.enabled ? review.testerUids : []), 'admin-gate');
    }
    for (const tester of records.testers) if (tester !== null) requireThat(plain(tester) && typeof tester.active === 'boolean' && tester.expiresAtMillis === review.endsAtMillis, 'admin-tester');
    if (initial) requireThat(same(gate, { enabled: false, projectId: PROJECT, region: REGION, previewOrigin: ORIGIN,
      startsAtMillis: review.startsAtMillis, endsAtMillis: review.endsAtMillis, maxRooms: 20, testerUids: [] }) &&
      records.testers.every((t) => same(t, { active: false, expiresAtMillis: review.endsAtMillis })) && same(records.usage, {
      projectId: PROJECT, startsAtMillis: review.startsAtMillis, endsAtMillis: review.endsAtMillis, maxRooms: 20, createdRoomCount: 0 }), 'admin-initial');
  }
  async function createStoppedAdmin(records) { return boundary(async () => {
    requireThat(readyMode === 'deploy' && !attemptedCreate, 'admin-create-mode'); requireLocal(); assertRecords(records, true);
    const db = await getDb(), r = refs(db); let writes = false;
    attemptedCreate = true;
    try {
      await db.runTransaction(async (tx) => {
        const existing = await Promise.all(r.map((ref) => tx.get(ref)));
        requireThat(existing.every((s) => !s.exists), 'admin-create-precondition');
        [records.gate, records.usage, ...records.testers].forEach((value, i) => tx.create(r[i], value)); writes = true;
      }, { maxAttempts: 1 });
      return result('success');
    } catch { return result(writes ? 'unknown' : 'failed'); }
  }); }
  async function updateAdmin(next, expected) { return boundary(async () => {
    requireThat(['deploy', 'activate', 'stop'].includes(readyMode), 'admin-update-mode'); requireLocal(); assertRecords(next); assertRecords(expected);
    requireThat(same(next.usage, expected.usage), 'admin-usage-untouched');
    const activation = next.gate?.enabled === true;
    if (activation) { requireThat(['deploy', 'activate'].includes(readyMode) && now() >= review.startsAtMillis && now() < review.endsAtMillis && expected.gate?.enabled === false && next.testers.every((t) => t?.active === true), 'admin-activation'); }
    else requireThat(next.gate === null || next.gate.enabled === false, 'admin-stop');
    const preservedGate = (gate) => gate === null ? null : Object.fromEntries(Object.entries(gate).filter(([key]) => !['enabled', 'testerUids'].includes(key)));
    requireThat(same(preservedGate(next.gate), preservedGate(expected.gate)), 'admin-gate-preservation');
    for (let i = 0; i < 2; i++) requireThat((expected.testers[i] === null && next.testers[i] === null) ||
      (plain(expected.testers[i]) && plain(next.testers[i]) && same({ ...expected.testers[i], active: next.testers[i].active }, next.testers[i]) &&
        next.testers[i].active === activation), 'admin-tester-preservation');
    const db = await getDb(), r = refs(db); let issued = false;
    try {
      await db.runTransaction(async (tx) => {
        const got = await Promise.all([tx.get(r[0]), tx.get(r[2]), tx.get(r[3])]);
        requireThat(same(data(got[0]), expected.gate) && got.slice(1).every((s, i) => same(data(s), expected.testers[i])), 'admin-concurrent-change');
        if (activation) requireThat(now() >= review.startsAtMillis && now() < review.endsAtMillis, 'admin-window');
        if (next.gate !== null && (!same(next.gate.enabled, expected.gate.enabled) || !same(next.gate.testerUids, expected.gate.testerUids))) {
          tx.update(r[0], { enabled: next.gate.enabled, testerUids: next.gate.testerUids }); issued = true;
        }
        for (let i = 0; i < 2; i++) if (next.testers[i] !== null && next.testers[i].active !== expected.testers[i].active) { tx.update(r[i + 2], { active: next.testers[i].active }); issued = true; }
      }, { maxAttempts: 1 });
      return result('success');
    } catch { return result(issued ? 'unknown' : 'failed'); }
  }); }
  function hostingConfig(kind) { return parse(checkedFile(join(kind === 'game' ? packet.gameDir : packet.stoppedDir, kind === 'game' ? 'firebase.hosting-only.json' : 'firebase.maintenance.json')).toString()); }
  function marker(kind) { return `garden-trial-${kind}-v1:${sha(checkedFile(packet.manifestPath))}`; }
  function cli(args, kind = 'game', config) {
    setupTooling(); const cwd = kind === 'game' ? packet.gameDir : packet.stoppedDir;
    return rawRun(process.execPath, [firebase, ...args, '--config', config ?? (kind === 'game' ? 'firebase.hosting-only.json' : 'firebase.maintenance.json'), '--project', PROJECT, '--non-interactive', '--json'], cwd);
  }
  function cliRead(args) {
    const r = cli(args);
    if (r?.exitCode !== 0) {
      const diagnostic = cliFailureDiagnostic(r);
      throw safe('hosting-cli-read', { ...diagnostic, reason: diagnostic.reason === 'unclassified' ? 'hosting-cli-read' : diagnostic.reason });
    }
    const v = parse(r.stdout); requireThat(v?.status === 'success' && plain(v.result), 'hosting-cli-read'); return v.result;
  }
  function readRelease() {
    sitePresent(cliRead(['hosting:sites:list']));
    const channel = liveChannel(cliRead(['hosting:channel:list', '--site', PROJECT])), release = channel.release;
    requireThat(release?.type === 'DEPLOY' && release.version?.status === 'FINALIZED', 'hosting-release');
    for (const kind of ['game', 'stopped']) if (release.message === marker(kind)) return { kind, version: canonicalVersionName(release.version.name), marker: release.message };
    const old = releaseIdentity(channel, CONNECTION_PAYLOAD);
    requireThat(['connection', 'maintenance'].includes(old.kind), 'hosting-migration-release');
    return { kind: old.kind, version: old.version, marker: old.message };
  }
  async function fetchPublic(path, status, expected, headers) {
    const response = await fetchImpl(`${ORIGIN}${path}`, { redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(30000) });
    if (response.status !== status) throw safe('hosting-status', { reason: 'hosting-status', httpStatus: response.status });
    const bytes = Buffer.from(await response.arrayBuffer()); requireThat(bytes.length <= 4 * 1024 * 1024, 'hosting-response-size');
    if (expected !== null) requireThat(bytes.equals(expected), 'hosting-bytes');
    for (const { key, value } of headers) requireThat(response.headers.get(key) === value, 'hosting-headers');
    return response;
  }
  async function verifyHostingBytes(kind) {
    if (['connection', 'maintenance'].includes(kind)) return verifyPublic(CONNECTION_PAYLOAD, kind, fetchImpl);
    requireThat(['game', 'stopped'].includes(kind), 'hosting-kind');
    const cfg = hostingConfig(kind), headers = cfg.hosting.headers?.[0]?.headers;
    requireThat(Array.isArray(headers) && cfg.hosting.headers.length === 1 && cfg.hosting.headers[0].source === '**', 'hosting-headers-config');
    const prefix = `${kind}/public/`, files = Object.keys(manifest.files).filter((p) => p.startsWith(prefix));
    for (const path of files) await fetchPublic(`/${path.slice(prefix.length)}`, 200, checkedFile(join(packet.output, path)), headers);
    if (kind === 'game') {
      requireThat(same(cfg.hosting.redirects, [{ source: '/', destination: '/lab/floating-garden/trial/index.html', type: 302 }]), 'hosting-root-config');
      const r = await fetchPublic('/', 302, null, headers);
      requireThat(['/lab/floating-garden/trial/index.html', `${ORIGIN}/lab/floating-garden/trial/index.html`].includes(r.headers.get('location')), 'hosting-root-redirect');
    } else {
      requireThat(!cfg.hosting.redirects && !cfg.hosting.rewrites, 'hosting-stopped-config');
      const inert = checkedFile(join(packet.stoppedDir, 'public/404.html'));
      await fetchPublic('/', 200, checkedFile(join(packet.stoppedDir, 'public/index.html')), headers);
      const former = new Set(Object.keys(manifest.files).filter((p) => p.startsWith('game/public/')).map((p) => `/${p.slice(12)}`));
      for (const name of CONNECTION_NAMES) former.add(`/connection-check/${name}`);
      for (const path of ['/connection-check/', '/lab/floating-garden/', '/lab/floating-garden/online/', '/lab/floating-garden/trial/']) former.add(path);
      for (const path of former) if (!['/index.html', '/404.html'].includes(path)) await fetchPublic(path, 404, inert, headers);
    }
    return { verified: true };
  }
  async function readHosting() { return boundary(async () => { requireLocal(); const a = readRelease(); await verifyHostingBytes(a.kind); requireThat(same(a, readRelease()), 'hosting-concurrent-change'); return a; }); }
  async function verifyHosting(kind) { return boundary(async () => { const h = await readHosting(); requireThat(h.kind === kind, 'hosting-target'); return { verified: true }; }); }
  async function deployHosting(kind) { return boundary(async () => {
    requireThat(['game', 'stopped'].includes(kind) && (kind === 'game' ? readyMode === 'deploy' : ['deploy', 'stop'].includes(readyMode)) && !attemptedHosting, 'hosting-deploy-mode');
    requireLocal(); const current = await readHosting();
    if (current.kind === kind) return result('success');
    const admin = await readAdmin(); assertRecords(admin);
    requireThat(kind === 'game' ? admin.gate?.enabled === false && admin.testers.every((t) => t?.active === false) :
      (admin.gate === null || admin.gate.enabled === false && admin.gate.testerUids.length === 0) && admin.testers.every((t) => t === null || t.active === false), 'hosting-private-gate');
    requireThat(same(current, readRelease()), 'hosting-concurrent-change'); requireLocal();
    attemptedHosting = true;
    return classifyDeployResult(cli(['deploy', '--only', `hosting:${PROJECT}`, '--message', marker(kind)], kind));
  }); }
  async function functionsList() {
    const value = await request(`https://cloudfunctions.googleapis.com/v2/projects/${PROJECT}/locations/-/functions?pageSize=1000`);
    requireThat(plain(value) && !value.nextPageToken && !(value.unreachable?.length) && Array.isArray(value.functions ?? []), 'function-inventory'); return value.functions ?? [];
  }
  async function verifyFunctions() { return boundary(async () => {
    requireLocal(); const functions = await functionsList();
    requireThat(functions.length === 5 && new Set(functions.map((f) => f.name)).size === 5, 'function-inventory');
    const proven = new Set(), services = new Set();
    for (const name of FUNCTION_NAMES) {
      const fn = functions.find((f) => f.name === `projects/${PROJECT}/locations/${REGION}/functions/${name}`);
      const { service, revision, source } = validateFunctionMetadata(fn, name);
      requireThat(!services.has(service), 'function-duplicate-service'); services.add(service);
      validateRunService(await request(`https://run.googleapis.com/v2/${service}`), service, revision);
      validateInvokerPolicy(await request(`https://run.googleapis.com/v2/${service}:getIamPolicy?options.requestedPolicyVersion=3`));
      const key = JSON.stringify(source);
      if (!proven.has(key)) {
        const bucket = await request(`https://storage.googleapis.com/storage/v1/b/${source.bucket}?fields=name,projectNumber`);
        requireThat(bucket.name === source.bucket && String(bucket.projectNumber) === PROJECT_NUMBER, 'source-bucket-owner');
        const objectUrl = `https://storage.googleapis.com/storage/v1/b/${source.bucket}/o/${encodeURIComponent(source.object)}?generation=${source.generation}`;
        const object = await request(objectUrl);
        requireThat(object.bucket === source.bucket && object.name === source.object && String(object.generation) === source.generation &&
          /^[1-9][0-9]*$/.test(String(object.size)) && Number(object.size) <= MAX_BYTES, 'source-object-identity');
        validateSourceArchive(await request(`${objectUrl}&alt=media`, { bytes: true }), expectedSource); proven.add(key);
      }
    }
    requireThat(same(functions, await functionsList()), 'functions-concurrent-change');
    return { verified: true };
  }); }
  async function rulesState() {
    const release = await request(`https://firebaserules.googleapis.com/v1/projects/${PROJECT}/releases/cloud.firestore`);
    requireThat(release.name === `projects/${PROJECT}/releases/cloud.firestore` && typeof release.rulesetName === 'string' &&
      new RegExp(`^projects/${PROJECT}/rulesets/[A-Za-z0-9_-]+$`).test(release.rulesetName), 'rules-release');
    const set = await request(`https://firebaserules.googleapis.com/v1/${release.rulesetName}`);
    requireThat(set.name === release.rulesetName && Array.isArray(set.source?.files) && set.source.files.length === 1 &&
      ['firestore.rules', 'deny-all.rules', 'config/floating-garden-trial/deny-all.rules'].includes(set.source.files[0].name) &&
      typeof set.source.files[0].content === 'string', 'rules-source');
    const again = await request(`https://firebaserules.googleapis.com/v1/projects/${PROJECT}/releases/cloud.firestore`);
    requireThat(same(again, release), 'rules-concurrent-change');
    return set.source.files[0].content;
  }
  async function verifyRules() { return boundary(async () => { requireLocal(); requireThat(await rulesState() === checkedFile(join(packet.gameDir, 'firestore.rules')).toString(), 'rules-bytes'); return { verified: true }; }); }
  async function deployFunctions() { return boundary(async () => {
    requireThat(readyMode === 'deploy' && !attemptedFunctions, 'functions-deploy-mode'); requireLocal();
    requireThat(review.retainBuildArtifacts && review.allowInitialFunctionRecreate && review.approvePublicInvoker, 'cli-effects-review');
    requireThat((await functionsList()).length === 0, 'functions-already-present');
    const admin = await readAdmin(); assertRecords(admin, true);
    attemptedFunctions = true;
    return classifyDeployResult(cli(['deploy', '--only', FUNCTION_NAMES.map((name) => `functions:${CODEBASE}:${name}`).join(',')], 'game', 'firebase.trial.json'), { allowCleanupWarning: true });
  }); }
  async function deployRules() { return boundary(async () => {
    requireThat(readyMode === 'deploy' && !attemptedRules, 'rules-deploy-mode'); requireLocal();
    const current = await rulesState();
    requireThat(sameDenyAllRules(current, checkedFile(join(ROOT, 'config/floating-garden-trial/deny-all.rules')).toString()), 'rules-initial-deny-all');
    const admin = await readAdmin(); assertRecords(admin, true); attemptedRules = true;
    return classifyDeployResult(cli(['deploy', '--only', 'firestore:rules'], 'game', 'firebase.trial.json'));
  }); }
  async function preflight(mode) { return boundary(async () => {
    requireThat(['deploy', 'activate', 'inspect', 'stop'].includes(mode), 'preflight-mode'); localScope();
    validateConfiguration(gcloud(['config', 'list', '--all']));
    const project = gcloud(['projects', 'describe', PROJECT]);
    requireThat(project.projectId === PROJECT && String(project.projectNumber) === PROJECT_NUMBER && project.lifecycleState === 'ACTIVE', 'project-identity');
    // Stop is gate-first. Hosting, tooling, runtime and build failures must not
    // prevent disabling an existing exact private gate with the existing ADC.
    if (mode === 'stop') { readyMode = mode; return { verified: true }; }
    setupTooling();
    if (mode === 'inspect' || mode === 'activate') {
      if (mode === 'activate') requireThat(review.retainBuildArtifacts && review.allowInitialFunctionRecreate && review.approvePublicInvoker, 'cli-effects-review');
      readyMode = mode; return { verified: true };
    }
    validateOperationReview(review, { now: now() });
    requireThat(review.retainBuildArtifacts && review.allowInitialFunctionRecreate && review.approvePublicInvoker, 'cli-effects-review');
    const apis = gcloud(['services', 'list', '--enabled']);
    requireThat(Array.isArray(apis) && REQUIRED_APIS.every((api) => apis.some((a) => a.config?.name === api)), 'apis-already-enabled');
    const api = await bootstrapApis({ apply: false, run: gcloudText, log: () => {} });
    // The owner's reviewed existing build account has an unconditional Editor
    // binding. Accept that existing evidence; this adapter never requests a
    // replacement identity, new grant, or permission broadening.
    const reviewedBuild = api.buildAccount === `${PROJECT_NUMBER}-compute@developer.gserviceaccount.com` &&
      api.bindings?.some((b) => b.role === 'roles/editor' && b.condition === null);
    requireThat(api.complete && (reviewedBuild || ['roles/cloudbuild.builds.builder', 'roles/run.builder'].some((role) =>
      api.bindings?.some((b) => b.role === role && b.condition === null))), 'build-account');
    requireThat((await bootstrapRuntime({ apply: false, run: gcloudText, log: () => {} })).complete, 'runtime-metadata');
    requireThat((await bootstrapHmac({ userOperated: false, run: (args) => gcloudText([...args, '--format=json']), log: () => {}, env, execArgv })).existing, 'hmac-metadata');
    validateSecret(gcloud(['secrets', 'describe', SECRET])); validateVersions(gcloud(['secrets', 'versions', 'list', SECRET]));
    validateVersion(gcloud(['secrets', 'versions', 'describe', `${SECRET}/versions/1`]));
    requireThat(validateSecretPolicy(gcloud(['secrets', 'get-iam-policy', SECRET])), 'hmac-policy');
    const repos = gcloud(['artifacts', 'repositories', 'list', `--location=${REGION}`]);
    requireThat(Array.isArray(repos) && repos.every((repo) => plain(repo) && Object.values(repo.cleanupPolicies ?? {}).every((policy) => policy.action !== 'DELETE')), 'artifact-retention');
    requireThat((await functionsList()).length === 0, 'functions-initial-empty');
    const allFunctions = gcloud(['functions', 'list']);
    requireThat(Array.isArray(allFunctions) && allFunctions.length === 0, 'functions-initial-empty');
    const run = gcloud(['run', 'services', 'list', '--platform=managed']);
    requireThat(Array.isArray(run) && run.length === 0, 'run-initial-empty');
    const admin = await readAdmin(); requireThat(admin.gate === null && admin.usage === null && admin.testers.every((t) => t === null), 'admin-initial-empty');
    requireThat(sameDenyAllRules(await rulesState(), checkedFile(join(ROOT, 'config/floating-garden-trial/deny-all.rules')).toString()), 'rules-initial-deny-all');
    const hosting = await readHosting(); requireThat(['connection', 'maintenance'].includes(hosting.kind), 'hosting-initial-release');
    // Loading the exact prepared module only constructs callable descriptors;
    // the module initializes Admin and reads the HMAC only inside a handler.
    const req = sdkRequire(), exports = req(join(packet.gameDir, 'functions/index.js'));
    requireThat(same(Object.keys(exports).sort(), [...FUNCTION_NAMES].sort()) && FUNCTION_NAMES.every((name) => typeof exports[name] === 'function'), 'source-five-exports');
    readyMode = mode; return { verified: true };
  }); }
  return Object.freeze({ preflight, readAdmin, createStoppedAdmin, updateAdmin, deployFunctions, verifyFunctions,
    deployRules, verifyRules, readHosting, deployHosting, verifyHosting });
}

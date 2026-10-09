// Private structural commitments, never provider values or dynamic keys.
// HMAC key stays in memory. Local durability does not survive runner teardown.
import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, open, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, join, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { canonicalData, requireActiveUpdate as need } from './floating-garden-active-update.mjs';
const KEYS = new Set(('baseline current before after data proof settings functions function inventory run iam functionIam build service template containers buildConfig serviceConfig name environment state stateMessages updateTime createTime deleteTime lastModifier creator client clientVersion description labels runtime entryPoint environmentVariables serviceAccount serviceAccountEmail source sourceProvenance resolvedStorageSource storageSource bucket object generation revision build dockerRepository onDeployUpdatePolicy runtimeVersion uri availableMemory availableCpu timeoutSeconds maxInstanceCount minInstanceCount maxInstanceRequestConcurrency ingressSettings vpcConnector vpcConnectorEgressSettings secretEnvironmentVariables secretVolumes key projectId secret version versions mountPath path concurrency cpuIdle startupCpuBoost resources limits ports containerPort env value valueSource secretKeyRef scaling timeout serviceAccount traffic trafficStatuses percent type tag observedGeneration etag terminalCondition conditions latestCreatedRevision latestReadyRevision reconciling invokerIamDisabled defaultUriDisabled ingress binaryAuthorization annotations encryptionKey bindings role members condition expression title auditConfigs auditLogConfigs logType exemptedMembers project secretVersion secretLatest artifacts apis auth appCheck appCheckServices config enabled services nextPageToken retainedDigest documentCount roomCount records gate usage testers active testerUids startsAtMillis endsAtMillis maxRooms createdRoomCount schemaVersion sourceAssignment oldManifestDigest newManifestDigest capturedAtMillis scope fingerprint historicalPreservation executionAllowed GOOGLE_NODE_RUN_SCRIPTS EVENTARC_CLOUD_EVENT_SOURCE FIREBASE_CONFIG FUNCTION_TARGET GCLOUD_PROJECT LOG_EXECUTION_ID FUNCTION_SIGNATURE_TYPE deployment-callable deployment-tool firebase-functions-codebase firebase-functions-hash').split(' '));
const EVENTS = new Set(['baseline', 'prewrite-functions', 'prewrite-rules', 'prewrite-hosting', 'preservation-failure', 'recovery-round', 'recovery-candidate']);
export function preservationDifference(before, after, category) {
  need(['functions', 'settings', 'configuration', 'inventory', 'data'].includes(category), 'journal');
  const paths = new Set(); let visited = 0, truncated = false, unknown = false;
  function walk(a, b, path, depth) {
    if (++visited > 20000 || depth > 32) { truncated = true; return; }
    if (isDeepStrictEqual(a, b)) return;
    if (paths.size >= 32) { truncated = true; return; }
    if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
      for (const key of keys) {
        const segment = Array.isArray(a) ? '[*]' : KEYS.has(key) ? key : '$unknown';
        if (segment === '$unknown') unknown = true;
        const next = `${path}.${segment}`;
        if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) paths.add(next);
        else walk(a[key], b[key], next, depth + 1);
        if (paths.size >= 32) { truncated = true; break; }
      }
    } else paths.add(path);
  }
  walk(before, after, category, 0);
  return Object.freeze({ category, paths: Object.freeze([...paths].slice(0, 32)), unknown, truncated });
}
export async function createPrivateEvidence(parent, { syncFile = file => file.sync(), syncDirectory = file => file.sync() } = {}) {
  need(typeof parent === 'string' && isAbsolute(parent) && resolve(parent) === parent && !/[\x00-\x1f]/.test(parent), 'journal');
  let part = sep;
  for (const name of parent.split(sep).filter(Boolean)) { part = join(part, name); const s = await lstat(part); need(s.isDirectory() && !s.isSymbolicLink(), 'journal'); }
  const parentStat = await lstat(parent);
  need(await realpath(parent) === parent && !(parentStat.mode & 0o077) && parentStat.uid === process.getuid(), 'journal');
  const directory = join(parent, 'PRIVATE-EVIDENCE'); await mkdir(directory, { mode: 0o700 });
  const directoryStat = await lstat(directory);
  const checkDirectory = async (path, expected) => {
    const s = await lstat(path); need(s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid() && !(s.mode & 0o077) &&
      s.dev === expected.dev && s.ino === expected.ino && await realpath(path) === path, 'journal');
  };
  const key = randomBytes(32); let sequence = 0, failed = false;
  const mac = value => createHmac('sha256', key).update(value).digest('hex');
  const syncDir = async path => { const file = await open(path, 'r'); try { await syncDirectory(file); } finally { await file.close(); } };
  await syncDir(parent);
  function structure(value, depth = 0) {
    need(depth <= 40, 'journal');
    if (Array.isArray(value)) return { type: 'array', items: value.map(x => structure(x, depth + 1)) };
    if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      return { type: 'object', entries: Object.keys(value).sort().map(k => ({ key: KEYS.has(k) ? k : '$unknown', keyCommitment: mac(k), value: structure(value[k], depth + 1) })) };
    }
    return { type: value === null ? 'null' : typeof value, commitment: mac(canonicalData(value)) };
  }
  return Object.freeze({ async append(event, value) {
    need(!failed && EVENTS.has(event) && sequence < 128, 'journal'); failed = true;
    const raw = canonicalData(value); need(Buffer.byteLength(raw) <= 16 * 1024 * 1024, 'journal');
    const bytes = JSON.stringify({ schemaVersion: 1, sequence, event, captureCommitment: mac(raw), structure: structure(value) }) + '\n';
    need(Buffer.byteLength(bytes) <= 64 * 1024 * 1024, 'journal');
    const path = join(directory, `${String(sequence).padStart(4, '0')}.json`);
    await checkDirectory(parent, parentStat); await checkDirectory(directory, directoryStat);
    const file = await open(path, 'wx+', 0o600);
    try {
      const initial = await file.stat();
      const verify = async () => {
        await checkDirectory(parent, parentStat); await checkDirectory(directory, directoryStat);
        const fd = await file.stat(), named = await lstat(path);
        for (const s of [fd, named]) need(s.isFile() && !s.isSymbolicLink() && s.uid === process.getuid() && s.nlink === 1 &&
          (s.mode & 0o777) === 0o600 && s.dev === initial.dev && s.ino === initial.ino && s.size === Buffer.byteLength(bytes), 'journal');
        const buffer = Buffer.alloc(Buffer.byteLength(bytes));
        const got = await file.read(buffer, 0, buffer.length, 0);
        need(got.bytesRead === buffer.length && buffer.equals(Buffer.from(bytes)), 'journal');
      };
      need(initial.isFile() && initial.uid === process.getuid() && initial.nlink === 1 && (initial.mode & 0o777) === 0o600, 'journal');
      await file.writeFile(bytes); await syncFile(file); await verify();
      await syncDir(directory); await verify();
    } finally { await file.close(); }
    sequence++; failed = false;
    return { saved: true, sequence: sequence - 1 };
  } });
}

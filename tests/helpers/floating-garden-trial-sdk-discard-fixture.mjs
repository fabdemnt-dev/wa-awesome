// Test-only diagnostic instrumentation, outside every deployable tree. The
// vendored SDK stays byte-for-byte official; only an exact test SDK module
// response receives these two observational comma expressions. Neither
// SDK comparisons, callbacks, log levels nor native network behavior is changed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const FIRESTORE_DIAGNOSTIC_SOURCE = Object.freeze({
  url: 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js',
  bytes: 434464,
  sha256: 'd5b81349f2b7b2317bacdd3effd576d4e0a747ff12eab684f77956ebc1fe7040',
});
export const DISCARD_ANCHOR = '__PRIVATE_logDebug("LocalStore","Ignoring outdated watch update for ",n,". Current version:",u.version," Watch version:",o.version)';
export const ARRIVAL_ANCHOR = '__PRIVATE_logDebug(Ft,`RPC \'${e}\' stream ${i} received:`,s),g.mo(s)';
const PRIVATE_STATE = '__PRIVATE_trialWatchDiagnostics1080';
const DISCARD_HOOK = '__PRIVATE_trialRecordDiscard1080';
const ARRIVAL_HOOK = '__PRIVATE_trialRecordArrival1080';

export function isTrialDiagnosticFirestoreRequest(address, method) {
  return method === 'GET' && address === `${FIRESTORE_DIAGNOSTIC_SOURCE.url}?trial-emulator-original=1`;
}

export function isOnlineDiagnosticFirestoreRequest(address, method) {
  return method === 'GET' && address === FIRESTORE_DIAGNOSTIC_SOURCE.url;
}

// Self-contained for embedding in the browser module. No arguments, documents,
// names, keys, IDs, URLs, payloads, tokens, raw messages or errors are retained.
// Only fixed field paths and numeric/boolean/allowlisted enum values are copied.
export function createTrialSdkWatchDiagnostics(now = () => performance.now()) {
  const events = [];
  const counts = { discardEqual: 0, discardEqualWithNewerRevision: 0, discardOlderWithNewerRevision: 0, discardOlder: 0, discardNewer: 0, discardUnknown: 0,
    listenDocumentChange: 0, listenTargetChange: 0, listenOther: 0 };
  let sequence = 0, time = 0, overflow = 0;
  const safe = (read) => { try { return read(); } catch { return null; } };
  const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const integerValue = (value) => {
    if (typeof value === 'string' && /^(?:0|[1-9]\d{0,15})$/.test(value)) return nonnegative(Number(value));
    return nonnegative(value);
  };
  const revision = (fields) => ({
    revision: integerValue(safe(() => fields.revision.integerValue)),
    matchRevision: integerValue(safe(() => fields.match.mapValue.fields.revision.integerValue)),
  });
  const timestamp = (seconds, nanoseconds) => Number.isSafeInteger(seconds) && seconds >= -62135596800 && seconds <= 253402300799 &&
    Number.isSafeInteger(nanoseconds) && nanoseconds >= 0 && nanoseconds <= 999999999 ? { seconds, nanoseconds } : null;
  const sdkVersion = (document) => {
    const value = safe(() => document.version.toTimestamp());
    return timestamp(safe(() => value.seconds), safe(() => value.nanoseconds));
  };
  const wireTimestamp = (value) => {
    if (typeof value !== 'string') return null;
    const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
    if (!parts) return null;
    const milliseconds = Date.parse(`${parts[1]}.000Z`);
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 19) !== parts[1]) return null;
    return timestamp(milliseconds / 1000, Number((parts[2] || '').padEnd(9, '0')));
  };
  const found = (document) => { const value = safe(() => document.isFoundDocument()); return typeof value === 'boolean' ? value : null; };
  const bump = (value) => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
  function record(category, fields) {
    const measured = safe(now);
    if (typeof measured === 'number' && Number.isFinite(measured) && measured >= 0 && measured <= Number.MAX_SAFE_INTEGER) time = Math.max(time, Math.floor(measured));
    sequence = bump(sequence);
    counts[category] = bump(counts[category]);
    events.push({ code: 'trial-firestore-watch-v1', sequence, time, category, ...fields });
    if (events.length > 256) { events.shift(); overflow = bump(overflow); }
  }
  function discard(incoming, current) {
    try {
      const incomingRevision = revision(safe(() => incoming.data.value.mapValue.fields));
      const currentRevision = revision(safe(() => current.data.value.mapValue.fields));
      const incomingVersion = sdkVersion(incoming), currentVersion = sdkVersion(current);
      // Derive the sign from the copied timestamps: never invoke compareTo a
      // second time, rewrite a version, or alter the SDK's acceptance condition.
      const comparison = !incomingVersion || !currentVersion ? null : Math.sign(incomingVersion.seconds - currentVersion.seconds || incomingVersion.nanoseconds - currentVersion.nanoseconds);
      const newerRevision = ['revision', 'matchRevision'].some((key) => incomingRevision[key] !== null && currentRevision[key] !== null && incomingRevision[key] > currentRevision[key]);
      const category = comparison === null ? 'discardUnknown' : comparison === 0 ? newerRevision ? 'discardEqualWithNewerRevision' : 'discardEqual' : comparison > 0 ? 'discardNewer' : newerRevision ? 'discardOlderWithNewerRevision' : 'discardOlder';
      record(category, { incoming: incomingRevision, current: currentRevision, incomingVersion, currentVersion, comparison,
        incomingFound: found(incoming), currentFound: found(current) });
    } catch { /* Diagnostic failures never change SDK logging/error semantics. */ }
  }
  function arrival(method, message) {
    try {
      if (method !== 'Listen') return;
      if (safe(() => message.documentChange) != null) {
        record('listenDocumentChange', { incoming: revision(safe(() => message.documentChange.document.fields)),
          incomingVersion: wireTimestamp(safe(() => message.documentChange.document.updateTime)) });
      } else if (safe(() => message.targetChange) != null) {
        const type = safe(() => message.targetChange.targetChangeType);
        const targetCount = safe(() => message.targetChange.targetIds === undefined ? 0 : Array.isArray(message.targetChange.targetIds) ? message.targetChange.targetIds.length : null);
        record('listenTargetChange', { targetType: type === undefined ? 'NO_CHANGE' : ['NO_CHANGE', 'ADD', 'REMOVE', 'CURRENT', 'RESET'].includes(type) ? type : 'UNKNOWN',
          readTime: wireTimestamp(safe(() => message.targetChange.readTime)),
          targetCount: nonnegative(targetCount), global: nonnegative(targetCount) === null ? null : targetCount === 0 });
      } else record('listenOther', {});
    } catch { /* Never suppress or replace the original stream callback. */ }
  }
  return Object.freeze({ discard, arrival, snapshot: () => ({ events: events.map((event) => ({ ...event,
    ...('incoming' in event ? { incoming: { ...event.incoming } } : {}), ...('current' in event ? { current: { ...event.current } } : {}),
    ...('incomingVersion' in event ? { incomingVersion: event.incomingVersion && { ...event.incomingVersion } } : {}),
    ...('currentVersion' in event ? { currentVersion: event.currentVersion && { ...event.currentVersion } } : {}),
    ...('readTime' in event ? { readTime: event.readTime && { ...event.readTime } } : {}),
  })), counts: { ...counts }, overflow }) });
}

export function instrumentTrialFirestoreSdk(bytes) {
  assert.ok(Buffer.isBuffer(bytes), 'Firestore diagnostics require exact original bytes');
  assert.equal(bytes.length, FIRESTORE_DIAGNOSTIC_SOURCE.bytes, 'Firestore diagnostic source byte length');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), FIRESTORE_DIAGNOSTIC_SOURCE.sha256, 'Firestore diagnostic source SHA-256');
  const source = bytes.toString('utf8');
  for (const anchor of [DISCARD_ANCHOR, ARRIVAL_ANCHOR]) assert.equal(source.split(anchor).length - 1, 1, 'Firestore diagnostic anchor must occur exactly once');
  for (const name of [PRIVATE_STATE, DISCARD_HOOK, ARRIVAL_HOOK]) assert.ok(!source.includes(name), 'Firestore diagnostic hook must be absent from the original SDK');
  const prelude = `// Test-only observer; official source is pinned and unchanged on disk.\nconst ${PRIVATE_STATE}=(${createTrialSdkWatchDiagnostics.toString()})();\nconst ${DISCARD_HOOK}=${PRIVATE_STATE}.discard,${ARRIVAL_HOOK}=${PRIVATE_STATE}.arrival;\nglobalThis.__trialSdkWatchDiagnostics=${PRIVATE_STATE}.snapshot;\n`;
  return prelude + source.replace(DISCARD_ANCHOR, `(${DISCARD_HOOK}(o,u),${DISCARD_ANCHOR})`)
    .replace(ARRIVAL_ANCHOR, `(${ARRIVAL_HOOK}(e,s),${ARRIVAL_ANCHOR})`);
}

export async function loadTrialDiagnosticFirestoreSdk() {
  const base = new URL('../fixtures/firebase-10.8.0/', import.meta.url);
  const provenance = JSON.parse(await readFile(new URL('firestore-provenance.json', base), 'utf8'));
  assert.equal(provenance.version, '10.8.0');
  assert.equal(provenance.license, 'Apache-2.0');
  assert.deepEqual(provenance.files, { 'firebase-firestore.js': FIRESTORE_DIAGNOSTIC_SOURCE });
  return instrumentTrialFirestoreSdk(await readFile(new URL('firebase-firestore.js', base)));
}

export async function collectTrialSdkWatchDiagnostics(page) {
  // The page exposes only a copy of sanitized private state. A closed/reloading
  // page must never hide the original test failure or capture evaluation errors.
  try { return await page.evaluate(() => typeof globalThis.__trialSdkWatchDiagnostics === 'function' ? globalThis.__trialSdkWatchDiagnostics() : null); }
  catch { return null; }
}

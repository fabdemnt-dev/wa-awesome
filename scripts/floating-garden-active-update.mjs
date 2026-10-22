#!/usr/bin/env node
// Narrow first-NPC rollout preparation. The CLI is offline/read-only. There is
// deliberately no apply flag; a reviewed source fence does not grant deployment approval.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual, types } from 'node:util';
import { resolve, join, sep } from 'node:path';
import { open, lstat, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readOperationPacket, verifyOperationPacket } from './operate-floating-garden-trial.mjs';
import { publicTrialConfig } from './prepare-floating-garden-trial-operation.mjs';

export const ACTIVE_UPDATE_SCOPE = Object.freeze({
  project: 'wa-awesome-garden-stg', projectNumber: '120030709276', region: 'asia-northeast1',
  origin: 'https://wa-awesome-garden-stg.web.app', maxRooms: 20,
  startsAtMillis: 1791157551472, endsAtMillis: 1791762351472,
  oldCommit: 'ce20dce88490ee42cc8e427ab90b0b2c8a576c95',
  reviewedNpcBaseCommit: 'b0f920a564ee64bf06b185dc39016fe3852793ab',
  npcRoomVersion: 'floating-garden-online-npc-1',
  // SHA256 of the complete sorted generated inventory, not just a declared source audit.
  oldInventory: '7522e7898cf31e9a9d7b1d65b8c91a60403e14ff8072f6c0d8ccd1f682344352',
  newInventory: '41c44301490ecff08b0753d4af85679a04bfebdea8ad1981bd8a923c8a76a4ca',
});
export const ACTIVE_UPDATE_ADDED = Object.freeze(['game/functions/online/core/cpu.js']);
export const ACTIVE_UPDATE_CHANGED = Object.freeze([
  'game/SOURCE-SHA256.json', 'game/firestore.rules', 'game/functions/online/contract.js',
  'game/functions/online/handlers.js', 'game/public/lab/floating-garden/online/controller.js',
  'game/public/lab/floating-garden/online/mount.js', 'game/public/lab/floating-garden/online/style.css',
  'game/public/lab/floating-garden/online/view.js',
]);
export const ACTIVE_UPDATE_BLOCKERS = Object.freeze([
  'owner-execution-approval-required', 'reviewed-provider-runner-required',
]);
const reasons = new Set(['local-packet', 'packet-review-mismatch', 'packet-source-pin', 'packet-delta',
  'fixed-window', 'admin-state', 'admin-race', 'usage-preservation', 'data-preservation',
  'source-proof', 'iam-preservation', 'provider-drift', 'old-invocation-isolation-unproved',
  'provider-writes-not-enabled', 'approval-required', 'journal', 'mutation-unknown', 'mutation-failed',
  'provider-read', 'inventory-shape', 'inventory-limit', 'unsafe-retry', 'stage-order', 'unclassified']);
const failures = new WeakMap(), failureDetails = new WeakMap();
export const PROVIDER_STAGES = Object.freeze(['input', 'read', 'functions-source-url', 'functions-source-upload', 'function-patch',
  'rules-create', 'rules-release', 'hosting-create', 'hosting-populate', 'hosting-file-upload', 'hosting-finalize', 'hosting-release', 'hosting-inventory']);
export function activeUpdateFailure(reason, detail) {
  const code = reasons.has(reason) ? reason : 'unclassified';
  const error = new Error(`Active update blocked: ${code}. No automatic retry or rollback.`);
  failures.set(error, code);
  if (detail && PROVIDER_STAGES.includes(detail.stage)) failureDetails.set(error, Object.freeze({ providerStage: detail.stage,
    ...(Number.isInteger(detail.completedFunctionCount) && detail.completedFunctionCount >= 0 && detail.completedFunctionCount <= 5 ? { completedFunctionCount: detail.completedFunctionCount } : {}) }));
  return error;
}
export function activeUpdateDetails(error) { return failureDetails.get(error) || {}; }
export function activeUpdateReason(error) { return failures.get(error) || 'unclassified'; }
export function requireActiveUpdate(condition, reason) { if (!condition) throw activeUpdateFailure(reason); }
export const digest = value => createHash('sha256').update(value).digest('hex');
// Canonical encoding is for trusted provider data, never logging. Reject values
// we cannot preserve exactly. Firestore Timestamp's nanoseconds are retained.
export function canonicalData(value) {
  function encode(input) {
    if (input === null) return ['null'];
    if (typeof input === 'string' || typeof input === 'boolean') return [typeof input, input];
    if (typeof input === 'number' && Number.isFinite(input)) return ['number', Object.is(input, -0) ? '-0' : String(input)];
    if (input && typeof input === 'object' && !types.isProxy(input)) {
      if (Array.isArray(input)) return ['array', input.map(encode)];
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) {
        if (Number.isSafeInteger(input._seconds) && Number.isInteger(input._nanoseconds) && input._nanoseconds >= 0 && input._nanoseconds < 1e9 &&
            typeof input.toMillis === 'function' && typeof input.toDate === 'function') return ['timestamp', input._seconds, input._nanoseconds];
        throw activeUpdateFailure('inventory-shape');
      }
      return ['map', Object.keys(input).sort().map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        requireActiveUpdate(Object.hasOwn(descriptor, 'value'), 'inventory-shape'); return [key, encode(descriptor.value)];
      })];
    }
    throw activeUpdateFailure('inventory-shape');
  }
  return JSON.stringify(encode(value));
}
export const dataDigest = value => digest(canonicalData(value));
const plans = new WeakMap();
function deepFreeze(value) { if (value && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); } return value; }
export async function prepareActiveUpdatePlan({ previousOutput, nextOutput } = {}) {
  let old, next;
  try { old = await readOperationPacket(previousOutput); next = await readOperationPacket(nextOutput); }
  catch { throw activeUpdateFailure('local-packet'); }
  const previous = old.packet.manifest.files, current = next.packet.manifest.files;
  const keys = value => Object.keys(value).sort();
  requireActiveUpdate(isDeepStrictEqual(old.review, next.review), 'packet-review-mismatch');
  const review = next.review;
  requireActiveUpdate(review.startsAtMillis === ACTIVE_UPDATE_SCOPE.startsAtMillis && review.endsAtMillis === ACTIVE_UPDATE_SCOPE.endsAtMillis, 'fixed-window');
  const added = keys(current).filter(name => !Object.hasOwn(previous, name));
  const removed = keys(previous).filter(name => !Object.hasOwn(current, name));
  const changed = keys(previous).filter(name => Object.hasOwn(current, name) && previous[name] !== current[name]);
  requireActiveUpdate(isDeepStrictEqual(added, ACTIVE_UPDATE_ADDED) && !removed.length && isDeepStrictEqual(changed, ACTIVE_UPDATE_CHANGED), 'packet-delta');
  // The generator orders ASCII paths by code point. Avoid locale-specific ordering.
  const pinnedDigest = files => digest(JSON.stringify(Object.fromEntries(Object.keys(files).sort().map(key => [key, files[key]]))));
  requireActiveUpdate(pinnedDigest(previous) === ACTIVE_UPDATE_SCOPE.oldInventory && pinnedDigest(current) === ACTIVE_UPDATE_SCOPE.newInventory, 'packet-source-pin');
  const plan = Object.freeze({ schemaVersion: 1, kind: 'first-npc-active-update-plan',
    project: ACTIVE_UPDATE_SCOPE.project, oldManifestDigest: old.packet.manifestDigest,
    newManifestDigest: next.packet.manifestDigest, added: ACTIVE_UPDATE_ADDED, changed: ACTIVE_UPDATE_CHANGED,
    unchangedFileCount: keys(previous).length - changed.length, preservedTesterCount: 2, maxRooms: 20,
    startsAtMillis: review.startsAtMillis, endsAtMillis: review.endsAtMillis,
    executionReady: false, blockers: ACTIVE_UPDATE_BLOCKERS, automaticRollback: false,
    providerAtomicCas: false, rulesPropagationVerified: false, runtimeImagePreserved: false,
    phases: Object.freeze(['read-only-baseline', 'pause-cas', 'verify-closed', 'update-five-functions',
      'verify-functions-and-iam', 'update-dedicated-rules', 'verify-rules', 'update-exact-hosting',
      'verify-hosting', 'verify-preservation', 'prove-old-invocation-isolation', 'reopen-cas', 'verify-reopened']),
  });
  plans.set(plan, deepFreeze({ old, next })); return plan;
}
export function activeUpdatePackets(plan) {
  const packets = plans.get(plan); requireActiveUpdate(Boolean(packets), 'local-packet');
  // Keep private review and source paths off public plan/report serialization.
  return packets;
}
export async function recheckActiveUpdatePlan(plan) {
  const { old, next } = activeUpdatePackets(plan);
  try { await verifyOperationPacket(old.packet); await verifyOperationPacket(next.packet); }
  catch { throw activeUpdateFailure('local-packet'); }
  return true;
}
export function assertActiveRecords(records, review, { active, now } = {}) {
  publicTrialConfig(review);
  requireActiveUpdate(records && records.gate && records.usage && Array.isArray(records.testers) && records.testers.length === 2, 'admin-state');
  const gate = records.gate, usage = records.usage;
  for (const field of ['projectId', 'region', 'previewOrigin', 'startsAtMillis', 'endsAtMillis', 'maxRooms']) {
    const expected = { projectId: ACTIVE_UPDATE_SCOPE.project, region: ACTIVE_UPDATE_SCOPE.region,
      previewOrigin: ACTIVE_UPDATE_SCOPE.origin, startsAtMillis: review.startsAtMillis, endsAtMillis: review.endsAtMillis, maxRooms: 20 }[field];
    requireActiveUpdate(gate[field] === expected, 'admin-state');
    if (!['region', 'previewOrigin'].includes(field)) requireActiveUpdate(usage[field] === expected, 'admin-state');
  }
  requireActiveUpdate(typeof active === 'boolean' && gate.enabled === active &&
    isDeepStrictEqual(gate.testerUids, active ? review.testerUids : []), 'admin-state');
  requireActiveUpdate(records.testers.every(tester => tester && tester.active === active && tester.expiresAtMillis === review.endsAtMillis), 'admin-state');
  requireActiveUpdate(Number.isSafeInteger(usage.createdRoomCount) && usage.createdRoomCount > 0 && usage.createdRoomCount <= 20, 'admin-state');
  if (now !== undefined) requireActiveUpdate(Number.isSafeInteger(now) && now >= review.startsAtMillis && now < review.endsAtMillis, 'fixed-window');
  return true;
}
export function toggleActiveRecords(records, review, active) {
  assertActiveRecords(records, review, { active: !active });
  return { ...records, gate: { ...records.gate, enabled: active, testerUids: active ? [...review.testerUids] : [] },
    testers: records.testers.map(tester => ({ ...tester, active })) };
}
export function assertPreservedRecords(before, after, review, active) {
  assertActiveRecords(after, review, { active });
  requireActiveUpdate(isDeepStrictEqual(before.usage, after.usage), 'usage-preservation');
  const expected = before.gate.enabled === active ? before : toggleActiveRecords(before, review, active);
  requireActiveUpdate(isDeepStrictEqual(expected, after), 'data-preservation'); return true;
}
// This proof is rooted in exact complete old/new generated-byte pins above,
// not an injected success flag or a timeout. The new NPC wire version is
// rejected by old readRoom before old reads/replays/mutations reach NPC data.
// Existing room modes are immutable and the provider separately establishes a
// first-upgrade legacy-only baseline. No claim of request drainage is made.
export function proveOldInvocationIsolation(plan) {
  activeUpdatePackets(plan);
  return Object.freeze({ kind: 'source-version-fence', oldInvocationsDrained: false,
    legacyRoomVersion: 'floating-garden-match-1', npcRoomVersion: ACTIVE_UPDATE_SCOPE.npcRoomVersion,
    oldInventory: ACTIVE_UPDATE_SCOPE.oldInventory, newInventory: ACTIVE_UPDATE_SCOPE.newInventory });
}
const APPROVAL_KEYS = Object.freeze(['oldManifestDigest', 'newManifestDigest', 'pauseExistingPair',
  'updateFiveFunctionSources', 'updateDedicatedRules', 'updateExactHosting', 'reopenExistingPair',
  'retainAllData', 'preserveExistingIam', 'exclusiveMaintenance']);
export function validateActiveUpdateApproval(approval, plan) {
  requireActiveUpdate(approval && isDeepStrictEqual(Object.keys(approval).sort(), [...APPROVAL_KEYS].sort()) &&
    approval.oldManifestDigest === plan.oldManifestDigest && approval.newManifestDigest === plan.newManifestDigest &&
    APPROVAL_KEYS.filter(k => !k.endsWith('Digest')).every(k => approval[k] === true), 'approval-required');
}
export async function createActiveUpdateJournal({ plan, now = Date.now } = {}) {
  await recheckActiveUpdatePlan(plan); const { next } = activeUpdatePackets(plan);
  let current = sep;
  for (const part of next.packet.output.split(sep).filter(Boolean)) {
    current = join(current, part); const info = await lstat(current);
    requireActiveUpdate(info.isDirectory() && !info.isSymbolicLink(), 'journal');
  }
  requireActiveUpdate(await realpath(current) === current, 'journal');
  let file;
  try { file = await open(join(current, 'ACTIVE-UPDATE-JOURNAL.jsonl'), 'wx', 0o600); }
  catch { throw activeUpdateFailure('journal'); }
  let failed = false, terminal = false; const issued = new Set();
  const append = async value => {
    requireActiveUpdate(!failed && !terminal, 'journal');
    try {
      const atMillis = now(); requireActiveUpdate(Number.isSafeInteger(atMillis) && atMillis > 0, 'journal');
      await file.writeFile(JSON.stringify({ schemaVersion: 1, atMillis, ...value }) + '\n'); await file.sync();
    } catch { failed = true; throw activeUpdateFailure('journal'); }
  };
  await append({ event: 'created', oldManifestDigest: plan.oldManifestDigest, newManifestDigest: plan.newManifestDigest });
  return Object.freeze({
    async issued(stage) { requireActiveUpdate(plan.phases.includes(stage) && !issued.has(stage), 'unsafe-retry'); issued.add(stage); await append({ event: 'issued', stage }); },
    async providerStep(step) {
      requireActiveUpdate(step && PROVIDER_STAGES.includes(step.stage) && ['functions', 'rules', 'hosting'].includes(step.resourceKind) && Number.isInteger(step.index) && step.index >= 0 && step.index < 5, 'journal');
      await append({ event: 'provider-issued', stage: step.stage, resourceKind: step.resourceKind, index: step.index });
    },
    async verified(stage) { requireActiveUpdate(issued.has(stage), 'stage-order'); await append({ event: 'verified', stage }); },
    async finish() { await append({ event: 'finished', status: 'active-updated' }); terminal = true; await file.close(); },
    async fail(stage, reason, access) {
      try { await append({ event: 'blocked', stage: plan.phases.includes(stage) ? stage : 'read-only-baseline',
        reason: reasons.has(reason) ? reason : 'unclassified', access: ['closed', 'open', 'unknown'].includes(access) ? access : 'unknown' }); }
      finally { terminal = true; await file.close(); }
    },
  });
}
export async function executeActiveUpdate({ plan, mode = 'plan', approval, cloud, journal, now = Date.now } = {}) {
  await recheckActiveUpdatePlan(plan);
  requireActiveUpdate(['plan', 'inspect', 'apply'].includes(mode), 'stage-order');
  if (mode === 'plan') return plan;
  if (mode === 'inspect') return cloud.inspect();
  validateActiveUpdateApproval(approval, plan);
  proveOldInvocationIsolation(plan);
  requireActiveUpdate(journal && ['issued', 'verified', 'providerStep', 'finish', 'fail'].every(key => typeof journal[key] === 'function'), 'journal');
  requireActiveUpdate(typeof cloud?.bindJournal === 'function', 'journal'); cloud.bindJournal(journal);
  const current = () => requireActiveUpdate(Number.isSafeInteger(now()) && now() >= plan.startsAtMillis && now() < plan.endsAtMillis, 'fixed-window');
  let stage = 'read-only-baseline', access = 'unknown';
  const issued = async name => { stage = name; await recheckActiveUpdatePlan(plan); current(); await journal.issued(name); };
  const accepted = result => requireActiveUpdate(result?.kind === 'success', result?.kind === 'unknown' ? 'mutation-unknown' : 'mutation-failed');
  try {
    current(); const baseline = await cloud.inspect();
    requireActiveUpdate(baseline?.kind === 'baseline' && /^[a-f0-9]{64}$/.test(baseline.fingerprint), 'source-proof');
    await issued('pause-cas'); accepted(await cloud.pause(baseline.fingerprint));
    stage = 'verify-closed'; await cloud.assertClosed(); access = 'closed'; await journal.verified('pause-cas');
    for (const [write, verify, method, checkMethod] of [
      ['update-five-functions', 'verify-functions-and-iam', 'updateFunctions', 'verifyFunctions'],
      ['update-dedicated-rules', 'verify-rules', 'updateRules', 'verifyRules'],
      ['update-exact-hosting', 'verify-hosting', 'updateHosting', 'verifyHosting'],
    ]) {
      await issued(write); accepted(await cloud[method]()); stage = verify;
      requireActiveUpdate((await cloud[checkMethod]())?.kind === 'verified', 'source-proof'); await journal.verified(write);
    }
    stage = 'verify-preservation'; requireActiveUpdate((await cloud.verifyPreservation())?.kind === 'verified', 'data-preservation');
    stage = 'prove-old-invocation-isolation'; proveOldInvocationIsolation(plan);
    await issued('reopen-cas'); accepted(await cloud.reopen()); access = 'open'; await journal.verified('reopen-cas');
    stage = 'verify-reopened'; requireActiveUpdate((await cloud.verifyReopened())?.kind === 'verified', 'data-preservation');
    await journal.finish();
    return { status: 'active-updated', access: 'open', preservedTesterCount: 2, endsAtMillis: plan.endsAtMillis,
      usageWritten: false, oldInvocationsDrained: false, oldInvocationsIsolatedBySourceFence: true, automaticRollback: false,
      providerAtomicCas: false, rulesPropagationVerified: false, runtimeImagePreserved: false };
  } catch (error) {
    const reason = activeUpdateReason(error), details = activeUpdateDetails(error);
    // Unknown pause/reopen results are reconciled read-only, never retried or
    // asserted closed merely because the preceding desired state was closed.
    try { access = (await cloud.readAccess()).access; } catch { access = 'unknown'; }
    try { await journal.fail(stage, reason, access); } catch { /* Preserve original stage; no further write. */ }
    return { status: 'blocked', stage, reason, ...details, access, automaticRetry: false, automaticRollback: false };
  }
}
export const ACTIVE_UPDATE_PLAN_TEXT = 'PLAN_ONLY: exact first-NPC source delta; retain the existing two testers, fixed dates, nonzero room usage and all data. The source-version fence is pinned; production execution still needs reviewed tooling and bounded owner approval. No timeout-based drain, retries, deletes, IAM changes or automatic rollback.';
export async function main(args = process.argv.slice(2), { log = console.log } = {}) {
  if (!args.length || args.length === 1 && args[0] === '--plan') { log(ACTIVE_UPDATE_PLAN_TEXT); return 0; }
  if (args.length === 4 && args[0] === '--previous' && args[2] === '--next') {
    try { log(JSON.stringify(await prepareActiveUpdatePlan({ previousOutput: args[1], nextOutput: args[3] }))); return 0; }
    catch (error) { log(`BLOCKED: ${activeUpdateReason(error)}. No cloud action.`); return 1; }
  }
  log('BLOCKED: plan-only interface; execution is unavailable.'); return 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();

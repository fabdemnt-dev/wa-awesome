#!/usr/bin/env node
// Bounded, user-operated trial execution. The default is an offline plan.
// Preparation/testing is not authority to invoke any mutation mode.
import { readFile, writeFile, lstat, readdir, mkdir, open, rename, unlink, realpath, cp } from 'node:fs/promises';
import { resolve, join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { prepareTrialOperation, publicTrialConfig } from './prepare-floating-garden-trial-operation.mjs';
import { validateEnvironment as validateOperatorEnvironment, checkTooling } from './deploy-floating-garden-connection-template.mjs';
import { normalizeFailureDiagnostic, describeAdapterFailure, makeCloudRunner, classifyDeployResult } from './floating-garden-trial-cloud-adapter.mjs';

export const PROJECT = 'wa-awesome-garden-stg';
export const ORIGIN = 'https://wa-awesome-garden-stg.web.app';
export const REGION = 'asia-northeast1';
export const MAX_START_WAIT_MILLIS = 30 * 60000;
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const STATE_FILE = 'OPERATION-STATE.json';
export const ACTIVATION_RECOVERY_FILE = 'ACTIVATION-RECOVERY-STATE.json';
export const HOSTING_UPDATE_FILES = Object.freeze(['game/public/lab/floating-garden/online/controller.js', 'game/public/lab/floating-garden/online/view.js']);
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const same = (a, b) => json(a) === json(b);
const stop = () => { throw new Error('Operation stopped; inspect before any further change.'); };
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function dataEqual(a, b) {
  if (a === b) return true;
  if (!plain(a) || !plain(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => dataEqual(value, b[i]));
  const keys = Object.keys(a).sort();
  return same(keys, Object.keys(b).sort()) && keys.every((key) => dataEqual(a[key], b[key]));
}
export function approvalReady(review) {
  publicTrialConfig(review);
  return review.retainBuildArtifacts === true && review.allowInitialFunctionRecreate === true && review.approvePublicInvoker === true;
}
export function adminRecords(review, active = false, count = 0) {
  const config = publicTrialConfig(review);
  return {
    gate: { enabled: active, projectId: PROJECT, region: REGION, previewOrigin: ORIGIN,
      startsAtMillis: config.startsAtMillis, endsAtMillis: config.endsAtMillis, maxRooms: 20,
      testerUids: active ? [...review.testerUids] : [] },
    usage: { projectId: PROJECT, startsAtMillis: config.startsAtMillis, endsAtMillis: config.endsAtMillis, maxRooms: 20, createdRoomCount: count },
    testers: review.testerUids.map(() => ({ active, expiresAtMillis: config.endsAtMillis })),
  };
}
export function adminState(state, review, { forStop = false } = {}) {
  publicTrialConfig(review);
  if (!plain(state) || !Array.isArray(state.testers) || state.testers.length !== 2) return 'inconsistent';
  if (state.gate === null && state.usage === null && state.testers.every((value) => value === null)) return 'absent';
  if (forStop) {
    // Usage never grants access to existing rooms and is never written by stop.
    // A missing/corrupt usage record must not prevent revoking known access.
    const disabled = adminRecords(review, false), enabled = adminRecords(review, true);
    if (state.gate !== null && ![disabled.gate, enabled.gate].some((gate) => dataEqual(state.gate, gate)) ||
        !state.testers.every((tester, i) => tester === null || [disabled.testers[i], enabled.testers[i]].some((value) => dataEqual(tester, value)))) return 'inconsistent';
    return state.gate?.enabled || state.testers.some((tester) => tester?.active) ? 'active' : 'stopped';
  }
  const count = state.usage?.createdRoomCount;
  if (!Number.isSafeInteger(count) || count < 0 || count > 20) return 'inconsistent';
  for (const active of [false, true]) {
    const expected = adminRecords(review, active, count);
    if (dataEqual(state, expected)) return active ? 'active' : 'stopped';
  }
  return 'inconsistent';
}
function assertState(state, review, expected, { unused = false, minimumCount = 0, forStop = false } = {}) {
  if (adminState(state, review, { forStop }) !== expected) stop();
  if (!forStop && (state.usage.createdRoomCount < minimumCount || unused && state.usage.createdRoomCount !== 0)) stop();
}
function verified(result) { if (result?.verified !== true) stop(); }
function validIdentity(value) { return plain(value) && typeof value.version === 'string' && value.version.length > 0 && ['connection', 'maintenance', 'game', 'stopped'].includes(value.kind); }
function clock(now) { const value = now(); if (!Number.isSafeInteger(value) || value <= 0) stop(); return value; }

/** Pure orchestrator. Tests inject all cloud, journal, clock and wait capabilities. */
export async function operateTrial({ mode, review, priorReview, cloud, journal, now = Date.now, wait = (ms) => new Promise((done) => setTimeout(done, ms)), log = console.log, checkLocal = async () => {} }) {
  publicTrialConfig(review);
  if (!['inspect', 'deploy', 'resume', 'activate', 'stop'].includes(mode)) stop();
  const publishing = mode === 'deploy' || mode === 'resume';
  let stage = 'preflight';
  let failureDiagnostic = null;
  const mutationSucceeded = (result) => {
    if (result?.kind !== 'success') {
      failureDiagnostic = normalizeFailureDiagnostic(result?.diagnostic);
      stop();
    }
  };
  const issue = async (name) => { await checkLocal(); journal.issued(name); if (journal.flush) await journal.flush(); if (mode === 'resume') log(`STAGE: ${name}`); };
  try {
    await checkLocal();
    if (mode === 'inspect') {
      await cloud.preflight('inspect');
      const state = await cloud.readAdmin();
      const hosting = await cloud.readHosting();
      if (!validIdentity(hosting)) stop();
      const result = { mode, admin: adminState(state, review), hosting: hosting.kind, journal: journal.snapshot() };
      log(`INSPECT_ONLY: admin=${result.admin}, hosting=${result.hosting}; no mutation or retry.`);
      return result;
    }
    if (!approvalReady(review)) stop();
    if (mode === 'resume') validateResumeReview(review, priorReview);
    const current = clock(now);
    if (publishing && current >= review.startsAtMillis) stop();
    if (mode === 'activate' && (current < review.startsAtMillis || current >= review.endsAtMillis)) stop();
    journal.begin(mode);
    await cloud.preflight(mode);
    if (mode === 'stop') {
      // The backend gate is stopped before inspecting an unrelated Hosting
      // release. An unknown page must not prevent safe backend revocation.
      stage = 'stop-admin-read';
      const before = await cloud.readAdmin();
      const state = adminState(before, review, { forStop: true });
      if (!['active', 'stopped', 'absent'].includes(state)) stop();
      if (state === 'active') {
        stage = 'stop-admin-write'; await checkLocal(); await issue(stage);
        const next = { ...before, gate: before.gate === null ? null : { ...before.gate, enabled: false, testerUids: [] },
          testers: before.testers.map((tester) => tester === null ? null : { ...tester, active: false }) };
        mutationSucceeded(await cloud.updateAdmin(next, before));
        const after = await cloud.readAdmin();
        assertState(after, review, 'stopped', { forStop: true });
        journal.verified(stage);
      }
      stage = 'stop-hosting-read';
      const identity = await cloud.readHosting();
      if (!validIdentity(identity)) stop();
      verified(await cloud.verifyHosting(identity.kind));
      if (!['maintenance', 'stopped'].includes(identity.kind)) {
        await checkLocal();
        const repeated = await cloud.readHosting(); if (!dataEqual(identity, repeated)) stop();
        stage = 'stop-hosting-write'; await issue(stage);
        mutationSucceeded(await cloud.deployHosting('stopped'));
        verified(await cloud.verifyHosting('stopped'));
        journal.verified(stage);
      }
      await checkLocal(); journal.finish('stopped');
      log('STOPPED: gate/testers disabled and stopped Hosting verified; usage, functions, artifacts, accounts, secrets and IAM retained.');
      return { mode, status: 'stopped' };
    }
    if (publishing) {
      stage = mode === 'resume' ? 'prior-stopped-admin-read' : 'initial-admin-read';
      const initialAdmin = await cloud.readAdmin();
      if (mode === 'resume') assertState(initialAdmin, priorReview, 'stopped', { unused: true });
      else if (adminState(initialAdmin, review) !== 'absent') stop();
      const initialHosting = await cloud.readHosting();
      if (!validIdentity(initialHosting) || !(mode === 'resume' ? ['connection'] : ['connection', 'maintenance']).includes(initialHosting.kind)) stop();
      verified(await cloud.verifyHosting(initialHosting.kind));
      if (mode === 'resume') {
        stage = 'replace-stopped-window';
        if (clock(now) >= review.startsAtMillis) stop();
        await issue(stage);
        mutationSucceeded(await cloud.replaceStoppedWindow(adminRecords(review), initialAdmin));
      } else {
        stage = 'create-stopped-admin'; await checkLocal(); await issue(stage);
        mutationSucceeded(await cloud.createStoppedAdmin(adminRecords(review)));
      }
      assertState(await cloud.readAdmin(), review, 'stopped', { unused: true }); await checkLocal(); journal.verified(stage);
      stage = 'deploy-functions'; await checkLocal(); await issue(stage);
      const functions = await cloud.deployFunctions();
      // A known cleanup-only error may mask function errors. Never trust its
      // wording: all five source/configuration/Run/IAM readbacks are mandatory.
      if (!['success', 'cleanup-warning'].includes(functions?.kind)) {
        failureDiagnostic = normalizeFailureDiagnostic(functions?.diagnostic);
        stop();
      }
      verified(await cloud.verifyFunctions()); journal.verified(stage);
      if (functions.kind === 'cleanup-warning') log('RETENTION_WARNING: CLI reported unconfigured artifact cleanup; all five functions independently verified. No retention policy changed.');
      assertState(await cloud.readAdmin(), review, 'stopped', { unused: true });
      stage = 'deploy-rules'; await checkLocal(); await issue(stage);
      mutationSucceeded(await cloud.deployRules()); verified(await cloud.verifyRules()); journal.verified(stage);
      assertState(await cloud.readAdmin(), review, 'stopped', { unused: true });
      stage = 'deploy-hosting'; await checkLocal();
      if (!dataEqual(await cloud.readHosting(), initialHosting)) stop();
      await issue(stage); mutationSucceeded(await cloud.deployHosting('game'));
      verified(await cloud.verifyHosting('game')); journal.verified(stage);
      assertState(await cloud.readAdmin(), review, 'stopped', { unused: true });
      await checkLocal(); journal.finish('published-stopped');
      const readyAt = clock(now);
      // Do not burn the chosen seven days by silently activating after a delayed
      // build, and never move the deadline. An explicit later activate is allowed
      // only after the owner has reviewed that timing change.
      if (readyAt >= review.startsAtMillis) {
        log('READY_STOPPED: deployment verified but chosen start passed; do not activate or extend the deadline without reviewing the fixed window.');
        return { mode, status: 'published-stopped', reason: 'start-passed' };
      }
      if (review.startsAtMillis - readyAt > MAX_START_WAIT_MILLIS) {
        log('READY_STOPPED: deployment verified; chosen start is more than 30 minutes away. A separately requested activate at that fixed start is required.');
        return { mode, status: 'published-stopped', reason: 'future-start' };
      }
      stage = 'wait-for-fixed-start';
      while (clock(now) < review.startsAtMillis) await wait(Math.min(1000, review.startsAtMillis - clock(now)));
      if (clock(now) - review.startsAtMillis > 60000) {
        log('READY_STOPPED: the fixed start was missed while waiting; no automatic activation or extension.');
        return { mode, status: 'published-stopped', reason: 'late-wake' };
      }
    }
    if (publishing) journal.begin('activate');
    stage = 'activation-readback'; await checkLocal();
    if (clock(now) < review.startsAtMillis || clock(now) >= review.endsAtMillis) stop();
    verified(await cloud.verifyFunctions()); verified(await cloud.verifyRules()); verified(await cloud.verifyHosting('game'));
    const before = await cloud.readAdmin(); assertState(before, review, 'stopped', { unused: true });
    stage = 'activate-two-testers'; await issue(stage);
    // Local integrity checks and durable journaling can also cross the fixed
    // start grace period. Recheck immediately before the actual activation.
    if (clock(now) < review.startsAtMillis || clock(now) >= review.endsAtMillis) stop();
    if (publishing && clock(now) - review.startsAtMillis > 60000) {
      journal.finish('published-stopped');
      log('READY_STOPPED: verification missed the fixed start; no automatic activation or extension.');
      return { mode, status: 'published-stopped', reason: 'late-verification' };
    }
    mutationSucceeded(await cloud.updateAdmin(adminRecords(review, true), before));
    assertState(await cloud.readAdmin(), review, 'active', { minimumCount: 0 }); await checkLocal(); journal.verified(stage);
    journal.finish('active');
    log('ACTIVE: exact two testers and fixed window verified. The first game still needs the approved owner check.');
    return { mode, status: 'active' };
  } catch (error) {
    const diagnostic = failureDiagnostic ?? describeAdapterFailure(error);
    if (mode !== 'inspect') journal.fail(stage, diagnostic);
    const detail = `reason=${diagnostic.reason}, exit=${diagnostic.exitCode ?? 'unknown'}, timeout=${diagnostic.timedOut}${diagnostic.httpStatus === undefined ? '' : `, http=${diagnostic.httpStatus}`}`;
    log(`STOP: ${stage}. ${detail}. No mutation is retried; inspect the saved operation before any further action. Raw diagnostics suppressed.`);
    return { mode, status: 'blocked', stage, diagnostic };
  }
}

async function regular(path, limit = 32 * 1024 * 1024) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > limit) stop();
  return readFile(path);
}
async function directory(path) {
  if (await realpath(path) !== resolve(path)) stop();
  const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) stop();
}
export async function readOperationPacket(output) {
  const path = resolve(output); await directory(path);
  const reviewPath = join(path, 'private-review.json');
  const info = await lstat(reviewPath); if ((info.mode & 0o077) !== 0) stop();
  const reviewBytes = await regular(reviewPath, 8192), review = JSON.parse(reviewBytes);
  publicTrialConfig(review);
  const manifestPath = join(path, 'OPERATION-MANIFEST.json'), manifestBytes = await regular(manifestPath, 32768), manifest = JSON.parse(manifestBytes);
  if (manifest.schemaVersion !== 1 || manifest.projectId !== PROJECT || manifest.origin !== ORIGIN || manifest.reviewDigest !== hash(reviewBytes) || !plain(manifest.files)) stop();
  const packet = { output: path, gameDir: join(path, 'game'), stoppedDir: join(path, 'stopped'), reviewPath,
    planPath: join(path, 'OPERATION-PLAN.json'), manifestPath, manifest, manifestDigest: hash(manifestBytes), reviewDigest: hash(reviewBytes) };
  await verifyOperationPacket(packet);
  return { packet, review };
}
export async function verifyOperationPacket(packet) {
  const expected = packet.manifest.files;
  if (Object.keys(expected).length > 128 || Object.keys(expected).some((path) => !/^(?:game\/|stopped\/|OPERATION-PLAN\.json$)/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..'))) stop();
  for (const [path, digest] of Object.entries(expected)) {
    if (!/^[a-f0-9]{64}$/.test(digest) || hash(await regular(join(packet.output, path))) !== digest) stop();
  }
  async function inventory(path, prefix) {
    for (const name of await readdir(path)) {
      const rel = `${prefix}${name}`, full = join(path, name), info = await lstat(full);
      if (rel === 'game/functions/node_modules') { await directory(full); continue; }
      // Firebase CLI 14.27 writes this non-executable upload cache beside public/.
      // Cache hashes cover gzip bytes, not the raw manifest files; they are only
      // syntax checked. Tracked file hashes and remote Hosting proofs still apply.
      if (rel === 'game/.firebase' || rel === 'stopped/.firebase') {
        await directory(full);
        const names = await readdir(full);
        if (names.some((entry) => entry !== 'hosting.cHVibGlj.cache')) stop();
        if (names.length) {
          const bytes = await regular(join(full, names[0]), 64 * 1024), text = bytes.toString('utf8');
          if (!Buffer.from(text, 'utf8').equals(bytes) || text && !text.endsWith('\n')) stop();
          const seen = new Set();
          for (const line of text ? text.slice(0, -1).split('\n') : []) {
            const row = /^([^,\r\n]+),(0|[1-9][0-9]*),([a-f0-9]{64})$/.exec(line);
            if (!row || !Number.isSafeInteger(Number(row[2])) || seen.has(row[1]) ||
                !Object.hasOwn(expected, `${prefix}public/${row[1]}`)) stop();
            seen.add(row[1]);
          }
        }
        continue;
      }

      if (/^(?:game|stopped)\/firebase-debug(?:\.[^/]*)?\.log$/.test(rel)) { await regular(full, 16 * 1024 * 1024); continue; }
      if (info.isSymbolicLink()) stop();
      if (info.isDirectory()) await inventory(full, `${rel}/`);
      else if (!Object.hasOwn(expected, rel)) stop();
    }
  }
  await inventory(packet.gameDir, 'game/'); await inventory(packet.stoppedDir, 'stopped/');
  if (hash(await regular(packet.reviewPath, 8192)) !== packet.reviewDigest || hash(await regular(packet.manifestPath, 32768)) !== packet.manifestDigest) stop();
}
// Resume is a new reviewed operation, never a retry of an uncertain journal.
export function validateResumeReview(review, priorReview) {
  if (!approvalReady(review) || !approvalReady(priorReview) ||
      !same(review.testerUids, priorReview.testerUids) || review.startsAtMillis <= priorReview.startsAtMillis) stop();
}
function predecessorShape(value) {
  return plain(value) && same(Object.keys(value).sort(), ['journalDigest', 'manifestDigest', 'output', 'reviewDigest']) &&
    typeof value.output === 'string' && value.output.startsWith('/') && resolve(value.output) === value.output &&
    ['manifestDigest', 'reviewDigest', 'journalDigest'].every((key) => /^[a-f0-9]{64}$/.test(value[key]));
}
async function unlocked(output) {
  try { await lstat(join(output, 'OPERATION.lock')); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  stop();
}
export async function readPriorOperation(output, expected) {
  const { packet, review } = await readOperationPacket(output);
  await unlocked(packet.output);
  const bytes = await regular(join(packet.output, STATE_FILE), 32768), state = JSON.parse(bytes);
  if (!plain(state) || !same(Object.keys(state).sort(), ['deploy', 'events', 'manifestDigest', 'reviewDigest', 'schemaVersion', 'stop']) ||
      state.schemaVersion !== 1 || state.manifestDigest !== packet.manifestDigest || state.reviewDigest !== packet.reviewDigest ||
      !plain(state.deploy) || state.deploy.status !== 'failed' || state.deploy.stage !== 'deploy-functions' ||
      Object.keys(state.deploy).some((key) => !['status', 'stage', 'diagnostic'].includes(key)) ||
      Object.hasOwn(state.deploy, 'diagnostic') && !dataEqual(state.deploy.diagnostic, normalizeFailureDiagnostic(state.deploy.diagnostic)) ||
      !dataEqual(state.stop, { status: 'new' }) || !Array.isArray(state.events) || state.events.length !== 3) stop();
  const stages = [['create-stopped-admin', 'issued'], ['create-stopped-admin', 'verified'], ['deploy-functions', 'issued']];
  for (let i = 0; i < stages.length; i++) {
    const event = state.events[i];
    if (!plain(event) || !same(Object.keys(event).sort(), ['atMillis', 'stage', 'status']) ||
        event.stage !== stages[i][0] || event.status !== stages[i][1] ||
        !Number.isSafeInteger(event.atMillis) || event.atMillis <= 0 || i > 0 && event.atMillis < state.events[i - 1].atMillis) stop();
  }
  const predecessor = Object.freeze({ output: packet.output, manifestDigest: packet.manifestDigest,
    reviewDigest: packet.reviewDigest, journalDigest: hash(bytes) });
  if (expected !== undefined && (!predecessorShape(expected) || !dataEqual(predecessor, expected))) stop();
  return { packet, review, predecessor };
}
export async function verifyPriorOperation(prior) {
  await verifyOperationPacket(prior.packet);
  await unlocked(prior.packet.output);
  if (!predecessorShape(prior.predecessor) || prior.packet.output !== prior.predecessor.output ||
      prior.packet.manifestDigest !== prior.predecessor.manifestDigest || prior.packet.reviewDigest !== prior.predecessor.reviewDigest ||
      hash(await regular(join(prior.packet.output, STATE_FILE), 32768)) !== prior.predecessor.journalDigest) stop();
}
export async function readPriorForMode(mode, journal) {
  const predecessor = journal.predecessor();
  // The predecessor is audit data for stop/inspect. Changed old files must not
  // prevent gate-first revocation using the new packet's exact known records.
  return mode === 'activate' && predecessor ? readPriorOperation(predecessor.output, predecessor) : undefined;
}
export async function createJournal(packet, { now = Date.now, prior } = {}) {
  const path = join(packet.output, STATE_FILE);
  let state, existed = true;
  try { state = JSON.parse(await regular(path, 32768)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; existed = false; state = { schemaVersion: 1, manifestDigest: packet.manifestDigest, reviewDigest: packet.reviewDigest, deploy: { status: 'new' }, stop: { status: 'new' }, events: [] }; }
  if (state.schemaVersion !== 1 || state.manifestDigest !== packet.manifestDigest || state.reviewDigest !== packet.reviewDigest || !plain(state.deploy) || !plain(state.stop) || !Array.isArray(state.events) || state.events.length > 32) stop();
  if (prior) {
    if (existed || packet.output === prior.packet.output) stop();
    await verifyPriorOperation(prior);
    state.predecessor = { ...prior.predecessor };
  }
  if (Object.hasOwn(state, 'predecessor') && (!predecessorShape(state.predecessor) || state.predecessor.output === packet.output)) stop();
  if (Object.hasOwn(state, 'hostingUpdate') && !hostingUpdateShape(state.hostingUpdate)) stop();
  return journalWriter(packet, path, state, now);
}
function journalWriter(packet, path, state, now, activationOnly = false) {
  let operation = null, pending = Promise.resolve();
  function persist() {
    const copy = json(state);
    pending = pending.then(async () => {
      const tmp = `${path}.tmp`, handle = await open(tmp, 'wx', 0o600);
      try { await handle.writeFile(copy); await handle.sync(); } finally { await handle.close(); }
      await rename(tmp, path);
      const directoryHandle = await open(packet.output, 'r');
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    });
  }
  function event(stage, status) { if (state.events.length >= 32) stop(); state.events.push({ stage, status, atMillis: clock(now) }); persist(); }
  return {
    begin(mode) {
      if (!['deploy', 'resume', 'activate', 'stop', 'update-hosting'].includes(mode) || activationOnly && mode !== 'activate') stop();
      const selected = mode === 'stop' ? 'stop' : 'deploy';
      const current = state[selected].status;
      if ((mode === 'deploy' || mode === 'resume') && current !== 'new' ||
          mode === 'resume' && !state.predecessor || mode === 'deploy' && state.predecessor || mode === 'activate' && current !== 'published-stopped' || mode === 'stop' && current !== 'new') stop();
      if (mode === 'update-hosting' && (!state.hostingUpdate || current !== 'new') || state.hostingUpdate && ['deploy', 'resume', 'activate'].includes(mode)) stop();
      operation = selected;
      state[operation] = { status: 'running', stage: mode }; persist();
    },
    issued(stage) { state[operation].stage = stage; event(stage, 'issued'); },
    verified(stage) { event(stage, 'verified'); },
    finish(status) { state[operation] = { status }; persist(); },
    fail(stage, diagnostic) {
      if (operation) {
        state[operation] = { status: 'failed', stage, diagnostic: normalizeFailureDiagnostic(diagnostic) };
        persist();
      }
    },
    snapshot() { return { deploy: { ...state.deploy }, stop: { ...state.stop } }; },
    predecessor() { return state.predecessor ? { ...state.predecessor } : null; },
    activationVerifiedAt() { return state.events.findLast((event) => event.stage === 'activate-two-testers' && event.status === 'verified')?.atMillis ?? null; },
    flush() { return pending; },
    async verify() { await pending; if (hash(await regular(path, 32768)) !== hash(json(state))) stop(); },
  };
}
// This narrow recovery consumes a separate receipt exactly once. It neither
// resets the failed deployment journal nor authorizes a deployment or new dates.
export async function readVerifiedHostingRecovery(packet, review) {
  await verifyOperationPacket(packet);
  const bytes = await regular(join(packet.output, STATE_FILE), 32768), state = JSON.parse(bytes);
  if (!plain(state) || !same(Object.keys(state).sort(), ['deploy', 'events', 'manifestDigest', 'predecessor', 'reviewDigest', 'schemaVersion', 'stop']) ||
      state.schemaVersion !== 1 || state.manifestDigest !== packet.manifestDigest || state.reviewDigest !== packet.reviewDigest ||
      !dataEqual(state.deploy, { status: 'failed', stage: 'deploy-hosting', diagnostic: { reason: 'unclassified', exitCode: null, timedOut: false } }) ||
      !dataEqual(state.stop, { status: 'new' }) || !predecessorShape(state.predecessor) || !Array.isArray(state.events) || state.events.length !== 8) stop();
  const stages = ['replace-stopped-window', 'deploy-functions', 'deploy-rules', 'deploy-hosting'];
  for (let i = 0; i < state.events.length; i++) {
    const event = state.events[i];
    if (!plain(event) || !same(Object.keys(event).sort(), ['atMillis', 'stage', 'status']) ||
        event.stage !== stages[Math.floor(i / 2)] || event.status !== (i % 2 ? 'verified' : 'issued') ||
        !Number.isSafeInteger(event.atMillis) || event.atMillis <= 0 || i > 0 && event.atMillis < state.events[i - 1].atMillis) stop();
  }
  const prior = await readPriorOperation(state.predecessor.output, state.predecessor);
  validateResumeReview(review, prior.review);
  const cache = await regular(join(packet.gameDir, '.firebase/hosting.cHVibGlj.cache'), 64 * 1024);
  const publicFiles = Object.keys(packet.manifest.files).filter((path) => path.startsWith('game/public/'));
  const rows = cache.toString('utf8').trimEnd().split('\n');
  if (rows.length !== publicFiles.length) stop();
  for (const row of rows) {
    const [path, mtime, digest] = row.split(','), full = join(packet.gameDir, 'public', path);
    // Only this activation-only recovery authenticates the complete CLI cache.
    // The pinned CLI hashes gzip level 9 and records Date#getTime milliseconds.
    if (!Object.hasOwn(packet.manifest.files, `game/public/${path}`) ||
        Number(mtime) !== (await lstat(full)).mtime.getTime() || hash(gzipSync(await regular(full), { level: 9 })) !== digest) stop();
  }
  const logs = join(packet.output, 'recovery-logs'); await directory(logs);
  if (((await lstat(logs)).mode & 0o777) !== 0o700) stop();
  const streams = {};
  for (const stream of ['stdout', 'stderr']) {
    const path = join(logs, `hosting-game.${stream}.log`);
    if (((await lstat(path)).mode & 0o777) !== 0o600) stop();
    streams[stream] = await regular(path, 16 * 1024 * 1024);
  }
  const result = JSON.parse(streams.stdout.toString('utf8'));
  if (!plain(result) || result.status !== 'success' || Object.hasOwn(result, 'error')) stop();
  const receipts = Object.freeze({ originalJournalDigest: hash(bytes), cacheDigest: hash(cache),
    hostingStdoutDigest: hash(streams.stdout), hostingStderrDigest: hash(streams.stderr) });
  const proof = { prior, receipts };
  await verifyVerifiedHostingRecovery(packet, proof);
  return proof;
}
export async function verifyVerifiedHostingRecovery(packet, proof) {
  await verifyOperationPacket(packet); await verifyPriorOperation(proof.prior);
  const targets = [[STATE_FILE, 'originalJournalDigest', 32768], ['game/.firebase/hosting.cHVibGlj.cache', 'cacheDigest', 64 * 1024],
    ['recovery-logs/hosting-game.stdout.log', 'hostingStdoutDigest', 16 * 1024 * 1024], ['recovery-logs/hosting-game.stderr.log', 'hostingStderrDigest', 16 * 1024 * 1024]];
  const logs = join(packet.output, 'recovery-logs'); await directory(logs);
  if (((await lstat(logs)).mode & 0o777) !== 0o700) stop();
  for (const stream of ['stdout', 'stderr']) if (((await lstat(join(logs, `hosting-game.${stream}.log`))).mode & 0o777) !== 0o600) stop();
  for (const [path, key, limit] of targets) if (hash(await regular(join(packet.output, path), limit)) !== proof.receipts[key]) stop();
}
export async function createActivationRecoveryJournal(packet, proof, { now = Date.now } = {}) {
  await verifyVerifiedHostingRecovery(packet, proof);
  const path = join(packet.output, ACTIVATION_RECOVERY_FILE), state = { schemaVersion: 1,
    manifestDigest: packet.manifestDigest, reviewDigest: packet.reviewDigest, predecessor: { ...proof.prior.predecessor },
    recovery: { ...proof.receipts }, deploy: { status: 'published-stopped' }, stop: { status: 'new' }, events: [] };
  // wx rejects every prior receipt, including failed/uncertain/malformed ones.
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(json(state)); await handle.sync(); } finally { await handle.close(); }
  const directoryHandle = await open(packet.output, 'r');
  try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  return journalWriter(packet, path, state, now, true);
}
function exactEvents(events, stages) {
  if (!Array.isArray(events) || events.length !== stages.length * 2) stop();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!plain(e) || !same(Object.keys(e).sort(), ['atMillis', 'stage', 'status']) || e.stage !== stages[Math.floor(i / 2)] ||
        e.status !== (i % 2 ? 'verified' : 'issued') || !Number.isSafeInteger(e.atMillis) || e.atMillis <= 0 || i > 0 && e.atMillis < events[i - 1].atMillis) stop();
  }
}
export async function readActiveHostingPrior(output) {
  const { packet, review } = await readOperationPacket(output), proof = await readVerifiedHostingRecovery(packet, review);
  await unlocked(packet.output);
  const bytes = await regular(join(packet.output, ACTIVATION_RECOVERY_FILE), 32768), receipt = JSON.parse(bytes);
  if (!plain(receipt) || !same(Object.keys(receipt).sort(), ['deploy', 'events', 'manifestDigest', 'predecessor', 'recovery', 'reviewDigest', 'schemaVersion', 'stop']) ||
      receipt.schemaVersion !== 1 || receipt.manifestDigest !== packet.manifestDigest || receipt.reviewDigest !== packet.reviewDigest ||
      !dataEqual(receipt.deploy, { status: 'active' }) || !dataEqual(receipt.stop, { status: 'new' }) ||
      !dataEqual(receipt.predecessor, proof.prior.predecessor) || !dataEqual(receipt.recovery, proof.receipts)) stop();
  exactEvents(receipt.events, ['activate-two-testers']);
  if (receipt.events.some((e) => e.atMillis < review.startsAtMillis || e.atMillis >= review.endsAtMillis)) stop();
  return { packet, review, proof, activationReceiptDigest: hash(bytes) };
}
export async function verifyActiveHostingPrior(prior) {
  await verifyVerifiedHostingRecovery(prior.packet, prior.proof); await unlocked(prior.packet.output);
  if (hash(await regular(join(prior.packet.output, ACTIVATION_RECOVERY_FILE), 32768)) !== prior.activationReceiptDigest) stop();
}
export async function verifyHostingUpdatePacket(packet, review, prior) {
  await verifyOperationPacket(packet); await verifyActiveHostingPrior(prior);
  if (packet.output === prior.packet.output || packet.reviewDigest !== prior.packet.reviewDigest || !dataEqual(review, prior.review) ||
      !same(Object.keys(packet.manifest.files).sort(), Object.keys(prior.packet.manifest.files).sort())) stop();
  const changed = Object.keys(packet.manifest.files).filter((path) => packet.manifest.files[path] !== prior.packet.manifest.files[path]);
  const auditPath = 'game/SOURCE-SHA256.json';
  if (!changed.some((path) => HOSTING_UPDATE_FILES.includes(path)) || changed.some((path) => path !== auditPath && !HOSTING_UPDATE_FILES.includes(path))) stop();
  // The real generator records source hashes as well as copying public bytes.
  // Authenticate the complete nested audit; it is not a third editable asset.
  const beforeBytes = await regular(join(prior.packet.output, auditPath)), afterBytes = await regular(join(packet.output, auditPath));
  const before = JSON.parse(beforeBytes), after = JSON.parse(afterBytes);
  if (!beforeBytes.equals(Buffer.from(json(before))) || !afterBytes.equals(Buffer.from(json(after)))) stop();
  if (!plain(before) || !plain(after) || !same(Object.keys(before).sort(), Object.keys(after).sort())) stop();
  const approved = Object.fromEntries(HOSTING_UPDATE_FILES.map((path) => [path.slice('game/public/'.length), path]));
  for (const [source, digest] of Object.entries(before)) {
    if (!/^[a-f0-9]{64}$/.test(digest) || !/^[a-f0-9]{64}$/.test(after[source])) stop();
    const publicPath = approved[source];
    if (publicPath ? digest !== prior.packet.manifest.files[publicPath] || after[source] !== packet.manifest.files[publicPath] : after[source] !== digest) stop();
  }
  if (Object.keys(approved).some((source) => !Object.hasOwn(before, source))) stop();
}
export async function verifyPreparedHostingPacket(packet, review, prior) {
  await verifyHostingUpdatePacket(packet, review, prior);
  const files = new Set([...Object.keys(packet.manifest.files), 'private-review.json', 'OPERATION-MANIFEST.json']);
  // A resumable preparation is exactly a generator output: no journal, lock,
  // SDK directory, CLI cache, logs or other evidence of any attempted execution.
  async function inventory(path, prefix = '') {
    for (const name of await readdir(path)) {
      const rel = prefix + name, full = join(path, name), info = await lstat(full);
      if (info.isSymbolicLink()) stop();
      if (info.isDirectory()) {
        if (![...files].some((file) => file.startsWith(`${rel}/`))) stop();
        await directory(full); await inventory(full, `${rel}/`);
      } else if (!files.has(rel)) stop();
    }
  }
  await inventory(packet.output);
}
function hostingUpdateShape(value) {
  return plain(value) && same(Object.keys(value).sort(), ['activationReceiptDigest', 'originalJournalDigest', 'priorManifestDigest', 'priorOutput', 'reviewDigest', 'schemaVersion']) &&
    value.schemaVersion === 1 && typeof value.priorOutput === 'string' && value.priorOutput.startsWith('/') && resolve(value.priorOutput) === value.priorOutput &&
    ['activationReceiptDigest', 'originalJournalDigest', 'priorManifestDigest', 'reviewDigest'].every((key) => /^[a-f0-9]{64}$/.test(value[key]));
}
export async function createHostingUpdateJournal(packet, review, prior, { now = Date.now } = {}) {
  await verifyHostingUpdatePacket(packet, review, prior);
  const hostingUpdate = { schemaVersion: 1, priorOutput: prior.packet.output, priorManifestDigest: prior.packet.manifestDigest,
    reviewDigest: prior.packet.reviewDigest, originalJournalDigest: prior.proof.receipts.originalJournalDigest, activationReceiptDigest: prior.activationReceiptDigest };
  const path = join(packet.output, STATE_FILE), state = { schemaVersion: 1, manifestDigest: packet.manifestDigest, reviewDigest: packet.reviewDigest,
    hostingUpdate, deploy: { status: 'new' }, stop: { status: 'new' }, events: [] };
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(json(state)); await handle.sync(); } finally { await handle.close(); }
  return journalWriter(packet, path, state, now);
}
export async function selectVerifiedHostingOperation(originalOut, updateOut) {
  const original = resolve(originalOut);
  try {
    const { packet } = await readOperationPacket(updateOut), state = JSON.parse(await regular(join(packet.output, STATE_FILE), 32768));
    if (state.schemaVersion !== 1 || state.manifestDigest !== packet.manifestDigest || state.reviewDigest !== packet.reviewDigest ||
        !hostingUpdateShape(state.hostingUpdate) || state.hostingUpdate.priorOutput !== original || state.hostingUpdate.reviewDigest !== packet.reviewDigest ||
        !dataEqual(state.deploy, { status: 'active' }) || !plain(state.stop) || !['new', 'running', 'failed', 'stopped'].includes(state.stop.status) ||
        !Array.isArray(state.events) || state.events.length < 2 || state.events.length > 6) stop();
    exactEvents(state.events.slice(0, 2), ['update-hosting']);
    if (state.events.slice(2).some((e) => !['stop-admin-write', 'stop-hosting-write'].includes(e.stage) || !['issued', 'verified'].includes(e.status))) stop();
    return packet.output;
  } catch { /* Never promote an incomplete update or depend on mutable prior logs for a verified one. */ }
  return (await readOperationPacket(original)).packet.output;
}
export async function createHostingPublisher({ packet, toolingDir, runner = makeCloudRunner() }) {
  await verifyOperationPacket(packet); await directory(toolingDir);
  const firebase = checkTooling(toolingDir, (command, args) => {
    const r = runner(command, args, packet.output);
    if (r?.exitCode !== 0 || r.signal || r.timedOut || typeof r.stdout !== 'string') stop();
    return r.stdout;
  });
  let attempted = false;
  return async () => {
    if (attempted) stop(); attempted = true;
    await verifyOperationPacket(packet);
    const logs = join(packet.output, 'hosting-update-logs'), handles = [];
    try {
      await mkdir(logs, { mode: 0o700 }); await directory(logs);
      for (const stream of ['stdout', 'stderr']) handles.push(await open(join(logs, `hosting.${stream}.log`), 'wx', 0o600));
      const raw = runner(process.execPath, [firebase, 'deploy', '--only', `hosting:${PROJECT}`, '--message', `garden-trial-game-v1:${packet.manifestDigest}`,
        '--config', 'firebase.hosting-only.json', '--project', PROJECT, '--non-interactive', '--json'], packet.gameDir);
      for (const [i, stream] of ['stdout', 'stderr'].entries()) {
        const value = raw?.[stream] ?? '';
        if (typeof value !== 'string' || Buffer.byteLength(value) > 16 * 1024 * 1024) stop();
        await handles[i].writeFile(value); await handles[i].sync();
      }
      return classifyDeployResult(raw);
    } catch { return { kind: 'unknown', diagnostic: normalizeFailureDiagnostic() }; }
    finally { for (const handle of handles) await handle.close(); }
  };
}
export async function operateHostingUpdate({ review, oldCloud, newCloud, publish, journal, checkLocal = async () => {}, now = Date.now, log = console.log }) {
  publicTrialConfig(review);
  let stage = 'hosting-update-preflight', failureDiagnostic;
  const activeWindow = () => { if (clock(now) < review.startsAtMillis || clock(now) >= review.endsAtMillis) stop(); };
  try {
    await checkLocal(); activeWindow(); if (!approvalReady(review)) stop();
    journal.begin('update-hosting'); await journal.flush();
    await oldCloud.preflight('inspect'); await newCloud.preflight('inspect');
    verified(await oldCloud.verifyFunctions()); verified(await oldCloud.verifyRules()); verified(await oldCloud.verifyHosting('game'));
    const before = await oldCloud.readAdmin(); assertState(before, review, 'active');
    const hosting = await oldCloud.readHosting(); if (!validIdentity(hosting) || hosting.kind !== 'game') stop();
    await checkLocal(); await journal.verify(); activeWindow();
    if (!dataEqual(before, await oldCloud.readAdmin()) || !dataEqual(hosting, await oldCloud.readHosting())) stop();
    stage = 'update-hosting'; journal.issued(stage); await journal.flush(); await journal.verify(); await checkLocal(); activeWindow();
    log('STAGE: update-hosting');
    const result = await publish();
    if (result?.kind !== 'success') { failureDiagnostic = normalizeFailureDiagnostic(result?.diagnostic); stop(); }
    stage = 'verify-hosting-update';
    verified(await newCloud.verifyHosting('game')); verified(await newCloud.verifyFunctions()); verified(await newCloud.verifyRules());
    const after = await oldCloud.readAdmin(); assertState(after, review, 'active'); if (!dataEqual(before, after)) stop();
    await checkLocal(); await journal.verify(); activeWindow();
    journal.verified('update-hosting'); journal.finish('active'); await journal.flush(); await journal.verify();
    log('HOSTING_UPDATED: verified; testers, room usage and the fixed deadline are unchanged.');
    return { mode: 'update-hosting', status: 'active' };
  } catch (error) {
    const diagnostic = failureDiagnostic ?? describeAdapterFailure(error); journal.fail(stage, diagnostic); await journal.flush();
    log(`STOP: ${stage}. reason=${diagnostic.reason}. No Hosting update is retried; inspect the saved operation before any further action.`);
    return { mode: 'update-hosting', status: 'blocked', stage, diagnostic };
  }
}
export function parseReviewBase64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,11000}$/.test(value)) stop();
  const bytes = Buffer.from(value, 'base64url'); if (bytes.length > 8192 || bytes.toString('base64url') !== value) stop();
  const review = JSON.parse(bytes.toString('utf8')); publicTrialConfig(review); return review;
}
export async function installRuntime(packet, prior) {
  const root = join(packet.gameDir, 'functions');
  try { await lstat(join(root, 'node_modules')); if (prior) stop(); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (prior) {
    // Reuse the already verified, pinned runtime without a new network install.
    // Copy links verbatim so resolution remains subject to the adapter's strict
    // local-root/version guards; never dereference an external dependency link.
    await verifyPriorOperation(prior);
    const previous = join(prior.packet.gameDir, 'functions');
    for (const name of ['package.json', 'package-lock.json']) {
      if (!(await regular(join(root, name))).equals(await regular(join(previous, name)))) stop();
    }
    await directory(join(previous, 'node_modules'));
    await cp(join(previous, 'node_modules'), join(root, 'node_modules'), { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    await directory(join(root, 'node_modules'));
    await verifyPriorOperation(prior);
    return;
  }
  const userConfig = join(packet.output, 'empty-user.npmrc'), globalConfig = join(packet.output, 'empty-global.npmrc');
  await writeFile(userConfig, '', { flag: 'wx', mode: 0o600 }); await writeFile(globalConfig, '', { flag: 'wx', mode: 0o600 });
  execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/', `--userconfig=${userConfig}`, `--globalconfig=${globalConfig}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000, maxBuffer: 4 * 1024 * 1024 });
}
export function formatTrialJst(milliseconds) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) stop();
  return new Date(milliseconds + 9 * 3600000).toISOString().replace('T', ' ').replace('Z', ' JST');
}
export const PLAN = 'PLAN_ONLY: prepare and review exact seven-day private input before any execution. Target wa-awesome-garden-stg only: five Functions, dedicated Rules/Hosting and exactly two tester records. Public invoker, managed service identity calls and bounded CLI initial recreate need explicit approval. Retain artifacts; no automatic cleanup policy. Default mode makes no network, SDK, auth, install or cloud call.';
export async function main(args = process.argv.slice(2), { log = console.log, hostingCapabilities } = {}) {
  if (!args.length || args.length === 1 && args[0] === '--plan') { log(PLAN); return 0; }
  let lock, packet, journal, prior, recoveryProof, hostingPrior, hostingSetupStage;
  try {
    if (['--update-hosting-reviewed', '--resume-hosting-prepared'].includes(args[0])) hostingSetupStage = 'validate-hosting-environment';
    validateOperatorEnvironment(process.env, process.execArgv);
    for (const key of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_DATABASE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST', 'CLOUDSDK_AUTH_DISABLE_CREDENTIALS']) if (process.env[key]) stop();
    const modes = ['--resume-hosting-prepared', '--update-hosting-reviewed', '--run-reviewed', '--resume-reviewed', '--activate', '--activate-verified-hosting', '--stop', '--inspect'];
    if (!modes.includes(args[0])) stop();
    if (['--update-hosting-reviewed', '--resume-hosting-prepared'].includes(args[0])) {
      const prepared = args[0] === '--resume-hosting-prepared';
      if (args.length !== 7 || args[1] !== '--prior-operation' || args[3] !== (prepared ? '--operation' : '--out') || args[5] !== '--tooling-dir' ||
          ![args[2], args[4], args[6]].every((path) => path.startsWith('/'))) stop();
      hostingSetupStage = 'read-hosting-prior';
      hostingPrior = await readActiveHostingPrior(args[2]);
      hostingSetupStage = 'validate-hosting-window';
      if (Date.now() < hostingPrior.review.startsAtMillis || Date.now() >= hostingPrior.review.endsAtMillis) stop();
      const rel = relative(hostingPrior.packet.output, resolve(args[4]));
      if (rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep)) stop();
      hostingSetupStage = prepared ? 'read-hosting-packet' : 'prepare-hosting-packet';
      if (!prepared) await prepareTrialOperation({ review: hostingPrior.review, output: args[4], repositoryRoot: ROOT });
      ({ packet } = await readOperationPacket(args[4]));
      hostingSetupStage = 'verify-hosting-audit';
      await verifyPreparedHostingPacket(packet, hostingPrior.review, hostingPrior);
      hostingSetupStage = 'verify-hosting-source';
      for (const path of HOSTING_UPDATE_FILES) {
        if (hash(await regular(join(ROOT, path.slice('game/public/'.length)))) !== packet.manifest.files[path]) stop();
      }
    } else if (args[0] === '--run-reviewed') {
      if (args.length !== 7 || args[1] !== '--review-base64' || args[3] !== '--out' || args[5] !== '--tooling-dir' || !args[4].startsWith('/') || !args[6].startsWith('/')) stop();
      const review = parseReviewBase64(args[2]); if (!approvalReady(review)) stop();
      if (Date.now() >= review.startsAtMillis) stop();
      await prepareTrialOperation({ review, output: args[4], repositoryRoot: ROOT });
      ({ packet } = await readOperationPacket(args[4]));
    } else if (args[0] === '--resume-reviewed') {
      if (args.length !== 9 || args[1] !== '--review-base64' || args[3] !== '--prior-operation' || args[5] !== '--out' ||
          args[7] !== '--tooling-dir' || ![args[4], args[6], args[8]].every((path) => path.startsWith('/'))) stop();
      const review = parseReviewBase64(args[2]);
      prior = await readPriorOperation(args[4]); validateResumeReview(review, prior.review);
      if (Date.now() >= review.startsAtMillis) stop();
      // A new packet or dependency install must never touch the retained prior operation.
      for (const path of [args[6], args[8]]) {
        const rel = relative(prior.packet.output, resolve(path));
        if (rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep)) stop();
      }
      await prepareTrialOperation({ review, output: args[6], repositoryRoot: ROOT });
      ({ packet } = await readOperationPacket(args[6]));
      await verifyPriorOperation(prior);
    } else {
      if (args.length !== 5 || args[1] !== '--operation' || args[3] !== '--tooling-dir' || !args[2].startsWith('/') || !args[4].startsWith('/')) stop();
      ({ packet } = await readOperationPacket(args[2]));
    }
    const { review } = await readOperationPacket(packet.output);
    const mode = ({ '--resume-hosting-prepared': 'update-hosting', '--update-hosting-reviewed': 'update-hosting', '--run-reviewed': 'deploy', '--resume-reviewed': 'resume', '--activate': 'activate', '--activate-verified-hosting': 'activate', '--stop': 'stop', '--inspect': 'inspect' })[args[0]];
    const recoveryRequested = args[0] === '--activate-verified-hosting';
    if (recoveryRequested) log(`END: ${formatTrialJst(review.endsAtMillis)}`);
    if (recoveryRequested && Date.now() < review.startsAtMillis) {
      log('READY_STOPPED: the fixed start has not arrived; activation recovery made no change. Run the reviewed activation only after that start.'); return 1;
    }
    if (recoveryRequested && Date.now() >= review.endsAtMillis) {
      log('STOP: the fixed trial deadline has passed; activation refused without changing the window.'); return 1;
    }
    if (mode !== 'inspect') {
      if (hostingPrior) hostingSetupStage = 'lock-hosting-packet';
      lock = await open(join(packet.output, 'OPERATION.lock'), 'wx', 0o600);
      await lock.writeFile('This operation is in progress. Do not remove or rerun after an uncertain interruption.\n');
    }
    if (hostingPrior) {
      hostingSetupStage = 'prepare-hosting-journal';
      journal = await createHostingUpdateJournal(packet, review, hostingPrior);
      hostingSetupStage = 'copy-hosting-runtime';
      await installRuntime(packet, hostingPrior.proof.prior);
      const { createCloudAdapter } = await import('./floating-garden-trial-cloud-adapter.mjs');
      // Offline integration tests may inject provider factories; no CLI flag
      // alters these capabilities, local guards, runtime copy or journaling.
      hostingSetupStage = 'check-hosting-tooling';
      const cloudFactory = hostingCapabilities?.createCloudAdapter ?? createCloudAdapter,
        publisherFactory = hostingCapabilities?.createHostingPublisher ?? createHostingPublisher;
      const toolingDir = args.at(-1), oldCloud = cloudFactory({ packet: hostingPrior.packet, review, toolingDir }),
        newCloud = cloudFactory({ packet, review, toolingDir });
      const publish = await publisherFactory({ packet, toolingDir });
      const checkLocal = () => verifyHostingUpdatePacket(packet, review, hostingPrior);
      log(`END: ${formatTrialJst(review.endsAtMillis)}`);
      hostingSetupStage = 'run-hosting-update';
      const result = await operateHostingUpdate({ review, oldCloud, newCloud, publish, journal, checkLocal, log });
      await journal.flush(); log(`OPERATION_DIRECTORY: ${packet.output}`);
      return result.status === 'active' ? 0 : 1;
    }
    if (recoveryRequested) {
      recoveryProof = await readVerifiedHostingRecovery(packet, review);
      prior = recoveryProof.prior;
      journal = await createActivationRecoveryJournal(packet, recoveryProof);
    } else {
      journal = await createJournal(packet, { prior });
      if (!prior) prior = await readPriorForMode(mode, journal);
    }
    if (prior) validateResumeReview(review, prior.review);
    if (mode === 'deploy' || mode === 'resume') await installRuntime(packet, mode === 'resume' ? prior : undefined);
    const { createCloudAdapter } = await import('./floating-garden-trial-cloud-adapter.mjs');
    const toolingDir = args.at(-1);
    const cloud = await createCloudAdapter({ packet, review, toolingDir, ...(prior ? { prior } : {}) });
    const checkLocal = async () => {
      if (recoveryProof) { await verifyVerifiedHostingRecovery(packet, recoveryProof); await journal.verify(); }
      else { await verifyOperationPacket(packet); if (prior) await verifyPriorOperation(prior); }
    };
    const operatorLog = recoveryRequested ? (line) => { if (!line.startsWith('ACTIVE:')) log(line); } : log;
    const result = await operateTrial({ mode, review, priorReview: prior?.review, cloud, journal, log: operatorLog, checkLocal });
    await checkLocal();
    await journal.flush();
    if (recoveryRequested && result.status === 'active') log(`ACTIVE: activation verified at ${formatTrialJst(journal.activationVerifiedAt())}; existing fixed deadline retained.`);
    log(`OPERATION_DIRECTORY: ${packet.output}`);
    return result.status === 'blocked' ? 1 : 0;
  } catch {
    if (journal) await journal.flush().catch(() => {});
    log(hostingSetupStage ? `STOP: ${hostingSetupStage}. Local inputs or setup could not be verified. No retry; private diagnostics are suppressed.` :
      'STOP: local inputs, dependencies, lock or setup could not be verified. Do not rerun a mutation. No raw diagnostics or private input are displayed.');
    return 1;
  } finally {
    if (lock) { await lock.close(); await unlink(join(packet.output, 'OPERATION.lock')).catch(() => {}); }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();

#!/usr/bin/env node
// Bounded, user-operated trial execution. The default is an offline plan.
// Preparation/testing is not authority to invoke any mutation mode.
import { readFile, writeFile, lstat, readdir, mkdir, open, rename, unlink, realpath } from 'node:fs/promises';
import { resolve, join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { prepareTrialOperation, publicTrialConfig } from './prepare-floating-garden-trial-operation.mjs';
import { validateEnvironment as validateOperatorEnvironment } from './deploy-floating-garden-connection-template.mjs';

export const PROJECT = 'wa-awesome-garden-stg';
export const ORIGIN = 'https://wa-awesome-garden-stg.web.app';
export const REGION = 'asia-northeast1';
export const MAX_START_WAIT_MILLIS = 30 * 60000;
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const STATE_FILE = 'OPERATION-STATE.json';
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
function mutationSucceeded(result) { if (result?.kind !== 'success') stop(); }
function verified(result) { if (result?.verified !== true) stop(); }
function validIdentity(value) { return plain(value) && typeof value.version === 'string' && value.version.length > 0 && ['connection', 'maintenance', 'game', 'stopped'].includes(value.kind); }
function clock(now) { const value = now(); if (!Number.isSafeInteger(value) || value <= 0) stop(); return value; }

/** Pure orchestrator. Tests inject all cloud, journal, clock and wait capabilities. */
export async function operateTrial({ mode, review, cloud, journal, now = Date.now, wait = (ms) => new Promise((done) => setTimeout(done, ms)), log = console.log, checkLocal = async () => {} }) {
  publicTrialConfig(review);
  if (!['inspect', 'deploy', 'activate', 'stop'].includes(mode)) stop();
  let stage = 'preflight';
  const issue = async (name) => { journal.issued(name); if (journal.flush) await journal.flush(); };
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
    const current = clock(now);
    if (mode === 'deploy' && current >= review.startsAtMillis) stop();
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
      journal.finish('stopped');
      log('STOPPED: gate/testers disabled and stopped Hosting verified; usage, functions, artifacts, accounts, secrets and IAM retained.');
      return { mode, status: 'stopped' };
    }
    if (mode === 'deploy') {
      stage = 'initial-admin-read';
      if (adminState(await cloud.readAdmin(), review) !== 'absent') stop();
      const initialHosting = await cloud.readHosting();
      if (!validIdentity(initialHosting) || !['connection', 'maintenance'].includes(initialHosting.kind)) stop();
      verified(await cloud.verifyHosting(initialHosting.kind));
      stage = 'create-stopped-admin'; await checkLocal(); await issue(stage);
      mutationSucceeded(await cloud.createStoppedAdmin(adminRecords(review)));
      assertState(await cloud.readAdmin(), review, 'stopped', { unused: true }); journal.verified(stage);
      stage = 'deploy-functions'; await checkLocal(); await issue(stage);
      const functions = await cloud.deployFunctions();
      // A known cleanup-only error may mask function errors. Never trust its
      // wording: all five source/configuration/Run/IAM readbacks are mandatory.
      if (!['success', 'cleanup-warning'].includes(functions?.kind)) stop();
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
      journal.finish('published-stopped');
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
    if (mode === 'deploy') journal.begin('activate');
    stage = 'activation-readback'; await checkLocal();
    if (clock(now) < review.startsAtMillis || clock(now) >= review.endsAtMillis) stop();
    verified(await cloud.verifyFunctions()); verified(await cloud.verifyRules()); verified(await cloud.verifyHosting('game'));
    const before = await cloud.readAdmin(); assertState(before, review, 'stopped', { unused: true });
    if (clock(now) < review.startsAtMillis || clock(now) >= review.endsAtMillis) stop();
    if (mode === 'deploy' && clock(now) - review.startsAtMillis > 60000) {
      journal.finish('published-stopped');
      log('READY_STOPPED: verification missed the fixed start; no automatic activation or extension.');
      return { mode, status: 'published-stopped', reason: 'late-verification' };
    }
    stage = 'activate-two-testers'; await issue(stage);
    mutationSucceeded(await cloud.updateAdmin(adminRecords(review, true), before));
    assertState(await cloud.readAdmin(), review, 'active', { minimumCount: 0 }); journal.verified(stage);
    journal.finish('active');
    log('ACTIVE: exact two testers and fixed window verified. The first game still needs the approved owner check.');
    return { mode, status: 'active' };
  } catch {
    if (mode !== 'inspect') journal.fail(stage);
    log(`STOP: ${stage}. No mutation is retried; inspect the saved operation before any further action. Raw diagnostics suppressed.`);
    return { mode, status: 'blocked', stage };
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
      if (/^(?:game|stopped)\/firebase-debug(?:\.[^/]*)?\.log$/.test(rel)) { await regular(full, 16 * 1024 * 1024); continue; }
      if (info.isSymbolicLink()) stop();
      if (info.isDirectory()) await inventory(full, `${rel}/`);
      else if (!Object.hasOwn(expected, rel)) stop();
    }
  }
  await inventory(packet.gameDir, 'game/'); await inventory(packet.stoppedDir, 'stopped/');
  if (hash(await regular(packet.reviewPath, 8192)) !== packet.reviewDigest || hash(await regular(packet.manifestPath, 32768)) !== packet.manifestDigest) stop();
}
export async function createJournal(packet, { now = Date.now } = {}) {
  const path = join(packet.output, STATE_FILE);
  let state;
  try { state = JSON.parse(await regular(path, 32768)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = { schemaVersion: 1, manifestDigest: packet.manifestDigest, reviewDigest: packet.reviewDigest, deploy: { status: 'new' }, stop: { status: 'new' }, events: [] }; }
  if (state.schemaVersion !== 1 || state.manifestDigest !== packet.manifestDigest || state.reviewDigest !== packet.reviewDigest || !plain(state.deploy) || !plain(state.stop) || !Array.isArray(state.events) || state.events.length > 32) stop();
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
      const selected = mode === 'stop' ? 'stop' : 'deploy';
      const current = state[selected].status;
      if (mode === 'deploy' && current !== 'new' || mode === 'activate' && current !== 'published-stopped' || mode === 'stop' && current !== 'new') stop();
      operation = selected;
      state[operation] = { status: 'running', stage: mode }; persist();
    },
    issued(stage) { state[operation].stage = stage; event(stage, 'issued'); },
    verified(stage) { event(stage, 'verified'); },
    finish(status) { state[operation] = { status }; persist(); },
    fail(stage) { if (operation) { state[operation] = { status: 'failed', stage }; persist(); } },
    snapshot() { return { deploy: { ...state.deploy }, stop: { ...state.stop } }; },
    flush() { return pending; },
  };
}
export function parseReviewBase64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,11000}$/.test(value)) stop();
  const bytes = Buffer.from(value, 'base64url'); if (bytes.length > 8192 || bytes.toString('base64url') !== value) stop();
  const review = JSON.parse(bytes.toString('utf8')); publicTrialConfig(review); return review;
}
async function installRuntime(packet) {
  const root = join(packet.gameDir, 'functions');
  try { await lstat(join(root, 'node_modules')); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const userConfig = join(packet.output, 'empty-user.npmrc'), globalConfig = join(packet.output, 'empty-global.npmrc');
  await writeFile(userConfig, '', { flag: 'wx', mode: 0o600 }); await writeFile(globalConfig, '', { flag: 'wx', mode: 0o600 });
  execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/', `--userconfig=${userConfig}`, `--globalconfig=${globalConfig}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000, maxBuffer: 4 * 1024 * 1024 });
}
export const PLAN = 'PLAN_ONLY: prepare and review exact seven-day private input before any execution. Target wa-awesome-garden-stg only: five Functions, dedicated Rules/Hosting and exactly two tester records. Public invoker, managed service identity calls and bounded CLI initial recreate need explicit approval. Retain artifacts; no automatic cleanup policy. Default mode makes no network, SDK, auth, install or cloud call.';
export async function main(args = process.argv.slice(2), { log = console.log } = {}) {
  if (!args.length || args.length === 1 && args[0] === '--plan') { log(PLAN); return 0; }
  let lock, packet, journal;
  try {
    validateOperatorEnvironment(process.env, process.execArgv);
    for (const key of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_DATABASE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST', 'CLOUDSDK_AUTH_DISABLE_CREDENTIALS']) if (process.env[key]) stop();
    const modes = ['--run-reviewed', '--activate', '--stop', '--inspect'];
    if (!modes.includes(args[0])) stop();
    if (args[0] === '--run-reviewed') {
      if (args.length !== 7 || args[1] !== '--review-base64' || args[3] !== '--out' || args[5] !== '--tooling-dir' || !args[4].startsWith('/') || !args[6].startsWith('/')) stop();
      const review = parseReviewBase64(args[2]); if (!approvalReady(review)) stop();
      if (Date.now() >= review.startsAtMillis) stop();
      await prepareTrialOperation({ review, output: args[4], repositoryRoot: ROOT });
      ({ packet } = await readOperationPacket(args[4]));
    } else {
      if (args.length !== 5 || args[1] !== '--operation' || args[3] !== '--tooling-dir' || !args[2].startsWith('/') || !args[4].startsWith('/')) stop();
      ({ packet } = await readOperationPacket(args[2]));
    }
    const { review } = await readOperationPacket(packet.output);
    const mode = ({ '--run-reviewed': 'deploy', '--activate': 'activate', '--stop': 'stop', '--inspect': 'inspect' })[args[0]];
    if (mode !== 'inspect') {
      lock = await open(join(packet.output, 'OPERATION.lock'), 'wx', 0o600);
      await lock.writeFile('This operation is in progress. Do not remove or rerun after an uncertain interruption.\n');
    }
    journal = await createJournal(packet);
    if (mode === 'deploy') await installRuntime(packet);
    const { createCloudAdapter } = await import('./floating-garden-trial-cloud-adapter.mjs');
    const toolingDir = args.at(-1);
    const cloud = await createCloudAdapter({ packet, review, toolingDir });
    const result = await operateTrial({ mode, review, cloud, journal, log, checkLocal: () => verifyOperationPacket(packet) });
    await journal.flush();
    log(`OPERATION_DIRECTORY: ${packet.output}`);
    return result.status === 'blocked' ? 1 : 0;
  } catch {
    if (journal) await journal.flush().catch(() => {});
    log('STOP: local inputs, dependencies, lock or setup could not be verified. Do not rerun a mutation. No raw diagnostics or private input are displayed.');
    return 1;
  } finally {
    if (lock) { await lock.close(); await unlink(join(packet.output, 'OPERATION.lock')).catch(() => {}); }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();

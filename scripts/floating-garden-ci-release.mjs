#!/usr/bin/env node
// First NPC release from the already CLOSED existing trial. Inert by default.
// This entry is a new official-CLI contract, not a retry of an owner journal.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, open, lstat, realpath, cp } from 'node:fs/promises';
import { resolve, join, dirname, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { createPrivateEvidence } from './floating-garden-active-update-evidence.mjs';
import { createCiClients } from './floating-garden-ci-clients.mjs';
import { requireCiAuthPolicy } from './floating-garden-ci-auth-policy.mjs';
import { prepareCiPacket } from './prepare-floating-garden-ci-packet.mjs';
import { validateOperationReview } from './prepare-floating-garden-trial-operation.mjs';
import { createActiveUpdateProvider, ciProviderFailureDiagnostic, providerPreservationDiagnostic } from './floating-garden-active-update-provider.mjs';
import { makeCloudRunner, describeAdapterFailure } from './floating-garden-trial-cloud-adapter.mjs';
import { checkTooling, canonicalVersionName, liveChannel } from './deploy-floating-garden-connection-template.mjs';
import { ACTIVE_UPDATE_SCOPE as S, prepareActiveUpdatePlan, recheckActiveUpdatePlan,
  proveOldInvocationIsolation, activeUpdateReason } from './floating-garden-active-update.mjs';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const failures = new WeakMap();
function need(condition, code) { if (!condition) { const e = new Error('CI release blocked'); failures.set(e, code); throw e; } }
export const CI_RELEASE_RECOVERY = Object.freeze({ before: '69ef07b9356470fbd3a643638baeec12bdd5680c', runNumber: '5' });
const STAGES = ['closed-baseline', 'functions', 'rules', 'hosting', 'preservation', 'reopen', 'reopened'];
export function ciReleaseApproval(sourceCommit, runNumber) {
  return { schemaVersion: 2, previousSourceCommit: CI_RELEASE_RECOVERY.before, releaseRefCreated: false, repository: 'fabdemnt-dev/wa-awesome', sourceCommit, runNumber,
    oldInventory: S.oldInventory, newInventory: S.newInventory, expiresAtMillis: S.endsAtMillis,
    existingClosedTrial: true, fiveFunctionsRulesHosting: true, standardCliInternalRetriesAndParallelism: true,
    functionsDeployer: 'gcloud-568.0.0', functionsSequential: true, serviceIdentityGeneration: false, preserveExistingIamAndData: true, reopenSamePairOnce: true,
    noAutomaticRetryOrRollback: true, exclusiveMaintenance: true };
}
function context(env, approval, policy, now) {
  requireCiAuthPolicy(policy).validateEnvironment(env, []);
  need(/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '') && env.GITHUB_WORKFLOW_SHA === env.GITHUB_SHA &&
    /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID || '') && env.GITHUB_RUN_ATTEMPT === '1' && env.GITHUB_RUN_NUMBER === CI_RELEASE_RECOVERY.runNumber && env.GARDEN_RELEASE_REF_CREATED === 'false' &&
    env.GARDEN_RELEASE_EVENT_BEFORE === CI_RELEASE_RECOVERY.before && env.GARDEN_RELEASE_EVENT_AFTER === env.GITHUB_SHA &&
    env.GITHUB_SHA !== CI_RELEASE_RECOVERY.before, 'ci-context');
  need(isDeepStrictEqual(approval, ciReleaseApproval(env.GITHUB_SHA, env.GITHUB_RUN_NUMBER)), 'release-approval');
  need(Number.isSafeInteger(now()) && now() >= S.startsAtMillis && now() < S.endsAtMillis, 'fixed-window');
}
export async function executeCiRelease({ plan, approval, cloud, journal, env, environmentPolicy, now = Date.now }) {
  context(env, approval, environmentPolicy, now); await recheckActiveUpdatePlan(plan); proveOldInvocationIsolation(plan);
  need(journal && ['issued', 'verified', 'providerStep', 'finish', 'fail'].every(k => typeof journal[k] === 'function'), 'journal');
  cloud.bindJournal(journal); let stage = 'closed-baseline', access = 'unknown';
  const step = async (name, fn, accept = r => r?.kind === 'verified') => {
    stage = name; context(env, approval, environmentPolicy, now); await recheckActiveUpdatePlan(plan);
    await journal.issued(name); const result = await fn(); need(accept(result), name === 'reopen' ? 'reopen-unconfirmed' : 'stage-unverified'); await journal.verified(name); return result;
  };
  try {
    const base = await step('closed-baseline', () => cloud.inspectClosed(), r => r?.kind === 'baseline' && r.createdRoomCount === 2 && r.roomCount === 2);
    need(base?.kind === 'baseline' && base.createdRoomCount === 2 && base.roomCount === 2, 'closed-baseline'); access = 'closed';
    for (const kind of ['functions', 'rules', 'hosting']) {
      const result = await step(kind, () => cloud.deployCiStage(kind), r => r?.kind === 'success'); need(result?.kind === 'success', 'cli-unverified');
    }
    await step('preservation', () => cloud.verifyPreservation()); proveOldInvocationIsolation(plan);
    const reopened = await step('reopen', () => cloud.reopen(), r => r?.kind === 'success' && r.access === 'open');
    need(reopened?.kind === 'success' && reopened.access === 'open', 'reopen-unconfirmed'); access = 'open';
    await step('reopened', () => cloud.verifyReopened()); await journal.finish();
    return { status: 'npc-released', access, preservedBaselineCreatedRoomCount: 2, preservedBaselineRoomCount: 2, maxRooms: S.maxRooms,
      endsAtMillis: S.endsAtMillis, sameTesterCount: 2, gateTransactionCount: 1,
      automaticRetry: false, automaticRollback: false, oldInvocationsDrained: false, oldInvocationsIsolatedBySourceFence: true };
  } catch (error) {
    try { const actual = await cloud.readAccess(); access = ['open', 'closed'].includes(actual.access) ? actual.access : 'unknown'; } catch { access = 'unknown'; }
    const adapter = describeAdapterFailure(error), active = activeUpdateReason(error);
    const reason = failures.get(error) || (active !== 'unclassified' ? active : adapter.reason);
    let journalWriteFailed = false;
    try { await journal.fail(stage, reason, access); } catch { journalWriteFailed = true; }
    const cliOutcome = ciProviderFailureDiagnostic(error), preservation = providerPreservationDiagnostic(error);
    return { status: 'blocked', stage, reason, access, automaticRetry: false, automaticRollback: false,
      ...(adapter.httpStatus ? { httpStatus: adapter.httpStatus } : {}),
      ...(cliOutcome ? { cliOutcome } : {}), ...(preservation ? { preservation } : {}), ...(journalWriteFailed ? { journalWriteFailed: true } : {}) };
  }
}
async function privatePath(path, file = false) {
  need(typeof path === 'string' && isAbsolute(path) && resolve(path) === path && !/[\x00-\x1f]/.test(path), 'private-path');
  let part = sep;
  for (const name of (file ? dirname(path) : path).split(sep).filter(Boolean)) {
    part = join(part, name); const info = await lstat(part); need(info.isDirectory() && !info.isSymbolicLink(), 'private-path');
  }
  need(await realpath(file ? dirname(path) : path) === (file ? dirname(path) : path), 'private-path');
  const info = await lstat(path);
  need(!(info.mode & 0o077) && (file ? info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 8192 : info.isDirectory()), 'private-path');
}
export async function createCiJournal(directory, now = Date.now) {
  await privatePath(directory); const evidence = await createPrivateEvidence(directory); const file = await open(join(directory, 'CI-RELEASE-JOURNAL.jsonl'), 'wx', 0o600);
  let terminal = false; const issued = new Set(), providerIssued = new Map();
  const append = async value => { need(!terminal, 'journal'); await file.writeFile(JSON.stringify({ atMillis: now(), ...value }) + '\n'); await file.sync(); };
  await append({ event: 'created', originalExpiry: S.endsAtMillis });
  return {
    async privateEvidence(event, value) { need(!terminal, 'journal'); return evidence.append(event, value); },
    async issued(stage) { need(STAGES.includes(stage) && !issued.has(stage), 'journal'); issued.add(stage); await append({ event: 'issued', stage }); },
    async verified(stage) { need(issued.has(stage), 'journal'); await append({ event: 'verified', stage }); },
    async providerStep(s) {
      need(['functions', 'rules', 'hosting'].includes(s.resourceKind) && issued.has(s.resourceKind) &&
        s.stage === `official-cli-${s.resourceKind}` && s.index === (providerIssued.get(s.resourceKind) || 0) &&
        Number.isSafeInteger(s.index) && s.index >= 0 && s.index < (s.resourceKind === 'functions' ? 5 : 1), 'journal');
      providerIssued.set(s.resourceKind, s.index + 1);
      await append({ event: 'cli-invocation-issued', stage: s.resourceKind, index: s.index });
    },
    async finish() { await append({ event: 'finished' }); terminal = true; await file.close(); },
    async fail(stage, reason, access) { await append({ event: 'blocked', stage, reason, access }); terminal = true; await file.close(); },
  };
}
// Recover only the exact old review whose generated manifest matches the
// current release marker. Both roster orders and all old review flags are
// finite candidates. No historical snapshot or approval is invented.
export function matchOldReview(baseManifest, testerUids, marker, now) {
  need(/^garden-trial-game-v1:[a-f0-9]{64}$/.test(marker || ''), 'old-hosting-marker');
  const candidates = [];
  for (const pair of [testerUids, [...testerUids].reverse()]) for (let flags = 0; flags < 8; flags++) {
    const review = validateOperationReview({ schemaVersion: 1, startsAtMillis: S.startsAtMillis, endsAtMillis: S.endsAtMillis,
      testerUids: pair, retainBuildArtifacts: Boolean(flags & 1), allowInitialFunctionRecreate: Boolean(flags & 2), approvePublicInvoker: Boolean(flags & 4) }, { now });
    const manifest = { ...baseManifest, reviewDigest: sha(json(review)) };
    if (`garden-trial-game-v1:${sha(json(manifest))}` === marker) candidates.push(review);
  }
  need(candidates.length === 1, 'old-hosting-marker'); return candidates[0];
}
// Fixed diagnostic codes only. Never expose CLI stdout/stderr, channel names,
// URLs, markers, roster IDs, authentication material or thrown error messages.
export function ciReleasePreparationFailure(error) {
  const adapter = describeAdapterFailure(error);
  return { status: 'blocked', stage: 'preparation', reason: failures.get(error) ||
    (['ci_clients_guard', 'ci_auth_policy_guard'].includes(error?.message) ? error.message : adapter.reason),
    access: 'unknown', automaticRetry: false, automaticRollback: false };
}
export function readCiOldHostingChannel(raw) {
  need(raw && typeof raw === 'object' && !Array.isArray(raw), 'old-hosting-cli-result');
  need(!raw.timedOut, 'old-hosting-cli-timeout');
  need(!raw.signal, 'old-hosting-cli-signal');
  need(raw.exitCode === 0, 'old-hosting-cli-exit');
  need(typeof raw.stdout === 'string', 'old-hosting-json');
  let response;
  try { response = JSON.parse(raw.stdout); } catch { need(false, 'old-hosting-json'); }
  const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  need(plain(response), 'old-hosting-schema');
  need(response.status === 'success', 'old-hosting-response-status');
  need(plain(response.result) && Array.isArray(response.result.channels), 'old-hosting-schema');
  const prefixes = [`sites/${S.project}`, `projects/${S.project}/sites/${S.project}`, `projects/${S.projectNumber}/sites/${S.project}`];
  need(response.result.channels.every(c => plain(c) && typeof c.name === 'string' &&
    prefixes.some(p => c.name.startsWith(`${p}/channels/`))), 'old-hosting-channel-schema');
  const matches = response.result.channels.filter(c => prefixes.some(p => c.name === `${p}/channels/live`));
  need(matches.length === 1, 'old-hosting-channel-count');
  const candidate = matches[0];
  need(candidate.url === S.origin, 'old-hosting-url');
  need(!candidate.expireTime, 'old-hosting-expiring-channel');
  // Reuse the existing exact project/site identity contract after classifying
  // safe failures above. No arbitrary suffix matching or fallback live guess.
  const channel = liveChannel(response.result);
  need(plain(channel.release) && plain(channel.release.version), 'old-hosting-release-schema');
  need(channel.release.type === 'DEPLOY', 'old-hosting-release-type');
  need(channel.release.version.status === 'FINALIZED', 'old-hosting-version-status');
  try { canonicalVersionName(channel.release.version.name); } catch { need(false, 'old-hosting-version-name'); }
  need(typeof channel.release.message === 'string' && channel.release.message.match(/^garden-trial-game-v1:[a-f0-9]{64}$/)?.[0] === channel.release.message, 'old-hosting-marker');
  return channel;
}
export async function prepareCiReleaseFiles({ db, workDir, toolingDir, runner, now }) {
  need(isAbsolute(workDir) && resolve(workDir) === workDir && !workDir.startsWith(ROOT), 'private-path');
  await mkdir(workDir, { mode: 0o700 }); await privatePath(workDir);
  const testers = await db.collection('floatingGardenTrialTesters').limit(3).get();
  need(testers.docs.length === 2 && testers.docs.every(d => /^[A-Za-z0-9_-]{1,128}$/.test(d.id) && d.data().active === false && d.data().expiresAtMillis === S.endsAtMillis), 'closed-roster');
  const pair = testers.docs.map(d => d.id).sort();
  const oldRoot = join(workDir, 'old-source'); await mkdir(oldRoot, { mode: 0o700 });
  const archive = execFileSync('git', ['archive', S.oldCommit, 'package.json', 'lab/floating-garden', 'functions/floating-garden-online',
    'functions/floating-garden-trial', 'scripts/prepare-floating-garden-trial.mjs', 'scripts/prepare-floating-garden-trial-operation.mjs'], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', oldRoot], { input: archive, stdio: ['pipe', 'ignore', 'pipe'] });
  const oldGenerator = await import(pathToFileURL(join(oldRoot, 'scripts/prepare-floating-garden-trial-operation.mjs')));
  const review0 = { schemaVersion: 1, startsAtMillis: S.startsAtMillis, endsAtMillis: S.endsAtMillis, testerUids: pair,
    retainBuildArtifacts: false, allowInitialFunctionRecreate: false, approvePublicInvoker: false };
  const seed = await oldGenerator.prepareTrialOperation({ review: review0, output: join(workDir, 'old-seed'), repositoryRoot: oldRoot, now: now() });
  const cli = checkTooling(toolingDir, (cmd, args, cwd) => { const r = runner(cmd, args, cwd); need(r.exitCode === 0, 'tooling'); return r.stdout; });
  let raw;
  try { raw = runner(process.execPath, [cli, 'hosting:channel:list', '--site', S.project, '--project', S.project, '--config', join(seed.gameDir, 'firebase.hosting-only.json'), '--non-interactive', '--json'], workDir); }
  catch { need(false, 'old-hosting-cli-spawn'); }
  const channel = readCiOldHostingChannel(raw);
  const review = matchOldReview(JSON.parse(await readFile(seed.manifestPath, 'utf8')), pair, channel.release.message, now());
  const previous = await oldGenerator.prepareTrialOperation({ review, output: join(workDir, 'previous'), repositoryRoot: oldRoot, now: now() });
  const reviewPath = join(workDir, 'private-review.json'); await writeFile(reviewPath, json(review), { flag: 'wx', mode: 0o600 });
  await prepareCiPacket({ reviewPath, output: join(workDir, 'next'), now });
  const nextOutput = join(workDir, 'next/packet');
  // Dependencies were lock-installed before authentication. Copy locally; never
  // npm-install with the OIDC credential present or upload private packet files.
  await cp(join(ROOT, 'functions/floating-garden-trial/node_modules'), join(nextOutput, 'game/functions/node_modules'), { recursive: true, dereference: false, errorOnExist: true, force: false });
  return prepareActiveUpdatePlan({ previousOutput: previous.output, nextOutput });
}
export async function main(args = process.argv.slice(2), { log = console.log, env = process.env, now = Date.now } = {}) {
  if (!args.length || args.length === 1 && args[0] === '--plan') {
    log('CI_PLAN: already-closed Garden, exact five Functions, Rules and Hosting, independent readback, then one same-pair CAS. Explicit reviewed release approval and Garden WIF are required. No work executed.'); return 0;
  }
  let db;
  try {
    need(args.length === 7 && args[0] === '--run-ci' && args[1] === '--approval' && args[3] === '--work-dir' && args[5] === '--tooling', 'arguments');
    await privatePath(args[2], true); const approval = JSON.parse(await readFile(args[2], 'utf8'));
    const clients = await createCiClients({ env, now }); db = clients.db;
    context(env, approval, clients.environmentPolicy, now);
    const runner = makeCloudRunner({ env }), plan = await prepareCiReleaseFiles({ db, workDir: args[4], toolingDir: args[6], runner, now });
    const journal = await createCiJournal(args[4], now);
    const cloud = createActiveUpdateProvider({ plan, toolingDir: args[6], runner, ...clients, env, now });
    const result = await executeCiRelease({ plan, approval, cloud, journal, env, environmentPolicy: clients.environmentPolicy, now });
    log('CI_RELEASE_RESULT: ' + JSON.stringify(result)); return result.status === 'npc-released' ? 0 : 2;
  } catch (error) {
    log('CI_RELEASE_RESULT: ' + JSON.stringify(ciReleasePreparationFailure(error))); return 2;
  } finally { if (db) try { await db.terminate(); } catch { /* Do not reveal SDK diagnostics. */ } }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();

#!/usr/bin/env node
// First NPC release from the already CLOSED existing trial. Inert by default.
// This entry is a new official-CLI contract, not a retry of an owner journal.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, open, lstat, realpath, cp } from 'node:fs/promises';
import { resolve, join, dirname, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { createCiClients } from './floating-garden-ci-clients.mjs';
import { requireCiAuthPolicy } from './floating-garden-ci-auth-policy.mjs';
import { prepareCiPacket } from './prepare-floating-garden-ci-packet.mjs';
import { validateOperationReview } from './prepare-floating-garden-trial-operation.mjs';
import { createActiveUpdateProvider, ciProviderFailureDiagnostic } from './floating-garden-active-update-provider.mjs';
import { makeCloudRunner, describeAdapterFailure } from './floating-garden-trial-cloud-adapter.mjs';
import { checkTooling, canonicalVersionName } from './deploy-floating-garden-connection-template.mjs';
import { ACTIVE_UPDATE_SCOPE as S, prepareActiveUpdatePlan, recheckActiveUpdatePlan,
  proveOldInvocationIsolation, activeUpdateReason } from './floating-garden-active-update.mjs';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const failures = new WeakMap();
function need(condition, code) { if (!condition) { const e = new Error('CI release blocked'); failures.set(e, code); throw e; } }
const STAGES = ['closed-baseline', 'functions', 'rules', 'hosting', 'preservation', 'reopen', 'reopened'];
export function ciReleaseApproval(sourceCommit, runNumber) {
  return { schemaVersion: 1, repository: 'fabdemnt-dev/wa-awesome', sourceCommit, runNumber,
    oldInventory: S.oldInventory, newInventory: S.newInventory, expiresAtMillis: S.endsAtMillis,
    existingClosedTrial: true, fiveFunctionsRulesHosting: true, standardCliInternalRetriesAndParallelism: true,
    serviceIdentityGeneration: true, preserveExistingIamAndData: true, reopenSamePairOnce: true,
    noAutomaticRetryOrRollback: true, exclusiveMaintenance: true };
}
function context(env, approval, policy, now) {
  requireCiAuthPolicy(policy).validateEnvironment(env, []);
  need(/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '') && env.GITHUB_WORKFLOW_SHA === env.GITHUB_SHA &&
    /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID || '') && env.GITHUB_RUN_ATTEMPT === '1' && /^[1-9][0-9]*$/.test(env.GITHUB_RUN_NUMBER || '') && env.GARDEN_RELEASE_REF_CREATED === 'true', 'ci-context');
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
    const cliOutcome = ciProviderFailureDiagnostic(error);
    return { status: 'blocked', stage, reason, access, automaticRetry: false, automaticRollback: false,
      ...(adapter.httpStatus ? { httpStatus: adapter.httpStatus } : {}),
      ...(cliOutcome ? { cliOutcome } : {}), ...(journalWriteFailed ? { journalWriteFailed: true } : {}) };
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
  await privatePath(directory); const file = await open(join(directory, 'CI-RELEASE-JOURNAL.jsonl'), 'wx', 0o600);
  let terminal = false; const issued = new Set();
  const append = async value => { need(!terminal, 'journal'); await file.writeFile(JSON.stringify({ atMillis: now(), ...value }) + '\n'); await file.sync(); };
  await append({ event: 'created', originalExpiry: S.endsAtMillis });
  return {
    async issued(stage) { need(STAGES.includes(stage) && !issued.has(stage), 'journal'); issued.add(stage); await append({ event: 'issued', stage }); },
    async verified(stage) { need(issued.has(stage), 'journal'); await append({ event: 'verified', stage }); },
    async providerStep(s) { need(['functions', 'rules', 'hosting'].includes(s.resourceKind) && s.stage === `official-cli-${s.resourceKind}` && s.index === 0, 'journal'); await append({ event: 'cli-invocation-issued', stage: s.resourceKind }); },
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
  const raw = runner(process.execPath, [cli, 'hosting:channel:list', '--site', S.project, '--project', S.project, '--config', join(seed.gameDir, 'firebase.hosting-only.json'), '--non-interactive', '--json'], workDir);
  need(raw.exitCode === 0 && !raw.signal && !raw.timedOut, 'old-hosting-read');
  const response = JSON.parse(raw.stdout);
  const channel = response.result?.channels?.filter(c => c.name === `sites/${S.project}/channels/live`);
  need(response.status === 'success' && channel?.length === 1 && channel[0].url === S.origin && channel[0].release?.type === 'DEPLOY' && channel[0].release.version?.status === 'FINALIZED', 'old-hosting-read');
  canonicalVersionName(channel[0].release.version.name);
  const review = matchOldReview(JSON.parse(await readFile(seed.manifestPath, 'utf8')), pair, channel[0].release.message, now());
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
    const adapter = describeAdapterFailure(error);
    log('CI_RELEASE_RESULT: ' + JSON.stringify({ status: 'blocked', stage: 'preparation', reason: failures.get(error) || (['ci_clients_guard', 'ci_auth_policy_guard'].includes(error?.message) ? error.message : adapter.reason),
      access: 'unknown', automaticRetry: false, automaticRollback: false })); return 2;
  } finally { if (db) try { await db.terminate(); } catch { /* Do not reveal SDK diagnostics. */ } }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();

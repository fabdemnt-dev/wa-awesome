#!/usr/bin/env node
// Local files only. This module has no deployment executor, SDK, network client,
// credential API, or subprocess dependency. Commands below are review data.
import { lstat, realpath, readdir, readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { resolve, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { prepareTrialBundle, prepareClosedLive, FUNCTION_NAMES } from './prepare-floating-garden-trial.mjs';
import { validateTrialConfig, FIXED_TRIAL_PROJECT, FIXED_TRIAL_ORIGIN, TRIAL_REGION } from '../lab/floating-garden/trial/config.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const WEEK = 7 * 86400000;
const REVIEW_KEYS = Object.freeze(['schemaVersion', 'startsAtMillis', 'endsAtMillis', 'testerUids', 'retainBuildArtifacts', 'allowInitialFunctionRecreate', 'approvePublicInvoker']);
// Exact public values from deploy-floating-garden-connection-template.mjs's
// runtimeConfig(). Kept as data here so preparation never imports an executor.
const FIREBASE = Object.freeze({
  apiKey: 'AIzaSyCfa04hxQzY0T6gsVLsvTxIhB2zAB0v874',
  authDomain: 'wa-awesome-garden-stg.firebaseapp.com',
  projectId: FIXED_TRIAL_PROJECT,
  appId: '1:120030709276:web:015f4e996b7c42a4e801d9',
});
const APP_CHECK = Object.freeze({ provider: 'recaptcha-enterprise', siteKey: '6Lc_LNwtAAAAADRAHvql0FwxirR3c5jZlxS9QpYw', verified: true });
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fail = (message) => { throw new Error(message); };
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function ownData(input, keys, array = false) {
  if (input === null || typeof input !== 'object' || types.isProxy(input) ||
      (array ? !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype :
        Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)))) fail('Review must contain only plain own data.');
  const actual = Reflect.ownKeys(input);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) fail('Review contains missing or unknown fields.');
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('Review accessors are not allowed.');
    result[key] = descriptor.value;
  }
  return result;
}
function normalizedReview(input, now) {
  const data = ownData(input, REVIEW_KEYS);
  if (data.schemaVersion !== 1) fail('Unsupported review schema.');
  if (!Number.isSafeInteger(data.startsAtMillis) || data.startsAtMillis <= 0 ||
      !Number.isSafeInteger(data.endsAtMillis) || data.endsAtMillis <= 0 ||
      data.endsAtMillis - data.startsAtMillis !== WEEK) fail('Review window must contain exactly seven days as positive safe integer milliseconds.');
  if (now !== undefined && (!Number.isSafeInteger(now) || now <= 0 || now >= data.endsAtMillis || data.startsAtMillis - now > WEEK)) fail('Preparation must be within seven days before start and before the fixed deadline.');
  const uids = ownData(data.testerUids, ['0', '1', 'length'], true);
  if (uids.length !== 2 || [uids[0], uids[1]].some((uid) => typeof uid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) || uids[0] === uids[1]) fail('Review requires exactly two distinct valid tester identifiers.');
  for (const key of ['retainBuildArtifacts', 'allowInitialFunctionRecreate', 'approvePublicInvoker']) if (typeof data[key] !== 'boolean') fail('Review approvals must be explicit booleans.');
  return Object.freeze({ schemaVersion: 1, startsAtMillis: data.startsAtMillis, endsAtMillis: data.endsAtMillis,
    testerUids: Object.freeze([uids[0], uids[1]]), retainBuildArtifacts: data.retainBuildArtifacts,
    allowInitialFunctionRecreate: data.allowInitialFunctionRecreate, approvePublicInvoker: data.approvePublicInvoker });
}

export function validateOperationReview(input, { now = Date.now() } = {}) {
  // Do not use undefined to bypass the public validator's temporal check.
  if (!Number.isSafeInteger(now) || now <= 0) fail('Preparation time must be a positive safe integer.');
  return normalizedReview(input, now);
}
export function publicTrialConfig(review) {
  // Projection is independent of wall-clock time, allowing inspection after
  // expiry. Preparation and later operation separately validate current time.
  const checked = normalizedReview(review);
  return validateTrialConfig({ schemaVersion: 1, enabled: true, projectId: FIXED_TRIAL_PROJECT,
    previewOrigin: FIXED_TRIAL_ORIGIN, startsAtMillis: checked.startsAtMillis, endsAtMillis: checked.endsAtMillis,
    region: TRIAL_REGION, maxTesters: 2, maxRooms: 20, firebase: { ...FIREBASE }, appCheck: { ...APP_CHECK } });
}
function operationPlan(review) {
  const command = (cwd, config, only) => ({ cwd, argv: ['firebase', '--config', config, '--project', FIXED_TRIAL_PROJECT, 'deploy', '--only', only] });
  return freeze({ schemaVersion: 1, mode: 'local-preparation-only', projectId: FIXED_TRIAL_PROJECT,
    region: TRIAL_REGION, origin: FIXED_TRIAL_ORIGIN,
    trialWindow: { startsAtMillis: review.startsAtMillis, endsAtMillis: review.endsAtMillis },
    functionNames: [...FUNCTION_NAMES], maxTesters: 2, maxRooms: 20,
    commandsNotExecuted: {
      functions: command('game', 'firebase.trial.json', FUNCTION_NAMES.map((name) => `functions:floating-garden-trial:${name}`).join(',')),
      rules: command('game', 'firebase.trial.json', 'firestore:rules'),
      gameHosting: command('game', 'firebase.hosting-only.json', `hosting:${FIXED_TRIAL_PROJECT}`),
      stoppedHosting: command('stopped', 'firebase.maintenance.json', `hosting:${FIXED_TRIAL_PROJECT}`),
    },
    initialGate: { enabled: false, testerCount: 0 },
    requiredApprovals: ['game-deployment', 'tester-enrollment', 'trial-activation', 'initial-function-recreate', 'public-invoker', 'retain-build-artifacts'],
    retention: { buildArtifacts: 'retain', deleteCommands: [], automaticCleanup: false,
      warning: 'An unconfigured current artifact cleanup policy does not prove that a later CLI will not prompt about cleanup. Do not accept or configure automatic deletion.' },
    cliEffects: { firebaseToolsVersion: '14.27.0',
      serviceIdentityGeneration: ['pubsub.googleapis.com', 'eventarc.googleapis.com'],
      initialFunctionRecreate: 'The untouched CLI can internally delete and recreate a just-created function after a Cloud Run resource-capacity error; allowInitialFunctionRecreate must be true before execution.',
      publicInvoker: 'Callable deployment grants the generated Cloud Run service public invocation; approvePublicInvoker must be true before execution. App Check, Auth and private trial gates remain required.',
      retainBuildArtifacts: 'retainBuildArtifacts must be true before execution; never enable automatic artifact cleanup.',
      warning: 'These are disclosed CLI effects, not authority to execute them. The exact effects and new service identities require explicit execution approval.' },
    stopPlan: ['Disable the private trial gate first.', 'Replace only the exact dedicated Hosting site with the stopped bundle.', 'Retain records, functions, build artifacts, Auth users, secrets and IAM; deletion requires a separately reviewed action.'],
    warning: 'Local preparation does not authorize or perform deployment, tester registration, activation, IAM changes, or resource deletion. False review approval fields do not grant permission. The fixed Hosting URL does not expire; client and backend gates use the fixed deadline.',
  });
}
function pathText(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\u0000')) fail('An explicit safe local path is required.');
  return resolve(value);
}
async function directoryWithoutLinks(path) {
  // Reject symlinks at every existing path component, not merely the leaf.
  let part = resolve(sep);
  for (const name of resolve(path).split(sep).filter(Boolean)) {
    part = join(part, name);
    const info = await lstat(part);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('Local directory paths must not contain symlinks.');
  }
  if (await realpath(path) !== resolve(path)) fail('Local directory paths must be canonical.');
}
function inside(root, path) {
  const rel = relative(root, path);
  return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
}
async function checkSourceDirectories(source) {
  // Every directory traversed by the existing generator's narrow input list.
  for (const path of ['lab/floating-garden', 'lab/floating-garden/online', 'lab/floating-garden/trial',
    'functions/floating-garden-trial', 'functions/floating-garden-online/core']) await directoryWithoutLinks(join(source, path));
  const template = await lstat(join(source, 'functions/floating-garden-trial/firestore.rules.template'));
  if (!template.isFile() || template.isSymbolicLink()) fail('Rules template must be a regular source file.');
}
async function collectFiles(directory, prefix = '', budget = { files: 0, bytes: 0 }) {
  const files = {};
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name), key = prefix + name, info = await lstat(path);
    if (info.isSymbolicLink()) fail('Prepared artifacts must not contain symlinks.');
    if (info.isDirectory()) Object.assign(files, await collectFiles(path, key + '/', budget));
    else {
      if (!info.isFile() || info.nlink !== 1 || info.size > 4 * 1024 * 1024 || ++budget.files > 128 || (budget.bytes += info.size) > 16 * 1024 * 1024) fail('Prepared artifact inventory is unsafe or exceeds its fixed budget.');
      files[key] = sha256(await readFile(path));
    }
  }
  return files;
}

export async function prepareTrialOperation({ review, output, now = Date.now(), repositoryRoot = ROOT }) {
  const checked = validateOperationReview(review, { now }), config = publicTrialConfig(checked);
  const destination = pathText(output), source = pathText(repositoryRoot), ownRepository = pathText(ROOT);
  await directoryWithoutLinks(source);
  await directoryWithoutLinks(dirname(destination));
  if (inside(source, destination) || inside(ownRepository, destination)) fail('Operation output must be outside the repository.');
  try { await lstat(destination); fail('Operation output already exists; choose a fresh directory.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await checkSourceDirectories(source);
  // A failure leaves an incomplete local directory, never a usable manifest.
  // Nothing is overwritten or deleted, and no source file is changed.
  await mkdir(destination, { mode: 0o700 });
  await chmod(destination, 0o700);
  const gameDir = join(destination, 'game'), stoppedDir = join(destination, 'stopped');
  await prepareTrialBundle({ config, output: gameDir, now, repositoryRoot: source });
  await prepareClosedLive({ project: FIXED_TRIAL_PROJECT, output: stoppedDir });
  await chmod(gameDir, 0o700); await chmod(stoppedDir, 0o700);
  const reviewPath = join(destination, 'private-review.json'), planPath = join(destination, 'OPERATION-PLAN.json');
  const reviewBytes = json(checked), reviewDigest = sha256(reviewBytes);
  await writeFile(reviewPath, reviewBytes, { flag: 'wx', mode: 0o600 });
  await chmod(reviewPath, 0o600);
  await writeFile(planPath, json(operationPlan(checked)), { flag: 'wx', mode: 0o600 });
  const files = { ...await collectFiles(gameDir, 'game/'), ...await collectFiles(stoppedDir, 'stopped/'), 'OPERATION-PLAN.json': sha256(await readFile(planPath)) };
  const manifest = { schemaVersion: 1, projectId: FIXED_TRIAL_PROJECT, origin: FIXED_TRIAL_ORIGIN, reviewDigest,
    files: Object.fromEntries(Object.entries(files).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) };
  const manifestPath = join(destination, 'OPERATION-MANIFEST.json'), manifestBytes = json(manifest);
  // The manifest is the final completion marker, after both complete bundles.
  await writeFile(manifestPath, manifestBytes, { flag: 'wx', mode: 0o600 });
  return Object.freeze({ output: destination, gameDir, stoppedDir, manifestPath, reviewPath, planPath,
    fileCount: Object.keys(files).length + 2, manifestDigest: sha256(manifestBytes), reviewDigest,
    startsAtMillis: checked.startsAtMillis, endsAtMillis: checked.endsAtMillis, testerCount: 2 });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.length || args.length === 1 && args[0] === '--plan') {
    console.log('LOCAL_PLAN: validate one private review containing two distinct testers and an exact seven-day window; prepare the dedicated game and stopped bundles in a fresh private directory outside the repository; write checksums and an unexecuted operation plan. No cloud action.');
  } else if (args.length === 4 && args[0] === '--review' && args[2] === '--out') {
    try {
      const path = pathText(args[1]); await directoryWithoutLinks(dirname(path));
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.size > 8192) fail('Input review must be a private regular file of at most 8192 bytes.');
      const review = JSON.parse(await readFile(path, 'utf8'));
      console.log(JSON.stringify(await prepareTrialOperation({ review, output: args[3] }), null, 2));
    } catch { console.error('STOP: local preparation failed. Check the private review, fixed window and fresh output path. No cloud action was attempted; an incomplete directory is not an operation package.'); process.exitCode = 1; }
  } else { console.error('STOP: use --plan or --review PRIVATE_REVIEW.json --out FRESH_DIRECTORY.'); process.exitCode = 1; }
}

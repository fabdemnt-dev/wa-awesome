#!/usr/bin/env node
// LOCAL ONLY. Reuse the existing pure operation generator (and its
// prepareTrialBundle/publicTrialConfig), without owner HOME or cloud setup.
// ACTIVE_UPDATE_SCOPE's import graph does not initialize an SDK. No operator,
// provider, subprocess, credential, network or deployment function is called.
import { constants } from 'node:fs';
import { lstat, realpath, readdir, readFile, open, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, join, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual, types } from 'node:util';
import { prepareTrialOperation, publicTrialConfig, validateOperationReview } from './prepare-floating-garden-trial-operation.mjs';
import { FUNCTION_NAMES } from './prepare-floating-garden-trial.mjs';
import { ACTIVE_UPDATE_SCOPE as S } from './floating-garden-active-update.mjs';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const stop = () => { throw new Error('CI packet blocked: invalid input, source inventory, output, or fixed deadline. No cloud action.'); };
function path(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.length > 4096 || /[\x00-\x1f]/.test(value)) stop();
  return resolve(value);
}
async function directory(value) {
  let part = sep;
  for (const name of value.split(sep).filter(Boolean)) {
    part = join(part, name);
    const info = await lstat(part);
    if (!info.isDirectory() || info.isSymbolicLink()) stop();
  }
  if (await realpath(value) !== value) stop();
}
async function privateReview(value) {
  await directory(dirname(value));
  const privateFile = info => info.isFile() && info.nlink === 1 && !(info.mode & 0o077) && info.size <= 8192;
  if (!privateFile(await lstat(value))) stop();
  const file = await open(value, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!privateFile(await file.stat())) stop();
    const bytes = Buffer.alloc(8193), { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 8192) stop();
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
  } finally { await file.close(); }
}
async function inventory(root, prefix = '', budget = { files: 0, bytes: 0 }) {
  const files = {};
  for (const name of (await readdir(join(root, prefix))).sort()) {
    // The existing packet keeps its review private; neither it nor its
    // review-dependent manifest is part of the public source inventory pin.
    if (!prefix && ['private-review.json', 'OPERATION-MANIFEST.json'].includes(name)) continue;
    const key = prefix + name, full = join(root, key), info = await lstat(full);
    if (info.isSymbolicLink()) stop();
    if (info.isDirectory()) Object.assign(files, await inventory(root, `${key}/`, budget));
    else {
      if (!info.isFile() || info.nlink !== 1 || info.size > 4 * 1024 * 1024 ||
          ++budget.files > 128 || (budget.bytes += info.size) > 16 * 1024 * 1024) stop();
      files[key] = sha(await readFile(full));
    }
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
function commands() {
  const command = (config, only) => ({ cwd: 'packet/game',
    argv: ['firebase', '--config', config, '--project', S.project, 'deploy', '--only', only] });
  return {
    functions: { driver: 'floating-garden-ci-release.mjs', cli: 'gcloud', version: '568.0.0',
      existingFunctionNames: [...FUNCTION_NAMES], sequential: true, identitiesFromVerifiedBaseline: true },
    rules: command('firebase.trial.json', 'firestore:rules'),
    hosting: command('firebase.hosting-only.json', `hosting:${S.project}`),
  };
}
export async function prepareCiPacket(options) {
  if (!options || types.isProxy(options) || ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
      Reflect.ownKeys(options).some(key => !['reviewPath', 'output', 'now'].includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), 'value'))) stop();
  const { reviewPath, output, now = Date.now } = options;
  if (typeof now !== 'function') stop();
  const input = path(reviewPath), destination = path(output);
  const rel = relative(ROOT, destination);
  if (!rel || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) stop();
  await directory(dirname(destination));
  const review = validateOperationReview(await privateReview(input), { now: now() });
  const config = publicTrialConfig(review);
  if (config.startsAtMillis !== S.startsAtMillis || config.endsAtMillis !== S.endsAtMillis ||
      config.projectId !== S.project || config.previewOrigin !== S.origin || config.region !== S.region ||
      config.maxRooms !== S.maxRooms || config.maxTesters !== 2) stop();
  // Exclusive creation: an existing or partially prepared output is never reused.
  await mkdir(destination, { mode: 0o700 });
  const packet = await prepareTrialOperation({ review, output: join(destination, 'packet'), now: now() });
  const files = await inventory(packet.output);
  const manifest = JSON.parse(await readFile(packet.manifestPath, 'utf8'));
  const inventoryDigest = sha(JSON.stringify(files)); // Existing canonical ASCII inventory scheme.
  if (!isDeepStrictEqual(files, manifest.files) || inventoryDigest !== S.newInventory) stop();
  const firebase = JSON.parse(await readFile(join(packet.gameDir, 'firebase.trial.json'), 'utf8'));
  const hosting = JSON.parse(await readFile(join(packet.gameDir, 'firebase.hosting-only.json'), 'utf8'));
  if (!isDeepStrictEqual(Object.keys(firebase).sort(), ['firestore', 'functions', 'hosting']) ||
      !isDeepStrictEqual(firebase.functions, { source: 'functions', codebase: 'floating-garden-trial', ignore: ['node_modules', '**/.*', '*-debug.log'] }) ||
      !isDeepStrictEqual(firebase.firestore, { rules: 'firestore.rules', indexes: 'firestore.indexes.json' }) ||
      firebase.hosting.site !== S.project || firebase.hosting.public !== 'public' ||
      !isDeepStrictEqual(hosting, { hosting: firebase.hosting })) stop();
  validateOperationReview(review, { now: now() }); // Never mark a late build complete after expiry.
  const summary = {
    schemaVersion: 1, mode: 'local-ci-preparation-only', project: S.project, site: S.project,
    region: S.region, origin: S.origin,
    trialWindow: { startsAtMillis: S.startsAtMillis, endsAtMillis: S.endsAtMillis },
    inventoryDigest, inventoryFileCount: Object.keys(files).length,
    commandsNotExecuted: commands(),
    warning: 'Local preparation only. Commands are review data, not deployment or activation authorization. Do not import initial admin records into an existing trial. Retain the private packet locally; do not upload it or its review as a public CI artifact.',
  };
  // A separate completion marker keeps the exact original packet unchanged.
  // No paths, review digests, tester identifiers, or review approvals are output.
  await writeFile(join(destination, 'CI-SUMMARY.json'), json(summary), { flag: 'wx', mode: 0o600 });
  return summary;
}
export async function main(args = process.argv.slice(2), { log = console.log, now = Date.now } = {}) {
  if (!args.length || args.length === 1 && args[0] === '--plan') {
    log('LOCAL_PLAN: prepare the exact pinned NPC packet from a private review and original fixed window; --review ABSOLUTE_FILE --out FRESH_ABSOLUTE_DIRECTORY. Commands are review data. No cloud action.');
    return 0;
  }
  if (args.length === 4 && args[0] === '--review' && args[2] === '--out') {
    try { log(json(await prepareCiPacket({ reviewPath: args[1], output: args[3], now })).trimEnd()); return 0; }
    catch { /* Deliberately do not serialize input, paths, or caught errors. */ }
  }
  log('CI_PACKET_BLOCKED: invalid local input, source inventory, output, or fixed deadline. No cloud action; no automatic retry.');
  return 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();

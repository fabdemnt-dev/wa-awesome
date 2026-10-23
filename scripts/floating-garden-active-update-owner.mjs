#!/usr/bin/env node
// Standalone owner entry. Only built-in modules are imported before the complete
// immutable public source closure has passed byte and path verification.
// Cloud-read-only: prepare local files, reuse existing dependencies, inspect.
// This entry has no apply mode, approval object or mutation-journal creation.
import { readFile, writeFile, lstat, realpath, readdir, mkdir, cp, open } from 'node:fs/promises';
import { resolve, join, dirname, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const OWNER_SOURCE_COMMIT = 'b7dd16da4fdbb19e401423beb42a3da5c49e75d1';
export const OWNER_SOURCE_TREE = 'ad707eca475b0477dccf4094a442dd31aede54fc';
// A new immutable inspection generation never rewrites the prior preparation.
export const OWNER_PREPARATION_NAME = 'garden-active-update-41c44301490e-iam-read-v2';
export const OWNER_SOURCE_FILES = Object.freeze({
  "config/floating-garden-trial/deny-all.rules": "ed1e7c11f025d9464e80e4c4584711c474a0c9b0e07802618de8d02dddadec87",
  "config/floating-garden-trial/example.json": "4ad53f032150f09ba651901b7ea583c9698a1c0cdbf99fe775b82fd086e3995c",
  "functions/floating-garden-online/contract.js": "f65b2d973a641339f4f3a80230db0fbbfa6b4e723563a17585513e4d8616a8b8",
  "functions/floating-garden-online/core/cpu.js": "fc4ae14182b01aa3eb2a7d7f1a5c9ca0b0106c8f6ac4e1a65df611f1341b89dc",
  "functions/floating-garden-online/core/engine.js": "5f3140bfe443910146e2b47e4ab0b3d846ac2418c2f87f15d02f0c3c29454e00",
  "functions/floating-garden-online/core/match-engine.js": "1f748c5f1fb5279bcdd21825de6c377cc579caf726f18b87d4cfbeba7f92948d",
  "functions/floating-garden-online/core/package.json": "609158e6c5fbc237939fa3ddf7faab80ab690bdc0c8d584414a885130103c4e8",
  "functions/floating-garden-online/handlers.js": "e4447b63ed88d4b0180f64d36774de45b0dc23da08a5c7784f1c6749265cd60c",
  "functions/floating-garden-online/index.js": "819ac537058485e7dbae47d74cd6845115afd8a695b9c8431e2c46c558566c5d",
  "functions/floating-garden-online/invite-code.js": "b670b5592d04bd2f73eaa005be7ea48c2f6a004c6b93cc66553785ddd46f88e2",
  "functions/floating-garden-trial/config.js": "a0a42addf541227f6f571f6931c2bde7b59bbb2a674e45fcf1b65ed8abf7dc31",
  "functions/floating-garden-trial/firestore.rules.template": "07e97aedb886bd29a11d484a622dc9243315022aa83ab52441be940c6314c78a",
  "functions/floating-garden-trial/index.js": "e778c38abf6f1c160ccb42ef36835a4205ac17b19f91ab6bf8a858c17832a638",
  "functions/floating-garden-trial/package-lock.json": "da967c535f96a09f1b59f7d7e3d6cb22cb233ccd9cde919c14408e64a0bc3f6a",
  "functions/floating-garden-trial/package.json": "0d9de042ca000ef81ec19935487cd309687fa8a235fad78e19695fb4f9a75964",
  "functions/floating-garden-trial/trial-handlers.js": "0e0e7a99194a728e03749b01a937ed1e15ef978fdb050fe8ca7d54fc0fc36add",
  "lab/floating-garden/app.js": "e3c2d83c74358f26a9ff120d35553b6d84e37235cc604cce5bd2d993f8eeac85",
  "lab/floating-garden/connection-check/app.js": "d8eb7c93ff51bbf1ccb8e5c8f5a78957a08b53669510ff0d3b9b647a9ab9a6ec",
  "lab/floating-garden/connection-check/connection.js": "ae1852392fbfcd535626d87c320c47de65c101ab4049b6048d31875dff9eba18",
  "lab/floating-garden/connection-check/index.html": "df9f726f3b13dfa779ae068ab69594502dea548e64586cdf5d4dbf98046cd9b9",
  "lab/floating-garden/connection-check/style.css": "25aef22d9e8bd13652cccbbd4a2f005a19de8b8b984c7a549d22440875d253e2",
  "lab/floating-garden/cpu.js": "fc4ae14182b01aa3eb2a7d7f1a5c9ca0b0106c8f6ac4e1a65df611f1341b89dc",
  "lab/floating-garden/engine.js": "5f3140bfe443910146e2b47e4ab0b3d846ac2418c2f87f15d02f0c3c29454e00",
  "lab/floating-garden/index.html": "e0e793474e87ff1a57cc5c4c0cadbc4245d74cb11aef878ddc8eb356144f95b0",
  "lab/floating-garden/match-app.js": "69a546125e640080d9dc6de033ae315d4552acaa714e8c3a16e1c8b439654ac6",
  "lab/floating-garden/match-assist.js": "5ba31aed97a199aaaeeb316ccea0cdd54efc2016b4ba2fc95c2922a022d4b73e",
  "lab/floating-garden/match-engine.js": "1f748c5f1fb5279bcdd21825de6c377cc579caf726f18b87d4cfbeba7f92948d",
  "lab/floating-garden/match-rule-examples.js": "90c431e5fb11ef87dd43d6f086a38668c8b7533b78f5df9fcd72195c6904a61b",
  "lab/floating-garden/match-save.js": "ad986f1800f2d15c195c286be0cfc55156fadc3703c746906def3533577edf95",
  "lab/floating-garden/match-style.css": "53c9f47e9cac77800420b9d8c23743e88a1f41eb347933014bb85abda7ae26b3",
  "lab/floating-garden/match-view.js": "38398792af18371f861c1eab526fba0e70b9f7b7893abd94e6cf2cfe62c227b2",
  "lab/floating-garden/match.html": "63131acc37deef1ade5f95bfa3c6ae9b16f837e2575c29cc9499b2ad923ea1c6",
  "lab/floating-garden/online/app.js": "0a48844e92bf34d16d28f468ff3c7cbed19a360b3d5e4abcbb4062bdba7ee218",
  "lab/floating-garden/online/config.js": "ba9da504e932addb4e404f075b1d910bdf3f63bc5f4a62ce530941c72253bd12",
  "lab/floating-garden/online/controller.js": "0b9a7fd85a7a00f5dbf4e0a9e129eaed6ae3a6cddcfca51aaa3741b49f9f736c",
  "lab/floating-garden/online/firebase.js": "371e5bf4b11de73f6b92037369704296c015e951c583f5736d4651e850270018",
  "lab/floating-garden/online/index.html": "14b53b998aa51a0936a07ebd4fe248a00e7ae3c17946122545491f8472b3651d",
  "lab/floating-garden/online/mount.js": "3c9acac53edbcfd4d887050e8c295b42a92f53ed877adf4f34e6c7d1b7dfc83a",
  "lab/floating-garden/online/style.css": "c7536c7b7ac6ef2f4fb816bc3d2fd243d759bbaca4cd1cf8f3701dd3bae88573",
  "lab/floating-garden/online/view.js": "6c73e6ac36ef4107aabb7bbb1540edbdfa53c80557c05bf9621bd35c0646f5bb",
  "lab/floating-garden/session.js": "c033cf7fdf8f7919efc39f2cfb4f1feab3080bcf68a0e7658d5d93a0bd9cf3d1",
  "lab/floating-garden/style.css": "ef292190d71ccbe349861b41d3382a1fed6a9046f6e8afe95ce22ed9f4692e8c",
  "lab/floating-garden/table-demo.js": "7d847271b52b093ea6ffabe32a13760aa1d67b78f0401cac23b6ec4b464f87a5",
  "lab/floating-garden/trial/app.js": "ca6618067be54a4ebc78ba8be16b14122bac83f9c9e5a077695ef73e7574b4f0",
  "lab/floating-garden/trial/bootstrap.js": "3a1c94367766c54ac524c0a437071516107f6c397d5c55f3f1196402bb8334ee",
  "lab/floating-garden/trial/config.js": "4c5e68aa80891478721d1856def25f260368d25158e58817f7fe368ee8122808",
  "lab/floating-garden/trial/firebase.js": "20cebe961e5d1fd9ae1cdef7b8c07162a4bb2b6a5a107d505a3e6d6bd7c1822c",
  "lab/floating-garden/trial/index.html": "541e86f5a328fa82018f55345bbfaef5ff90f579baaaf5bd69866f0e72b73e93",
  "lab/floating-garden/trial/style.css": "f251f0864aa15ec8dfa4e18e7e1dba370d694150272e3a104374de22fb1a4619",
  "lab/floating-garden/trial/trialruntime.js": "f84114ff0c6ba70344027744bf427ddf50fd86614ef8c0d967f2eba8e8f7f47d",
  "lab/floating-garden/view.js": "378ea9d08f7853e4725a8f09a934dd67ac504297303fedf71d74d80a2bf6beea",
  "package.json": "afca224366f8c80961d57ba249f01a900e3502a150cc917062c72778d4828dea",
  "scripts/bootstrap-floating-garden-apis.mjs": "40c3d939edc8dc502c2ae7d1d6b448a344eade422e66f3c9c13b017f03eacd26",
  "scripts/bootstrap-floating-garden-hmac.mjs": "ff314f26f8cc37da12fe54d6a9e0132950e0c00b52c50bffcf9b100969e8ee48",
  "scripts/bootstrap-floating-garden-runtime.mjs": "007f7ccf0ea88b38f48f4001ac7ecc244ddc14d96649315f7654ac663313a39b",
  "scripts/deploy-floating-garden-connection-check.mjs": "ec1c39f951c3ce1f866c34628bd774089305936524c935f288ae89f78187be11",
  "scripts/deploy-floating-garden-connection-template.mjs": "5133a9c8659207b78c753cf89c4a9d3dddfeae78c8b4b903fd313253538ca92d",
  "scripts/floating-garden-active-update-provider.mjs": "8d4b6a2b1e558f1e4a3a0c77b4c852d301e622462725e1daed734cb634f4c252",
  "scripts/floating-garden-active-update-transport.mjs": "2d92b468ed74cba77210435f31b662c1c0a91c3fc53dd92854abd79ecd14e1c7",
  "scripts/floating-garden-active-update.mjs": "75bb394312e1b77eed1a03c95bf3218d2e4afcb197db336f653d5f236e33ea70",
  "scripts/floating-garden-trial-cloud-adapter.mjs": "3649aaf36ed7ad270c6e3143eb1e895a7d3371a5d1fe7ba6121b92ad374d658f",
  "scripts/operate-floating-garden-trial.mjs": "b651faa287cf81d0ace154c16c9f51446bf233dc2b485544ce68af27630e1760",
  "scripts/prepare-floating-garden-trial-operation.mjs": "60098c23b79b8ea9a65e69ac3ce61b18a1222fbe83ac949f3f89a86663c6fbfd",
  "scripts/prepare-floating-garden-trial.mjs": "c78cb46dad837bb280ff9ad8d9cd66f76e9d9ab48272d71784b619e7c877356c"
});
const ROOT_NAMES = Object.freeze(['PREPARATION.json', 'operation', 'source']);
const OPERATION_NAMES = Object.freeze(['OPERATION-MANIFEST.json', 'OPERATION-PLAN.json', 'game', 'private-review.json', 'stopped']);
const MARKER_KEYS = Object.freeze(['schemaVersion', 'sourceCommit', 'sourceTree', 'previousOutput', 'previousManifestDigest', 'targetManifestDigest', 'reviewDigest']);
const STAGES = new Set(['owner-paths', 'source-download', 'source-verification', 'operation-selection', 'target-preparation', 'runtime-reuse', 'local-readiness', 'baseline-read']);
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const stop = () => { throw Error('Owner inspection stopped.'); };
const need = condition => { if (!condition) stop(); };
async function canonicalDirectory(path, { privateDirectory = false } = {}) {
  need(typeof path === 'string' && path === resolve(path));
  let part = sep;
  for (const name of path.split(sep).filter(Boolean)) {
    part = join(part, name); const info = await lstat(part); need(info.isDirectory() && !info.isSymbolicLink());
  }
  need(await realpath(path) === path);
  if (privateDirectory) need(((await lstat(path)).mode & 0o077) === 0);
}
async function regularFile(path, { privateFile = false, limit = MAX_FILE_BYTES } = {}) {
  await canonicalDirectory(dirname(path)); const info = await lstat(path);
  need(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= limit && (!privateFile || (info.mode & 0o077) === 0));
  return readFile(path);
}
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function sourceInventory(source) {
  await canonicalDirectory(source, { privateDirectory: true });
  const files = []; let directories = 0;
  async function visit(path, prefix = '') {
    for (const name of await readdir(path)) {
      const full = join(path, name), key = prefix + name, info = await lstat(full);
      need(!info.isSymbolicLink());
      if (info.isDirectory()) {
        need(++directories <= 128 && Object.keys(OWNER_SOURCE_FILES).some(file => file.startsWith(key + '/')));
        await visit(full, key + '/');
      } else { need(info.isFile() && files.length < 64); files.push(key); }
    }
  }
  await visit(source);
  need(isDeepStrictEqual(files.sort(), Object.keys(OWNER_SOURCE_FILES).sort()));
  for (const [path, digest] of Object.entries(OWNER_SOURCE_FILES)) need(hash(await regularFile(join(source, path))) === digest);
}
async function downloadSource(source, fetchImpl) {
  await mkdir(source, { mode: 0o700 });
  for (const [path, digest] of Object.entries(OWNER_SOURCE_FILES)) {
    const url = `https://raw.githubusercontent.com/fabdemnt-dev/wa-awesome/${OWNER_SOURCE_COMMIT}/${path}`;
    const response = await fetchImpl(url, { redirect: 'error', credentials: 'omit', cache: 'no-store',
      headers: { Accept: 'application/octet-stream' }, signal: AbortSignal.timeout(30000) });
    need(response.status === 200 && response.url === url && response.redirected !== true && response.body?.getReader);
    const length = response.headers.get('content-length'); if (length !== null) need(/^[0-9]+$/.test(length) && Number(length) <= MAX_FILE_BYTES);
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; need(size <= MAX_FILE_BYTES); chunks.push(Buffer.from(chunk.value)); }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    const bytes = Buffer.concat(chunks); need(hash(bytes) === digest);
    const destination = join(source, path); await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await canonicalDirectory(dirname(destination)); await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
  }
  await sourceInventory(source);
}
function checkInitialEnvironment(env, execArgv) {
  need(Number(process.versions.node.split('.')[0]) >= 20);
  need(!execArgv.some(argument => /inspect|trace|heap|prof|report|require|import/i.test(argument)));
  const present = value => value !== undefined && value !== null && value !== '';
  const enabled = value => value === true || ['true', '1'].includes(String(value).toLowerCase());
  // Match the pinned provider prerequisite before even a public-source fetch.
  // Do not erase overrides, select a different route, or weaken TLS to proceed.
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
    'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'NODE_OPTIONS', 'NODE_V8_COVERAGE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'GOOGLE_APPLICATION_CREDENTIALS',
    'GCLOUD_ACCESS_TOKEN', 'GOOGLE_OAUTH_ACCESS_TOKEN', 'DEBUG', 'GRPC_TRACE', 'GRPC_VERBOSITY', 'GOOGLE_SDK_NODE_LOGGING']) need(!present(env[key]));
  for (const [key, value] of Object.entries(env)) if (present(value)) {
    need(!/^npm_config_(?:proxy|http_proxy|https_proxy|noproxy|cafile|ca|cert|key|strict_ssl|registry|userconfig|globalconfig|node_options|_auth|_authToken)$/i.test(key));
    need(!key.startsWith('CLOUDSDK_API_ENDPOINT_OVERRIDES_') && !key.startsWith('FIREBASE_') && !/_EMULATOR_HOST$/.test(key) &&
      !/^GOOGLE_(API_USE|CLOUD_UNIVERSE_DOMAIN)/.test(key) &&
      !/^CLOUDSDK_AUTH_(ACCESS_TOKEN|ACCESS_TOKEN_FILE|CREDENTIAL_FILE_OVERRIDE|IMPERSONATE_SERVICE_ACCOUNT|TOKEN_HOST|AUTH_HOST)$/.test(key));
  }
  for (const key of ['CLOUDSDK_AUTH_DISABLE_CREDENTIALS', 'CLOUDSDK_AUTH_DISABLE_SSL_VALIDATION', 'CLOUDSDK_CORE_DISABLE_SSL_VALIDATION']) need(!enabled(env[key]));
}
async function validateRuntime(packet) {
  const root = join(packet.gameDir, 'functions'), modules = join(root, 'node_modules'); await canonicalDirectory(modules);
  for (const [name, version] of [['firebase-admin', '12.7.0'], ['firebase-functions', '6.6.0'], ['google-auth-library', '9.15.1'], ['@google-cloud/firestore', '7.11.6']]) {
    need(JSON.parse(await regularFile(join(modules, name, 'package.json'))).version === version);
  }
  const req = createRequire(join(root, 'package.json'));
  for (const name of ['firebase-admin/app', 'firebase-admin/firestore', 'firebase-functions/v2/https', 'google-auth-library']) need((await realpath(req.resolve(name))).startsWith(modules + sep));
  for (const [parent, dependency, version] of [['google-auth-library', 'gaxios', '6.7.1'], ['firebase-admin/firestore', '@google-cloud/firestore', '7.11.6']]) {
    const path = createRequire(req.resolve(parent)).resolve(`${dependency}/package.json`);
    need((await realpath(path)).startsWith(modules + sep) && JSON.parse(await regularFile(path)).version === version);
  }
}
async function copyRuntime(previous, next) {
  await validateRuntime(previous);
  const old = join(previous.gameDir, 'functions'), current = join(next.gameDir, 'functions');
  for (const name of ['package.json', 'package-lock.json']) need((await regularFile(join(old, name))).equals(await regularFile(join(current, name))));
  need(!await exists(join(current, 'node_modules')));
  // Only a fresh target receives this copy. Never install, dereference external
  // symlinks, overwrite the old runtime, or relax the old failed-deploy copier.
  await cp(join(old, 'node_modules'), join(current, 'node_modules'), { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
  await validateRuntime(previous); await validateRuntime(next);
}
async function writeMarker(path, marker) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(marker, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); }
}
function expectedMarker(previous, next) {
  return { schemaVersion: 1, sourceCommit: OWNER_SOURCE_COMMIT, sourceTree: OWNER_SOURCE_TREE,
    previousOutput: previous.output, previousManifestDigest: previous.manifestDigest,
    targetManifestDigest: next.manifestDigest, reviewDigest: next.reviewDigest };
}
/** Test capabilities are unavailable as CLI arguments. Production always uses
 * the owner's existing home, native HTTPS and verified public provider module. */
export async function inspectOwnerActiveUpdate({ home = homedir(), fetchImpl = fetch, env = process.env, execArgv = process.execArgv,
  now = Date.now, log = console.log, createProvider } = {}) {
  let stage = 'owner-paths', diagnose = () => 'unclassified';
  try {
    checkInitialEnvironment(env, execArgv); await canonicalDirectory(home);
    const original = join(home, 'garden-final-reviewed-v1'), updated = join(home, 'garden-lobby-entry-reviewed-v1');
    const toolingDir = join(home, 'garden-trial-f0bc4eb0', 'tooling');
    await canonicalDirectory(toolingDir);
    need(await exists(original) || await exists(updated));
    for (const directory of [original, updated]) if (await exists(directory)) await canonicalDirectory(directory, { privateDirectory: true });
    const base = join(home, OWNER_PREPARATION_NAME), source = join(base, 'source'), output = join(base, 'operation'), markerPath = join(base, 'PREPARATION.json');
    const reused = await exists(base);
    if (reused) {
      await canonicalDirectory(base, { privateDirectory: true });
      need(isDeepStrictEqual((await readdir(base)).sort(), [...ROOT_NAMES].sort()));
      need(await exists(markerPath));
    } else {
      await mkdir(base, { mode: 0o700 }); stage = 'source-download'; await downloadSource(source, fetchImpl);
    }
    stage = 'source-verification'; await sourceInventory(source);
    // The entire imported module closure has now been checked against the
    // immutable 64-file manifest, before any non-built-in module is evaluated.
    const load = path => import(pathToFileURL(join(source, path)).href);
    const setup = await load('scripts/deploy-floating-garden-connection-template.mjs'); setup.validateEnvironment(env, execArgv);
    const operator = await load('scripts/operate-floating-garden-trial.mjs');
    const active = await load('scripts/floating-garden-active-update.mjs'); diagnose = active.activeUpdateReason;
    const provider = await load('scripts/floating-garden-active-update-provider.mjs');
    stage = 'operation-selection';
    const selected = await operator.selectVerifiedHostingOperation(join(original, 'operation'), join(updated, 'operation'));
    need([join(original, 'operation'), join(updated, 'operation')].includes(selected));
    const previous = await operator.readOperationPacket(selected);
    stage = 'target-preparation';
    if (!reused) {
      const preparation = await load('scripts/prepare-floating-garden-trial-operation.mjs');
      await preparation.prepareTrialOperation({ review: previous.review, output, repositoryRoot: source, now: now() });
    }
    const next = await operator.readOperationPacket(output);
    need(isDeepStrictEqual((await readdir(output)).sort(), [...OPERATION_NAMES].sort()));
    const plan = await active.prepareActiveUpdatePlan({ previousOutput: selected, nextOutput: output });
    stage = 'runtime-reuse';
    if (reused) {
      const marker = JSON.parse(await regularFile(markerPath, { privateFile: true, limit: 16384 }));
      need(isDeepStrictEqual(Object.keys(marker).sort(), [...MARKER_KEYS].sort()) && isDeepStrictEqual(marker, expectedMarker(previous.packet, next.packet)));
      await validateRuntime(next.packet);
    } else {
      await copyRuntime(previous.packet, next.packet);
      await operator.verifyOperationPacket(previous.packet); await operator.verifyOperationPacket(next.packet);
      await sourceInventory(source); await writeMarker(markerPath, expectedMarker(previous.packet, next.packet));
    }
    stage = 'local-readiness';
    await sourceInventory(source); await active.recheckActiveUpdatePlan(plan);
    // No active-update approval is constructed. Inspection neither binds a
    // journal nor calls a provider mutation, even if old review flags are true.
    const cloud = (createProvider ?? provider.createActiveUpdateProvider)({ plan, toolingDir, env, execArgv, now });
    stage = 'baseline-read'; const result = await active.executeActiveUpdate({ plan, cloud, mode: 'inspect', now });
    need(result?.kind === 'baseline' && /^[a-f0-9]{64}$/.test(result.fingerprint) &&
      Number.isSafeInteger(result.createdRoomCount) && result.createdRoomCount > 0 && result.createdRoomCount <= 20 &&
      Number.isSafeInteger(result.roomCount) && result.roomCount >= 0 && result.roomCount <= result.createdRoomCount &&
      Number.isSafeInteger(result.documentCount) && result.documentCount >= 4 && result.documentCount <= 10000);
    const summary = Object.freeze({ status: 'baseline-read-only', sourceCommit: OWNER_SOURCE_COMMIT,
      fingerprint: result.fingerprint, oldManifestDigest: plan.oldManifestDigest, newManifestDigest: plan.newManifestDigest,
      createdRoomCount: result.createdRoomCount, roomCount: result.roomCount,
      documentCount: result.documentCount, endsAtMillis: plan.endsAtMillis, maxRooms: 20,
      cloudWrites: 0, executionApproved: false, preparedTargetReused: reused });
    log('BASELINE_READ_ONLY: ' + JSON.stringify(summary)); return summary;
  } catch (error) {
    const reason = diagnose(error);
    const summary = Object.freeze({ status: 'blocked', stage: STAGES.has(stage) ? stage : 'owner-paths',
      reason: /^[a-z][a-z-]{0,63}$/.test(reason) ? reason : 'unclassified', cloudWrites: 0 });
    log(`READ_ONLY_STOP: ${summary.stage}; reason=${summary.reason}. Preserve the preparation and original operation directories; no install, login or cloud change was performed.`);
    return summary;
  }
}
export const OWNER_INSPECTION_PLAN = 'PLAN_ONLY: reuse the existing owner operation/private review and installed dependencies; SHA-verify exactly 64 public source files from the fixed commit; prepare local files and read the active trial baseline only. No apply flag, deployment approval, mutation journal, install, login, IAM/API change or game action.';
export async function main(args = process.argv.slice(2), capabilities = {}) {
  const log = capabilities.log ?? console.log;
  if (!args.length || args.length === 1 && args[0] === '--plan') { log(OWNER_INSPECTION_PLAN); return 0; }
  if (args.length === 1 && args[0] === '--inspect') return (await inspectOwnerActiveUpdate(capabilities)).status === 'baseline-read-only' ? 0 : 1;
  log('READ_ONLY_STOP: use --plan or --inspect only. No cloud change.'); return 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Admin/Firestore clients can hold channels open. A direct one-shot owner
  // invocation awaits all work and output, then exits; imports remain inert.
  let code = 1;
  try { code = await main(); }
  catch { process.stdout.write('READ_ONLY_STOP: unexpected local failure. No change is retried.\n'); }
  await new Promise(done => process.stdout.write('', done));
  await new Promise(done => process.stderr.write('', done));
  process.exit(code);
}

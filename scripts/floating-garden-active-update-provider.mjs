// Narrow provider evidence and admin-CAS boundary. No work on import/construction.
// The orchestration module owns authorization and ordering. No existing initial
// deployment/resume/activate guard is relaxed or reused for active-trial writes.
import { createRequire } from 'node:module';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createCloudAdapter, FIRESTORE_CLIENT_CONFIG, RUNTIME_ACCOUNT, makeCloudRunner } from './floating-garden-trial-cloud-adapter.mjs';
import { createActiveUpdateRequest, createActiveUpdateTransport } from './floating-garden-active-update-transport.mjs';
import { FUNCTION_NAMES } from './prepare-floating-garden-trial.mjs';
import { validateEnvironment } from './deploy-floating-garden-connection-template.mjs';
import { ACTIVE_UPDATE_SCOPE as S, activeUpdatePackets, recheckActiveUpdatePlan, assertActiveRecords,
  toggleActiveRecords, assertPreservedRecords, requireActiveUpdate as check, activeUpdateFailure,
  activeUpdateReason, dataDigest, canonicalData } from './floating-garden-active-update.mjs';

const ROOTS = Object.freeze(['floatingGardenTrial', 'floatingGardenTrialTesters', 'floatingGardenRooms',
  'floatingGardenActionRequests', 'floatingGardenInvites', 'floatingGardenRateLimits']);
const GROUPS = Object.freeze(['members', 'serverGames']);
const GATE = 'floatingGardenTrial/config', USAGE = 'floatingGardenTrial/usage';
const SECRET = 'FLOATING_GARDEN_INVITE_HMAC_KEY';
const MAX_BYTES = 16 * 1024 * 1024, MAX_DOCS = 10000;
const copy = value => structuredClone(value);
const omit = (value, keys) => Object.fromEntries(Object.entries(value || {}).filter(([key]) => !keys.includes(key)));

function documentedEmptyRuntimePolicy(name, policy) {
  // Google documents etag-only getIamPolicy responses for service accounts
  // without direct grants. Accept only that exact runtime response shape;
  // project/secret policies still require bindings and no JSON is normalized.
  // https://docs.cloud.google.com/iam/docs/create-short-lived-credentials-delegated
  return name === 'runtime' && policy !== null && typeof policy === 'object' &&
    Object.getPrototypeOf(policy) === Object.prototype && Object.keys(policy).length === 1 &&
    Object.hasOwn(policy, 'etag') && typeof policy.etag === 'string' && policy.etag.length > 0 &&
    Buffer.from(policy.etag, 'base64').toString('base64') === policy.etag;
}

export function stableArtifactRepositories(repositories) {
  check(Array.isArray(repositories), 'provider-read');
  // Artifact Registry Repository.sizeBytes/createTime/updateTime are output-only.
  // Preserve creation identity, configuration, cleanup and encryption; only
  // updateTime and storage growth are expected to move during a source build.
  return repositories.map(repository => omit(repository, ['sizeBytes', 'updateTime']));
}

export function stableFunctionConfiguration(proof) {
  // Provider-output build/revision identifiers necessarily change on a source
  // rebuild. Configured policy/limits/environment/secrets remain exact. The
  // provider's patched runtime/container image is not claimed byte-identical.
  return proof.map(({ function: fn, run, iam, functionIam }) => ({
    function: omit(fn, ['state', 'stateMessages', 'updateTime', 'buildConfig', 'serviceConfig']),
    build: { ...omit(fn.buildConfig, ['build', 'source', 'sourceProvenance']),
      ...(fn.buildConfig.onDeployUpdatePolicy ? { onDeployUpdatePolicy: omit(fn.buildConfig.onDeployUpdatePolicy, ['runtimeVersion']) } : {}) },
    service: omit(fn.serviceConfig, ['revision']),
    run: omit(run, ['generation', 'observedGeneration', 'updateTime', 'etag', 'terminalCondition', 'conditions',
      'latestCreatedRevision', 'latestReadyRevision', 'traffic', 'trafficStatuses', 'template']),
    template: { ...omit(run.template, ['revision', 'containers']), containers: run.template.containers.map(c => omit(c, ['image'])) },
    iam, ...(functionIam === undefined ? {} : { functionIam }),
  }));
}
export function validateAppliedTraffic(proof) {
  check(Array.isArray(proof) && proof.length === 5, 'source-proof');
  for (const { run } of proof) {
    check(!run.reconciling && run.generation === run.observedGeneration && run.latestCreatedRevision === run.latestReadyRevision, 'source-proof');
    check(Array.isArray(run.trafficStatuses) && run.trafficStatuses.length === 1 && run.trafficStatuses[0].percent === 100 &&
      !run.trafficStatuses[0].tag && !run.trafficStatuses[0].uri, 'source-proof');
    const traffic = run.traffic || [];
    check(traffic.length <= 1 && traffic.every(t => !t.tag && t.percent === 100 &&
      (!t.revision || t.revision === run.latestReadyRevision) &&
      [undefined, 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION'].includes(t.type)), 'source-proof');
  }
  return true;
}
export function createActiveUpdateProvider({ plan, toolingDir, runner = makeCloudRunner(), requestClient,
  db: injectedDb, fetchImpl = fetch, now = Date.now, env = process.env, execArgv = process.execArgv,
  transport } = {}) {
  let db = injectedDb, client = requestClient, previous, next, oldAdapter, newAdapter, recordStep;
  let initialised = false, attemptedPause = false, attemptedReopen = false;
  let baseline, stopped, applied = [], settingsBefore, reopened = false, journalBound = false; const attemptedStages = new Set();
  const checkedNow = () => { const value = now(); check(Number.isSafeInteger(value) && value >= S.startsAtMillis && value < S.endsAtMillis, 'fixed-window'); return value; };
  function sdk() {
    const modules = join(next.packet.gameDir, 'functions/node_modules');
    check(realpathSync(modules) === modules && !lstatSync(modules).isSymbolicLink(), 'local-packet');
    for (const [name, version] of [['firebase-admin', '12.7.0'], ['google-auth-library', '9.15.1'], ['@google-cloud/firestore', '7.11.6']]) {
      const path = join(modules, name, 'package.json'), stat = lstatSync(path);
      check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && JSON.parse(readFileSync(path)).version === version, 'local-packet');
    }
    const req = createRequire(join(next.packet.gameDir, 'functions/package.json'));
    for (const name of ['firebase-admin/app', 'firebase-admin/firestore', 'google-auth-library']) check(realpathSync(req.resolve(name)).startsWith(`${modules}/`), 'local-packet');
    // Validate the actual transitive resolutions used by the audited clients,
    // including a nested gaxios installation rather than assuming root hoisting.
    for (const [parent, dependency, version] of [['google-auth-library', 'gaxios', '6.7.1'], ['firebase-admin/firestore', '@google-cloud/firestore', '7.11.6']]) {
      const selected = createRequire(req.resolve(parent)).resolve(`${dependency}/package.json`);
      const info = lstatSync(selected);
      check(realpathSync(selected).startsWith(`${modules}/`) && info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && JSON.parse(readFileSync(selected)).version === version, 'local-packet');
    }
    return req;
  }
  async function initialize() {
    if (initialised) return;
    await recheckActiveUpdatePlan(plan); ({ old: previous, next } = activeUpdatePackets(plan));
    validateEnvironment(env, execArgv);
    if (!client || !db) {
      const req = sdk();
      if (!client) { const { GoogleAuth } = req('google-auth-library'); client = new GoogleAuth({ projectId: S.project, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }); }
      if (!db) {
        const app = req('firebase-admin/app'), firestore = req('firebase-admin/firestore'), name = 'floating-garden-active-update';
        check(!app.getApps().some(a => a.name === name), 'provider-read');
        db = firestore.getFirestore(app.initializeApp({ projectId: S.project, credential: app.applicationDefault() }, name));
        db.settings({ ignoreUndefinedProperties: false, clientConfig: FIRESTORE_CLIENT_CONFIG });
      }
    }
    if (!transport) transport = createActiveUpdateTransport({
      request: createActiveUpdateRequest({ requestClient: client, fetchImpl }), now,
      wait: millis => new Promise(done => setTimeout(done, millis)),
    });
    const checkedFetch = async (url, options) => {
      const result = await fetchImpl(url, options);
      if (result.status === 200) {
        const path = new URL(url).pathname, mime = (result.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        const accepted = path.endsWith('.js') ? ['text/javascript', 'application/javascript'] : path.endsWith('.css') ? ['text/css'] : path.endsWith('.html') ? ['text/html'] : [];
        check(!accepted.length || accepted.includes(mime), 'source-proof');
      }
      return result;
    };
    const shared = { toolingDir, runner, requestClient: client, db, fetchImpl: checkedFetch, now, env, execArgv };
    oldAdapter = createCloudAdapter({ ...previous, ...shared }); newAdapter = createCloudAdapter({ ...next, ...shared });
    await oldAdapter.preflight('inspect'); await newAdapter.preflight('inspect'); initialised = true;
  }
  async function read(url) {
    // All URLs originate from literals/validated function identities in this
    // module. Nothing reads a SecretVersion payload or extracts a bearer token.
    try {
      const response = await client.request({ url, method: 'GET', responseType: 'json', retry: false, maxRedirects: 0,
        timeout: 30000, maxContentLength: MAX_BYTES, maxBodyLength: MAX_BYTES });
      check(response?.status === 200 && response.data !== undefined, 'provider-read'); return response.data;
    } catch { throw activeUpdateFailure('provider-read'); }
  }
  function gcloud(args) {
    try {
      const result = runner('gcloud', [...args, `--project=${S.project}`, `--billing-project=${S.project}`, '--format=json', '--verbosity=error'], previous.packet.gameDir);
      check(result?.exitCode === 0 && !result.signal && !result.timedOut && typeof result.stdout === 'string', 'provider-read'); return JSON.parse(result.stdout);
    } catch { throw activeUpdateFailure('provider-read'); }
  }
  async function readSettings() {
    const iam = {
      project: gcloud(['projects', 'get-iam-policy', S.project]),
      runtime: gcloud(['iam', 'service-accounts', 'get-iam-policy', RUNTIME_ACCOUNT]),
      secret: gcloud(['secrets', 'get-iam-policy', SECRET]),
    };
    for (const [name, policy] of Object.entries(iam)) check(policy &&
      (Array.isArray(policy.bindings) || documentedEmptyRuntimePolicy(name, policy)), 'iam-preservation');
    return { iam, runtime: gcloud(['iam', 'service-accounts', 'describe', RUNTIME_ACCOUNT]),
      secret: gcloud(['secrets', 'describe', SECRET]),
      secretVersion: gcloud(['secrets', 'versions', 'describe', '1', `--secret=${SECRET}`]),
      artifacts: stableArtifactRepositories(gcloud(['artifacts', 'repositories', 'list', `--location=${S.region}`])),
      apis: gcloud(['services', 'list', '--enabled']),
      auth: await read(`https://identitytoolkit.googleapis.com/admin/v2/projects/${S.project}/config`),
      appCheck: await read(`https://firebaseappcheck.googleapis.com/v1/projects/${S.projectNumber}/apps/1:120030709276:web:015f4e996b7c42a4e801d9/recaptchaEnterpriseConfig`),
      appCheckServices: await read(`https://firebaseappcheck.googleapis.com/v1/projects/${S.projectNumber}/services?pageSize=100`),
    };
  }
  async function snapshotInTransaction(tx, allowNpc = reopened) {
    const documents = new Map(); let bytes = 0;
    const queries = [...ROOTS.map(name => db.collection(name)), ...GROUPS.map(name => db.collectionGroup(name))];
    for (const query of queries) {
      const result = await tx.get(query.limit(MAX_DOCS + 1));
      check(result && Array.isArray(result.docs), 'inventory-shape');
      for (const document of result.docs) {
        const path = document.ref?.path;
        check(typeof path === 'string' && !documents.has(path), 'inventory-shape');
        const value = document.data(); bytes += Buffer.byteLength(canonicalData(value));
        check(bytes <= MAX_BYTES && documents.size < MAX_DOCS, 'inventory-limit'); documents.set(path, value);
      }
    }
    const records = { gate: documents.get(GATE), usage: documents.get(USAGE),
      testers: next.review.testerUids.map(uid => documents.get(`floatingGardenTrialTesters/${uid}`)) };
    check([...documents.keys()].filter(p => p.startsWith('floatingGardenTrialTesters/')).length === 2 &&
      [...documents.keys()].filter(p => p.startsWith('floatingGardenTrial/')).length === 2, 'inventory-shape');
    const rooms = [...documents].filter(([path]) => /^floatingGardenRooms\/[^/]+$/.test(path));
    check(rooms.length <= 20 && records.usage?.createdRoomCount >= rooms.length, 'inventory-shape');
    for (const [path, value] of documents) {
      if (path.includes('/members/') || path.includes('/serverGames/')) check(/^floatingGardenRooms\/[^/]+\/(members|serverGames)\/[^/]+$/.test(path) && documents.has(path.split('/').slice(0, 2).join('/')), 'inventory-shape');
      if (/^floatingGardenRooms\/[^/]+$/.test(path)) {
        const legacy = value.playerCount === 2 && (value.npcCount === undefined || value.npcCount === 0) && value.rulesVersion === 'floating-garden-match-1';
        const npc = allowNpc && [1, 2].includes(value.npcCount) && value.playerCount === 2 + value.npcCount && value.rulesVersion === 'floating-garden-online-npc-1';
        check(value.id === path.split('/')[1] && (legacy || npc), 'source-proof');
        check(['waiting', 'playing', 'finished'].includes(value.status) && Array.isArray(value.players) &&
          value.players.every((player, index) => player && player.seat === index) &&
          (value.status === 'waiting' ? value.players.length >= 1 && value.players.length <= 2 :
            value.players.length === value.playerCount && Array.isArray(value.match?.players) && value.match.players.length === value.playerCount), 'source-proof');
      }
      if (path.includes('/members/')) check(next.review.testerUids.includes(path.split('/')[3]) && Number.isInteger(value.seat) && [0, 1].includes(value.seat), 'source-proof');
      if (path.includes('/serverGames/')) {
        const room = documents.get(path.split('/').slice(0, 2).join('/'));
        check(value.rulesVersion === room.rulesVersion && value.state?.version === 'floating-garden-match-1' &&
          Array.isArray(value.state.players) && value.state.players.length === room.playerCount, 'source-proof');
      }
    }
    const retained = [...documents].filter(([path]) => path !== GATE && !path.startsWith('floatingGardenTrialTesters/')).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return { records, retainedDigest: dataDigest(retained), documentCount: documents.size, roomCount: rooms.length };
  }
  async function readData() {
    const roots = await db.listCollections();
    check(roots.every(root => ROOTS.includes(root.id)), 'inventory-shape');
    return db.runTransaction(tx => snapshotInTransaction(tx), { readOnly: true });
  }
  async function evidence(which) {
    const adapter = which === 'previous' ? oldAdapter : newAdapter;
    const functions = await adapter.verifyFunctions({ includeProof: true });
    const rules = await adapter.verifyRules({ includeProof: true });
    const proof = { functions: functions.functions, rules: { release: rules.release, ruleset: rules.ruleset }, hosting: await adapter.readHosting() };
    validateAppliedTraffic(proof.functions); return proof;
  }
  async function inspect() {
    await initialize(); checkedNow();
    const before = await readData(); assertActiveRecords(before.records, next.review, { active: true, now: checkedNow() });
    const proof = await evidence('previous'), settings = await readSettings();
    check(!settings.appCheckServices.nextPageToken, 'provider-read');
    const after = await readData();
    check(isDeepStrictEqual(before, after), 'admin-race');
    const again = await evidence('previous'); check(isDeepStrictEqual(proof, again), 'provider-drift');
    check(isDeepStrictEqual(settings, await readSettings()), 'provider-drift');
    baseline = { data: after, proof, settings }; settingsBefore = settings;
    return { kind: 'baseline', fingerprint: dataDigest(baseline), createdRoomCount: after.records.usage.createdRoomCount,
      roomCount: after.roomCount, documentCount: after.documentCount, runtimeImagePreserved: false };
  }
  async function assertSettingsUnchanged() {
    check(isDeepStrictEqual(settingsBefore, await readSettings()), 'iam-preservation');
  }
  async function assertClosed() {
    checkedNow(); const value = await readData();
    check(stopped && isDeepStrictEqual(value, stopped), 'data-preservation');
    assertActiveRecords(value.records, next.review, { active: false, now: checkedNow() }); return value;
  }
  async function compareAndSet(active) {
    check(initialised && baseline, 'stage-order'); await recheckActiveUpdatePlan(plan); checkedNow();
    check(active ? !attemptedReopen && stopped && applied.join(',') === 'functions,rules,hosting' : !attemptedPause && !stopped, 'unsafe-retry');
    if (active) attemptedReopen = true; else attemptedPause = true;
    let issued = false;
    try {
      const expected = active ? stopped : baseline.data;
      await db.runTransaction(async tx => {
        const actual = await snapshotInTransaction(tx);
        check(isDeepStrictEqual(actual, expected), 'admin-race');
        assertActiveRecords(actual.records, next.review, { active: !active, now: checkedNow() });
        const target = toggleActiveRecords(actual.records, next.review, active);
        tx.update(db.doc(GATE), { enabled: active, testerUids: target.gate.testerUids }); issued = true;
        for (const uid of next.review.testerUids) tx.update(db.doc(`floatingGardenTrialTesters/${uid}`), { active });
        // No usage, room, receipt, game, invitation or rate-limit writes exist.
      }, { maxAttempts: 1 });
      if (active) reopened = true;
      const actual = await readData();
      if (active) assertReopenedRecords(actual.records, expected.records);
      else {
        assertPreservedRecords(expected.records, actual.records, next.review, false);
        check(actual.retainedDigest === expected.retainedDigest && actual.documentCount === expected.documentCount, 'data-preservation');
        stopped = actual;
      }
      return { kind: 'success', access: active ? 'open' : 'closed' };
    } catch (error) { return { kind: issued ? 'unknown' : 'failed', reason: activeUpdateReason(error), access: 'unknown' }; }
  }
  function bindJournal(journal) {
    check(!journalBound && !attemptedPause && journal && typeof journal.providerStep === 'function', 'journal');
    recordStep = step => journal.providerStep(step); journalBound = true;
  }
  async function pause(expectedFingerprint) {
    check(journalBound && typeof recordStep === 'function' && transport && ['functions', 'rules', 'hosting'].every(key => typeof transport[key] === 'function'), 'provider-writes-not-enabled');
    check(baseline && expectedFingerprint === dataDigest(baseline), 'admin-race');
    check(isDeepStrictEqual(baseline.proof, await evidence('previous')), 'provider-drift'); await assertSettingsUnchanged();
    return compareAndSet(false);
  }
  async function verifyMixedFunctions(completed = []) {
    check(Array.isArray(completed) && new Set(completed).size === completed.length && completed.every(name => FUNCTION_NAMES.includes(name)), 'source-proof');
    const remaining = FUNCTION_NAMES.filter(name => !completed.includes(name)); const proof = [];
    if (remaining.length) proof.push(...(await oldAdapter.verifyFunctions({ includeProof: true, functionNames: remaining })).functions);
    if (completed.length) proof.push(...(await newAdapter.verifyFunctions({ includeProof: true, functionNames: completed })).functions);
    proof.sort((a, b) => FUNCTION_NAMES.indexOf(a.function.buildConfig.entryPoint) - FUNCTION_NAMES.indexOf(b.function.buildConfig.entryPoint));
    validateAppliedTraffic(proof);
    check(isDeepStrictEqual(stableFunctionConfiguration(baseline.proof.functions), stableFunctionConfiguration(proof)), 'iam-preservation');
  }
  // The transport is only used by the separately approved state machine. It
  // receives immutable exact packets and baseline evidence, never a broad CLI.
  async function update(kind) {
    check(['functions', 'rules', 'hosting'][applied.length] === kind && transport && !attemptedStages.has(kind), 'stage-order');
    attemptedStages.add(kind);
    await recheckActiveUpdatePlan(plan); await assertClosed(); await assertSettingsUnchanged();
    const result = await transport[kind]({ previous, next, baseline: copy(baseline.proof),
      beforeMutation: async step => {
        await recheckActiveUpdatePlan(plan); await assertClosed(); await assertSettingsUnchanged();
        await verifyMixedFunctions(kind === 'functions' ? step?.completedFunctionNames || [] : FUNCTION_NAMES);
        await recordStep(step);
      } });
    if (result?.kind !== 'success') throw activeUpdateFailure(result?.kind === 'unknown' ? 'mutation-unknown' : 'mutation-failed', result);
    applied.push(kind); return { kind: 'success' };
  }
  async function verifyFunctions() {
    const got = await newAdapter.verifyFunctions({ includeProof: true }); validateAppliedTraffic(got.functions);
    const before = stableFunctionConfiguration(baseline.proof.functions), after = stableFunctionConfiguration(got.functions);
    check(isDeepStrictEqual(before, after), 'iam-preservation'); await assertSettingsUnchanged(); await assertClosed(); return { kind: 'verified' };
  }
  async function verifyRules() { await newAdapter.verifyRules(); await assertClosed(); return { kind: 'verified' }; }
  async function verifyHosting() { await newAdapter.verifyHosting('game'); await assertClosed(); return { kind: 'verified' }; }
  async function verifyPreservation() {
    await verifyFunctions(); await verifyRules(); await verifyHosting(); await assertSettingsUnchanged(); await assertClosed(); return { kind: 'verified' };
  }
  function assertReopenedRecords(actual, expected) {
    assertActiveRecords(actual, next.review, { active: true, now: checkedNow() });
    const projected = { ...actual, usage: { ...actual.usage, createdRoomCount: expected.usage.createdRoomCount } };
    assertPreservedRecords(expected, projected, next.review, true);
    check(actual.usage.createdRoomCount >= expected.usage.createdRoomCount, 'usage-preservation');
  }
  async function reopen() { await verifyPreservation(); return compareAndSet(true); }
  async function verifyReopened() {
    check(reopened && stopped, 'stage-order'); const actual = await readData(); assertReopenedRecords(actual.records, stopped.records);
    const proof = await evidence('next');
    check(isDeepStrictEqual(stableFunctionConfiguration(baseline.proof.functions), stableFunctionConfiguration(proof.functions)), 'iam-preservation');
    await assertSettingsUnchanged(); return { kind: 'verified' };
  }
  async function readAccess() {
    try {
      const records = await oldAdapter.readAdmin();
      if (records.gate?.enabled === false) return { access: 'closed' };
      // Usage affects new-room admission, not existing-room access. Reconcile
      // gate/tester authorization independently even when usage/data is corrupt.
      if (records.gate?.enabled === true && records.testers.some((tester, i) => tester?.active === true && records.gate.testerUids?.includes(next.review.testerUids[i]))) return { access: 'open' };
      return { access: 'unknown' };
    }
    catch { return { access: 'unknown' }; }
  }
  return Object.freeze({ bindJournal, inspect, pause, assertClosed, updateFunctions: () => update('functions'), verifyFunctions,
    updateRules: () => update('rules'), verifyRules, updateHosting: () => update('hosting'), verifyHosting,
    verifyPreservation, reopen, verifyReopened, readAccess });
}

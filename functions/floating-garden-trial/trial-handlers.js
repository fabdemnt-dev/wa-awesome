'use strict';

const { CALLABLE_NAMES, validateTrialConfig } = require('./config');
const GATE_PATH = 'floatingGardenTrial/config';
const USAGE_PATH = 'floatingGardenTrial/usage';
class TrialError extends Error {
  constructor(code, reason) {
    super('庭園の試験利用条件を確認できません。');
    this.name = 'TrialError'; this.code = code; this.details = { reason };
  }
}
const deny = (reason, code = 'permission-denied') => { throw new TrialError(code, reason); };
const validUid = (uid) => typeof uid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(uid);
function assertEnvironment(config, env) {
  const projects = [env.GCLOUD_PROJECT, env.GCP_PROJECT, env.GOOGLE_CLOUD_PROJECT].filter((value) => value !== undefined);
  if (!projects.length || projects.some((projectId) => projectId !== config.projectId)) deny('trial-project-mismatch', 'failed-precondition');
  if (env.FIREBASE_CONFIG) {
    let firebase;
    try { firebase = JSON.parse(env.FIREBASE_CONFIG); } catch { deny('trial-project-mismatch', 'failed-precondition'); }
    if (firebase.projectId !== config.projectId) deny('trial-project-mismatch', 'failed-precondition');
  }
}
function assertRequest(config, request, timestamp, env) {
  assertEnvironment(config, env);
  if (!config.enabled) deny('trial-disabled', 'failed-precondition');
  if (timestamp < config.startsAtMillis || timestamp >= config.endsAtMillis) deny('trial-outside-window', 'failed-precondition');
  if (!validUid(request?.auth?.uid)) deny('trial-auth-required', 'unauthenticated');
  // The callable platform verifies these credentials. Origin is an additional bound,
  // never a substitute for verified Auth, App Check or the server-only tester gate.
  if (!request.app || typeof request.app.appId !== 'string' || !request.app.appId) deny('trial-app-check-required', 'unauthenticated');
  if (request.rawRequest?.headers?.origin !== config.previewOrigin) deny('trial-origin-mismatch');
  return request.auth.uid;
}
function assertGate(config, gate, tester, uid, timestamp) {
  if (!gate || gate.enabled !== true) deny('trial-disabled', 'failed-precondition');
  for (const key of ['projectId', 'previewOrigin', 'startsAtMillis', 'endsAtMillis', 'maxRooms']) if (gate[key] !== config[key]) deny('trial-gate-mismatch', 'failed-precondition');
  if (timestamp < config.startsAtMillis || timestamp >= config.endsAtMillis) deny('trial-outside-window', 'failed-precondition');
  if (!Array.isArray(gate.testerUids) || gate.testerUids.length !== 2 || !gate.testerUids.every(validUid) || new Set(gate.testerUids).size !== 2 || !gate.testerUids.includes(uid)) deny('trial-tester-not-enrolled');
  if (!tester || tester.active !== true || !Number.isSafeInteger(tester.expiresAtMillis) || tester.expiresAtMillis <= timestamp || tester.expiresAtMillis > config.endsAtMillis || tester.expiresAtMillis <= config.startsAtMillis) deny('trial-tester-not-enrolled');
}
function usageCount(config, snapshot) {
  if (!snapshot.exists) deny('trial-usage-invalid', 'failed-precondition');
  const data = snapshot.data();
  if (data.projectId !== config.projectId || data.startsAtMillis !== config.startsAtMillis || data.endsAtMillis !== config.endsAtMillis || data.maxRooms !== config.maxRooms ||
      !Number.isSafeInteger(data.createdRoomCount) || data.createdRoomCount < 0 || data.createdRoomCount > config.maxRooms) deny('trial-usage-invalid', 'failed-precondition');
  return data.createdRoomCount;
}
/** Wrap the unchanged trusted handlers. No game engine or transaction logic is forked.
 * Every trusted transaction re-reads the admin gate/tester before its own reads, so
 * revocation conflicts with pending writes. A room and its lifetime admission counter
 * are committed atomically; rejected creation and receipt replay do not spend a slot.
 */
function createTrialHandlers({ db, config: rawConfig, trustedHandlersFactory, now = Date.now, env = process.env,
  timestampFromMillis = (millis) => millis, ...trustedOptions } = {}) {
  const config = validateTrialConfig(rawConfig);
  if (!db?.doc || !db?.runTransaction || typeof trustedHandlersFactory !== 'function') throw new TypeError('Trial db and trusted handler factory are required');
  async function runGateTransaction(request, body, creating = false) {
    const uid = assertRequest(config, request, now(), env);
    return db.runTransaction(async (tx) => {
      const [gate, tester, usage] = await Promise.all([
        tx.get(db.doc(GATE_PATH)), tx.get(db.doc(`floatingGardenTrialTesters/${uid}`)),
        ...(creating ? [tx.get(db.doc(USAGE_PATH))] : []),
      ]);
      assertRequest(config, request, now(), env);
      assertGate(config, gate.exists ? gate.data() : null, tester.exists ? tester.data() : null, uid, now());
      const count = creating ? usageCount(config, usage) : 0;
      let newRooms = 0;
      const readExpiries = [];
      const clamp = (data) => {
        if (!data || typeof data !== 'object' || !Number.isSafeInteger(data.expiresAtMillis)) return data;
        const expiresAtMillis = Math.min(data.expiresAtMillis, config.endsAtMillis);
        return { ...data, expiresAtMillis, ...(Object.hasOwn(data, 'expiresAt') ? { expiresAt: timestampFromMillis(expiresAtMillis) } : {}) };
      };
      const guardedTx = {
        get(ref) {
          const result = tx.get(ref);
          // Observe before the trusted caller resumes, preserving the original read
          // promise and transaction ordering. Its rejection still reaches the caller.
          void result.then((snapshot) => {
            if (snapshot.exists && /^(floatingGardenRooms|floatingGardenActionRequests|floatingGardenInvites)\//.test(ref.path)) {
              const expiresAtMillis = snapshot.data().expiresAtMillis;
              if (Number.isSafeInteger(expiresAtMillis)) readExpiries.push(expiresAtMillis);
            }
          }, () => {});
          return result;
        },
        create(ref, data) {
          if (/^floatingGardenRooms\/[^/]+$/.test(ref.path)) {
            if (!creating) deny('trial-unexpected-room-create', 'failed-precondition');
            if (count + ++newRooms > config.maxRooms) deny('trial-room-limit', 'resource-exhausted');
          }
          tx.create(ref, clamp(data));
        },
        set: (ref, data) => tx.set(ref, clamp(data)),
        update: (ref, data) => tx.update(ref, clamp(data)),
      };
      const result = await body(guardedTx);
      // Re-evaluate time at the end of the callback too, including after engine work.
      assertRequest(config, request, now(), env);
      assertGate(config, gate.data(), tester.data(), uid, now());
      if (readExpiries.some((expiresAtMillis) => expiresAtMillis <= now())) deny('room-expired', 'failed-precondition');
      if (newRooms) tx.set(db.doc(USAGE_PATH), { projectId: config.projectId, startsAtMillis: config.startsAtMillis,
        endsAtMillis: config.endsAtMillis, maxRooms: config.maxRooms, createdRoomCount: count + newRooms });
      return result;
    });
  }
  return Object.fromEntries(CALLABLE_NAMES.map((name) => [name, async (request) => {
    // Even receipt replay and snapshot pass this guard before any trusted reads/writes.
    await runGateTransaction(request, async () => undefined);
    const scopedDb = { doc: (path) => db.doc(path), runTransaction: (body) => runGateTransaction(request, body, name === 'floatingGardenCreateRoom') };
    const handler = trustedHandlersFactory({ ...trustedOptions, db: scopedDb, now, timestampFromMillis })[name];
    const result = await handler(request);
    // Do not return a response from an in-flight call after expiry/revocation.
    await runGateTransaction(request, async () => undefined);
    return result;
  }]));
}
module.exports = { TrialError, GATE_PATH, USAGE_PATH, validUid, assertEnvironment, assertRequest, assertGate, createTrialHandlers };

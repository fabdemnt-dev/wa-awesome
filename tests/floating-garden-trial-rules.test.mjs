import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, collectionGroup, deleteDoc, doc, documentId, getDoc, getDocs, onSnapshot, query, setDoc, updateDoc, where } from 'firebase/firestore';
import { emulatorConfig } from './helpers/floating-garden-emulators.mjs';
const require = createRequire(import.meta.url);
const { renderTrialRules } = require('../functions/floating-garden-trial/config.js');
const { projectId, firestore } = emulatorConfig();
const now = Date.now();
const config = { enabled: true, projectId: 'wa-garden-trial-rules', region: 'asia-northeast1',
  previewOrigin: 'https://wa-garden-trial-rules--trial-abc123.web.app', startsAtMillis: now - 60000,
  endsAtMillis: now + 3600000, maxRooms: 20 };
const gate = (overrides = {}) => ({ ...config, testerUids: ['host', 'guest'], ...overrides });
const tester = (overrides = {}) => ({ active: true, expiresAtMillis: config.endsAtMillis, ...overrides });
const member = (overrides = {}) => ({ active: true, seat: 0, isHost: true, expiresAtMillis: config.endsAtMillis, ...overrides });
const room = (overrides = {}) => ({ status: 'playing', expiresAtMillis: config.endsAtMillis, revision: 1, ...overrides });
const roomPath = 'floatingGardenRooms/active';
const protectedPaths = [
  'floatingGardenTrial/config', 'floatingGardenTrial/usage', 'floatingGardenTrialTesters/host', 'floatingGardenTrialTesters/guest',
  'floatingGardenActionRequests/receipt', 'floatingGardenInvites/locator', 'floatingGardenRateLimits/key',
  `${roomPath}/serverGames/game`, `${roomPath}/serverGames/game/history/action`, `${roomPath}/private/arbitrary`, 'unrelatedCollection/other',
];
let env;
async function adminSet(path, value) { await env.withSecurityRulesDisabled((context) => setDoc(doc(context.firestore(), path), value)); }
async function seed() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    const fixtures = {
      ...Object.fromEntries(protectedPaths.map((path) => [path, { private: true }])),
      'floatingGardenTrial/config': gate(),
      'floatingGardenTrialTesters/host': tester(), 'floatingGardenTrialTesters/guest': tester(),
      'floatingGardenTrialTesters/third': tester(),
      [roomPath]: room(), [`${roomPath}/members/host`]: member(), [`${roomPath}/members/guest`]: member({ seat: 1, isHost: false }),
      [`${roomPath}/members/third`]: member(),
    };
    await Promise.all(Object.entries(fixtures).map(([path, value]) => setDoc(doc(db, path), value)));
  });
}
test.before(async () => {
  env = await initializeTestEnvironment({ projectId, firestore: { ...firestore,
    rules: renderTrialRules(await readFile(new URL('../functions/floating-garden-trial/firestore.rules.template', import.meta.url), 'utf8'), config) } });
});
test.beforeEach(seed);
test.after(async () => { if (env) await env.cleanup(); });

test('only the two enrolled active members can get room and own membership', async () => {
  for (const uid of ['host', 'guest']) {
    const db = env.authenticatedContext(uid).firestore();
    assert.equal((await assertSucceeds(getDoc(doc(db, roomPath)))).data().revision, 1);
    await assertSucceeds(getDoc(doc(db, `${roomPath}/members/${uid}`)));
    await assertFails(getDoc(doc(db, `${roomPath}/members/${uid === 'host' ? 'guest' : 'host'}`)));
  }
  for (const context of [env.unauthenticatedContext(), env.authenticatedContext('third'), env.authenticatedContext('outsider')]) await assertFails(getDoc(doc(context.firestore(), roomPath)));
});

test('all gate, tester, counter and game-private documents deny reads, writes and lists', async () => {
  const db = env.authenticatedContext('host').firestore();
  for (const path of protectedPaths) {
    await assertFails(getDoc(doc(db, path)));
    await assertFails(setDoc(doc(db, path), { forged: true }));
    await assertFails(updateDoc(doc(db, path), { enabled: true }));
    await assertFails(deleteDoc(doc(db, path)));
  }
  for (const path of ['floatingGardenTrial', 'floatingGardenTrialTesters', 'floatingGardenActionRequests', 'floatingGardenInvites', 'floatingGardenRateLimits', `${roomPath}/serverGames`]) await assertFails(getDocs(collection(db, path)));
});

test('every room/member direct write and every enumeration query fails', async () => {
  const db = env.authenticatedContext('host').firestore();
  for (const path of [roomPath, `${roomPath}/members/host`, 'floatingGardenRooms/forged', 'floatingGardenRooms/forged/members/host']) {
    await assertFails(setDoc(doc(db, path), room())); await assertFails(updateDoc(doc(db, path), { active: true })); await assertFails(deleteDoc(doc(db, path)));
  }
  for (const target of [collection(db, 'floatingGardenRooms'), query(collection(db, 'floatingGardenRooms'), where(documentId(), '==', 'active')), collection(db, `${roomPath}/members`), query(collection(db, `${roomPath}/members`), where(documentId(), '==', 'host')), collectionGroup(db, 'members')]) await assertFails(getDocs(target));
});

test('disabled, missing, wrong-project, wrong-origin or altered trial bounds deny member reads', async () => {
  const db = env.authenticatedContext('host').firestore();
  for (const patch of [{ enabled: false }, { enabled: 'true' }, { projectId: 'wa-awesome' }, { previewOrigin: 'https://wrong.example' }, { startsAtMillis: now + 100000 }, { endsAtMillis: now - 1000 }, { maxRooms: 21 }]) {
    await adminSet('floatingGardenTrial/config', gate(patch)); await assertFails(getDoc(doc(db, roomPath))); await assertFails(getDoc(doc(db, `${roomPath}/members/host`)));
  }
  await env.withSecurityRulesDisabled((context) => deleteDoc(doc(context.firestore(), 'floatingGardenTrial/config')));
  await assertFails(getDoc(doc(db, roomPath)));
});

test('roster must contain exactly two unique valid UIDs; a third active tester document grants nothing', async () => {
  const db = env.authenticatedContext('host').firestore();
  for (const testerUids of [[], ['host'], ['host', 'host'], ['host', 'guest', 'third'], ['host', 'bad/uid'], ['host', 42], ['guest', 'third'], 'host']) {
    await adminSet('floatingGardenTrial/config', gate({ testerUids })); await assertFails(getDoc(doc(db, roomPath)));
  }
  await adminSet('floatingGardenTrial/config', gate());
  await assertFails(getDoc(doc(env.authenticatedContext('third').firestore(), roomPath)));
});

test('missing/revoked/expired/malformed tester or expiry beyond trial end fails closed', async () => {
  const db = env.authenticatedContext('host').firestore();
  for (const value of [{}, tester({ active: false }), tester({ active: 1 }), tester({ expiresAtMillis: now - 1000 }), tester({ expiresAtMillis: config.endsAtMillis + 1 }), tester({ expiresAtMillis: String(config.endsAtMillis) }), tester({ expiresAtMillis: config.endsAtMillis - 0.5 })]) {
    await adminSet('floatingGardenTrialTesters/host', value); await assertFails(getDoc(doc(db, roomPath))); await assertFails(getDoc(doc(db, `${roomPath}/members/host`)));
  }
  await env.withSecurityRulesDisabled((context) => deleteDoc(doc(context.firestore(), 'floatingGardenTrialTesters/host')));
  await assertFails(getDoc(doc(db, roomPath)));
});

test('expired/malformed rooms and inactive members stay unreadable despite enrollment', async () => {
  const db = env.authenticatedContext('host').firestore();
  for (const value of [{}, room({ status: 'closed' }), room({ expiresAtMillis: now - 1000 }), room({ expiresAtMillis: config.endsAtMillis + 1 }), room({ expiresAtMillis: String(config.endsAtMillis) })]) {
    await adminSet(roomPath, value); await assertFails(getDoc(doc(db, roomPath))); await assertFails(getDoc(doc(db, `${roomPath}/members/host`)));
  }
  await adminSet(roomPath, room());
  for (const value of [{}, member({ active: false }), member({ expiresAtMillis: now - 1000 }), member({ expiresAtMillis: config.endsAtMillis + 1 })]) {
    await adminSet(`${roomPath}/members/host`, value); await assertFails(getDoc(doc(db, roomPath)));
  }
});

test('room listener terminates when server-owned trial gate is disabled', async () => {
  const db = env.authenticatedContext('guest').firestore(); let unsubscribe; let received = false;
  const denied = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('disabled gate listener remained active')), 10000);
    unsubscribe = onSnapshot(doc(db, roomPath), async (snapshot) => {
      if (snapshot.metadata.fromCache || received) return; received = true;
      try { await adminSet('floatingGardenTrial/config', gate({ enabled: false })); await adminSet(roomPath, room({ revision: 2 })); }
      catch (error) { clearTimeout(timeout); reject(error); }
    }, (error) => { clearTimeout(timeout); resolve(error); });
  });
  try { assert.equal((await denied).code, 'permission-denied'); } finally { unsubscribe?.(); }
});

test('real emulator transactions keep duplicate creation and the global twenty-room boundary atomic', { timeout: 60000 }, async () => {
  // Partial integration only: real Firestore transaction behavior with synthetic
  // callable Auth/App Check and environment values. This is not HTTP/Auth validation.
  const functionsRequire = createRequire(new URL('../functions/package.json', import.meta.url));
  const { initializeApp, deleteApp } = functionsRequire('firebase-admin/app');
  const { getFirestore, Timestamp } = functionsRequire('firebase-admin/firestore');
  const { createHandlers, RATE_LIMITS } = functionsRequire('./floating-garden-online/handlers.js');
  const { createTrialHandlers } = functionsRequire('./floating-garden-trial/trial-handlers.js');
  const app = initializeApp({ projectId }, 'trial-counter-emulator-test');
  const db = getFirestore(app);
  try {
    await db.doc('floatingGardenTrial/usage').set({ projectId: config.projectId, startsAtMillis: config.startsAtMillis,
      endsAtMillis: config.endsAtMillis, maxRooms: 20, createdRoomCount: 0 });
    const handlers = createTrialHandlers({ db, config, env: { GCLOUD_PROJECT: config.projectId }, trustedHandlersFactory: createHandlers,
      timestampFromMillis: Timestamp.fromMillis, inviteSecret: () => 'local-only-emulator-trial-32-character-invite-key',
      rateLimits: { ...RATE_LIMITS, create: { ...RATE_LIMITS.create, limit: 1000, ipLimit: 1000 } } });
    const create = (requestId) => handlers.floatingGardenCreateRoom({ auth: { uid: 'host' }, app: { appId: 'synthetic-test-app' },
      rawRequest: { headers: { origin: config.previewOrigin }, ip: '127.0.0.1' }, data: { displayName: 'Garden', requestId } });
    const copies = await Promise.all(Array.from({ length: 3 }, () => create('emulator-identical-request')));
    copies.forEach((result) => assert.deepEqual(result, copies[0]));
    assert.equal((await db.doc('floatingGardenTrial/usage').get()).data().createdRoomCount, 1);
    for (let i = 0; i < 18; i += 1) await create(`emulator-serial-room-${i}`);
    const raced = await Promise.allSettled(Array.from({ length: 3 }, (_, i) => create(`emulator-boundary-race-${i}`)));
    assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1);
    assert.ok(raced.filter((result) => result.status === 'rejected').every((result) => result.reason.details?.reason === 'trial-room-limit'));
    assert.equal((await db.doc('floatingGardenTrial/usage').get()).data().createdRoomCount, 20);
    // One seeded room existed before this test; twenty new admission-backed rooms.
    assert.equal((await db.collection('floatingGardenRooms').get()).size, 21);
    assert.deepEqual(await create('emulator-identical-request'), copies[0]);
    assert.equal((await db.doc('floatingGardenTrial/usage').get()).data().createdRoomCount, 20);
  } finally { await db.terminate(); await deleteApp(app); }
});

test('generated static false and fixed expired/future windows deny even a matching enabled gate', async () => {
  const template = await readFile(new URL('../functions/floating-garden-trial/firestore.rules.template', import.meta.url), 'utf8');
  for (const patch of [{ enabled: false }, { startsAtMillis: now - 3600000, endsAtMillis: now - 1000 }, { startsAtMillis: now + 3600000, endsAtMillis: now + 7200000 }]) {
    const altered = { ...config, ...patch };
    const local = await initializeTestEnvironment({ projectId, firestore: { ...firestore, rules: renderTrialRules(template, altered) } });
    try {
      await local.withSecurityRulesDisabled(async (context) => {
        const db = context.firestore();
        await setDoc(doc(db, 'floatingGardenTrial/config'), { ...altered, enabled: true, testerUids: ['host', 'guest'] });
        await setDoc(doc(db, 'floatingGardenTrialTesters/host'), tester({ expiresAtMillis: altered.endsAtMillis }));
        await setDoc(doc(db, roomPath), room({ expiresAtMillis: altered.endsAtMillis }));
        await setDoc(doc(db, `${roomPath}/members/host`), member({ expiresAtMillis: altered.endsAtMillis }));
      });
      await assertFails(getDoc(doc(local.authenticatedContext('host').firestore(), roomPath)));
    } finally { await local.cleanup(); }
  }
});


test('NPC seats never become authenticated human memberships even for enrolled testers', async () => {
  const db = env.authenticatedContext('host').firestore();
  for (const seat of [2, 3, -1, '0', 0.5]) {
    await adminSet(`${roomPath}/members/host`, member({ seat }));
    await assertFails(getDoc(doc(db, roomPath)));
    await assertFails(getDoc(doc(db, `${roomPath}/members/host`)));
  }
});

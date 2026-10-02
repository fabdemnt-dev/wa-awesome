import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, collectionGroup, deleteDoc, doc, documentId, getDoc, getDocs, onSnapshot, query, setDoc, updateDoc, where } from 'firebase/firestore';
import { emulatorConfig } from './helpers/floating-garden-emulators.mjs';

const { projectId, firestore } = emulatorConfig();
let env;
const expiresAtMillis = Date.now() + 60 * 60 * 1000;
const room = (overrides = {}) => ({ status: 'playing', expiresAtMillis, revision: 4, match: { revision: 2 }, ...overrides });
const member = (overrides = {}) => ({ seat: 0, isHost: true, active: true, expiresAtMillis, ...overrides });
const roomPath = 'floatingGardenRooms/active';
const protectedPaths = [
  `${roomPath}/serverGames/game-1`, `${roomPath}/serverGames/game-1/history/action-1`,
  `${roomPath}/private/unknown`, 'floatingGardenActionRequests/uid_request',
  'floatingGardenInvites/locator', 'floatingGardenRateLimits/key',
];

test.before(async () => {
  env = await initializeTestEnvironment({ projectId, firestore: { ...firestore, rules: await readFile(new URL('../firestore.rules', import.meta.url), 'utf8') } });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    const fixtures = {
      [roomPath]: room(),
      [`${roomPath}/members/host`]: member(),
      [`${roomPath}/members/guest`]: member({ seat: 1, isHost: false }),
      [`${roomPath}/members/revoked`]: member({ active: false }),
      [`${roomPath}/members/expired-member`]: member({ expiresAtMillis: 1 }),
      [`${roomPath}/members/missing-active`]: { seat: 1, expiresAtMillis },
      [`${roomPath}/members/missing-expiry`]: { seat: 1, active: true },
      [`${roomPath}/members/string-expiry`]: member({ expiresAtMillis: String(expiresAtMillis) }),
      'floatingGardenRooms/expired': room({ expiresAtMillis: 1 }),
      'floatingGardenRooms/expired/members/host': member(),
      'floatingGardenRooms/closed': room({ status: 'closed' }),
      'floatingGardenRooms/closed/members/host': member(),
      'floatingGardenRooms/malformed': { status: 'playing' },
      'floatingGardenRooms/malformed/members/host': member(),
      'floatingGardenRooms/string-expiry': room({ expiresAtMillis: String(expiresAtMillis) }),
      'floatingGardenRooms/string-expiry/members/host': member(),
      'floatingGardenRooms/orphan/members/host': member(),
      'floatingGardenRooms/waiting': room({ status: 'waiting', match: null }),
      'floatingGardenRooms/waiting/members/host': member(),
      'floatingGardenRooms/finished': room({ status: 'finished' }),
      'floatingGardenRooms/finished/members/host': member(),
      ...Object.fromEntries(protectedPaths.map((path) => [path, { secret: 'never public' }])),
    };
    await Promise.all(Object.entries(fixtures).map(([path, data]) => setDoc(doc(db, path), data)));
  });
});
test.after(async () => { if (env) await env.cleanup(); });

test('active participants can get only their room and own membership in every public status', async () => {
  for (const uid of ['host', 'guest']) {
    const db = env.authenticatedContext(uid).firestore();
    assert.equal((await assertSucceeds(getDoc(doc(db, roomPath)))).data().revision, 4);
    assert.equal((await assertSucceeds(getDoc(doc(db, `${roomPath}/members/${uid}`)))).data().active, true);
    await assertFails(getDoc(doc(db, `${roomPath}/members/${uid === 'host' ? 'guest' : 'host'}`)));
  }
  const db = env.authenticatedContext('host').firestore();
  for (const status of ['waiting', 'finished']) await assertSucceeds(getDoc(doc(db, `floatingGardenRooms/${status}`)));
});

test('unsigned clients, outsiders, expired/revoked/malformed memberships fail closed', async () => {
  for (const context of [env.unauthenticatedContext(), ...['outsider', 'revoked', 'expired-member', 'missing-active', 'missing-expiry', 'string-expiry'].map((uid) => env.authenticatedContext(uid))]) {
    const db = context.firestore();
    await assertFails(getDoc(doc(db, roomPath)));
    await assertFails(getDoc(doc(db, `${roomPath}/members/host`)));
  }
});

test('expired, closed, malformed or missing rooms deny even existing memberships', async () => {
  const db = env.authenticatedContext('host').firestore();
  for (const id of ['expired', 'closed', 'malformed', 'string-expiry', 'orphan', 'missing']) {
    await assertFails(getDoc(doc(db, `floatingGardenRooms/${id}`)));
    await assertFails(getDoc(doc(db, `floatingGardenRooms/${id}/members/host`)));
  }
});

test('room and member enumeration is denied, including document-ID constrained queries', async () => {
  const db = env.authenticatedContext('host').firestore();
  for (const target of [collection(db, 'floatingGardenRooms'), query(collection(db, 'floatingGardenRooms'), where(documentId(), '==', 'active')), collection(db, `${roomPath}/members`), query(collection(db, `${roomPath}/members`), where(documentId(), '==', 'host')), collectionGroup(db, 'members')]) await assertFails(getDocs(target));
});

test('every direct game write is denied, including self-join, forgery and recoverable deletes', async () => {
  for (const uid of ['host', 'outsider']) {
    const db = env.authenticatedContext(uid).firestore();
    for (const path of [roomPath, `${roomPath}/members/${uid}`, ...protectedPaths]) {
      await assertFails(setDoc(doc(db, path), { forged: true }));
      await assertFails(updateDoc(doc(db, path), { revision: 999 }));
      await assertFails(deleteDoc(doc(db, path)));
    }
    await assertFails(setDoc(doc(db, 'floatingGardenRooms/forged-room'), room()));
  }
});

test('all server-only and unknown nested paths deny participant reads and lists', async () => {
  const db = env.authenticatedContext('host').firestore();
  for (const path of protectedPaths) await assertFails(getDoc(doc(db, path)));
  for (const path of [`${roomPath}/serverGames`, 'floatingGardenActionRequests', 'floatingGardenInvites', 'floatingGardenRateLimits']) await assertFails(getDocs(collection(db, path)));
});

test('a public-room listener is removed when the membership is revoked and room updates', async () => {
  const db = env.authenticatedContext('guest').firestore();
  let unsubscribe;
  let received = 0;
  const denied = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('revoked listener stayed active')), 10000);
    unsubscribe = onSnapshot(doc(db, roomPath), async (snapshot) => {
      if (snapshot.metadata.fromCache || received++) return;
      try {
        await env.withSecurityRulesDisabled(async (context) => {
          const admin = context.firestore();
          await updateDoc(doc(admin, `${roomPath}/members/guest`), { active: false });
          await updateDoc(doc(admin, roomPath), { revision: 5 });
        });
      } catch (error) { clearTimeout(timeout); reject(error); }
    }, (error) => { clearTimeout(timeout); resolve(error); });
  });
  try { assert.equal((await denied).code, 'permission-denied'); }
  finally { unsubscribe?.(); }
});

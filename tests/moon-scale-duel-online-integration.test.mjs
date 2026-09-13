import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInAnonymously } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { getFirestore, connectFirestoreEmulator, doc, getDoc, terminate } from 'firebase/firestore';
import { getDatabase, connectDatabaseEmulator, ref, set, get, goOffline } from 'firebase/database';
import { createRequire } from 'node:module';

const functionRequire = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp: initializeAdminApp, getApps: getAdminApps, deleteApp: deleteAdminApp } = functionRequire('firebase-admin/app');
const { getFirestore: getAdminFirestore, Timestamp } = functionRequire('firebase-admin/firestore');
let ownedAdminApp = null;
if (!getAdminApps().length) ownedAdminApp = initializeAdminApp({ projectId: 'demo-moon-scale-duel', databaseURL: 'http://127.0.0.1:9000?ns=demo-moon-scale-duel-default-rtdb' });
const adminDb = getAdminFirestore();
const clients = [];
const config = { projectId: 'demo-moon-scale-duel', apiKey: 'demo', appId: 'demo', databaseURL: 'http://127.0.0.1:9000?ns=demo-moon-scale-duel-default-rtdb' };

function client(name) {
  const app = initializeApp(config, name);
  const auth = getAuth(app);
  const fs = getFirestore(app);
  const fn = getFunctions(app, 'asia-northeast1');
  const rt = getDatabase(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(fs, '127.0.0.1', 8080);
  connectFunctionsEmulator(fn, '127.0.0.1', 5001);
  connectDatabaseEmulator(rt, '127.0.0.1', 9000);
  const value = { app, auth, fs, fn, rt, call: (name, data) => httpsCallable(fn, name)(data).then((response) => response.data) };
  clients.push(value);
  return value;
}
async function denied(promise, code) {
  await assert.rejects(promise, (error) => !code || error.code === code);
}
function publicPart(snapshot) {
  return { room: snapshot.room, members: snapshot.members, seats: snapshot.seats, game: snapshot.game };
}

test.after(async () => {
  clients.forEach(({ rt }) => goOffline(rt));
  await Promise.allSettled(clients.map(({ fs }) => terminate(fs)));
  await Promise.allSettled(clients.map(({ app }) => deleteApp(app)));
  if (ownedAdminApp) await deleteAdminApp(ownedAdminApp);
});

test('stage one enforces two seats, secrets, idempotency, start guards, and shared snapshot', { timeout: 120000 }, async () => {
  const unauth = client('moon-unauth');
  await denied(unauth.call('moonScaleDuelCreateRoom', { displayName: '未認証', requestId: 'unauth-create' }), 'functions/unauthenticated');

  const host = client('moon-host');
  const guest = client('moon-guest');
  const third = client('moon-third');
  await Promise.all([signInAnonymously(host.auth), signInAnonymously(guest.auth), signInAnonymously(third.auth)]);

  const createPayload = { displayName: '月詠', requestId: 'create-replay-1' };
  const created = await host.call('moonScaleDuelCreateRoom', createPayload);
  assert.match(created.roomId, /^[0-9a-f-]{36}$/);
  assert.match(created.inviteCode, /^MSD1-[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{10}$/);
  assert.deepEqual(await host.call('moonScaleDuelCreateRoom', createPayload), created);
  const locator = created.inviteCode.split('-')[1];
  const secretPart = created.inviteCode.split('-')[2];
  const [secretDoc, actionDoc] = await Promise.all([
    adminDb.doc(`moonScaleDuelRoomSecrets/${created.roomId}`).get(),
    adminDb.doc(`moonScaleDuelActionRequests/${host.auth.currentUser.uid}_create-replay-1`).get(),
  ]);
  assert.ok(secretDoc.exists && secretDoc.data().inviteMac);
  assert.equal(JSON.stringify(secretDoc.data()).includes(secretPart), false);
  assert.equal(JSON.stringify(actionDoc.data()).includes(created.inviteCode), false);
  assert.equal((await adminDb.doc(`moonScaleDuelRoomLocators/${locator}`).get()).data().roomId, created.roomId);

  await denied(host.call('moonScaleDuelStartGame', { roomId: created.roomId, stateVersion: 1, requestId: 'start-too-early' }), 'functions/failed-precondition');
  const selfJoin = await host.call('moonScaleDuelJoinRoom', { displayName: '月詠', inviteCode: created.inviteCode, requestId: 'self-join' });
  assert.equal(selfJoin.seatId, 'seat1');
  assert.equal((await adminDb.doc(`moonScaleDuelRooms/${created.roomId}`).get()).data().humanCount, 1);

  const joinPayload = { displayName: '星読', inviteCode: created.inviteCode, requestId: 'join-replay-1' };
  const joined = await guest.call('moonScaleDuelJoinRoom', joinPayload);
  assert.equal(joined.seatId, 'seat2');
  assert.deepEqual(await guest.call('moonScaleDuelJoinRoom', joinPayload), joined);
  await denied(third.call('moonScaleDuelJoinRoom', { displayName: '三人目', inviteCode: created.inviteCode, requestId: 'third-join' }), 'functions/resource-exhausted');

  const before = await host.call('moonScaleDuelGetSnapshot', { roomId: created.roomId });
  assert.equal(before.seats.length, 2);
  assert.equal(before.seats.every((seat) => seat.occupied), true);
  assert.equal(before.inviteCode, created.inviteCode);
  await denied(guest.call('moonScaleDuelStartGame', { roomId: created.roomId, stateVersion: before.room.stateVersion, requestId: 'guest-start' }), 'functions/permission-denied');
  await denied(host.call('moonScaleDuelStartGame', { roomId: created.roomId, stateVersion: before.room.stateVersion - 1, requestId: 'stale-start' }), 'functions/failed-precondition');

  const startPayload = { roomId: created.roomId, stateVersion: before.room.stateVersion, requestId: 'start-replay-1' };
  const started = await host.call('moonScaleDuelStartGame', startPayload);
  assert.equal(started.phase, 'stage1-ready');
  assert.deepEqual(await host.call('moonScaleDuelStartGame', startPayload), started);
  await denied(third.call('moonScaleDuelJoinRoom', { displayName: '遅刻', inviteCode: created.inviteCode, requestId: 'late-join' }), 'functions/not-found');

  const [hostSnapshot, guestSnapshot] = await Promise.all([
    host.call('moonScaleDuelGetSnapshot', { roomId: created.roomId }),
    guest.call('moonScaleDuelGetSnapshot', { roomId: created.roomId }),
  ]);
  assert.deepEqual(publicPart(hostSnapshot), publicPart(guestSnapshot));
  assert.deepEqual(hostSnapshot.game.moonShadow, { seat1: 10, seat2: 10 });
  assert.deepEqual(hostSnapshot.game.remainingCardCounts, { seat1: 6, seat2: 6 });
  assert.equal(hostSnapshot.private.seatId, 'seat1');
  assert.equal(guestSnapshot.private.seatId, 'seat2');
  assert.equal(JSON.stringify(hostSnapshot).includes('privateSelections'), false);
  assert.equal(JSON.stringify(hostSnapshot).includes('hostUid'), false);

  const serverGame = await adminDb.doc(`moonScaleDuelRooms/${created.roomId}/serverGames/${started.gameId}`).get();
  assert.ok(serverGame.exists);
  assert.deepEqual(serverGame.data().privateSelections, { seat1: null, seat2: null });
  await denied(getDoc(doc(host.fs, `moonScaleDuelRooms/${created.roomId}`)), 'permission-denied');
  await denied(getDoc(doc(host.fs, `moonScaleDuelRooms/${created.roomId}/privatePlayers/${guest.auth.currentUser.uid}`)), 'permission-denied');
  await denied(getDoc(doc(host.fs, `moonScaleDuelRooms/${created.roomId}/serverGames/${started.gameId}`)), 'permission-denied');
  await denied(set(ref(host.rt, `moonScaleDuelPresence/${created.roomId}/${guest.auth.currentUser.uid}`), { state: 'online', lastChanged: Date.now() }));
  await set(ref(host.rt, `moonScaleDuelPresence/${created.roomId}/${host.auth.currentUser.uid}`), { state: 'online', lastChanged: Date.now() });
  assert.equal((await get(ref(guest.rt, `moonScaleDuelPresence/${created.roomId}/${host.auth.currentUser.uid}`))).val().state, 'online');
});

test('expired waiting room rejects a new participant', { timeout: 30000 }, async () => {
  const host = client('moon-expired-host');
  const guest = client('moon-expired-guest');
  await Promise.all([signInAnonymously(host.auth), signInAnonymously(guest.auth)]);
  const created = await host.call('moonScaleDuelCreateRoom', { displayName: '期限', requestId: 'expired-create' });
  await adminDb.doc(`moonScaleDuelRooms/${created.roomId}`).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
  await denied(guest.call('moonScaleDuelJoinRoom', { displayName: '遅延', inviteCode: created.inviteCode, requestId: 'expired-join' }), 'functions/not-found');
});

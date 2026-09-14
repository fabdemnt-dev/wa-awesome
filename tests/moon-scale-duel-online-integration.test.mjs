import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInAnonymously } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { getFirestore, connectFirestoreEmulator, doc, getDoc, terminate } from 'firebase/firestore';
import { getDatabase, connectDatabaseEmulator, goOffline } from 'firebase/database';
import { createRequire } from 'node:module';

const functionRequire = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp: initializeAdminApp, getApps: getAdminApps, deleteApp: deleteAdminApp } = functionRequire('firebase-admin/app');
const { getFirestore: getAdminFirestore, Timestamp } = functionRequire('firebase-admin/firestore');
const { getDatabase: getAdminDatabase } = functionRequire('firebase-admin/database');
let ownedAdminApp = null;
if (!getAdminApps().length) ownedAdminApp = initializeAdminApp({ projectId: 'demo-moon-scale-duel', databaseURL: 'http://127.0.0.1:9000?ns=demo-moon-scale-duel' });
const adminDb = getAdminFirestore();
const adminRtdb = getAdminDatabase();
const clients = [];
const config = { projectId: 'demo-moon-scale-duel', apiKey: 'demo', appId: 'demo', databaseURL: 'http://127.0.0.1:9000?ns=demo-moon-scale-duel' };

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
  assert.equal((await adminRtdb.ref(`moonScaleDuelRoomAccess/${created.roomId}/${host.auth.currentUser.uid}`).get()).val(), true);

  await denied(host.call('moonScaleDuelStartGame', { roomId: created.roomId, stateVersion: 1, requestId: 'start-too-early' }), 'functions/failed-precondition');
  const selfJoin = await host.call('moonScaleDuelJoinRoom', { displayName: '月詠', inviteCode: created.inviteCode, requestId: 'self-join' });
  assert.equal(selfJoin.seatId, 'seat1');
  assert.equal((await adminDb.doc(`moonScaleDuelRooms/${created.roomId}`).get()).data().humanCount, 1);

  const joinPayload = { displayName: '星読', inviteCode: created.inviteCode, requestId: 'join-replay-1' };
  const joined = await guest.call('moonScaleDuelJoinRoom', joinPayload);
  assert.equal(joined.seatId, 'seat2');
  assert.deepEqual(await guest.call('moonScaleDuelJoinRoom', joinPayload), joined);
  assert.equal((await adminRtdb.ref(`moonScaleDuelRoomAccess/${created.roomId}/${guest.auth.currentUser.uid}`).get()).val(), true);
  await denied(third.call('moonScaleDuelJoinRoom', { displayName: '三人目', inviteCode: created.inviteCode, requestId: 'third-join' }), 'functions/resource-exhausted');

  const before = await host.call('moonScaleDuelGetSnapshot', { roomId: created.roomId });
  assert.equal(before.seats.length, 2);
  assert.equal(before.seats.every((seat) => seat.occupied), true);
  assert.equal(before.inviteCode, created.inviteCode);
  await denied(guest.call('moonScaleDuelStartGame', { roomId: created.roomId, stateVersion: before.room.stateVersion, requestId: 'guest-start' }), 'functions/permission-denied');
  await denied(host.call('moonScaleDuelStartGame', { roomId: created.roomId, stateVersion: before.room.stateVersion - 1, requestId: 'stale-start' }), 'functions/failed-precondition');

  const startPayload = { roomId: created.roomId, stateVersion: before.room.stateVersion, requestId: 'start-replay-1' };
  const started = await host.call('moonScaleDuelStartGame', startPayload);
  assert.equal(started.phase, 'selecting-card');
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
  assert.deepEqual(hostSnapshot.private.availableCards, ['waxing', 'waning', 'reflection', 'stillness', 'falseMoon', 'oath']);
  assert.equal(hostSnapshot.private.submitted, false);
  assert.equal(JSON.stringify(hostSnapshot).includes('privateSelections'), false);
  assert.equal(JSON.stringify(hostSnapshot).includes('hostUid'), false);

  const serverGame = await adminDb.doc(`moonScaleDuelRooms/${created.roomId}/serverGames/${started.gameId}`).get();
  assert.ok(serverGame.exists);
  assert.deepEqual(serverGame.data().privateSelections, { seat1: null, seat2: null });
  await denied(getDoc(doc(host.fs, `moonScaleDuelRooms/${created.roomId}`)), 'permission-denied');
  await denied(getDoc(doc(host.fs, `moonScaleDuelRooms/${created.roomId}/privatePlayers/${guest.auth.currentUser.uid}`)), 'permission-denied');
  await denied(getDoc(doc(host.fs, `moonScaleDuelRooms/${created.roomId}/serverGames/${started.gameId}`)), 'permission-denied');
});

async function startedRoom(prefix) {
  const host = client(`${prefix}-host`);
  const guest = client(`${prefix}-guest`);
  await Promise.all([signInAnonymously(host.auth), signInAnonymously(guest.auth)]);
  const created = await host.call('moonScaleDuelCreateRoom', { displayName: '月詠', requestId: `${prefix}-create` });
  await guest.call('moonScaleDuelJoinRoom', { displayName: '星読', inviteCode: created.inviteCode, requestId: `${prefix}-join` });
  const waiting = await host.call('moonScaleDuelGetSnapshot', { roomId: created.roomId });
  const started = await host.call('moonScaleDuelStartGame', {
    roomId: created.roomId,
    stateVersion: waiting.room.stateVersion,
    requestId: `${prefix}-start`,
  });
  return { host, guest, roomId: created.roomId, started };
}

function submitPayload(room, cardId, requestId, overrides = {}) {
  return {
    roomId: room.roomId,
    gameId: room.started.gameId,
    round: 1,
    stateVersion: room.started.stateVersion,
    cardId,
    requestId,
    ...overrides,
  };
}

function copyPayload(room, copyTargetId, requestId, stateVersion, overrides = {}) {
  return {
    roomId: room.roomId,
    gameId: room.started.gameId,
    round: 1,
    stateVersion,
    copyTargetId,
    requestId,
    ...overrides,
  };
}

function assertNoCardLeak(snapshot) {
  assert.equal(snapshot.game.phase, 'selecting-card');
  assert.equal(snapshot.game.publicCards, null);
  assert.equal(snapshot.private.selectedCardId, null);
  assert.equal(snapshot.private.submitted, false);
  assert.equal(JSON.stringify(snapshot).includes('privateSelections'), false);
  assert.equal(JSON.stringify(snapshot).includes('submittedCount'), false);
}

test('one-sided submissions stay private in either seat and request replay is idempotent', { timeout: 120000 }, async () => {
  const hostFirst = await startedRoom('secret-a');
  const hostPayload = submitPayload(hostFirst, 'waxing', 'secret-a-submit');
  const first = await hostFirst.host.call('moonScaleDuelSubmitCard', hostPayload);
  assert.deepEqual(first, {
    roomId: hostFirst.roomId,
    gameId: hostFirst.started.gameId,
    round: 1,
    phase: 'selecting-card',
    stateVersion: hostFirst.started.stateVersion,
    submitted: true,
    revealed: false,
  });
  assert.deepEqual(await hostFirst.host.call('moonScaleDuelSubmitCard', hostPayload), first);
  const [hostView, guestView, publicGame, serverGame] = await Promise.all([
    hostFirst.host.call('moonScaleDuelGetSnapshot', { roomId: hostFirst.roomId }),
    hostFirst.guest.call('moonScaleDuelGetSnapshot', { roomId: hostFirst.roomId }),
    adminDb.doc(`moonScaleDuelRooms/${hostFirst.roomId}/games/${hostFirst.started.gameId}`).get(),
    adminDb.doc(`moonScaleDuelRooms/${hostFirst.roomId}/serverGames/${hostFirst.started.gameId}`).get(),
  ]);
  assert.equal(hostView.private.submitted, true);
  assert.equal(hostView.private.selectedCardId, 'waxing');
  assertNoCardLeak(guestView);
  assert.equal(JSON.stringify(publicGame.data()).includes('waxing'), false);
  assert.equal(serverGame.data().privateSelections.seat1.cardId, 'waxing');
  assert.equal(hostView.private.usedCards.length, 0);
  await denied(hostFirst.host.call('moonScaleDuelSubmitCard', { ...hostPayload, cardId: 'waning' }), 'functions/already-exists');

  const guestFirst = await startedRoom('secret-b');
  await guestFirst.guest.call('moonScaleDuelSubmitCard', submitPayload(guestFirst, 'oath', 'secret-b-submit'));
  const hostWaiting = await guestFirst.host.call('moonScaleDuelGetSnapshot', { roomId: guestFirst.roomId });
  assertNoCardLeak(hostWaiting);
});

test('both submissions reveal atomically and near-simultaneous calls preserve one transition', { timeout: 120000 }, async () => {
  const room = await startedRoom('reveal');
  const [hostResult, guestResult] = await Promise.all([
    room.host.call('moonScaleDuelSubmitCard', submitPayload(room, 'reflection', 'reveal-host')),
    room.guest.call('moonScaleDuelSubmitCard', submitPayload(room, 'stillness', 'reveal-guest')),
  ]);
  assert.equal([hostResult, guestResult].filter((result) => result.revealed).length, 1);
  const [hostView, guestView, publicGame, serverGame] = await Promise.all([
    room.host.call('moonScaleDuelGetSnapshot', { roomId: room.roomId }),
    room.guest.call('moonScaleDuelGetSnapshot', { roomId: room.roomId }),
    adminDb.doc(`moonScaleDuelRooms/${room.roomId}/games/${room.started.gameId}`).get(),
    adminDb.doc(`moonScaleDuelRooms/${room.roomId}/serverGames/${room.started.gameId}`).get(),
  ]);
  assert.deepEqual(publicPart(hostView), publicPart(guestView));
  assert.equal(hostView.game.phase, 'round-result');
  assert.deepEqual(hostView.game.publicCards, { seat1: 'reflection', seat2: 'stillness' });
  assert.equal(hostView.game.stateVersion, room.started.stateVersion + 1);
  assert.deepEqual(hostView.game.remainingCardCounts, { seat1: 5, seat2: 5 });
  assert.deepEqual(hostView.private.usedCards, ['reflection']);
  assert.deepEqual(guestView.private.usedCards, ['stillness']);
  assert.deepEqual(serverGame.data().usedCards, { seat1: ['reflection'], seat2: ['stillness'] });
  assert.deepEqual(publicGame.data().publicCards, { seat1: 'reflection', seat2: 'stillness' });
  assert.deepEqual(hostView.game.moonShadow, { seat1: 10, seat2: 10 });
  assert.equal(hostView.game.roundResult.effects.seat1.status, 'blocked');
});

test('false moon exposes candidates only to its owner and resolves after a valid secret target', { timeout: 120000 }, async () => {
  const room = await startedRoom('copy-one');
  await room.host.call('moonScaleDuelSubmitCard', submitPayload(room, 'falseMoon', 'copy-one-host'));
  const reveal = await room.guest.call('moonScaleDuelSubmitCard', submitPayload(room, 'waxing', 'copy-one-guest'));
  assert.equal(reveal.phase, 'choosing-copy');
  const [hostChoosing, guestChoosing] = await Promise.all([
    room.host.call('moonScaleDuelGetSnapshot', { roomId: room.roomId }),
    room.guest.call('moonScaleDuelGetSnapshot', { roomId: room.roomId }),
  ]);
  assert.deepEqual(hostChoosing.private.legalCopyTargets, ['waxing', 'waning', 'reflection']);
  assert.deepEqual(guestChoosing.private.legalCopyTargets, []);
  assert.equal(JSON.stringify(guestChoosing).includes('copyCandidates'), false);
  const payload = copyPayload(room, 'waning', 'copy-one-target', reveal.stateVersion);
  await denied(room.host.call('moonScaleDuelSubmitCopyTarget', { ...payload, requestId: 'copy-one-stale', stateVersion: reveal.stateVersion - 1 }), 'functions/failed-precondition');
  const resolved = await room.host.call('moonScaleDuelSubmitCopyTarget', payload);
  assert.equal(resolved.phase, 'round-result');
  assert.deepEqual(await room.host.call('moonScaleDuelSubmitCopyTarget', payload), resolved);
  await denied(room.host.call('moonScaleDuelSubmitCopyTarget', { ...payload, copyTargetId: 'waxing' }), 'functions/already-exists');
  const [hostResult, guestResult] = await Promise.all([
    room.host.call('moonScaleDuelGetSnapshot', { roomId: room.roomId }),
    room.guest.call('moonScaleDuelGetSnapshot', { roomId: room.roomId }),
  ]);
  assert.deepEqual(publicPart(hostResult), publicPart(guestResult));
  assert.equal(hostResult.game.publicCopies.seat1, 'waning');
  assert.deepEqual(hostResult.game.moonShadow, { seat1: 10, seat2: 10 });
});

test('two false moons keep the first copy secret until both choices exist', { timeout: 120000 }, async () => {
  const room = await startedRoom('copy-both');
  await Promise.all([
    room.host.call('moonScaleDuelSubmitCard', submitPayload(room, 'falseMoon', 'copy-both-host')),
    room.guest.call('moonScaleDuelSubmitCard', submitPayload(room, 'falseMoon', 'copy-both-guest')),
  ]);
  const choosing = await room.host.call('moonScaleDuelGetSnapshot', { roomId: room.roomId });
  assert.equal(choosing.game.phase, 'choosing-copy');
  const version = choosing.game.stateVersion;
  await room.host.call('moonScaleDuelSubmitCopyTarget', copyPayload(room, 'waxing', 'copy-both-target-a', version));
  const guestWaiting = await room.guest.call('moonScaleDuelGetSnapshot', { roomId: room.roomId });
  assert.equal(guestWaiting.game.publicCopies, null);
  assert.equal(guestWaiting.game.roundResult, null);
  assert.equal(guestWaiting.private.selectedCopyTarget, null);
  await denied(room.guest.call('moonScaleDuelSubmitCopyTarget', copyPayload(room, 'oath', 'copy-both-invalid', version)), 'functions/failed-precondition');
  const outsider = client('copy-both-outsider');
  await signInAnonymously(outsider.auth);
  await denied(outsider.call('moonScaleDuelSubmitCopyTarget', copyPayload(room, 'waning', 'copy-both-outsider', version)), 'functions/permission-denied');
  const guestResult = await room.guest.call('moonScaleDuelSubmitCopyTarget', copyPayload(room, 'reflection', 'copy-both-target-b', version));
  assert.equal(guestResult.resolved, true);
  const [hostResult, finalGuest, serverGame] = await Promise.all([
    room.host.call('moonScaleDuelGetSnapshot', { roomId: room.roomId }),
    room.guest.call('moonScaleDuelGetSnapshot', { roomId: room.roomId }),
    adminDb.doc(`moonScaleDuelRooms/${room.roomId}/serverGames/${room.started.gameId}`).get(),
  ]);
  assert.deepEqual(publicPart(hostResult), publicPart(finalGuest));
  assert.equal(hostResult.game.phase, 'round-result');
  assert.deepEqual(hostResult.game.publicCopies, { seat1: 'waxing', seat2: 'reflection' });
  assert.equal(serverGame.data().publicResult.round, 1);
  assert.equal(serverGame.data().phase, 'round-result');
});

test('near-simultaneous copy choices produce one consistent round result', { timeout: 120000 }, async () => {
  const room = await startedRoom('copy-race');
  await Promise.all([
    room.host.call('moonScaleDuelSubmitCard', submitPayload(room, 'falseMoon', 'copy-race-host')),
    room.guest.call('moonScaleDuelSubmitCard', submitPayload(room, 'falseMoon', 'copy-race-guest')),
  ]);
  const choosing = await room.host.call('moonScaleDuelGetSnapshot', { roomId: room.roomId });
  const results = await Promise.all([
    room.host.call('moonScaleDuelSubmitCopyTarget', copyPayload(room, 'waxing', 'copy-race-target-a', choosing.game.stateVersion)),
    room.guest.call('moonScaleDuelSubmitCopyTarget', copyPayload(room, 'waning', 'copy-race-target-b', choosing.game.stateVersion)),
  ]);
  assert.equal(results.filter((result) => result.resolved).length, 1);
  const [hostResult, guestResult] = await Promise.all([
    room.host.call('moonScaleDuelGetSnapshot', { roomId: room.roomId }),
    room.guest.call('moonScaleDuelGetSnapshot', { roomId: room.roomId }),
  ]);
  assert.deepEqual(publicPart(hostResult), publicPart(guestResult));
  assert.equal(hostResult.game.phase, 'round-result');
  assert.deepEqual(hostResult.game.publicCopies, { seat1: 'waxing', seat2: 'waning' });
  assert.deepEqual(hostResult.game.moonShadow, { seat1: 10, seat2: 10 });
});

test('submission rejects stale, invalid, already-used, and outsider operations', { timeout: 120000 }, async () => {
  const room = await startedRoom('guards');
  const outsider = client('guards-outsider');
  await signInAnonymously(outsider.auth);
  await denied(room.host.call('moonScaleDuelSubmitCard', submitPayload(room, 'waxing', 'guards-stale', {
    stateVersion: room.started.stateVersion - 1,
  })), 'functions/failed-precondition');
  await denied(room.host.call('moonScaleDuelSubmitCard', submitPayload(room, 'not-a-card', 'guards-invalid')), 'functions/invalid-argument');
  await denied(outsider.call('moonScaleDuelSubmitCard', submitPayload(room, 'waxing', 'guards-outsider')), 'functions/permission-denied');

  const hostPrivateRef = adminDb.doc(`moonScaleDuelRooms/${room.roomId}/privatePlayers/${room.host.auth.currentUser.uid}`);
  const serverRef = adminDb.doc(`moonScaleDuelRooms/${room.roomId}/serverGames/${room.started.gameId}`);
  await Promise.all([
    hostPrivateRef.update({ usedCards: ['waning'] }),
    serverRef.update({ 'usedCards.seat1': ['waning'] }),
  ]);
  await denied(room.host.call('moonScaleDuelSubmitCard', submitPayload(room, 'waning', 'guards-used')), 'functions/failed-precondition');
  await room.host.call('moonScaleDuelSubmitCard', submitPayload(room, 'waxing', 'guards-first'));
  await denied(room.host.call('moonScaleDuelSubmitCard', submitPayload(room, 'reflection', 'guards-second')), 'functions/already-exists');

  await denied(getDoc(doc(room.host.fs, `moonScaleDuelRooms/${room.roomId}`)), 'permission-denied');
  await denied(getDoc(doc(room.host.fs, `moonScaleDuelRooms/${room.roomId}/privatePlayers/${room.guest.auth.currentUser.uid}`)), 'permission-denied');
  await denied(getDoc(doc(room.host.fs, `moonScaleDuelRooms/${room.roomId}/serverGames/${room.started.gameId}`)), 'permission-denied');
});

test('expired waiting room rejects a new participant', { timeout: 30000 }, async () => {
  const host = client('moon-expired-host');
  const guest = client('moon-expired-guest');
  await Promise.all([signInAnonymously(host.auth), signInAnonymously(guest.auth)]);
  const created = await host.call('moonScaleDuelCreateRoom', { displayName: '期限', requestId: 'expired-create' });
  await adminDb.doc(`moonScaleDuelRooms/${created.roomId}`).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
  await denied(guest.call('moonScaleDuelJoinRoom', { displayName: '遅延', inviteCode: created.inviteCode, requestId: 'expired-join' }), 'functions/not-found');
});

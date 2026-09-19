import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInAnonymously } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { getFirestore, connectFirestoreEmulator, doc, getDoc, terminate } from 'firebase/firestore';
import { getDatabase, connectDatabaseEmulator, goOffline } from 'firebase/database';
import { createRequire } from 'node:module';
import { callReadyNextRoundWithEmulatorRetry } from './helpers/moon-scale-duel-emulator-retry.mjs';

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
  const invoke = (callableName, data) => httpsCallable(fn, callableName)(data).then((response) => response.data);
  const value = {
    app, auth, fs, fn, rt,
    call: (callableName, data) => callableName === 'moonScaleDuelReadyNextRound'
      ? callReadyNextRoundWithEmulatorRetry((payload) => invoke(callableName, payload), data)
      : invoke(callableName, data),
  };
  clients.push(value);
  return value;
}
async function denied(promise, code) {
  await assert.rejects(promise, (error) => !code || error.code === code);
}
function publicPart(snapshot) {
  const { serverTimeMillis, ...game } = snapshot.game;
  assert.equal(typeof serverTimeMillis, 'number');
  assert.equal(Number.isFinite(serverTimeMillis), true);
  assert.ok(serverTimeMillis > 0);
  return { room: snapshot.room, members: snapshot.members, seats: snapshot.seats, game };
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

function roundPayload(room, snapshot, requestId, overrides = {}) {
  return {
    roomId: room.roomId,
    gameId: room.started.gameId,
    round: snapshot.game.round,
    stateVersion: snapshot.game.stateVersion,
    requestId,
    ...overrides,
  };
}

async function playRound(room, hostCard, guestCard, prefix) {
  const before = await room.host.call('moonScaleDuelGetSnapshot', { roomId: room.roomId });
  const payload = (cardId, requestId) => ({
    roomId: room.roomId, gameId: room.started.gameId, round: before.game.round,
    stateVersion: before.game.stateVersion, cardId, requestId,
  });
  await Promise.all([
    room.host.call('moonScaleDuelSubmitCard', payload(hostCard, `${prefix}-host`)),
    room.guest.call('moonScaleDuelSubmitCard', payload(guestCard, `${prefix}-guest`)),
  ]);
  return room.host.call('moonScaleDuelGetSnapshot', { roomId: room.roomId });
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
  const roomRef = adminDb.doc(`moonScaleDuelRooms/${hostFirst.roomId}`);
  const gameRef = roomRef.collection('games').doc(hostFirst.started.gameId);
  const [roomBefore, gameBefore] = await Promise.all([roomRef.get(), gameRef.get()]);
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
  const [hostView, guestView, roomAfter, publicGame, serverGame, privatePlayer, action] = await Promise.all([
    hostFirst.host.call('moonScaleDuelGetSnapshot', { roomId: hostFirst.roomId }),
    hostFirst.guest.call('moonScaleDuelGetSnapshot', { roomId: hostFirst.roomId }),
    roomRef.get(),
    gameRef.get(),
    roomRef.collection('serverGames').doc(hostFirst.started.gameId).get(),
    roomRef.collection('privatePlayers').doc(hostFirst.host.auth.currentUser.uid).get(),
    adminDb.doc(`moonScaleDuelActionRequests/${hostFirst.host.auth.currentUser.uid}_secret-a-submit`).get(),
  ]);
  assert.ok(roomAfter.data().lastValidActionAt.toMillis() > roomBefore.data().lastValidActionAt.toMillis());
  assert.ok(roomAfter.data().expiresAt.toMillis() > roomBefore.data().expiresAt.toMillis());
  assert.equal(publicGame.data().lastValidActionAt.toMillis(), gameBefore.data().lastValidActionAt.toMillis());
  assert.equal(publicGame.data().expiresAt.toMillis(), gameBefore.data().expiresAt.toMillis());
  assert.equal(hostView.private.submitted, true);
  assert.equal(hostView.private.selectedCardId, 'waxing');
  assertNoCardLeak(guestView);
  assert.equal(JSON.stringify(publicGame.data()).includes('waxing'), false);
  assert.equal(serverGame.data().privateSelections.seat1.cardId, 'waxing');
  assert.equal(privatePlayer.data().submitted, true);
  assert.equal(privatePlayer.data().selectedCardId, 'waxing');
  assert.equal(action.data().type, 'submitCard');
  assert.deepEqual(action.data().result, first);
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

test('next-round readiness preserves durable state and advances exactly once', { timeout: 120000 }, async () => {
  const room = await startedRoom('next-round');
  const result = await playRound(room, 'waxing', 'waxing', 'next-round-r1');
  const readyPayload = roundPayload(room, result, 'next-round-ready-host');
  const first = await room.host.call('moonScaleDuelReadyNextRound', readyPayload);
  assert.equal(first.advanced, false);
  const waiting = await room.host.call('moonScaleDuelGetSnapshot', { roomId: room.roomId });
  assert.equal(waiting.game.round, 1);
  assert.equal(waiting.game.nextRoundReady.seat1, true);
  assert.equal(waiting.game.nextRoundReady.seat2, false);
  assert.ok(waiting.game.deadlineMillis > waiting.game.serverTimeMillis);
  assert.deepEqual(await room.host.call('moonScaleDuelReadyNextRound', readyPayload), first);
  await denied(room.host.call('moonScaleDuelReadyNextRound', { ...readyPayload, round: 2 }), 'functions/already-exists');

  const moonBefore = waiting.game.moonShadow;
  const historyBefore = waiting.game.history;
  const advanced = await room.guest.call('moonScaleDuelReadyNextRound', roundPayload(room, waiting, 'next-round-ready-guest'));
  assert.equal(advanced.advanced, true);
  const next = await room.host.call('moonScaleDuelGetSnapshot', { roomId: room.roomId });
  assert.equal(next.game.round, 2);
  assert.equal(next.game.phase, 'selecting-card');
  assert.deepEqual(next.game.moonShadow, moonBefore);
  assert.deepEqual(next.game.history, historyBefore);
  assert.deepEqual(next.game.nextRoundReady, { seat1: false, seat2: false });
  assert.equal(next.game.deadlineMillis, null);
  assert.equal(next.game.publicCards, null);
  assert.equal(next.game.roundResult, null);
  assert.equal(next.private.submitted, false);
  assert.equal(next.private.selectedCardId, null);
  assert.deepEqual(next.private.usedCards, ['waxing']);
  assert.equal(next.private.availableCards.includes('waxing'), false);
  await denied(room.host.call('moonScaleDuelSubmitCard', {
    roomId: room.roomId, gameId: room.started.gameId, round: 2, stateVersion: next.game.stateVersion,
    cardId: 'waxing', requestId: 'next-round-reuse-card',
  }), 'functions/failed-precondition');
  await denied(room.host.call('moonScaleDuelReadyNextRound', roundPayload(room, result, 'next-round-stale')), 'functions/failed-precondition');
});

test('known emulator failure after commit retries the same request without double application', { timeout: 120000 }, async () => {
  const room = await startedRoom('emulator-retry');
  const result = await playRound(room, 'waxing', 'waxing', 'emulator-retry-r1');
  const payload = roundPayload(room, result, 'emulator-retry-host');
  let attempts = 0;
  const hostResult = await callReadyNextRoundWithEmulatorRetry(async (samePayload) => {
    attempts += 1;
    const committed = await httpsCallable(room.host.fn, 'moonScaleDuelReadyNextRound')(samePayload)
      .then((response) => response.data);
    if (attempts === 1) {
      throw Object.assign(new Error('INTERNAL'), {
        code: 'functions/internal',
        details: {
          kind: 'moon-scale-duel/firestore-emulator-invalid-transaction',
          firestoreCode: 'INVALID_ARGUMENT',
          firestoreMessage: 'Transaction is invalid or closed.',
        },
      });
    }
    return committed;
  }, payload);

  assert.equal(attempts, 2);
  assert.equal(hostResult.advanced, false);
  assert.equal(hostResult.round, 1);
  const hostAction = await adminDb.doc(`moonScaleDuelActionRequests/${room.host.auth.currentUser.uid}_${payload.requestId}`).get();
  assert.equal(hostAction.exists, true);
  assert.deepEqual(hostAction.data().result, hostResult);

  const guestResult = await room.guest.call(
    'moonScaleDuelReadyNextRound',
    roundPayload(room, result, 'emulator-retry-guest'),
  );
  assert.equal(guestResult.advanced, true);
  const advanced = await room.host.call('moonScaleDuelGetSnapshot', { roomId: room.roomId });
  assert.equal(advanced.game.round, 2);
  assert.equal(advanced.game.stateVersion, result.game.stateVersion + 1);
  assert.deepEqual(advanced.game.nextRoundReady, { seat1: false, seat2: false });
});

test('expired readiness can be extended idempotently only by the waiting player', { timeout: 120000 }, async () => {
  const room = await startedRoom('extend-wait');
  const result = await playRound(room, 'waxing', 'waxing', 'extend-wait-r1');
  await room.host.call('moonScaleDuelReadyNextRound', roundPayload(room, result, 'extend-wait-ready'));
  const gameRef = adminDb.doc(`moonScaleDuelRooms/${room.roomId}/games/${room.started.gameId}`);
  await gameRef.update({ deadline: Timestamp.fromMillis(Date.now() - 10) });
  const expired = await room.host.call('moonScaleDuelGetSnapshot', { roomId: room.roomId });
  await denied(room.guest.call('moonScaleDuelExtendNextRoundWait', roundPayload(room, expired, 'extend-wait-wrong-side')), 'functions/permission-denied');
  const extendPayload = roundPayload(room, expired, 'extend-wait-once');
  const extended = await room.host.call('moonScaleDuelExtendNextRoundWait', extendPayload);
  assert.ok(extended.deadlineMillis >= Date.now() + 55000);
  assert.deepEqual(await room.host.call('moonScaleDuelExtendNextRoundWait', extendPayload), extended);
  await denied(room.host.call('moonScaleDuelExtendNextRoundWait', { ...extendPayload, round: 2 }), 'functions/already-exists');
  await denied(room.host.call('moonScaleDuelExtendNextRoundWait', roundPayload(room, await room.host.call('moonScaleDuelGetSnapshot', { roomId: room.roomId }), 'extend-wait-too-early')), 'functions/failed-precondition');
  await gameRef.update({ deadline: Timestamp.fromMillis(Date.now() - 10) });
  const expiredAgain = await room.host.call('moonScaleDuelGetSnapshot', { roomId: room.roomId });
  const extendedAgain = await room.host.call('moonScaleDuelExtendNextRoundWait', roundPayload(room, expiredAgain, 'extend-wait-twice'));
  assert.ok(extendedAgain.deadlineMillis > extended.deadlineMillis);
});

test('timeout abort is separate from victory and races safely with readiness', { timeout: 120000 }, async () => {
  const room = await startedRoom('abort-wait');
  const result = await playRound(room, 'waxing', 'waxing', 'abort-wait-r1');
  await room.host.call('moonScaleDuelReadyNextRound', roundPayload(room, result, 'abort-wait-ready'));
  const current = await room.host.call('moonScaleDuelGetSnapshot', { roomId: room.roomId });
  await denied(room.host.call('moonScaleDuelAbortAfterWait', roundPayload(room, current, 'abort-wait-early')), 'functions/failed-precondition');
  const gameRef = adminDb.doc(`moonScaleDuelRooms/${room.roomId}/games/${room.started.gameId}`);
  await gameRef.update({ deadline: Timestamp.fromMillis(Date.now() - 10) });
  const expired = await room.host.call('moonScaleDuelGetSnapshot', { roomId: room.roomId });
  await denied(room.guest.call('moonScaleDuelAbortAfterWait', roundPayload(room, expired, 'abort-wait-wrong-side')), 'functions/permission-denied');
  const abortPayload = roundPayload(room, expired, 'abort-wait-once');
  const aborted = await room.host.call('moonScaleDuelAbortAfterWait', abortPayload);
  assert.equal(aborted.result.type, 'aborted');
  assert.equal(aborted.result.reason, 'next-round-timeout');
  assert.deepEqual(await room.host.call('moonScaleDuelAbortAfterWait', abortPayload), aborted);
  const snapshot = await room.guest.call('moonScaleDuelGetSnapshot', { roomId: room.roomId });
  assert.equal(snapshot.game.phase, 'aborted');
  assert.equal(snapshot.game.result.type, 'aborted');
  assert.equal(JSON.stringify(snapshot.game.result).includes('winner'), false);

  const race = await startedRoom('abort-race');
  const raceResult = await playRound(race, 'waxing', 'waxing', 'abort-race-r1');
  await race.host.call('moonScaleDuelReadyNextRound', roundPayload(race, raceResult, 'abort-race-ready'));
  const raceGameRef = adminDb.doc(`moonScaleDuelRooms/${race.roomId}/games/${race.started.gameId}`);
  await raceGameRef.update({ deadline: Timestamp.fromMillis(Date.now() - 10) });
  const raceState = await race.host.call('moonScaleDuelGetSnapshot', { roomId: race.roomId });
  await Promise.allSettled([
    race.host.call('moonScaleDuelAbortAfterWait', roundPayload(race, raceState, 'abort-race-abort')),
    race.guest.call('moonScaleDuelReadyNextRound', roundPayload(race, raceState, 'abort-race-guest')),
  ]);
  const final = await race.host.call('moonScaleDuelGetSnapshot', { roomId: race.roomId });
  assert.ok((final.game.phase === 'aborted' && final.game.round === 1) || (final.game.phase === 'selecting-card' && final.game.round === 2));

  const extendRace = await startedRoom('extend-race');
  const extendResult = await playRound(extendRace, 'waxing', 'waxing', 'extend-race-r1');
  await extendRace.host.call('moonScaleDuelReadyNextRound', roundPayload(extendRace, extendResult, 'extend-race-ready'));
  const extendGameRef = adminDb.doc(`moonScaleDuelRooms/${extendRace.roomId}/games/${extendRace.started.gameId}`);
  await extendGameRef.update({ deadline: Timestamp.fromMillis(Date.now() - 10) });
  const extendState = await extendRace.host.call('moonScaleDuelGetSnapshot', { roomId: extendRace.roomId });
  await Promise.allSettled([
    extendRace.host.call('moonScaleDuelExtendNextRoundWait', roundPayload(extendRace, extendState, 'extend-race-extend')),
    extendRace.guest.call('moonScaleDuelReadyNextRound', roundPayload(extendRace, extendState, 'extend-race-guest')),
  ]);
  const extendFinal = await extendRace.host.call('moonScaleDuelGetSnapshot', { roomId: extendRace.roomId });
  assert.ok((extendFinal.game.phase === 'selecting-card' && extendFinal.game.round === 2)
    || (extendFinal.game.phase === 'round-result' && extendFinal.game.round === 1 && extendFinal.game.deadlineMillis > Date.now()));
});

test('a normal outcome ends the game and rejects next-round readiness', { timeout: 120000 }, async () => {
  const room = await startedRoom('early-finish');
  await Promise.all([
    adminDb.doc(`moonScaleDuelRooms/${room.roomId}/games/${room.started.gameId}`).update({ moonShadow: { seat1: 3, seat2: 3 } }),
    adminDb.doc(`moonScaleDuelRooms/${room.roomId}/serverGames/${room.started.gameId}`).update({ moonShadow: { seat1: 3, seat2: 3 } }),
  ]);
  const result = await playRound(room, 'waning', 'waning', 'early-finish-r1');
  assert.equal(result.game.phase, 'ended');
  assert.equal(result.game.result.type, 'completed');
  assert.equal(result.game.result.outcome, 'draw');
  assert.deepEqual(result.game.moonShadow, { seat1: 0, seat2: 0 });
  await denied(room.host.call('moonScaleDuelReadyNextRound', roundPayload(room, result, 'early-finish-ready')), 'functions/failed-precondition');
});

test('six rounds complete with ordered public history and no seventh round', { timeout: 180000 }, async () => {
  const room = await startedRoom('six-rounds');
  const cards = ['waxing', 'waning', 'reflection', 'stillness', 'oath', 'falseMoon'];
  for (let index = 0; index < cards.length; index += 1) {
    const round = index + 1;
    const result = await playRound(room, cards[index], cards[index], `six-rounds-r${round}`);
    assert.equal(result.game.round, round);
    assert.equal(result.game.history.length, round);
    assert.deepEqual(result.game.history.map((item) => item.round), Array.from({ length: round }, (_, item) => item + 1));
    assert.equal(JSON.stringify(result.game.history).includes('privateSelections'), false);
    assert.equal(JSON.stringify(result.game.history).includes('copyCandidates'), false);
    if (round < 6) {
      await Promise.all([
        room.host.call('moonScaleDuelReadyNextRound', roundPayload(room, result, `six-rounds-ready-h-${round}`)),
        room.guest.call('moonScaleDuelReadyNextRound', roundPayload(room, result, `six-rounds-ready-g-${round}`)),
      ]);
      const next = await room.host.call('moonScaleDuelGetSnapshot', { roomId: room.roomId });
      assert.equal(next.game.round, round + 1);
      assert.equal(next.private.usedCards.length, round);
    } else {
      assert.equal(result.game.phase, 'ended');
      assert.equal(result.game.result.type, 'completed');
      assert.equal(result.game.result.outcome, 'draw');
      await denied(room.host.call('moonScaleDuelReadyNextRound', roundPayload(room, result, 'six-rounds-seventh')), 'functions/failed-precondition');
      const rematches = await Promise.all([
        room.host.call('moonScaleDuelRequestRematch', rematchPayload(room, result, 'six-rounds-rematch-host')),
        room.guest.call('moonScaleDuelRequestRematch', rematchPayload(room, result, 'six-rounds-rematch-guest')),
      ]);
      assert.equal(rematches.filter((item) => item.started).length, 1);
      const restarted = await room.host.call('moonScaleDuelGetSnapshot', { roomId: room.roomId });
      assert.notEqual(restarted.game.gameId, room.started.gameId);
      assert.equal(restarted.game.round, 1);
      assert.equal(restarted.game.phase, 'selecting-card');
      await Promise.all([
        room.host.call('moonScaleDuelSubmitCard', {
          roomId: room.roomId, gameId: restarted.game.gameId, round: 1,
          stateVersion: restarted.game.stateVersion, cardId: 'waxing', requestId: 'six-rounds-new-host',
        }),
        room.guest.call('moonScaleDuelSubmitCard', {
          roomId: room.roomId, gameId: restarted.game.gameId, round: 1,
          stateVersion: restarted.game.stateVersion, cardId: 'waning', requestId: 'six-rounds-new-guest',
        }),
      ]);
      assert.equal((await room.host.call('moonScaleDuelGetSnapshot', { roomId: room.roomId })).game.phase, 'round-result');
    }
  }
});

async function forceCompleted(room, outcome = 'seat1', moonShadow = { seat1: 12, seat2: 7 }) {
  const gameRef = adminDb.doc(`moonScaleDuelRooms/${room.roomId}/games/${room.started.gameId}`);
  const serverRef = adminDb.doc(`moonScaleDuelRooms/${room.roomId}/serverGames/${room.started.gameId}`);
  const roomRef = adminDb.doc(`moonScaleDuelRooms/${room.roomId}`);
  const current = (await gameRef.get()).data();
  const result = { type: 'completed', outcome, round: current.round, moonShadow };
  await Promise.all([
    gameRef.update({ phase: 'ended', moonShadow, result, rematchReady: { seat1: false, seat2: false } }),
    serverRef.update({ phase: 'ended' }),
    roomRef.update({ status: 'ended' }),
  ]);
  return { ...current, phase: 'ended', moonShadow, result };
}

function rematchPayload(room, snapshot, requestId, overrides = {}) {
  return {
    roomId: room.roomId,
    gameId: snapshot.game.gameId,
    stateVersion: snapshot.game.stateVersion,
    requestId,
    ...overrides,
  };
}

test('normal completion is recoverable and two rematch requests create exactly one fresh game', { timeout: 120000 }, async () => {
  const room = await startedRoom('rematch-complete');
  await forceCompleted(room, 'seat1', { seat1: 12, seat2: 7 });
  const [hostEnded, guestEnded] = await Promise.all([
    room.host.call('moonScaleDuelGetSnapshot', { roomId: room.roomId }),
    room.guest.call('moonScaleDuelGetSnapshot', { roomId: room.roomId }),
  ]);
  assert.equal(hostEnded.game.result.outcome, 'seat1');
  assert.deepEqual(hostEnded.game.result, guestEnded.game.result);
  assert.deepEqual(hostEnded.game.result.moonShadow, { seat1: 12, seat2: 7 });
  assert.equal(JSON.stringify(hostEnded).includes('privateSelections'), false);
  assert.equal(JSON.stringify(hostEnded).includes('copyCandidates'), false);

  const hostPayload = rematchPayload(room, hostEnded, 'rematch-complete-host');
  const requested = await room.host.call('moonScaleDuelRequestRematch', hostPayload);
  assert.equal(requested.started, false);
  assert.deepEqual(await room.host.call('moonScaleDuelRequestRematch', hostPayload), requested);
  await denied(room.host.call('moonScaleDuelRequestRematch', { ...hostPayload, stateVersion: hostPayload.stateVersion + 1 }), 'functions/already-exists');
  const waiting = await room.guest.call('moonScaleDuelGetSnapshot', { roomId: room.roomId });
  assert.deepEqual(waiting.game.rematchReady, { seat1: true, seat2: false });
  assert.equal(waiting.game.gameId, room.started.gameId);
  await denied(room.guest.call('moonScaleDuelRequestRematch', rematchPayload(room, waiting, 'rematch-stale-version', {
    stateVersion: waiting.game.stateVersion - 1,
  })), 'functions/failed-precondition');

  const outsider = client('rematch-complete-outsider');
  await signInAnonymously(outsider.auth);
  await denied(outsider.call('moonScaleDuelRequestRematch', rematchPayload(room, waiting, 'rematch-outsider')), 'functions/permission-denied');
  const started = await room.guest.call('moonScaleDuelRequestRematch', rematchPayload(room, waiting, 'rematch-complete-guest'));
  assert.equal(started.started, true);
  assert.notEqual(started.gameId, room.started.gameId);

  const [hostNew, guestNew, oldGame, newServer, roomDoc] = await Promise.all([
    room.host.call('moonScaleDuelGetSnapshot', { roomId: room.roomId }),
    room.guest.call('moonScaleDuelGetSnapshot', { roomId: room.roomId }),
    adminDb.doc(`moonScaleDuelRooms/${room.roomId}/games/${room.started.gameId}`).get(),
    adminDb.doc(`moonScaleDuelRooms/${room.roomId}/serverGames/${started.gameId}`).get(),
    adminDb.doc(`moonScaleDuelRooms/${room.roomId}`).get(),
  ]);
  assert.deepEqual(publicPart(hostNew), publicPart(guestNew));
  assert.equal(hostNew.game.gameId, started.gameId);
  assert.equal(hostNew.game.round, 1);
  assert.equal(hostNew.game.phase, 'selecting-card');
  assert.deepEqual(hostNew.game.moonShadow, { seat1: 10, seat2: 10 });
  assert.deepEqual(hostNew.game.remainingCardCounts, { seat1: 6, seat2: 6 });
  assert.deepEqual(hostNew.game.history, []);
  assert.equal(hostNew.game.publicCards, null);
  assert.equal(hostNew.game.publicCopies, null);
  assert.equal(hostNew.game.roundResult, null);
  assert.deepEqual(hostNew.game.nextRoundReady, { seat1: false, seat2: false });
  assert.deepEqual(hostNew.game.rematchReady, { seat1: false, seat2: false });
  assert.equal(hostNew.game.deadlineMillis, null);
  assert.equal(hostNew.game.result, null);
  assert.deepEqual(hostNew.private.usedCards, []);
  assert.equal(hostNew.private.submitted, false);
  assert.equal(hostNew.private.selectedCardId, null);
  assert.deepEqual(hostNew.private.legalCopyTargets, []);
  assert.equal(hostNew.private.copySubmitted, false);
  assert.equal(hostNew.private.selectedCopyTarget, null);
  assert.equal(oldGame.data().result.outcome, 'seat1');
  assert.equal(newServer.data().gameId, started.gameId);
  assert.deepEqual(newServer.data().usedCards, { seat1: [], seat2: [] });
  assert.deepEqual(newServer.data().history, []);
  assert.equal(roomDoc.data().gameId, started.gameId);
  assert.equal(roomDoc.data().humanCount, 2);
  assert.equal(hostNew.seats.length, 2);
  await denied(room.host.call('moonScaleDuelRequestRematch', { ...hostPayload, requestId: 'old-game-rematch' }), 'functions/failed-precondition');
  await denied(room.host.call('moonScaleDuelSubmitCard', {
    roomId: room.roomId, gameId: room.started.gameId, round: 1, stateVersion: hostEnded.game.stateVersion,
    cardId: 'waxing', requestId: 'old-game-submit',
  }), 'functions/failed-precondition');

  await room.host.call('moonScaleDuelSubmitCard', {
    roomId: room.roomId, gameId: started.gameId, round: 1, stateVersion: started.stateVersion,
    cardId: 'waxing', requestId: 'new-game-submit-host',
  });
  const guestPrivate = await room.guest.call('moonScaleDuelGetSnapshot', { roomId: room.roomId });
  assert.equal(guestPrivate.game.publicCards, null);
  assert.equal(guestPrivate.private.submitted, false);
});

test('rematch cancellation is idempotent, rejects aborted games, and races safely with consent', { timeout: 120000 }, async () => {
  const room = await startedRoom('rematch-cancel');
  await forceCompleted(room, 'draw', { seat1: 10, seat2: 10 });
  const ended = await room.host.call('moonScaleDuelGetSnapshot', { roomId: room.roomId });
  await room.host.call('moonScaleDuelRequestRematch', rematchPayload(room, ended, 'rematch-cancel-request'));
  const cancelPayload = rematchPayload(room, ended, 'rematch-cancel-once');
  const cancelled = await room.host.call('moonScaleDuelCancelRematch', cancelPayload);
  assert.equal(cancelled.cancelled, true);
  assert.deepEqual(await room.host.call('moonScaleDuelCancelRematch', cancelPayload), cancelled);
  await denied(room.host.call('moonScaleDuelCancelRematch', { ...cancelPayload, gameId: 'another-game' }), 'functions/already-exists');
  await denied(room.host.call('moonScaleDuelCancelRematch', { ...cancelPayload, requestId: 'cancel-when-clear' }), 'functions/failed-precondition');
  assert.deepEqual((await room.host.call('moonScaleDuelGetSnapshot', { roomId: room.roomId })).game.rematchReady, { seat1: false, seat2: false });

  await room.host.call('moonScaleDuelRequestRematch', rematchPayload(room, ended, 'rematch-race-host'));
  await Promise.allSettled([
    room.host.call('moonScaleDuelCancelRematch', rematchPayload(room, ended, 'rematch-race-cancel')),
    room.guest.call('moonScaleDuelRequestRematch', rematchPayload(room, ended, 'rematch-race-guest')),
  ]);
  const final = await room.host.call('moonScaleDuelGetSnapshot', { roomId: room.roomId });
  assert.ok(
    (final.game.phase === 'selecting-card' && final.game.gameId !== room.started.gameId)
    || (final.game.phase === 'ended' && final.game.gameId === room.started.gameId && final.game.rematchReady.seat1 === false),
  );

  const abortedRoom = await startedRoom('rematch-aborted');
  await denied(abortedRoom.host.call('moonScaleDuelRequestRematch', {
    roomId: abortedRoom.roomId, gameId: abortedRoom.started.gameId,
    stateVersion: abortedRoom.started.stateVersion, requestId: 'rematch-before-end',
  }), 'functions/failed-precondition');
  await Promise.all([
    adminDb.doc(`moonScaleDuelRooms/${abortedRoom.roomId}`).update({ status: 'aborted' }),
    adminDb.doc(`moonScaleDuelRooms/${abortedRoom.roomId}/games/${abortedRoom.started.gameId}`).update({ phase: 'aborted', result: { type: 'aborted', reason: 'next-round-timeout', round: 1 } }),
    adminDb.doc(`moonScaleDuelRooms/${abortedRoom.roomId}/serverGames/${abortedRoom.started.gameId}`).update({ phase: 'aborted' }),
  ]);
  const aborted = await abortedRoom.host.call('moonScaleDuelGetSnapshot', { roomId: abortedRoom.roomId });
  await denied(abortedRoom.host.call('moonScaleDuelRequestRematch', rematchPayload(abortedRoom, aborted, 'rematch-aborted-request')), 'functions/failed-precondition');
});

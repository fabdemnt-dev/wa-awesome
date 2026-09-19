import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInAnonymously } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { getFirestore, connectFirestoreEmulator, doc, getDoc, terminate } from 'firebase/firestore';
import { createRequire } from 'node:module';

const functionRequire = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp: initializeAdminApp, getApps: getAdminApps, deleteApp: deleteAdminApp } = functionRequire('firebase-admin/app');
const { getFirestore: getAdminFirestore } = functionRequire('firebase-admin/firestore');
let ownedAdminApp = null;
if (!getAdminApps().length) ownedAdminApp = initializeAdminApp({ projectId: 'demo-deep-mining-agreement' });
const adminDb = getAdminFirestore();

let serial = 0;
async function client(label) {
  const app = initializeApp({ projectId: 'demo-deep-mining-agreement', apiKey: 'demo', appId: `demo-${label}-${serial += 1}` }, `dma-${label}-${serial}`);
  const auth = getAuth(app); const firestore = getFirestore(app); const functions = getFunctions(app, 'asia-northeast1');
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(firestore, '127.0.0.1', 8080);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  await signInAnonymously(auth);
  return { app, auth, firestore, call: (name, data) => httpsCallable(functions, name)(data).then((response) => response.data) };
}
const rid = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll('-', '_')}`;
async function denied(promise, code) { await assert.rejects(promise, (error) => String(error.code).endsWith(code)); }
async function assertMemberExpiryMatchesRoom(roomId, uids) {
  const room = await adminDb.doc(`deepMiningAgreementRooms/${roomId}`).get();
  const members = await Promise.all(uids.map((uid) => adminDb.doc(`deepMiningAgreementRooms/${roomId}/deepMiningAgreementMembers/${uid}`).get()));
  assert.equal(room.exists, true);
  assert.equal(typeof room.data().expiresAt?.toMillis, 'function');
  for (const member of members) {
    assert.equal(member.exists, true);
    assert.equal(member.data().expiresAt.toMillis(), room.data().expiresAt.toMillis());
  }
}

test.after(async () => { if (ownedAdminApp) await deleteAdminApp(ownedAdminApp); });

test('legacy playerCount clients can create rooms against the new Functions', async () => {
  const host = await client('legacy-create');
  try {
    const created = await host.call('deepMiningAgreementCreateRoom', {
      displayName: 'Legacy Host',
      playerCount: 2,
      requestId: rid('legacy-create'),
    });
    const snapshot = await host.call('deepMiningAgreementGetSnapshot', { roomId: created.roomId });
    assert.equal(snapshot.room.humanPlayerCount, 2);
    assert.equal(snapshot.room.playerCount, 2);
  } finally {
    await terminate(host.firestore);
    await deleteApp(host.app);
  }
});

for (const count of [2, 3, 4]) {
  test(`${count} players create, join, start, recover, and finish`, async () => {
    const clients = await Promise.all(Array.from({ length: count + 1 }, (_, i) => client(`${count}-${i}`)));
    try {
      const host = clients[0]; const created = await host.call('deepMiningAgreementCreateRoom', { displayName: 'Host', humanPlayerCount: count, requestId: rid('create') });
      await assertMemberExpiryMatchesRoom(created.roomId, [host.auth.currentUser.uid]);
      await denied(host.call('deepMiningAgreementStartGame', { roomId: created.roomId, stateVersion: 1, requestId: rid('early') }), 'failed-precondition');
      for (let index = 1; index < count; index += 1) await clients[index].call('deepMiningAgreementJoinRoom', { displayName: `P${index + 1}`, inviteCode: created.inviteCode, requestId: rid(`join${index}`) });
      await assertMemberExpiryMatchesRoom(created.roomId, clients.slice(0, count).map(({ auth }) => auth.currentUser.uid));
      await denied(clients[count].call('deepMiningAgreementJoinRoom', { displayName: 'Overflow', inviteCode: created.inviteCode, requestId: rid('overflow') }), 'resource-exhausted');
      let snapshot = await host.call('deepMiningAgreementGetSnapshot', { roomId: created.roomId });
      await host.call('deepMiningAgreementStartGame', { roomId: created.roomId, stateVersion: snapshot.room.stateVersion, requestId: rid('start') });
      await assertMemberExpiryMatchesRoom(created.roomId, clients.slice(0, count).map(({ auth }) => auth.currentUser.uid));
      const recovered = await clients[1].call('deepMiningAgreementGetSnapshot', { roomId: created.roomId });
      assert.equal(recovered.room.status, 'playing');
      assert.equal(recovered.room.humanPlayerCount, count);
      assert.equal(recovered.game.players.length, 4);
      assert.equal(recovered.game.players.filter((player) => player.isHuman).length, count);
      assert.equal(recovered.game.players.filter((player) => !player.isHuman).length, 4 - count);
      assert.deepEqual(recovered.game.players.filter((player) => !player.isHuman).map((player) => player.name), ['ミナト', 'ガク', 'シオン'].slice(count - 1));
      assert.equal(recovered.game.players.every((player) => player.secretOre == null), true);
      assert.equal(recovered.game.players.every((player) => player.vaultOre == null), true);
      const recoveredAgain = await clients[1].call('deepMiningAgreementGetSnapshot', { roomId: created.roomId });
      assert.equal(recoveredAgain.self.seatId, recovered.self.seatId);
      assert.equal(clients[1].auth.currentUser.uid.length > 0, true);
      await denied(getDoc(doc(clients[1].firestore, `deepMiningAgreementRooms/${created.roomId}`)), 'permission-denied');
      await denied(getDoc(doc(clients[1].firestore, `deepMiningAgreementRooms/${created.roomId}/deepMiningAgreementMembers/${clients[0].auth.currentUser.uid}`)), 'permission-denied');
      await denied(clients[count].call('deepMiningAgreementSubmitAction', { roomId: created.roomId, gameId: recovered.game.gameId, round: 1, stateVersion: recovered.room.stateVersion, action: 'mine', requestId: rid('outsider') }), 'permission-denied');
      let duplicatePayload;
      for (let round = 1; round <= 8; round += 1) {
        const roundStart = await host.call('deepMiningAgreementGetSnapshot', { roomId: created.roomId });
        const activeSeatIds = roundStart.game.players.filter((player) => player.active).map((player) => player.id).sort();
        for (let index = 0; index < count; index += 1) {
          snapshot = await clients[index].call('deepMiningAgreementGetSnapshot', { roomId: created.roomId });
          const action = round === 3 && index === 0 ? 'secret' : 'reinforce';
          const payload = { roomId: created.roomId, gameId: snapshot.game.gameId, round, stateVersion: snapshot.room.stateVersion, action, scout: false, accusationTarget: null, requestId: rid(`r${round}p${index}`) };
          const result = await clients[index].call('deepMiningAgreementSubmitAction', payload);
          if (round === 1 && index === 0) {
            duplicatePayload = payload;
            assert.deepEqual(await clients[index].call('deepMiningAgreementSubmitAction', payload), result);
            await denied(clients[index].call('deepMiningAgreementSubmitAction', { ...payload, action: 'mine' }), 'already-exists');
          }
          if (index < count - 1) {
            const waiting = await clients[index].call('deepMiningAgreementGetSnapshot', { roomId: created.roomId });
            assert.equal(waiting.game.round, round);
            assert.equal(waiting.game.submittedSeatIds.every((seatId) => Number(seatId.slice(4)) <= count), true);
          }
          if (round === 3 && index === 0) {
            const otherPlayerView = await clients[1].call('deepMiningAgreementGetSnapshot', { roomId: created.roomId });
            assert.deepEqual(otherPlayerView.game.submittedSeatIds, ['seat1']);
            assert.equal(otherPlayerView.game.history.length, 2);
            assert.equal(otherPlayerView.game.players.every((player) => player.secretOre == null), true);
            assert.equal(otherPlayerView.game.players.every((player) => player.vaultOre == null), true);
            assert.equal(Object.hasOwn(otherPlayerView.game, 'submissions'), false);
            assert.equal(otherPlayerView.game.history.some((entry) => Object.values(entry.publicActions).includes('secret')), false);
          }
        }
        if (round === 3) {
          const resolved = await clients[1].call('deepMiningAgreementGetSnapshot', { roomId: created.roomId });
          assert.equal(resolved.game.history[2].publicActions.seat1, 'mine');
          assert.ok(resolved.game.history[2].secretCount >= 1);
          assert.equal(Object.values(resolved.game.history[2].publicActions).includes('secret'), false);
          assert.equal(resolved.game.players.every((player) => player.secretOre == null), true);
          assert.equal(resolved.game.selfPrivate.secretOre[resolved.game.history[2].oreId], 0);
        }
        const afterRound = await host.call('deepMiningAgreementGetSnapshot', { roomId: created.roomId });
        const record = afterRound.game.history[round - 1];
        assert.deepEqual(Object.keys(record.publicActions).sort(), activeSeatIds);
        assert.deepEqual([...record.submittedSeatIds].sort(), activeSeatIds);
      }
      snapshot = await host.call('deepMiningAgreementGetSnapshot', { roomId: created.roomId });
      await assertMemberExpiryMatchesRoom(created.roomId, clients.slice(0, count).map(({ auth }) => auth.currentUser.uid));
      assert.equal(snapshot.game.ended, true);
      assert.equal(snapshot.game.endReason, 'rounds');
      assert.equal(snapshot.game.history.length, 8);
      assert.equal(snapshot.game.players[0].secretActions, 1);
      assert.equal(typeof snapshot.game.players[0].secretOre[snapshot.game.history[2].oreId], 'number');
      assert.ok(snapshot.game.players.every((player) => Number.isInteger(player.rank)));
      await denied(host.call('deepMiningAgreementSubmitAction', { ...duplicatePayload, requestId: rid('after-end'), round: 8 }), 'failed-precondition');
    } finally {
      await Promise.allSettled(clients.map(({ firestore }) => terminate(firestore)));
      await Promise.all(clients.map(({ app }) => deleteApp(app)));
    }
  });
}

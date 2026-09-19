import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInAnonymously } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { getFirestore, connectFirestoreEmulator, doc, getDoc, terminate } from 'firebase/firestore';

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

for (const count of [2, 3, 4]) {
  test(`${count} players create, join, start, recover, and finish`, async () => {
    const clients = await Promise.all(Array.from({ length: count + 1 }, (_, i) => client(`${count}-${i}`)));
    try {
      const host = clients[0]; const created = await host.call('deepMiningAgreementCreateRoom', { displayName: 'Host', playerCount: count, requestId: rid('create') });
      await denied(host.call('deepMiningAgreementStartGame', { roomId: created.roomId, stateVersion: 1, requestId: rid('early') }), 'failed-precondition');
      for (let index = 1; index < count; index += 1) await clients[index].call('deepMiningAgreementJoinRoom', { displayName: `P${index + 1}`, inviteCode: created.inviteCode, requestId: rid(`join${index}`) });
      await denied(clients[count].call('deepMiningAgreementJoinRoom', { displayName: 'Overflow', inviteCode: created.inviteCode, requestId: rid('overflow') }), 'resource-exhausted');
      let snapshot = await host.call('deepMiningAgreementGetSnapshot', { roomId: created.roomId });
      await host.call('deepMiningAgreementStartGame', { roomId: created.roomId, stateVersion: snapshot.room.stateVersion, requestId: rid('start') });
      const recovered = await clients[1].call('deepMiningAgreementGetSnapshot', { roomId: created.roomId });
      assert.equal(recovered.room.status, 'playing');
      assert.equal(recovered.game.players.length, count);
      assert.equal(recovered.game.players.every((player) => player.secretOre == null), true);
      assert.equal(recovered.game.players.every((player) => player.vaultOre == null), true);
      const recoveredAgain = await clients[1].call('deepMiningAgreementGetSnapshot', { roomId: created.roomId });
      assert.equal(recoveredAgain.self.seatId, recovered.self.seatId);
      assert.equal(clients[1].auth.currentUser.uid.length > 0, true);
      await denied(getDoc(doc(clients[1].firestore, `deepMiningAgreementRooms/${created.roomId}`)), 'permission-denied');
      await denied(getDoc(doc(clients[1].firestore, `deepMiningAgreementRooms/${created.roomId}/members/${clients[0].auth.currentUser.uid}`)), 'permission-denied');
      await denied(clients[count].call('deepMiningAgreementSubmitAction', { roomId: created.roomId, gameId: recovered.game.gameId, round: 1, stateVersion: recovered.room.stateVersion, action: 'mine', requestId: rid('outsider') }), 'permission-denied');
      let duplicatePayload;
      for (let round = 1; round <= 8; round += 1) {
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
          assert.equal(resolved.game.history[2].secretCount, 1);
          assert.equal(resolved.game.players.every((player) => player.secretOre == null), true);
          assert.equal(resolved.game.selfPrivate.secretOre[resolved.game.history[2].oreId], 0);
        }
      }
      snapshot = await host.call('deepMiningAgreementGetSnapshot', { roomId: created.roomId });
      assert.equal(snapshot.game.ended, true);
      assert.equal(snapshot.game.endReason, 'rounds');
      assert.equal(snapshot.game.history.length, 8);
      assert.equal(snapshot.game.players[0].secretActions, 1);
      assert.equal(snapshot.game.players[0].secretOre[snapshot.game.history[2].oreId], 1);
      await denied(host.call('deepMiningAgreementSubmitAction', { ...duplicatePayload, requestId: rid('after-end'), round: 8 }), 'failed-precondition');
    } finally {
      await Promise.allSettled(clients.map(({ firestore }) => terminate(firestore)));
      await Promise.all(clients.map(({ app }) => deleteApp(app)));
    }
  });
}

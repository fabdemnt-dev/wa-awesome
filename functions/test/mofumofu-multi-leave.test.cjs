'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  test('Multi leave Firestore transaction', { skip: 'Firestore Emulatorが必要' }, () => {});
} else {
  process.env.MOFUMOFU_DIRECT_HANDLERS = '1';
  const { getFirestore } = require('firebase-admin/firestore');
  const multi = require('../mofumofu-multi');
  const { COLLECTIONS, publicRoomViolations } = multi._test.contract;
  const { createHandler, joinHandler, startHandler, makeOfferHandler, judgeOfferHandler, leaveGameHandler } = multi._handlers;
  const db = getFirestore();
  const req = (uid, data) => ({ auth: uid ? { uid } : null, data, rawRequest: { ip: '198.51.100.91' } });
  const code = async (work, expected) => assert.rejects(work, (error) => error.code === expected);
  const roomRef = (id) => db.collection(COLLECTIONS.rooms).doc(id);
  async function createGame(count) {
    const uids = Array.from({ length: count }, (_, i) => `multi-leave-${crypto.randomUUID()}-${i}`);
    const created = await createHandler(req(uids[0], { actionId: crypto.randomUUID() }));
    for (let i = 1; i < count; i += 1) {
      await joinHandler(req(uids[i], { inviteCode: created.inviteCode, actionId: crypto.randomUUID() }));
    }
    await startHandler(req(uids[0], { roomId: created.roomId, actionId: crypto.randomUUID() }));
    return { uids, roomId: created.roomId, ref: roomRef(created.roomId) };
  }
  const room = async (game) => (await game.ref.get()).data();
  const hand = async (game, index) => (await game.ref.collection(COLLECTIONS.privateHands).doc(game.uids[index]).get()).data().cards;
  const server = async (game) => (await game.ref.collection(COLLECTIONS.serverState).doc('current').get()).data();
  const leave = (game, index, actionId = crypto.randomUUID()) => leaveGameHandler(req(game.uids[index], {
    roomId: game.roomId, actionId,
  }));

  test('Multi明示退出はtransactionで手札をdiscardし、現在手番を次のactive席へ移す', async () => {
    const game = await createGame(4);
    const before = await hand(game, 0);
    const result = await leave(game, 0);
    const after = await room(game);
    const secret = await server(game);
    assert.equal(result.status, 'playing');
    assert.equal(after.playerStatus.S1, 'left');
    assert.deepEqual(after.leftPlayerIds, ['S1']);
    assert.equal(after.currentTurnPlayerId, 'S2');
    assert.equal(after.handCounts.S1, 0);
    assert.deepEqual(await hand(game, 0), []);
    assert.deepEqual(secret.discard, before);
    assert.deepEqual(after.faceUpCards.S1, []);
    assert.deepEqual(publicRoomViolations(after), []);
    await code(() => leave(game, 0), 'permission-denied');
  });

  test('非手番退出は現手番を維持し、3人からはtoo-few-activeで残る2人が勝者', async () => {
    const four = await createGame(5);
    await leave(four, 4);
    assert.equal((await room(four)).currentTurnPlayerId, 'S1');
    assert.equal((await room(four)).status, 'playing');
    const three = await createGame(3);
    const result = await leave(three, 2);
    const after = await room(three);
    assert.equal(result.status, 'finished');
    assert.equal(after.finishReason, 'too-few-active');
    assert.deepEqual(after.winnerPlayerIds, ['S1', 'S2']);
    assert.deepEqual(after.leftPlayerIds, ['S3']);
    assert.equal(after.finalResult.players.find((p) => p.seatId === 'S3').status, 'left');
    assert.deepEqual(publicRoomViolations(after), []);
    await code(() => leave(three, 1), 'failed-precondition');
  });

  test('判定待ちの当事者は拒否し、非当事者の退出では秘密pendingOfferを維持する', async () => {
    const game = await createGame(4);
    const first = (await hand(game, 0))[0];
    await makeOfferHandler(req(game.uids[0], {
      roomId: game.roomId, actionId: crypto.randomUUID(), cardId: first.cardId,
      claimedAnimalType: first.animalType, targetPlayerId: 'S2',
    }));
    await code(() => leave(game, 0), 'failed-precondition');
    await code(() => leave(game, 1), 'failed-precondition');
    const pendingBefore = (await server(game)).pendingOffer;
    await leave(game, 2);
    assert.deepEqual((await server(game)).pendingOffer, pendingBefore);
    assert.equal((await room(game)).publicOffer.status, 'pending');
    await judgeOfferHandler(req(game.uids[1], {
      roomId: game.roomId, actionId: crypto.randomUUID(), judgment: 'truth',
    }));
    assert.equal((await room(game)).playerStatus.S3, 'left');
  });

  test('同一actionId再送は同じ結果を返し二重discardせず、別UID/room利用は拒否', async () => {
    const game = await createGame(4);
    const actionId = crypto.randomUUID();
    const first = await leave(game, 3, actionId);
    const discard = (await server(game)).discard;
    assert.deepEqual(await leave(game, 3, actionId), first);
    assert.deepEqual((await server(game)).discard, discard);
    await code(() => leave(game, 2, actionId), 'already-exists');
    const otherRoom = await createGame(3);
    await code(() => leaveGameHandler(req(game.uids[3], {
      roomId: otherRoom.roomId, actionId,
    })), 'already-exists');
    await code(() => leaveGameHandler(req(null, { roomId: game.roomId, actionId: crypto.randomUUID() })), 'unauthenticated');
    await code(() => leaveGameHandler(req('other-uid', { roomId: game.roomId, actionId: crypto.randomUUID() })), 'permission-denied');
    const waitingUid = 'multi-wait-' + crypto.randomUUID();
    const waiting = await createHandler(req(waitingUid, { actionId: crypto.randomUUID() }));
    await code(() => leaveGameHandler(req(waitingUid, {
      roomId: waiting.roomId, actionId: crypto.randomUUID(),
    })), 'permission-denied');
  });
}

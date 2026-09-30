'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  test('Multi host close transaction', { skip: 'Firestore Emulatorが必要' }, () => {});
} else {
  process.env.MOFUMOFU_DIRECT_HANDLERS = '1';
  const { initializeApp, getApps } = require('firebase-admin/app');
  if (!getApps().length) initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-mofumofu-multi' });
  const { getFirestore } = require('firebase-admin/firestore');
  const multi = require('../mofumofu-multi');
  const { COLLECTIONS, inviteCodeDigest } = multi._test.contract;
  const { createHandler, joinHandler, startHandler, closeWaitingHandler, leaveWaitingHandler } = multi._handlers;
  const db = getFirestore();
  const req = (uid, data) => ({ auth: uid ? { uid } : null, data, rawRequest: { ip: '198.51.100.92' } });
  const rejected = (work, code) => assert.rejects(work, (error) => error.code === code);
  async function waiting(count = 3) {
    const uids = Array.from({ length: count }, () => `multi-close-${randomUUID()}`);
    const created = await createHandler(req(uids[0], { actionId: randomUUID() }));
    for (const uid of uids.slice(1)) await joinHandler(req(uid, { inviteCode: created.inviteCode, actionId: randomUUID() }));
    const room = db.collection(COLLECTIONS.rooms).doc(created.roomId);
    const secret = db.collection(COLLECTIONS.roomSecrets).doc(created.roomId);
    const invite = db.collection(COLLECTIONS.invites).doc(inviteCodeDigest(created.inviteCode));
    return { uids, created, room, secret, invite };
  }
  const close = (game, uid = game.uids[0], actionId = randomUUID()) => closeWaitingHandler(req(uid, { roomId: game.created.roomId, actionId }));

  test('host closeはroom/member/secretを消し、inviteを閉じ、同じactionIdを再生する', async () => {
    const game = await waiting(3);
    const actionId = randomUUID();
    const first = await close(game, game.uids[0], actionId);
    assert.deepEqual(first, { roomId: game.created.roomId, status: 'closed' });
    assert.equal((await game.room.get()).exists, false);
    assert.equal((await game.secret.get()).exists, false);
    assert.equal((await game.invite.get()).data().status, 'closed');
    for (const uid of game.uids) {
      assert.equal((await game.room.collection(COLLECTIONS.members).doc(uid).get()).exists, false);
      assert.equal((await game.room.collection(COLLECTIONS.privateHands).doc(uid).get()).exists, false);
    }
    assert.deepEqual(await close(game, game.uids[0], actionId), first);
    await rejected(() => close(game, game.uids[1], actionId), 'already-exists');
    await rejected(() => close(game), 'not-found');
    await rejected(() => joinHandler(req(`guest-${randomUUID()}`, { inviteCode: game.created.inviteCode, actionId: randomUUID() })), 'failed-precondition');
  });

  test('非ホスト、room外、未認証を拒否し、失敗してもroomを保持する', async () => {
    const game = await waiting(3);
    await rejected(() => close(game, game.uids[1]), 'permission-denied');
    await rejected(() => close(game, `other-${randomUUID()}`), 'permission-denied');
    await rejected(() => closeWaitingHandler(req(null, { roomId: game.created.roomId, actionId: randomUUID() })), 'unauthenticated');
    assert.equal((await game.room.get()).data().status, 'waiting');
    await leaveWaitingHandler(req(game.uids[2], { roomId: game.created.roomId, actionId: randomUUID() }));
    assert.equal((await game.room.get()).data().status, 'waiting');
  });

  test('startとcloseの競合では一方だけが成立し、開始済みroomは削除しない', async () => {
    const game = await waiting(3);
    const results = await Promise.allSettled([
      startHandler(req(game.uids[0], { roomId: game.created.roomId, actionId: randomUUID() })),
      close(game),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const snapshot = await game.room.get();
    if (results[0].status === 'fulfilled') {
      assert.equal(snapshot.data().status, 'playing');
      assert.equal((await game.room.collection(COLLECTIONS.serverState).doc('current').get()).exists, true);
      await rejected(() => close(game), 'failed-precondition');
    } else {
      assert.equal(snapshot.exists, false);
      await rejected(() => startHandler(req(game.uids[0], { roomId: game.created.roomId, actionId: randomUUID() })), 'not-found');
    }
  });

  test('playing/finished/配札済みの正本ではcloseを拒否する', async () => {
    const game = await waiting(3);
    await startHandler(req(game.uids[0], { roomId: game.created.roomId, actionId: randomUUID() }));
    await rejected(() => close(game), 'failed-precondition');
    assert.equal((await game.room.get()).exists, true);
    await game.room.update({ status: 'finished' });
    await rejected(() => close(game), 'failed-precondition');
  });
}

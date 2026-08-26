const assert = require('node:assert/strict');
const test = require('node:test');
const { getFirestore } = require('firebase-admin/firestore');
const {
  dealHaikuHands,
  redrawHaikuHand,
  submitHaikuPhrase,
  revealHaikuPhrase,
  selfPraiseHaikuPhrase,
  submitHaikuVote,
} = require('../index.js');

const db = getFirestore();

function roomRef(roomId) {
  return db.collection('rooms').doc(`haiku_${roomId}`);
}

async function seedRoom(roomId) {
  await roomRef(roomId).set({
    schemaVersion: 2,
    status: 'lobby',
    currentHost: '親',
    currentHostUid: 'uid-host',
    roundCount: 1,
    players: ['親', '参加者'],
    spectators: [],
    participantUids: {
      'uid-host': '親',
      'uid-player': '参加者',
    },
    settings: { hand5: 1, hand7: 1 },
    words5: [
      { id: 'five-1', text: '五1', author: '素材' },
      { id: 'five-2', text: '五2', author: '素材' },
      { id: 'five-3', text: '五3', author: '素材' },
      { id: 'five-4', text: '五4', author: '素材' },
    ],
    words7: [
      { id: 'seven-1', text: '七1', author: '素材' },
      { id: 'seven-2', text: '七2', author: '素材' },
      { id: 'seven-3', text: '七3', author: '素材' },
      { id: 'seven-4', text: '七4', author: '素材' },
    ],
    hands5: { legacy: ['古い手札'] },
    hands7: { legacy: ['古い手札'] },
  });
}

test('未認証Callableは拒否される', async () => {
  await assert.rejects(
    dealHaikuHands.run({ data: { roomId: 'unauthenticated' } }),
    (error) => error.code === 'unauthenticated',
  );
});

test('非親のCallableは拒否される', async () => {
  await seedRoom('non-host');
  await assert.rejects(
    dealHaikuHands.run({ data: { roomId: 'non-host' }, auth: { uid: 'uid-player' } }),
    (error) => error.code === 'permission-denied',
  );
});

test('親のCallableはUID別に配札し二重配札を拒否する', async () => {
  await seedRoom('deal-success');
  const result = await dealHaikuHands.run({
    data: { roomId: 'deal-success' },
    auth: { uid: 'uid-host' },
  });
  assert.deepEqual(result, { ok: true });

  const room = (await roomRef('deal-success').get()).data();
  assert.equal(room.status, 'playing');
  assert.equal(room.hands5, undefined);
  assert.equal(room.hands7, undefined);
  assert.equal((await roomRef('deal-success').collection('hands').doc('uid-host').get()).exists, true);
  assert.equal((await roomRef('deal-success').collection('hands').doc('uid-player').get()).exists, true);

  await assert.rejects(
    dealHaikuHands.run({
      data: { roomId: 'deal-success' },
      auth: { uid: 'uid-host' },
    }),
    (error) => error.code === 'failed-precondition',
  );
});

test('同名で再接続した最新UIDの親は旧UIDが残っていても配札できる', async () => {
  await seedRoom('duplicate-host-name');
  await roomRef('duplicate-host-name').update({
    currentHostUid: 'uid-old-host',
    participantUids: {
      'uid-old-host': '親',
      'uid-new-host': '親',
      'uid-player': '参加者',
    },
  });

  const result = await dealHaikuHands.run({
    data: { roomId: 'duplicate-host-name' },
    auth: { uid: 'uid-new-host' },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal((await roomRef('duplicate-host-name').collection('hands').doc('uid-new-host').get()).exists, true);
});

test('作品・披露・自画自賛・投票CallableはUID本人性と重複操作を検証する', async () => {
  await seedRoom('haiku-actions');
  await dealHaikuHands.run({ data: { roomId: 'haiku-actions' }, auth: { uid: 'uid-host' } });
  const hostHand = (await roomRef('haiku-actions').collection('hands').doc('uid-host').get()).data();
  const playerHand = (await roomRef('haiku-actions').collection('hands').doc('uid-player').get()).data();
  const makePhrase = (hand) => ({
    phrase: hand.hand5[0].text + ' ' + hand.hand7[0].text + ' ' + hand.hand5[0].text,
    phraseDetails: [hand.hand5[0], hand.hand7[0], hand.hand5[0]],
  });

  await submitHaikuPhrase.run({ data: { roomId: 'haiku-actions', ...makePhrase(hostHand) }, auth: { uid: 'uid-host' } });
  await assert.rejects(
    submitHaikuPhrase.run({ data: { roomId: 'haiku-actions', ...makePhrase(hostHand) }, auth: { uid: 'uid-player' } }),
    (error) => error.code === 'permission-denied',
  );
  await submitHaikuPhrase.run({ data: { roomId: 'haiku-actions', ...makePhrase(playerHand) }, auth: { uid: 'uid-player' } });
  await assert.rejects(
    submitHaikuPhrase.run({ data: { roomId: 'haiku-actions', ...makePhrase(hostHand) }, auth: { uid: 'uid-host' } }),
    (error) => error.code === 'failed-precondition',
  );

  await revealHaikuPhrase.run({ data: { roomId: 'haiku-actions', targetUid: 'uid-host' }, auth: { uid: 'uid-host' } });
  await revealHaikuPhrase.run({ data: { roomId: 'haiku-actions', targetUid: 'uid-player' }, auth: { uid: 'uid-host' } });
  await selfPraiseHaikuPhrase.run({ data: { roomId: 'haiku-actions' }, auth: { uid: 'uid-host' } });
  await submitHaikuVote.run({ data: { roomId: 'haiku-actions', targetUid: 'uid-player', evalKey: 'tae' }, auth: { uid: 'uid-host' } });
  await submitHaikuVote.run({ data: { roomId: 'haiku-actions', targetUid: 'uid-host', evalKey: 'okashi' }, auth: { uid: 'uid-player' } });
  await assert.rejects(
    submitHaikuVote.run({ data: { roomId: 'haiku-actions', targetUid: 'uid-host', evalKey: 'aware' }, auth: { uid: 'uid-player' } }),
    (error) => error.code === 'failed-precondition',
  );
});

test('本人の引き直しは成功し、他人の札と二重実行は拒否する', async () => {
  await seedRoom('redraw-success');
  await dealHaikuHands.run({
    data: { roomId: 'redraw-success' },
    auth: { uid: 'uid-host' },
  });
  const handRef = roomRef('redraw-success').collection('hands').doc('uid-host');
  const before = (await handRef.get()).data();
  const selectedId = before.hand5[0].id;

  const updatedHand = {
    ...before,
    hand5: [{ id: selectedId, text: '五1' }],
    hand7: [{ id: 'seven-selected', text: '七1' }],
  };
  await handRef.set(updatedHand);
  await roomRef('redraw-success').update({
    deck5: [{ id: 'five-drawn', text: '五2' }],
    deck7: [{ id: 'seven-drawn', text: '七2' }],
  });

  const result = await redrawHaikuHand.run({
    data: {
      roomId: 'redraw-success',
      selectedIds5: [selectedId],
      selectedIds7: [],
    },
    auth: { uid: 'uid-host' },
  });
  assert.deepEqual(result, { ok: true });
  const after = (await handRef.get()).data();
  assert.equal(after.redrawUsed, true);
  assert.deepEqual(after.hand5.map((word) => word.id), ['five-drawn']);

  await assert.rejects(
    redrawHaikuHand.run({
      data: { roomId: 'redraw-success', selectedIds5: ['not-owned'], selectedIds7: [] },
      auth: { uid: 'uid-player' },
    }),
    (error) => error.code === 'invalid-argument' || error.code === 'failed-precondition',
  );
  await assert.rejects(
    redrawHaikuHand.run({
      data: { roomId: 'redraw-success', selectedIds5: ['five-drawn'], selectedIds7: [] },
      auth: { uid: 'uid-host' },
    }),
    (error) => error.code === 'failed-precondition',
  );
});

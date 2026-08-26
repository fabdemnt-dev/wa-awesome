const assert = require('node:assert/strict');
const test = require('node:test');
const { getFirestore } = require('firebase-admin/firestore');
const { dealHaikuHands } = require('../index.js');

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
    words5: ['五1', '五2', '五3', '五4'],
    words7: ['七1', '七2', '七3', '七4'],
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

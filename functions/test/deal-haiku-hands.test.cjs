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
  submitPoemSecure,
  revealPoemSecure,
  reactPoemSecure,
  changeHaikuRole,
  submitHaikuWords,
  removeHaikuWord,
  submitPoemWords,
  removePoemWord,
  updateHaikuSettings,
  updatePoemSettings,
} = require('../index.js');

const db = getFirestore();

function roomRef(roomId) {
  return db.collection('rooms').doc(`haiku_${roomId}`);
}

function poemRoomRef(roomId) {
  return db.collection('rooms').doc(`poem_${roomId}`);
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

test('設定Callableは親限定と入力範囲を検証する', async () => {
  await roomRef('settings-actions').set({ schemaVersion: 2, status: 'lobby', currentHost: '親', currentHostUid: 'uid-host', players: ['親', '参加者'], spectators: [], participantUids: { 'uid-host': '親', 'uid-player': '参加者' }, settings: { hand5: 5, hand7: 3, carryOver: true } });
  await assert.rejects(
    updateHaikuSettings.run({ data: { roomId: 'settings-actions', hand5: 4, hand7: 2, carryOver: false }, auth: { uid: 'uid-player' } }),
    (error) => error.code === 'permission-denied',
  );
  await updateHaikuSettings.run({ data: { roomId: 'settings-actions', hand5: 4, hand7: 2, carryOver: false }, auth: { uid: 'uid-host' } });
  assert.deepEqual((await roomRef('settings-actions').get()).data().settings, { hand5: 4, hand7: 2, carryOver: false });
  await assert.rejects(
    updateHaikuSettings.run({ data: { roomId: 'settings-actions', hand5: 0, hand7: 2 }, auth: { uid: 'uid-host' } }),
    (error) => error.code === 'invalid-argument',
  );

  await poemRoomRef('settings-actions').set({ schemaVersion: 2, status: 'lobby', currentHost: '親', currentHostUid: 'uid-host', players: ['親'], spectators: [], participantUids: { 'uid-host': '親' }, settings: { handCount: 5 } });
  await updatePoemSettings.run({ data: { roomId: 'settings-actions', handCount: 8 }, auth: { uid: 'uid-host' } });
  assert.equal((await poemRoomRef('settings-actions').get()).data().settings.handCount, 8);
});

test('素材Callableは本人投稿・他人偽装拒否・本人削除を検証する', async () => {
  await roomRef('material-actions').set({
    schemaVersion: 2,
    status: 'lobby',
    players: ['親', '参加者'],
    spectators: [],
    participantUids: { 'uid-host': '親', 'uid-player': '参加者' },
    words5: [],
    words7: [],
  });
  const ownWord = { id: 'own-5', text: '自分の素材', author: '参加者' };
  await submitHaikuWords.run({ data: { roomId: 'material-actions', words5: [ownWord], words7: [] }, auth: { uid: 'uid-player' } });
  await assert.rejects(
    submitHaikuWords.run({ data: { roomId: 'material-actions', words5: [{ id: 'fake', text: '偽装', author: '親' }], words7: [] }, auth: { uid: 'uid-player' } }),
    (error) => error.code === 'permission-denied',
  );
  await removeHaikuWord.run({ data: { roomId: 'material-actions', type: '5', wordId: 'own-5' }, auth: { uid: 'uid-player' } });
  const haikuRoom = (await roomRef('material-actions').get()).data();
  assert.deepEqual(haikuRoom.words5, []);

  await poemRoomRef('material-actions').set({
    schemaVersion: 2,
    status: 'lobby',
    players: ['参加者'],
    spectators: [],
    participantUids: { 'uid-player': '参加者' },
    words: [],
  });
  const poemWord = { id: 'poem-word', text: 'ポエム素材', author: '参加者' };
  await submitPoemWords.run({ data: { roomId: 'material-actions', words: [poemWord] }, auth: { uid: 'uid-player' } });
  await removePoemWord.run({ data: { roomId: 'material-actions', wordId: 'poem-word' }, auth: { uid: 'uid-player' } });
  assert.deepEqual((await poemRoomRef('material-actions').get()).data().words, []);
});

test('Haiku途中参加Callableは同名UIDを統合してUID別手札へ配札する', async () => {
  await roomRef('role-change').set({
    schemaVersion: 2,
    status: 'playing',
    roundCount: 1,
    currentHost: '親',
    currentHostUid: 'uid-host',
    players: ['親'],
    spectators: ['参加者'],
    participantUids: { 'uid-host': '親', 'old-uid': '参加者', 'uid-player': '参加者' },
    settings: { hand5: 1, hand7: 1 },
    deck5: [{ id: 'new-5', text: '五', author: '🎴お題ぶくろ' }],
    deck7: [{ id: 'new-7', text: '七', author: '🎴お題ぶくろ' }],
    hands: {},
  });
  await changeHaikuRole.run({ data: { roomId: 'role-change', role: 'player' }, auth: { uid: 'uid-player' } });
  const room = (await roomRef('role-change').get()).data();
  const hand = (await roomRef('role-change').collection('hands').doc('uid-player').get()).data();
  assert.deepEqual(room.players, ['親', '参加者']);
  assert.deepEqual(room.spectators, []);
  assert.equal(room.participantUids['old-uid'], undefined);
  assert.equal(hand.hand5[0].id, 'new-5');
  assert.equal(hand.hand7[0].id, 'new-7');
});

test('Poem作品・披露・リアクションCallableはUIDと状態を検証する', async () => {
  await poemRoomRef('poem-actions').set({
    schemaVersion: 2,
    status: 'playing',
    roundCount: 1,
    currentHost: '親',
    players: ['親', '参加者'],
    spectators: ['見学者'],
    participantUids: { 'uid-host': '親', 'uid-player': '参加者', 'uid-spectator': '見学者' },
    hands: {
      'uid-host': [{ id: 'h1', text: '親の素材', author: '親' }],
      'uid-player': [{ id: 'p1', text: '参加者の素材', author: '参加者' }],
    },
    poems: {},
  });
  const poem = { text: '親の作品', usedHands: [{ id: 'h1', text: '親の素材', author: '親' }] };
  await submitPoemSecure.run({ data: { roomId: 'poem-actions', ...poem }, auth: { uid: 'uid-host' } });
  await assert.rejects(
    submitPoemSecure.run({ data: { roomId: 'poem-actions', text: '偽装作品', usedHands: poem.usedHands }, auth: { uid: 'uid-player' } }),
    (error) => error.code === 'permission-denied',
  );
  await submitPoemSecure.run({ data: { roomId: 'poem-actions', text: '参加者の作品', usedHands: [{ id: 'p1', text: '参加者の素材', author: '参加者' }] }, auth: { uid: 'uid-player' } });
  await assert.rejects(
    reactPoemSecure.run({ data: { roomId: 'poem-actions', targetUid: 'uid-player', type: 'like' }, auth: { uid: 'uid-spectator' } }),
    (error) => error.code === 'failed-precondition',
  );
  await revealPoemSecure.run({ data: { roomId: 'poem-actions', targetUid: 'uid-player' }, auth: { uid: 'uid-host' } });
  await reactPoemSecure.run({ data: { roomId: 'poem-actions', targetUid: 'uid-player', type: 'like' }, auth: { uid: 'uid-spectator' } });
  const saved = (await poemRoomRef('poem-actions').get()).data();
  assert.equal(saved.poems['uid-player'].revealed, true);
  assert.equal(saved.poems['uid-player'].likes, 1);
});

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

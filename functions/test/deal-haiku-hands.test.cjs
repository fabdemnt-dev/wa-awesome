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
  supplementHaikuWords,
  removeHaikuWord,
  removePlayer,
  submitPoemWords,
  removePoemWord,
  updateHaikuSettings,
  updatePoemSettings,
  advanceHaikuRound,
  dealPoemHands,
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

test('Poem配札Callableは親だけがUID別手札へ配札できる', async () => {
  await poemRoomRef('poem-deal').set({
    schemaVersion: 2, status: 'lobby', roundCount: 1, currentHost: '親', currentHostUid: 'uid-host',
    players: ['親', '参加者'], spectators: [], participantUids: { 'uid-host': '親', 'uid-player': '参加者' },
    settings: { handCount: 2 }, words: [
      { id: 'p1', text: '一', author: '親' }, { id: 'p2', text: '二', author: '参加者' },
      { id: 'p3', text: '三', author: '親' }, { id: 'p4', text: '四', author: '参加者' },
    ], poems: {},
  });
  await assert.rejects(
    dealPoemHands.run({ data: { roomId: 'poem-deal' }, auth: { uid: 'uid-player' } }),
    (error) => error.code === 'permission-denied',
  );
  const result = await dealPoemHands.run({ data: { roomId: 'poem-deal' }, auth: { uid: 'uid-host' } });
  const room = (await poemRoomRef('poem-deal').get()).data();
  assert.equal(result.handCount, 2);
  assert.equal(room.status, 'playing');
  assert.equal(room.hands['uid-host'].length, 2);
  assert.equal(room.hands['uid-player'].length, 2);
});

test('Haiku次節Callableは得点・履歴・親交代・素材持越しを一括処理する', async () => {
  await roomRef('advance-round').set({
    schemaVersion: 2, status: 'playing', roundCount: 1, currentHost: '親', currentHostUid: 'uid-host',
    players: ['親', '参加者'], spectators: ['見学者'],
    participantUids: { 'uid-host': '親', 'uid-player': '参加者', 'uid-spectator': '見学者' },
    settings: { hand5: 1, hand7: 1, carryOver: true },
    words5: [{ id: 'user-word', text: '持越し', author: '参加者' }, { id: 'default-word', text: '補充', author: '🎴お題ぶくろ' }],
    words7: [], phrases: { 'uid-player': '作品' }, phraseDetails: {},
    votes: { 'uid-host': { 'uid-player': ['tae'] }, 'uid-spectator': { 'uid-player': ['kanpu'] } }, scores: { '参加者': 0 },
  });
  const result = await advanceHaikuRound.run({ data: { roomId: 'advance-round' }, auth: { uid: 'uid-host' } });
  const room = (await roomRef('advance-round').get()).data();
  const history = await roomRef('advance-round').collection('history').get();
  assert.equal(result.nextRound, 2);
  assert.equal(result.nextHost, '参加者');
  assert.equal(room.status, 'lobby');
  assert.equal(room.currentHostUid, 'uid-player');
  assert.equal(room.scores['参加者'], 10);
  assert.deepEqual(room.words5.map((word) => word.id), ['user-word']);
  assert.equal(history.size, 1);
  const historyEntry = history.docs[0].data();
  assert.deepEqual(historyEntry.scoreDeltas, { '参加者': 10 });
  assert.deepEqual(historyEntry.scoresAfter, { '参加者': 10 });
  assert.deepEqual(historyEntry.playerNames, ['親', '参加者']);
  assert.deepEqual(historyEntry.spectatorNames, ['見学者']);
});

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

test('Haiku補充Callableはプレイヤーだけが実行できる', async () => {
  await roomRef('supplement-actions').set({
    schemaVersion: 2,
    status: 'lobby',
    currentHost: '親',
    currentHostUid: 'uid-host',
    players: ['親', '参加者'],
    spectators: ['見学者'],
    participantUids: { 'uid-host': '親', 'uid-player': '参加者', 'uid-spectator': '見学者' },
    settings: { hand5: 1, hand7: 1 },
    words5: [],
    words7: [],
  });
  const words5 = [1, 2, 3, 4].map((id) => ({ id: `supp-5-${id}`, text: `五${id}`, author: '🎴お題ぶくろ' }));
  const words7 = [1, 2, 3, 4].map((id) => ({ id: `supp-7-${id}`, text: `七${id}`, author: '🎴お題ぶくろ' }));
  await assert.rejects(
    supplementHaikuWords.run({ data: { roomId: 'supplement-actions', words5, words7 }, auth: { uid: 'uid-spectator' } }),
    (error) => error.code === 'permission-denied',
  );
  await supplementHaikuWords.run({ data: { roomId: 'supplement-actions', words5, words7 }, auth: { uid: 'uid-player' } });
  const room = (await roomRef('supplement-actions').get()).data();
  assert.equal(room.words5.length, 4);
  assert.equal(room.words7.length, 4);
});

test('Haiku鯖落ちはルーム参加中の親・子・見学者がUID指定で実行できる', async () => {
  await roomRef('remove-member-actions').set({
    schemaVersion: 2,
    status: 'lobby',
    currentHost: '親',
    currentHostUid: 'uid-host',
    players: ['親', '参加者'],
    spectators: ['見学者', '見学2'],
    participantUids: {
      'uid-host': '親',
      'uid-player': '参加者',
      'uid-spectator': '見学者',
      'uid-spectator-2': '見学2',
    },
  });

  await removePlayer.run({ data: { roomId: 'remove-member-actions', game: 'haiku', targetUid: 'uid-host' }, auth: { uid: 'uid-player' } });
  let room = (await roomRef('remove-member-actions').get()).data();
  assert.deepEqual(room.players, ['参加者']);
  assert.equal(room.currentHost, null);
  assert.equal(room.currentHostUid, null);

  await removePlayer.run({ data: { roomId: 'remove-member-actions', game: 'haiku', targetUid: 'uid-player' }, auth: { uid: 'uid-spectator' } });
  room = (await roomRef('remove-member-actions').get()).data();
  assert.deepEqual(room.players, []);

  await removePlayer.run({ data: { roomId: 'remove-member-actions', game: 'haiku', targetUid: 'uid-spectator' }, auth: { uid: 'uid-spectator-2' } });
  room = (await roomRef('remove-member-actions').get()).data();
  assert.deepEqual(room.spectators, ['見学2']);

  await assert.rejects(
    removePlayer.run({ data: { roomId: 'remove-member-actions', game: 'haiku', targetUid: 'uid-spectator-2' }, auth: { uid: 'uid-outsider' } }),
    (error) => error.code === 'permission-denied',
  );
  await assert.rejects(
    removePlayer.run({ data: { roomId: 'remove-member-actions', game: 'haiku', targetUid: 'uid-spectator-2' }, auth: null }),
    (error) => error.code === 'unauthenticated',
  );
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
  const result = await changeHaikuRole.run({ data: { roomId: 'role-change', role: 'player' }, auth: { uid: 'uid-player' } });
  const room = (await roomRef('role-change').get()).data();
  const hand = (await roomRef('role-change').collection('hands').doc('uid-player').get()).data();
  assert.equal(result.joinedRound, true);
  assert.deepEqual(room.players, ['親', '参加者']);
  assert.deepEqual(room.spectators, []);
  assert.equal(room.participantUids['old-uid'], undefined);
  assert.deepEqual(room.roundPlayerUids, ['uid-host', 'uid-player']);
  assert.equal(hand.hand5[0].id, 'new-5');
  assert.equal(hand.hand7[0].id, 'new-7');
});

test('Haiku元プレイヤーの見学者復帰は手札・句・披露・自画自賛・御印を維持する', async () => {
  await roomRef('role-return').set({
    schemaVersion: 2,
    status: 'playing',
    roundCount: 1,
    currentHost: '親',
    currentHostUid: 'uid-host',
    players: ['親', '参加者'],
    spectators: [],
    participantUids: { 'uid-host': '親', 'uid-player': '参加者' },
    roundPlayerUids: ['uid-host', 'uid-player'],
    roundPlayerNames: { 'uid-host': '親', 'uid-player': '参加者' },
    settings: { hand5: 1, hand7: 1 },
    deck5: [{ id: 'deck-5', text: '山札五', author: '🎴お題ぶくろ' }],
    deck7: [{ id: 'deck-7', text: '山札七', author: '🎴お題ぶくろ' }],
    phrases: { 'uid-player': '参加者の句' },
    phraseDetails: { 'uid-player': [{ id: 'hand-5', text: '五', author: '🎴お題ぶくろ' }] },
    revealedPhrases: { 'uid-player': true },
    selfPraise: { 'uid-player': true },
    votes: { 'uid-host': { 'uid-player': 'okashi' } },
    voteRoles: { 'uid-host': 'host' },
  });
  await roomRef('role-return').collection('hands').doc('uid-player').set({
    hand5: [{ id: 'hand-5', text: '五', author: '🎴お題ぶくろ' }],
    hand7: [{ id: 'hand-7', text: '七', author: '🎴お題ぶくろ' }],
    redrawUsed: true,
    round: 1,
  });

  await changeHaikuRole.run({ data: { roomId: 'role-return', role: 'spectator' }, auth: { uid: 'uid-player' } });
  const spectatorRoom = (await roomRef('role-return').get()).data();
  assert.deepEqual(spectatorRoom.players, ['親']);
  assert.deepEqual(spectatorRoom.spectators, ['参加者']);
  assert.deepEqual(spectatorRoom.roundPlayerUids, ['uid-host', 'uid-player']);

  const result = await changeHaikuRole.run({ data: { roomId: 'role-return', role: 'player' }, auth: { uid: 'uid-player' } });
  const restoredRoom = (await roomRef('role-return').get()).data();
  const restoredHand = (await roomRef('role-return').collection('hands').doc('uid-player').get()).data();
  assert.equal(result.joinedRound, false);
  assert.deepEqual(restoredRoom.players, ['親', '参加者']);
  assert.deepEqual(restoredRoom.spectators, []);
  assert.deepEqual(restoredRoom.deck5, [{ id: 'deck-5', text: '山札五', author: '🎴お題ぶくろ' }]);
  assert.deepEqual(restoredRoom.deck7, [{ id: 'deck-7', text: '山札七', author: '🎴お題ぶくろ' }]);
  assert.equal(restoredRoom.phrases['uid-player'], '参加者の句');
  assert.equal(restoredRoom.revealedPhrases['uid-player'], true);
  assert.equal(restoredRoom.selfPraise['uid-player'], true);
  assert.equal(restoredRoom.votes['uid-host']['uid-player'], 'okashi');
  assert.deepEqual(restoredHand.hand5, [{ id: 'hand-5', text: '五', author: '🎴お題ぶくろ' }]);
  assert.equal(restoredHand.redrawUsed, true);
});

test('Haiku同名・別UIDの再接続は旧UIDの今節状態を新UIDへ移行する', async () => {
  await roomRef('uid-migration').set({
    schemaVersion: 2,
    status: 'playing',
    roundCount: 1,
    currentHost: '親',
    currentHostUid: 'uid-host',
    players: ['親'],
    spectators: ['参加者'],
    participantUids: { 'uid-host': '親', 'uid-old': '参加者', 'uid-new': '参加者' },
    roundPlayerUids: ['uid-host', 'uid-old'],
    roundPlayerNames: { 'uid-host': '親', 'uid-old': '参加者' },
    settings: { hand5: 1, hand7: 1 },
    deck5: [{ id: 'keep-5', text: '残五', author: '🎴お題ぶくろ' }],
    deck7: [{ id: 'keep-7', text: '残七', author: '🎴お題ぶくろ' }],
    phrases: { 'uid-old': '旧UIDの句' },
    phraseDetails: { 'uid-old': [{ id: 'old-detail', text: '五', author: '🎴お題ぶくろ' }] },
    revealedPhrases: { 'uid-old': true },
    selfPraise: { 'uid-old': true },
    votes: { 'uid-host': { 'uid-old': 'okashi' } },
    voteRoles: { 'uid-host': 'host' },
  });
  await roomRef('uid-migration').collection('hands').doc('uid-old').set({
    hand5: [{ id: 'old-hand-5', text: '旧五', author: '🎴お題ぶくろ' }],
    hand7: [{ id: 'old-hand-7', text: '旧七', author: '🎴お題ぶくろ' }],
    redrawUsed: true,
    round: 1,
  });

  const result = await changeHaikuRole.run({ data: { roomId: 'uid-migration', role: 'player' }, auth: { uid: 'uid-new' } });
  const room = (await roomRef('uid-migration').get()).data();
  const hand = (await roomRef('uid-migration').collection('hands').doc('uid-new').get()).data();
  const oldHandSnapshot = await roomRef('uid-migration').collection('hands').doc('uid-old').get();
  assert.equal(result.joinedRound, false);
  assert.deepEqual(room.roundPlayerUids, ['uid-host', 'uid-new']);
  assert.equal(room.roundPlayerNames['uid-old'], undefined);
  assert.equal(room.phrases['uid-old'], undefined);
  assert.equal(room.phrases['uid-new'], '旧UIDの句');
  assert.equal(room.votes['uid-host']['uid-new'], 'okashi');
  assert.deepEqual(room.deck5, [{ id: 'keep-5', text: '残五', author: '🎴お題ぶくろ' }]);
  assert.deepEqual(hand.hand5, [{ id: 'old-hand-5', text: '旧五', author: '🎴お題ぶくろ' }]);
  assert.equal(hand.redrawUsed, true);
  assert.equal(oldHandSnapshot.exists, false);
});

test('Haiku新規途中参加だけがroundPlayerUidsへ追加され手札を受け取る', async () => {
  await roomRef('new-round-player').set({
    schemaVersion: 2,
    status: 'playing',
    roundCount: 1,
    currentHost: '親',
    currentHostUid: 'uid-host',
    players: ['親'],
    spectators: ['新規'],
    participantUids: { 'uid-host': '親', 'uid-new': '新規' },
    roundPlayerUids: ['uid-host'],
    roundPlayerNames: { 'uid-host': '親' },
    settings: { hand5: 1, hand7: 1 },
    deck5: [],
    deck7: [],
  });

  const result = await changeHaikuRole.run({ data: { roomId: 'new-round-player', role: 'player' }, auth: { uid: 'uid-new' } });
  const room = (await roomRef('new-round-player').get()).data();
  const hand = (await roomRef('new-round-player').collection('hands').doc('uid-new').get()).data();
  assert.equal(result.joinedRound, true);
  assert.deepEqual(room.roundPlayerUids, ['uid-host', 'uid-new']);
  assert.equal(room.deck5.length, 0);
  assert.equal(room.deck7.length, 0);
  assert.equal(hand.round, 1);
  assert.equal(hand.hand5[0].author, '🎴お題ぶくろ');
  assert.equal(hand.hand7[0].author, '🎴お題ぶくろ');
});

test('Haiku次節Callableは見学へ切り替えた元プレイヤーの得点と履歴を保持する', async () => {
  await roomRef('advance-with-spectator').set({
    schemaVersion: 2,
    status: 'playing',
    roundCount: 1,
    currentHost: '親',
    currentHostUid: 'uid-host',
    players: ['親'],
    spectators: ['参加者'],
    participantUids: { 'uid-host': '親', 'uid-player': '参加者' },
    roundPlayerUids: ['uid-host', 'uid-player'],
    roundPlayerNames: { 'uid-host': '親', 'uid-player': '参加者' },
    settings: { hand5: 1, hand7: 1, carryOver: false },
    words5: [], words7: [],
    phrases: { 'uid-player': '参加者の句' },
    phraseDetails: {},
    revealedPhrases: { 'uid-player': true },
    votes: {
      'uid-host': { 'uid-player': 'okashi' },
      'uid-player': { 'uid-host': 'kanpu' },
    },
    voteRoles: { 'uid-host': 'host', 'uid-player': 'spectator' },
    scores: {},
  });

  await advanceHaikuRound.run({ data: { roomId: 'advance-with-spectator' }, auth: { uid: 'uid-host' } });
  const room = (await roomRef('advance-with-spectator').get()).data();
  const history = await roomRef('advance-with-spectator').collection('history').get();
  const historyEntry = history.docs[0].data();
  assert.equal(room.scores['参加者'], 1);
  assert.deepEqual(historyEntry.playerNames, ['親', '参加者']);
  assert.deepEqual(historyEntry.roundPlayerUids, ['uid-host', 'uid-player']);
  assert.deepEqual(historyEntry.roundPlayerNames, { 'uid-host': '親', 'uid-player': '参加者' });
  assert.deepEqual(historyEntry.spectatorNames, ['参加者']);
  assert.equal(room.roundPlayerUids, undefined);
  assert.equal(room.roundPlayerNames, undefined);
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
  assert.deepEqual(room.roundPlayerUids, ['uid-host', 'uid-player']);
  assert.deepEqual(room.roundPlayerNames, { 'uid-host': '親', 'uid-player': '参加者' });
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

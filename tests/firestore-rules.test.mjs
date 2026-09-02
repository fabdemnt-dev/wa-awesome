import test, { after, before } from 'node:test';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, runTransaction, setDoc, updateDoc } from 'firebase/firestore';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

let testEnv;

before(async () => {
  const rules = await fs.readFile(new URL('../firestore.rules', import.meta.url), 'utf8');
  const seedEnv = await initializeTestEnvironment({
    projectId: 'demo-wa-awesome',
    firestore: { rules },
  });
  await seedEnv.withSecurityRulesDisabled(async (context) => {
    const firestore = context.firestore();
    await setDoc(doc(firestore, 'rooms/rule-test-hands'), { status: 'playing' });
    await setDoc(doc(firestore, 'rooms/rule-test-hands/hands/uid-hand-owner'), {
      hand5: [{ id: 'five-1', text: '五1' }], hand7: [],
    });
  });
  await seedEnv.cleanup();
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-wa-awesome',
    firestore: { rules },
  });
});

after(async () => {
  await testEnv.cleanup();
});

async function seedV2HaikuRoom(roomId, overrides = {}) {
  const data = {
    schemaVersion: 2,
    status: 'lobby',
    roundCount: 1,
    currentHost: '親',
    currentHostUid: 'uid-owner',
    players: ['親', '参加者'],
    spectators: ['見学者'],
    participantUids: {
      'uid-owner': '親',
      'uid-player': '参加者',
      'uid-spectator': '見学者',
    },
    settings: { hand5: 5, hand7: 3, carryOver: true },
    words5: [],
    words7: [],
    hands5: {},
    hands7: {},
    deck5: [],
    deck7: [],
    phrases: {},
    phraseDetails: {},
    revealedPhrases: {},
    selfPraise: {},
    votes: {},
    voteRoles: {},
    scores: {},
    scoreHistory: [],
    redraws: {},
    ...overrides,
  };
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), `rooms/haiku_${roomId}`), data);
  });
  return data;
}

test('ポエムの同時進行は最新作品を1回だけ保存し、古い画面で次の回を消さない', async () => {
  const db = testEnv.authenticatedContext('uid-player').firestore();
  const roomRef = doc(db, 'rooms/poem-history-transaction');
  const current = { schemaVersion: 2, status: 'playing', roundCount: 1, players: ['参加者'], participantUids: { 'uid-player': '参加者' }, poems: { latest: { text: '直前に投稿された作品', revealed: true, likes: 2 } } };
  await setDoc(roomRef, current);
  const source = await fs.readFile(new URL('../poem-game.js', import.meta.url), 'utf8');
  const state = { roomRef, myUid: 'uid-player', myName: '参加者', isSpectator: false, currentData: { ...current, poems: {} } };
  const notices = [];
  // Firestoreは別VMのObjectをカスタム型として拒否するため、SDKと同じrealmで実コードを実行する。
  const context = { window: {}, state, db, doc, runTransaction, confirm: () => true, alert: x => notices.push(x) };
  new Function(...Object.keys(context), source.slice(source.indexOf('window.nextGame =')))(...Object.values(context));
  await Promise.all([context.window.nextGame(), context.window.nextGame()]);
  const history = await getDocs(collection(roomRef, 'history'));
  assert.equal(history.size, 1);
  assert.deepEqual(history.docs[0].data().poems, current.poems);
  assert.equal((await getDoc(roomRef)).data().roundCount, 2);
  assert.equal(notices.filter(x => x.includes('保存しました')).length, 1);
  await updateDoc(roomRef, { status: 'playing', poems: { new: { text: '2回目の作品' } } });
  await context.window.nextGame(); // 画面側はまだ1回目
  assert.equal((await getDoc(roomRef)).data().poems.new.text, '2回目の作品');
  assert.equal((await getDocs(collection(roomRef, 'history'))).size, 1);
});

test('未認証ユーザーはルームを読み書きできない', async () => {
  const room = doc(testEnv.unauthenticatedContext().firestore(), 'rooms/rule-test-unauth');
  await assertFails(getDoc(room));
  await assertFails(setDoc(room, { status: 'lobby' }));
});

test('認証済みユーザーはv1互換ルームを作成・更新・読み取りできる', async () => {
  const room = doc(testEnv.authenticatedContext({ uid: 'user-a' }).firestore(), 'rooms/rule-test-auth');
  await assertSucceeds(setDoc(room, { status: 'lobby', players: ['あ'] }));
  await assertSucceeds(updateDoc(room, { status: 'playing' }));
  await assertSucceeds(getDoc(room));
});

test('未認証ユーザーは履歴を読み書きできない', async () => {
  const entry = doc(testEnv.unauthenticatedContext().firestore(), 'rooms/rule-test-history/history/entry-1');
  await assertFails(getDoc(entry));
  await assertFails(setDoc(entry, { status: 'lobby' }));
});

test('認証済みユーザーは履歴を作成・読み取りできるが更新できない', async () => {
  const entry = doc(testEnv.authenticatedContext({ uid: 'user-c' }).firestore(), 'rooms/rule-test-history/history/entry-2');
  await assertSucceeds(setDoc(entry, { status: 'lobby' }));
  await assertSucceeds(getDoc(entry));
  await assertFails(updateDoc(entry, { status: 'playing' }));
});

test('UID別手札は他人・未認証ユーザーが読めず、クライアント書込みも拒否される', async () => {
  const owner = testEnv.authenticatedContext({ uid: 'uid-hand-owner' }).firestore();
  const other = testEnv.authenticatedContext({ uid: 'uid-hand-other' }).firestore();
  const hand = doc(owner, 'rooms/rule-test-hands/hands/uid-hand-owner');
  await assertFails(getDoc(doc(other, 'rooms/rule-test-hands/hands/uid-hand-owner')));
  await assertFails(getDoc(doc(testEnv.unauthenticatedContext().firestore(), 'rooms/rule-test-hands/hands/uid-hand-owner')));
  await assertFails(updateDoc(hand, { redrawUsed: true }));
});

test('v2俳句ルームは安全な空ロビーを含めてクライアントから直接作成できない', async () => {
  const owner = testEnv.authenticatedContext({ uid: 'uid-owner' }).firestore();
  const base = {
    schemaVersion: 2,
    status: 'lobby',
    roundCount: 1,
    players: ['親'],
    spectators: [],
    participantUids: { 'uid-owner': '親' },
    currentHost: '親',
    currentHostUid: 'uid-owner',
    settings: { hand5: 5, hand7: 3, carryOver: true },
    words5: [],
    words7: [],
    phrases: {},
    scores: {},
  };
  const cases = [
    base,
    { ...base, status: 'playing' },
    { ...base, roundCount: 2 },
    { ...base, words5: [{ id: 'w5', text: '持込み', author: '親' }] },
    { ...base, words7: [{ id: 'w7', text: '持込み', author: '親' }] },
    { ...base, phrases: { 'uid-owner': '持込み句' } },
    { ...base, scores: { '親': 999 } },
  ];
  for (const [index, data] of cases.entries()) {
    await assertFails(setDoc(doc(owner, `rooms/haiku_rule-test-create-${index}`), data));
  }
});

test('v2俳句ルームのゲーム状態はすべてクライアント直接更新を拒否する', async () => {
  const roomId = 'rule-test-game-state';
  await seedV2HaikuRoom(roomId);
  const room = doc(testEnv.authenticatedContext({ uid: 'uid-owner' }).firestore(), `rooms/haiku_${roomId}`);
  await assertSucceeds(getDoc(room));

  const protectedUpdates = {
    words5: [{ id: 'w5', text: '改変', author: '親' }],
    words7: [{ id: 'w7', text: '改変', author: '親' }],
    hands5: { 'uid-owner': [] },
    hands7: { 'uid-owner': [] },
    deck5: [{ id: 'd5', text: '改変', author: '親' }],
    deck7: [{ id: 'd7', text: '改変', author: '親' }],
    phrases: { 'uid-owner': '不正な句' },
    phraseDetails: { 'uid-owner': [] },
    revealedPhrases: { 'uid-owner': true },
    selfPraise: { 'uid-owner': true },
    votes: { 'uid-owner': {} },
    voteRoles: { 'uid-owner': 'host' },
    scores: { '親': 999 },
    scoreHistory: [{ round: 1 }],
    redraws: { 'uid-owner': true },
    roundCount: 2,
    status: 'playing',
  };
  for (const [field, value] of Object.entries(protectedUpdates)) {
    await assertFails(updateDoc(room, { [field]: value }));
  }
});

test('v2俳句ルームの参加者情報は正常値を含めてクライアント直接更新を拒否する', async () => {
  const roomId = 'rule-test-participants';
  const original = await seedV2HaikuRoom(roomId);
  const room = doc(testEnv.authenticatedContext({ uid: 'uid-owner' }).firestore(), `rooms/haiku_${roomId}`);
  const updates = [
    { participantUids: { ...original.participantUids, 'uid-other': '他人' } },
    { participantUids: { ...original.participantUids, 'uid-player': '改名' } },
    { participantUids: { 'uid-owner': '親', 'uid-spectator': '見学者' } },
    { participantUids: { ...original.participantUids, '   ': '空白UID' } },
    { participantUids: { ...original.participantUids, 'uid-empty': '' } },
    { players: [...original.players, '任意名'] },
    { players: ['親'] },
    { spectators: [...original.spectators, '任意名'] },
    { spectators: [] },
    { players: ['親', '参加者', '見学者'], spectators: ['見学者'] },
    { players: ['親', '存在しない参加者'] },
    { spectators: ['存在しない見学者'] },
    { players: ['親', '参加者'], spectators: ['見学者'], participantUids: original.participantUids },
  ];
  for (const update of updates) await assertFails(updateDoc(room, update));
});

test('v2俳句ルームの親情報はクライアントから直接変更できない', async () => {
  const lobbyId = 'rule-test-host-lobby';
  await seedV2HaikuRoom(lobbyId);
  const lobbyRoom = doc(testEnv.authenticatedContext({ uid: 'uid-player' }).firestore(), `rooms/haiku_${lobbyId}`);
  for (const update of [
    { currentHost: '参加者' },
    { currentHostUid: 'uid-player' },
    { currentHost: '参加者', currentHostUid: 'uid-owner' },
    { currentHostUid: 'uid-missing' },
    { currentHost: '見学者', currentHostUid: 'uid-spectator' },
  ]) await assertFails(updateDoc(lobbyRoom, update));

  const playingId = 'rule-test-host-playing';
  await seedV2HaikuRoom(playingId, { status: 'playing' });
  const playingRoom = doc(testEnv.authenticatedContext({ uid: 'uid-player' }).firestore(), `rooms/haiku_${playingId}`);
  await assertFails(updateDoc(playingRoom, { currentHost: '参加者', currentHostUid: 'uid-player' }));
});

test('v2俳句ルームの設定とschemaVersionはクライアントから直接変更できない', async () => {
  const lobbyId = 'rule-test-settings-lobby';
  await seedV2HaikuRoom(lobbyId);
  const lobbyRoom = doc(testEnv.authenticatedContext({ uid: 'uid-owner' }).firestore(), `rooms/haiku_${lobbyId}`);
  const settingsCases = [
    { hand5: 0, hand7: 3, carryOver: true },
    { hand5: -1, hand7: 3, carryOver: true },
    { hand5: 21, hand7: 3, carryOver: true },
    { hand5: 5, hand7: 0, carryOver: true },
    { hand5: 5, hand7: -1, carryOver: true },
    { hand5: 5, hand7: 21, carryOver: true },
    { hand5: 5, hand7: 3, carryOver: 'true' },
    { hand5: 4, hand7: 2, carryOver: false },
  ];
  for (const settings of settingsCases) await assertFails(updateDoc(lobbyRoom, { settings }));
  await assertFails(updateDoc(lobbyRoom, { schemaVersion: 1 }));
  await assertFails(updateDoc(lobbyRoom, { schemaVersion: 1, status: 'playing' }));

  const playingId = 'rule-test-settings-playing';
  await seedV2HaikuRoom(playingId, { status: 'playing' });
  const playingRoom = doc(testEnv.authenticatedContext({ uid: 'uid-owner' }).firestore(), `rooms/haiku_${playingId}`);
  await assertFails(updateDoc(playingRoom, { settings: { hand5: 4, hand7: 2, carryOver: false } }));
});

test('v1俳句ルームとv2 Poemルームの従来更新互換を維持する', async () => {
  const owner = testEnv.authenticatedContext({ uid: 'uid-legacy-owner' }).firestore();
  const legacyHaiku = doc(owner, 'rooms/haiku_rule-test-v1');
  await assertSucceeds(setDoc(legacyHaiku, { status: 'lobby', players: ['あ'], phrases: {} }));
  await assertSucceeds(updateDoc(legacyHaiku, { status: 'playing', phrases: { 'あ': '旧形式の句' } }));

  const poem = doc(owner, 'rooms/poem_rule-test-v2');
  await assertSucceeds(setDoc(poem, { schemaVersion: 2, status: 'lobby', players: ['あ'], poems: {} }));
  await assertSucceeds(updateDoc(poem, { status: 'playing', poems: { 'uid-legacy-owner': { text: '作品' } } }));
});

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import fs from 'node:fs/promises';

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

test('未認証ユーザーはルームを読み書きできない', async () => {
  const room = doc(testEnv.unauthenticatedContext().firestore(), 'rooms/rule-test-unauth');
  await assertFails(getDoc(room));
  await assertFails(setDoc(room, { status: 'lobby' }));
});

test('認証済みユーザーはルームを作成・更新・読み取りできる', async () => {
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

test('v2俳句ルームは空のロビー状態だけを新規作成できる', async () => {
  const owner = testEnv.authenticatedContext({ uid: 'uid-owner' }).firestore();
  const safeRoom = doc(owner, 'rooms/haiku_rule-test-safe-create');
  await assertSucceeds(setDoc(safeRoom, {
    schemaVersion: 2,
    status: 'lobby',
    roundCount: 1,
    players: ['あ'],
    spectators: [],
    participantUids: { 'uid-owner': 'あ' },
    words5: [],
    words7: [],
    hands5: {},
    hands7: {},
    phrases: {},
    phraseDetails: {},
    votes: {},
    scores: {},
    selfPraise: {},
    redraws: {},
  }));

  await assertFails(setDoc(doc(owner, 'rooms/haiku_rule-test-playing-create'), {
    schemaVersion: 2,
    status: 'playing',
    roundCount: 1,
    words5: [],
    words7: [],
  }));
  await assertFails(setDoc(doc(owner, 'rooms/haiku_rule-test-result-create'), {
    schemaVersion: 2,
    status: 'lobby',
    roundCount: 1,
    words5: [],
    words7: [],
    phrases: { 'uid-owner': '持込み句' },
  }));
});

test('v2俳句ルームは参加・再接続情報を更新できるがゲーム状態を直接更新できない', async () => {
  const owner = testEnv.authenticatedContext({ uid: 'uid-v2-owner' }).firestore();
  const room = doc(owner, 'rooms/haiku_rule-test-v2');
  await assertSucceeds(setDoc(room, {
    schemaVersion: 2,
    status: 'lobby',
    roundCount: 1,
    currentHost: 'あ',
    currentHostUid: 'uid-v2-owner',
    players: ['あ'],
    spectators: [],
    participantUids: { 'uid-v2-owner': 'あ' },
    words5: [],
    words7: [],
    hands5: {},
    hands7: {},
    phrases: {},
    phraseDetails: {},
    revealedPhrases: {},
    selfPraise: {},
    votes: {},
    voteRoles: {},
    scores: {},
    scoreHistory: [],
    redraws: {},
  }));

  await assertSucceeds(updateDoc(room, {
    players: ['あ', 'い'],
    participantUids: { 'uid-v2-owner': 'あ', 'uid-v2-player': 'い' },
  }));

  const protectedUpdates = {
    words5: [{ id: 'w5', text: '改変', author: 'あ' }],
    words7: [{ id: 'w7', text: '改変', author: 'あ' }],
    hands5: { 'uid-v2-owner': [] },
    hands7: { 'uid-v2-owner': [] },
    deck5: [],
    deck7: [],
    phrases: { 'uid-v2-owner': '不正な句' },
    phraseDetails: { 'uid-v2-owner': [] },
    revealedPhrases: { 'uid-v2-owner': true },
    selfPraise: { 'uid-v2-owner': true },
    votes: { 'uid-v2-owner': {} },
    voteRoles: { 'uid-v2-owner': 'host' },
    scores: { 'あ': 999 },
    scoreHistory: [{ round: 1 }],
    redraws: { 'uid-v2-owner': true },
    roundCount: 2,
    status: 'playing',
  };
  for (const [field, value] of Object.entries(protectedUpdates)) {
    await assertFails(updateDoc(room, { [field]: value }));
  }
  await assertFails(updateDoc(room, { schemaVersion: 1, status: 'playing' }));
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

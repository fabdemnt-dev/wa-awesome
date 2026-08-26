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

test('UID対応済みルームでも既存の共有ゲーム状態を更新できる', async () => {
  const owner = testEnv.authenticatedContext({ uid: 'uid-owner' }).firestore();
  const room = doc(owner, 'rooms/rule-test-uid');
  await assertSucceeds(setDoc(room, {
    status: 'playing',
    players: ['あ'],
    spectators: [],
    participantUids: { 'uid-owner': 'あ' },
    hands: { あ: ['札'] },
  }));
  await assertSucceeds(updateDoc(room, { status: 'lobby', currentHost: 'あ' }));
});

test('UID対応済みルームでも共有状態の更新は既存仕様どおり許可する', async () => {
  const owner = testEnv.authenticatedContext({ uid: 'uid-shared-owner' }).firestore();
  const room = doc(owner, 'rooms/rule-test-shared');
  await assertSucceeds(setDoc(room, {
    status: 'lobby',
    players: ['あ'],
    spectators: [],
    participantUids: { 'uid-shared-owner': 'あ' },
    hands: { あ: [] },
  }));
  await assertSucceeds(updateDoc(room, { status: 'playing', currentHost: 'あ' }));
});

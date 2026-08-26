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

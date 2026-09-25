import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { completeInitialConnection } from '../toybox/mofumofu-gathering/online/initial-connection.js';

function harness({ roomId = null, seatId = null, currentUser = null } = {}) {
  const calls = { authReady: 0, signIn: 0, connected: 0, resume: 0 };
  const auth = {
    currentUser,
    async authStateReady() { calls.authReady += 1; },
  };
  const signInAnonymously = async (target) => {
    calls.signIn += 1;
    target.currentUser = { uid: 'new-anonymous-uid', isAnonymous: true };
  };
  const run = () => completeInitialConnection({
    auth,
    signInAnonymously,
    roomId,
    markConnected: () => { calls.connected += 1; },
    resumeRoom: async () => { calls.resume += 1; },
  });
  return { auth, calls, roomId, seatId, run };
}

test('roomIdなし・seatIdなしはAuth完了後に接続済み表示へ進む', async () => {
  const value = harness();
  await value.run();
  assert.deepEqual(value.calls, { authReady: 1, signIn: 1, connected: 1, resume: 0 });
});

test('保存済みAnonymous AuthとroomなしはUIDを維持する', async () => {
  const saved = { uid: 'saved-anonymous-uid', isAnonymous: true };
  const value = harness({ currentUser: saved });
  await value.run();
  assert.equal(value.auth.currentUser, saved);
  assert.deepEqual(value.calls, { authReady: 1, signIn: 0, connected: 1, resume: 0 });
});

test('roomIdなし・seatIdありも正常初期画面へ進む', async () => {
  const value = harness({ seatId: 'A', currentUser: { uid: 'saved', isAnonymous: true } });
  await value.run();
  assert.equal(value.calls.connected, 1);
  assert.equal(value.calls.resume, 0);
});

test('roomIdあり・seatIdなしは従来どおりfull resumeへ進む', async () => {
  const value = harness({ roomId: 'room-1', currentUser: { uid: 'saved', isAnonymous: true } });
  await value.run();
  assert.equal(value.calls.connected, 0);
  assert.equal(value.calls.resume, 1);
});

test('roomIdあり・seatIdありは従来どおりfull resumeへ進む', async () => {
  const value = harness({ roomId: 'room-1', seatId: 'A', currentUser: { uid: 'saved', isAnonymous: true } });
  await value.run();
  assert.equal(value.calls.connected, 0);
  assert.equal(value.calls.resume, 1);
});

test('roomなしではfull resume・presence・listener・polling相当処理を開始しない', async () => {
  const started = { fullResume: 0, presence: 0, firestore: 0, polling: 0 };
  const auth = { currentUser: { uid: 'saved' }, async authStateReady() {} };
  await completeInitialConnection({
    auth,
    signInAnonymously: async () => assert.fail('sign-in should not run'),
    roomId: null,
    markConnected() {},
    resumeRoom: async () => {
      started.fullResume += 1;
      started.presence += 1;
      started.firestore += 1;
      started.polling += 1;
    },
  });
  assert.deepEqual(started, { fullResume: 0, presence: 0, firestore: 0, polling: 0 });
});

for (const eventName of ['visibilitychange', 'pageshow', 'online']) {
  test(`roomなしの${eventName}後も接続済み状態を維持する`, async () => {
    let status = '接続準備中です…';
    const value = harness({ currentUser: { uid: 'saved', isAnonymous: true } });
    await completeInitialConnection({
      auth: value.auth,
      signInAnonymously: async () => assert.fail('sign-in should not run'),
      roomId: null,
      markConnected: () => { status = '接続しました。'; },
      resumeRoom: async () => assert.fail('resume should not run'),
    });
    await Promise.resolve();
    assert.equal(status, '接続しました。');
  });
}

test('クライアントの復帰イベントはroomなしなら既存のrequestFullResume早期終了を使う', () => {
  const source = fs.readFileSync(new URL('../toybox/mofumofu-gathering/online/script.js', import.meta.url), 'utf8');
  const control = fs.readFileSync(new URL('../toybox/mofumofu-gathering/online/connection-control.js', import.meta.url), 'utf8');
  assert.match(control, /const roomId = getRoomId\(\);\s*if \(!roomId\) return Promise\.resolve\(\);/);
  for (const reason of ['visibilitychange', 'pageshow', 'online']) assert.ok(source.includes(`requestFullResume('${reason}')`));
});

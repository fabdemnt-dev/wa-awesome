'use strict';
// 追加のEmulator統合試験: 古いstateVersion拒否 / 別ルーム越境アクセス拒否
// ゲームロジック・Rules・Functions・依存関係は変更せず、テストだけで検証する。
import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInAnonymously } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { getFirestore, connectFirestoreEmulator, doc, getDoc } from 'firebase/firestore';
import { getDatabase, connectDatabaseEmulator } from 'firebase/database';
import { createRequire } from 'node:module';

// Admin SDKをEmulatorへ向ける(本番へは接続しない)
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_DATABASE_EMULATOR_HOST = '127.0.0.1:9000';

const functionRequire = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp: initializeAdminApp, getApps: getAdminApps } = functionRequire('firebase-admin/app');
const { getFirestore: getAdminFirestore } = functionRequire('firebase-admin/firestore');
const { getDatabase: getAdminDatabase } = functionRequire('firebase-admin/database');
if (!getAdminApps().length) initializeAdminApp({ projectId: 'demo-shadow-card', databaseURL: 'http://127.0.0.1:9000?ns=demo-shadow-card' });
const adminFs = getAdminFirestore();
const adminRtdb = getAdminDatabase();

const config = { projectId: 'demo-shadow-card', apiKey: 'emulator-only-not-a-real-key', appId: 'emulator-only', databaseURL: 'http://127.0.0.1:9000?ns=demo-shadow-card' };
function client(name) {
  const app = initializeApp(config, name);
  const auth = getAuth(app);
  const fs = getFirestore(app);
  const fn = getFunctions(app, 'asia-northeast1');
  const rt = getDatabase(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(fs, '127.0.0.1', 8080);
  connectFunctionsEmulator(fn, '127.0.0.1', 5001);
  connectDatabaseEmulator(rt, '127.0.0.1', 9000);
  return { app, auth, fs, fn, rt, call: (n, d) => httpsCallable(fn, n)(d).then((x) => x.data) };
}
async function denied(p) { await assert.rejects(p); }
async function deniedPermission(fs, path) {
  await assert.rejects(getDoc(doc(fs, path)), (err) => {
    assert.equal(err?.code, 'permission-denied', `${path} => ${err?.code} ${err?.message}`);
    return true;
  });
}
async function deniedWith(p, prefix) {
  await assert.rejects(p, (err) => {
    assert.ok(String(err?.code || '').startsWith(prefix), `unexpected code=${err?.code} message=${err?.message}`);
    return true;
  });
}
// ルームの全状態をサーバー側(Admin SDK)から取得してbefore/after比較に使う
async function dumpRoomState(roomId, gameId, uids = []) {
  const out = {};
  out.room = (await adminFs.doc(`shadowCardRooms/${roomId}`).get()).data();
  const members = await adminFs.collection(`shadowCardRooms/${roomId}/members`).get();
  out.members = members.docs.map((d) => d.data());
  const seats = await adminFs.collection(`shadowCardRooms/${roomId}/seats`).get();
  out.seats = seats.docs.map((d) => d.data()).sort((x, y) => x.seatIndex - y.seatIndex);
  out.game = gameId ? (await adminFs.doc(`shadowCardRooms/${roomId}/games/${gameId}`).get()).data() : null;
  // privatePlayersはポイントリード(直接doc取得)で読み、コレクション一覧クエリの整合性に依存しない
  out.privatePlayers = {};
  for (const uid of uids) {
    for (let r = 1; r <= 5; r += 1) {
      const d = await adminFs.doc(`shadowCardRooms/${roomId}/privatePlayers/${uid}/rounds/${r}`).get();
      if (d.exists) {
        if (!out.privatePlayers[uid]) out.privatePlayers[uid] = {};
        out.privatePlayers[uid][String(r)] = d.data();
      }
    }
  }
  const sr = await adminFs.collection(`shadowCardRooms/${roomId}/serverRounds`).get();
  out.serverRounds = Object.fromEntries(sr.docs.map((r) => [r.id, r.data()]));
  const rd = await adminFs.collection(`shadowCardRooms/${roomId}/rounds`).get();
  out.rounds = Object.fromEntries(rd.docs.map((r) => [r.id, r.data()]));
  const rs = await adminFs.collection(`shadowCardRooms/${roomId}/results`).get();
  out.results = Object.fromEntries(rs.docs.map((r) => [r.id, r.data()]));
  const sec = await adminFs.doc(`shadowCardRoomSecrets/${roomId}`).get();
  out.secrets = sec.exists ? sec.data() : null;
  const loc = await adminFs.collection('shadowCardRoomLocators').get();
  out.locators = Object.fromEntries(loc.docs.map((d) => [d.id, d.data()]));
  const ar = await adminFs.collection('shadowCardActionRequests').get();
  out.actionRequests = Object.fromEntries(ar.docs.map((d) => [d.id, d.data()]));
  return out;
}

test('stale stateVersion is rejected and no state changes', { timeout: 180000 }, async () => {
  const a = client('stale-a');
  const b = client('stale-b');
  await signInAnonymously(a.auth);
  await signInAnonymously(b.auth);
  const aUid = a.auth.currentUser.uid;
  const bUid = b.auth.currentUser.uid;
  const created = await a.call('shadowCardCreateRoom', { displayName: 'A' });
  await b.call('shadowCardJoinRoom', { displayName: 'B', inviteCode: created.inviteCode });
  const roomId = created.roomId;
  await a.call('shadowCardStartGame', { roomId });
  let sa = await a.call('shadowCardGetSnapshot', { roomId });
  const gameId = sa.room.gameId;
  const svRound1 = sa.game.stateVersion;
  // ラウンド1を両者提出で解決させる(有効な操作でstateVersionが進む)
  await Promise.all([
    a.call('shadowCardSubmitChoice', { roomId, gameId, roundNumber: 1, handIndex: 0, stateVersion: svRound1, requestId: 'stale-r1-a' }),
    b.call('shadowCardSubmitChoice', { roomId, gameId, roundNumber: 1, handIndex: 1, stateVersion: svRound1, requestId: 'stale-r1-b' }),
  ]);
  sa = await a.call('shadowCardGetSnapshot', { roomId });
  assert.equal(sa.round.revealed, true);
  assert.equal(sa.round.submittedSeats, 4);
  // ラウンド2を開始(ここでもstateVersionが進む)
  await a.call('shadowCardContinueGame', { roomId });
  const before = await dumpRoomState(roomId, gameId, [aUid, bUid]);
  const svCurrent = before.game.stateVersion;
  assert.equal(before.rounds['2'].phase, 'choosing');
  assert.equal(before.privatePlayers[aUid]['1'].submitted, true);
  assert.equal(before.privatePlayers[aUid]['2'].hand.length, 4);
  assert.equal(before.privatePlayers[bUid]['2'].hand.length, 4);
  assert.ok(svCurrent > svRound1, `svCurrent=${svCurrent} svRound1=${svRound1}`);
  // 1つ古いstateVersionでsubmitChoice → 拒否される
  const stale = svCurrent - 1;
  await deniedWith(
    a.call('shadowCardSubmitChoice', { roomId, gameId, roundNumber: 2, handIndex: 0, stateVersion: stale, requestId: 'stale-r2-attempt' }),
    'functions/failed-precondition'
  );
  // 拒否試行の前後で状態(手札・選択・得点・ラウンド・結果・stateVersion)が一切変わらない
  const after = await dumpRoomState(roomId, gameId, [aUid, bUid]);
  assert.deepEqual(after, before, 'stale-stateVersion attempt must not change any state');
  // 現在のstateVersionなら同ラウンドに提出できる(拒否が古いversionによることを確認)
  const okSubmit = await a.call('shadowCardSubmitChoice', { roomId, gameId, roundNumber: 2, handIndex: 0, stateVersion: svCurrent, requestId: 'stale-r2-ok' });
  assert.equal(okSubmit.resolved, false);
  const afterOk = await dumpRoomState(roomId, gameId, [aUid, bUid]);
  assert.equal(afterOk.game.stateVersion, svCurrent);
  assert.equal(afterOk.serverRounds['2'].choices.seat0.handIndex, 0);
  assert.equal(afterOk.privatePlayers[aUid]['2'].submitted, true);
  const okSnap = await a.call('shadowCardGetSnapshot', { roomId });
  assert.equal(okSnap.privateRound.submitted, true);
  await Promise.all([deleteApp(a.app), deleteApp(b.app)]);
});

test('cross-room reads and callables are denied and room B state is unchanged', { timeout: 180000 }, async () => {
  const a = client('cross-a');
  const b = client('cross-b');
  const c = client('cross-c');
  const d = client('cross-d');
  await Promise.all([signInAnonymously(a.auth), signInAnonymously(b.auth), signInAnonymously(c.auth), signInAnonymously(d.auth)]);
  // ルームA: ユーザーAとB
  const roomX = await a.call('shadowCardCreateRoom', { displayName: 'A' });
  await b.call('shadowCardJoinRoom', { displayName: 'B', inviteCode: roomX.inviteCode });
  await a.call('shadowCardStartGame', { roomId: roomX.roomId });
  // ルームB: ユーザーCとD(越境先)
  const roomY = await c.call('shadowCardCreateRoom', { displayName: 'C' });
  await d.call('shadowCardJoinRoom', { displayName: 'D', inviteCode: roomY.inviteCode });
  const yStarted = await c.call('shadowCardStartGame', { roomId: roomY.roomId });
  const roomIdY = roomY.roomId;
  const gameIdY = yStarted.gameId;
  const cuid = c.auth.currentUser.uid;
  const dUid = d.auth.currentUser.uid;
  // ルームBのラウンド1をC/Dの正当な提出で解決させ、全秘匿パスが存在する安定状態にする
  // (ルームBにchoosingのラウンドを残さず、スケジュール掃引が途中で状態を変えるのを避ける)
  let sB = await c.call('shadowCardGetSnapshot', { roomId: roomIdY });
  const svY1 = sB.game.stateVersion;
  await Promise.all([
    c.call('shadowCardSubmitChoice', { roomId: roomIdY, gameId: gameIdY, roundNumber: 1, handIndex: 0, stateVersion: svY1, requestId: 'crossroom-r1-c' }),
    d.call('shadowCardSubmitChoice', { roomId: roomIdY, gameId: gameIdY, roundNumber: 1, handIndex: 1, stateVersion: svY1, requestId: 'crossroom-r1-d' }),
  ]);
  const before = await dumpRoomState(roomIdY, gameIdY, [cuid, dUid]);
  const svY = before.game.stateVersion;
  assert.equal(before.results['1'].roundNumber, 1);
  assert.equal(before.privatePlayers[cuid]['1'].submitted, true);
  assert.equal(before.privatePlayers[dUid]['1'].submitted, true);
  const locatorY = before.secrets.locator;
  // 対照: Aは自分のルームAにはアクセスできる
  const sx = await a.call('shadowCardGetSnapshot', { roomId: roomX.roomId });
  assert.equal(sx.members.length, 2);
  // AからルームBの公開情報・members・seats・games・rounds・results・privatePlayers・serverRounds・roomSecrets・roomLocatorsを直接読めない
  const deniedReads = [
    `shadowCardRooms/${roomIdY}`,
    `shadowCardRooms/${roomIdY}/members/${cuid}`,
    `shadowCardRooms/${roomIdY}/seats/seat0`,
    `shadowCardRooms/${roomIdY}/games/${gameIdY}`,
    `shadowCardRooms/${roomIdY}/rounds/1`,
    `shadowCardRooms/${roomIdY}/results/1`,
    `shadowCardRooms/${roomIdY}/privatePlayers/${cuid}/rounds/1`,
    `shadowCardRooms/${roomIdY}/serverRounds/1`,
    `shadowCardRoomSecrets/${roomIdY}`,
    `shadowCardRoomLocators/${locatorY}`,
  ];
  for (const p of deniedReads) { await deniedPermission(a.fs, p); }
  // AからルームBへのCallable操作(snapshot/submitChoice/continueGame/leaveRoom)はすべて拒否される
  await deniedWith(a.call('shadowCardGetSnapshot', { roomId: roomIdY }), 'functions/permission-denied');
  await deniedWith(a.call('shadowCardSubmitChoice', { roomId: roomIdY, gameId: gameIdY, roundNumber: 1, handIndex: 0, stateVersion: svY, requestId: 'cross-submit' }), 'functions/permission-denied');
  await deniedWith(a.call('shadowCardContinueGame', { roomId: roomIdY }), 'functions/permission-denied');
  await deniedWith(a.call('shadowCardLeaveRoom', { roomId: roomIdY }), 'functions/permission-denied');
  // 越境試行の前後でルームBの状態が一切変わらない
  const after = await dumpRoomState(roomIdY, gameIdY, [cuid, dUid]);
  assert.deepEqual(after, before, 'cross-room attempts must not change room B state');
  // Presenceのアクセス許可も消えていない
  assert.equal((await adminRtdb.ref(`shadowCardRoomAccess/${roomIdY}/${cuid}`).get()).val(), true);
  assert.equal((await adminRtdb.ref(`shadowCardRoomAccess/${roomIdY}/${dUid}`).get()).val(), true);
  await Promise.all([deleteApp(a.app), deleteApp(b.app), deleteApp(c.app), deleteApp(d.app)]);
});

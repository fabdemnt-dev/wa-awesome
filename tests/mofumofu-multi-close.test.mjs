import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const requireFunctions = createRequire(new URL('../functions/package.json', import.meta.url));
const contract = requireFunctions('./mofumofu-multi/contract.js');
const close = await import('../toybox/mofumofu-gathering/online/multi/multi-close.js');
const resume = await import('../toybox/mofumofu-gathering/online/multi/multi-resume.js');
const script = readFileSync(new URL('../toybox/mofumofu-gathering/online/multi/script.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../toybox/mofumofu-gathering/online/multi/index.html', import.meta.url), 'utf8');
const server = readFileSync(new URL('../functions/mofumofu-multi/index.js', import.meta.url), 'utf8');
const room = (overrides = {}) => ({ kind: 'multi', hostUid: 'host', status: 'waiting', dealt: false,
  startedAt: null, turnState: 'waiting', seatOrder: ['S1', 'S2', 'S3'],
  playerUids: { S1: 'host', S2: 'guest', S3: 'other' }, handCounts: { S1: 0, S2: 0, S3: 0 }, ...overrides });

test('host closeは正規ホストの未配札waitingだけ許可する', () => {
  assert.deepEqual(contract.waitingHostCloseDecision(room(), { uid: 'host' }),
    { ok: true, memberUids: ['host', 'guest', 'other'] });
  for (const value of [room({ status: 'playing' }), room({ status: 'finished' }), room({ dealt: true }),
    room({ startedAt: 100 }), room({ handCounts: { S1: 1 } }), room({ turnState: 'awaitingOffer' })]) {
    assert.equal(contract.waitingHostCloseDecision(value, { uid: 'host' }).ok, false);
  }
  assert.equal(contract.waitingHostCloseDecision(room(), { uid: 'guest' }).code, 'permission-denied');
  assert.equal(contract.waitingHostCloseDecision(room(), { uid: 'stranger' }).code, 'permission-denied');
  assert.equal(contract.waitingHostCloseDecision(room({ playerUids: { S1: 'other' } }), { uid: 'host' }).ok, false);
  assert.equal(contract.waitingHostCloseDecision(room({ playerUids: { S1: 'host', S2: 'host' } }), { uid: 'host' }).ok, false);
});

test('hostだけのUI・確認キャンセル・同一actionId再送・結果不明時の保持', () => {
  const state = { room: room(), connectionState: 'connected', startBusy: false, closeBusy: false };
  assert.equal(close.hostCloseView(state, 'host').visible, true);
  assert.equal(close.hostCloseView(state, 'guest').visible, false);
  assert.equal(close.hostCloseView({ ...state, room: room({ status: 'playing' }) }, 'host').visible, false);
  assert.equal(close.hostCloseView({ ...state, room: room({ status: 'finished' }) }, 'host').visible, false);
  assert.equal(close.hostCloseView({ ...state, closeBusy: true }, 'host').disabled, true);
  assert.equal(close.hostCloseView({ ...state, startBusy: true }, 'host').disabled, true);
  const data = new Map();
  const storage = { getItem: (key) => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) };
  const request = { roomId: 'room', actionId: 'action' };
  close.saveCloseRequest(storage, request);
  assert.deepEqual(close.loadCloseRequest(storage, 'room'), request);
  assert.equal(close.loadCloseRequest(storage, 'other'), null);
  close.clearCloseRequest(storage);
  assert.equal(close.loadCloseRequest(storage, 'room'), null);
  assert.match(script, /if \(!existing && !globalThis\.confirm\('待機室を閉じますか/);
  assert.match(script, /const request = existing \|\| \{ roomId: state\.roomId, actionId: newId\(\) \}/);
  assert.match(script, /boundedLeaveResult\(call\('closeMofumofuMultiWaitingRoom', request\)\)/);
  assert.match(script, /state\.closeRequest = loadCloseRequest\(localStorage, saved\.roomId\)/);
  assert.match(html, /id="close-waiting"[^>]+hidden>待機室を閉じる/);
  assert.match(html, /id="leave-waiting"[^>]+hidden>待機室から退出/);
});

test('room消失で参加者も入口へ戻し、旧presence・listenerを停止する', () => {
  assert.match(script, /function handleRoomGone\(\) \{[\s\S]*?clearMultiLocalRoom\(\{ state, storage: localStorage, stopRealtime, retirePresence, forgetInvite, resetEntryView \}\)/);
  const state = { roomId: 'r', resumeGeneration: 0, handRetryFlight: null, lastSuccessfulResumeAt: 1 };
  let stopped = 0; let retired = 0; let reset = 0;
  const data = new Map([['mofumofuMultiRoomId', 'r'], ['mofumofuMultiSeatId', 'S2']]);
  const storage = { removeItem: (key) => data.delete(key) };
  resume.clearMultiLocalRoom({ state, storage, stopRealtime: () => { stopped++; }, retirePresence: () => { retired++; },
    forgetInvite: () => {}, resetEntryView: () => { reset++; } });
  assert.deepEqual([stopped, retired, reset], [1, 1, 1]);
  assert.equal(data.size, 0);
  assert.match(script, /if \(!snap\.exists\(\)\) \{ handleRoomGone\(\); return; \}/);
});

test('transactionはroom削除・invite閉鎖・member削除・global action保持を一体にし、開始と競合する', () => {
  const section = server.slice(server.indexOf('async function closeWaitingHandler'), server.indexOf('async function leaveWaitingHandler'));
  for (const value of ["tx.get(r.room)", "tx.get(r.member(uid))", "tx.get(r.secret)", "tx.get(r.server)",
    "contract.waitingHostCloseDecision", "tx.update(inviteRef, { status: 'closed'", "tx.delete(r.member(memberUid))",
    "tx.delete(r.room)", "tx.create(actionRef", "contract.replayAction"]) assert.ok(section.includes(value), value);
  assert.ok(section.indexOf('tx.delete(r.room)') > section.indexOf('tx.get(r.room)'));
  assert.doesNotMatch(section, /tx\.(set|update)\(r\.room/);
  assert.doesNotMatch(section, /cards|privateHand.*get/);
  assert.match(server, /const closeMofumofuMultiWaitingRoom = onCall\(callableOptions/);
  assert.match(server, /const leaveMofumofuMultiGame = onCall\(callableOptions/);
  assert.match(server, /const leaveMofumofuMultiWaitingRoom = onCall\(callableOptions/);
});

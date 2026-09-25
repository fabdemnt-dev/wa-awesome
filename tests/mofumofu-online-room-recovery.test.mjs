import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const script = read('toybox/mofumofu-gathering/online/script.js');
const entry = read('toybox/mofumofu-gathering/online-entry.js');
const functionsSource = read('functions/mofumofu-online/index.js');
const recovery = await import('../toybox/mofumofu-gathering/online/room-recovery.js');

test('room不在のnot-foundだけを救済する', () => {
  assert.equal(recovery.isSavedRoomGoneError({ code: 'functions/not-found', message: '部屋が見つかりません。' }), true);
  assert.equal(recovery.isSavedRoomGoneError({ code: 'functions/not-found', message: '別原因のnot-found' }), false);
  assert.equal(recovery.isSavedRoomGoneError({ code: 'functions/invalid-argument', message: '部屋が見つかりません。' }), false);
  assert.equal(recovery.isSavedRoomGoneError({ code: 'functions/permission-denied', message: 'メンバーだけが操作できます。' }), false);
  assert.equal(recovery.isSavedRoomGoneError(new Error('network down')), false);
  assert.equal(recovery.isSavedRoomGoneError(null), false);
});

test('保存解除はroom/seatの2キーだけ', () => {
  const removed = [];
  recovery.clearSavedRoom({ removeItem: (key) => removed.push(key) });
  assert.deepEqual(removed.sort(), ['mofumofuRoomId', 'mofumofuSeatId']);
});

test('recoveryでstate破棄・UI復帰・接続完了になる', () => {
  const state = { roomId: 'r', seatId: 'A', room: {}, cards: [1], presence: { x: 1 }, connectionId: 'c', connectionState: 'error', playingResumeKey: 'k', lastSuccessfulResumeRoomId: 'r', lastSuccessfulResumeAt: 123, makeRequest: {}, judgeRequest: {}, npcRequest: {}, proxyStartRequest: {}, proxyActionRequest: {} };
  const messages = [];
  let entryReset = false;
  const recover = recovery.createRoomGoneRecovery({ state, storage: { removeItem: () => {} }, message: (t) => messages.push(t), resetEntryView: () => { entryReset = true; } });
  recover();
  assert.equal(entryReset, true);
  assert.equal(state.roomId, null);
  assert.equal(state.seatId, null);
  assert.equal(state.room, null);
  assert.deepEqual(state.cards, []);
  assert.deepEqual(state.presence, {});
  assert.equal(state.connectionId, null);
  assert.equal(state.connectionState, 'connected');
  assert.match(messages[0], /接続しました。/);
});

test('実行経路: fullResumeのcatchでrecoveryを呼ぶ', () => {
  assert.ok(script.includes("import { isSavedRoomGoneError, createRoomGoneRecovery } from './room-recovery.js?v=20260925-3';"));
  assert.ok(script.includes('if (isSavedRoomGoneError(error)) {'));
  assert.ok(script.includes('state.resumeGeneration += 1;'));
  assert.ok(script.indexOf('stopRealtime(generation);') < script.indexOf('isSavedRoomGoneError(error)'));
});

test('App Check関連は無変更', () => {
  assert.ok(functionsSource.includes("enforceAppCheck = process.env.MOFUMOFU_ENFORCE_APP_CHECK === 'true'"));
  assert.ok(script.includes('ReCaptchaEnterpriseProvider'));
  assert.ok(!script.includes('getToken('));
  assert.ok(entry.includes('ONLINE_PUBLIC_ENABLED = true'));
});

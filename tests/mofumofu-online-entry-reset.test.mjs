import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beginEntrySubmit, endEntrySubmit } from '../toybox/mofumofu-gathering/online/connection-control.js';
import { createRoomGoneRecovery } from '../toybox/mofumofu-gathering/online/room-recovery.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const script = read('toybox/mofumofu-gathering/online/script.js');
const html = read('toybox/mofumofu-gathering/online/index.html');
const entry = read('toybox/mofumofu-gathering/online-entry.js');
const recovery = read('toybox/mofumofu-gathering/online/room-recovery.js');

// script.js の renderEntry と同じ導出（DOMはstate.entryBusyだけから決まる）を検証用に再現する。
const entryDisabled = (state) => Boolean(state.entryBusy);

function runRecovery(state) {
  const recover = createRoomGoneRecovery({
    state,
    storage: { removeItem() {} },
    message() {},
    resetEntryView() {},
  });
  recover('部屋が閉じられました。');
  return state;
}

test('1. host close後（room消失）に入口のcreateはenabledへ戻る', () => {
  const state = { roomId: 'r', seatId: 'A', entryBusy: true, closeBusy: false };
  runRecovery(state);
  assert.equal(state.entryBusy, false);
  assert.equal(entryDisabled(state), false, 'create button must derive enabled from the released state');
});

test('2. close後も招待コード入力は利用可能（join inputを無効化しない）', () => {
  assert.equal(/\$\('invite-code'\)\.disabled/.test(script), false, 'the invite input is never disabled');
  const state = { roomId: 'r', seatId: 'A', entryBusy: true };
  runRecovery(state);
  assert.equal(entryDisabled(state), false);
});

test('3. close後もjoin buttonは正常（同じreleaseでenabled）', () => {
  assert.ok(script.includes("$('join-room').disabled = busy;"), 'renderEntry must also drive the join button');
  const state = { roomId: 'r', seatId: 'A', entryBusy: true };
  runRecovery(state);
  assert.equal(entryDisabled(state), false);
});

test('4. close後にもう一度create可能（stateが正常へ戻る）', () => {
  const state = { roomId: 'r', seatId: 'A', entryBusy: true };
  runRecovery(state);
  assert.equal(state.roomId, null);
  assert.equal(entryDisabled(state), false);
  assert.equal(beginEntrySubmit(state), true, 'a fresh create submit is accepted again');
});

test('5. create二重送信防止は維持（submit中の2回目は拒否）', () => {
  const state = { entryBusy: false };
  assert.equal(beginEntrySubmit(state), true);
  assert.equal(beginEntrySubmit(state), false, 'a second submit while in-flight must be rejected');
  assert.ok(script.includes('if (!beginEntrySubmit(state)) return;'), 'create handler must guard with beginEntrySubmit');
});

test('6. join二重送信防止は維持（submit中の2回目は拒否）', () => {
  const state = { entryBusy: false };
  assert.equal(beginEntrySubmit(state), true);
  assert.equal(beginEntrySubmit(state), false);
  const joinBlock = script.slice(script.indexOf("$('join-form').addEventListener"), script.indexOf("$('start-game').addEventListener"));
  assert.ok(joinBlock.includes('if (!beginEntrySubmit(state)) return;'), 'join handler must guard with beginEntrySubmit');
});

test('7. 送信中は従来どおりdisabledを維持（早すぎる再enabledをしない）', () => {
  const state = { entryBusy: false };
  beginEntrySubmit(state);
  assert.equal(entryDisabled(state), true, 'while a submit is in flight the entry stays disabled');
  assert.equal(beginEntrySubmit(state), false);
});

test('8. room recovery後も入口操作可能', () => {
  const state = { roomId: 'r', seatId: 'B', room: {}, entryBusy: true, cards: [] };
  runRecovery(state);
  assert.equal(entryDisabled(state), false);
  assert.ok(recovery.includes('state.entryBusy = false;'), 'the shared recovery must release the entry in-flight state');
});

test('9. B側room消失後も入口操作可能（host closeと共通経路）', () => {
  assert.ok(script.includes('function handleRoomGone(notice = null) {'));
  assert.ok(script.includes('recoverFromRoomGone(notice);'));
  // B側のroom消失検知（Firestore listener / safety sync）は同じ handleRoomGone を通る。
  assert.ok(script.includes('if (!snap.exists()) { handleRoomGone(roomGoneNotice(state.room)); return; }'));
  const state = { roomId: 'r', seatId: 'B', entryBusy: true };
  runRecovery(state);
  assert.equal(entryDisabled(state), false);
});

test('10. close失敗時はroom画面を勝手に解除しない', () => {
  const confirm = script.slice(script.indexOf("$('close-room-confirm').addEventListener"), script.indexOf("document.addEventListener('visibilitychange'"));
  const catchLine = confirm.slice(confirm.indexOf('catch (error)'));
  assert.ok(catchLine.includes('message(error.message)'), 'a failed close surfaces the error');
  assert.equal(catchLine.includes('handleRoomGone'), false, 'a failed close must not tear the room down');
  assert.ok(confirm.slice(0, confirm.indexOf('catch (error)')).includes("handleRoomGone('部屋を閉じました。')"), 'only the success path tears the room down');
});

test('11. キャンセル時は状態変更なし', () => {
  const cancel = script.slice(script.indexOf("$('close-room-cancel').addEventListener"), script.indexOf("$('close-room-confirm').addEventListener"));
  assert.ok(cancel.includes("$('close-room-dialog').close()"));
  assert.equal(/handleRoomGone|recoverFromRoomGone|entryBusy/.test(cancel), false, 'cancel must only close the dialog');
});

test('12. CLOSE_ROOM_ENABLED=false維持', () => {
  assert.ok(script.includes('const CLOSE_ROOM_ENABLED = false;'));
  assert.ok(script.includes("$('close-room').hidden = !(CLOSE_ROOM_ENABLED && hostWaitingRoom(room));"));
});

test('13. ONLINE_PUBLIC_ENABLED=true維持', () => {
  assert.ok(entry.includes('const ONLINE_PUBLIC_ENABLED = true;'));
  assert.ok(html.includes('id="onlineEntry"') || entry.includes("getElementById('onlineEntry')"));
});

test('14a. create/join成功時もfinallyでin-flightを解放する（disabled残留の回帰防止）', () => {
  const createBlock = script.slice(script.indexOf("$('create-room').addEventListener"), script.indexOf("$('join-form').addEventListener"));
  assert.ok(createBlock.includes('finally { endEntrySubmit(state); renderEntry(); }'), 'create must release on success and failure');
  const joinBlock = script.slice(script.indexOf("$('join-form').addEventListener"), script.indexOf("$('start-game').addEventListener"));
  assert.ok(joinBlock.includes('finally { endEntrySubmit(state); renderEntry(); }'), 'join must release on success and failure');
});

test('14b. 入口renderはstateから導出し、recovery後に再renderされる', () => {
  assert.ok(script.includes('function renderEntry() { const busy = Boolean(state.entryBusy);'));
  const reset = script.slice(script.indexOf('resetEntryView: () => {'), script.indexOf('function setConnectionState'));
  assert.ok(reset.includes('renderEntry();'), 'resetEntryView must re-render the entry from state');
});

test('14c. endEntrySubmit は in-flight を解放する（state単体）', () => {
  const state = { entryBusy: false };
  beginEntrySubmit(state);
  endEntrySubmit(state);
  assert.equal(state.entryBusy, false);
});

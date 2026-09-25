import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { roomGoneNotice, createRoomGoneRecovery } from '../toybox/mofumofu-gathering/online/room-recovery.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const functions = read('functions/mofumofu-online/index.js');
const aggregator = read('functions/index.js');
const client = read('toybox/mofumofu-gathering/online/script.js');
const html = read('toybox/mofumofu-gathering/online/index.html');
const recovery = read('toybox/mofumofu-gathering/online/room-recovery.js');
const closeFn = functions.slice(functions.indexOf('async function closeHandler'), functions.indexOf('const createMofumofuRoom = onCall'));
const constants = functions.slice(functions.indexOf('const CREATE_UID_RATE_LIMIT'), functions.indexOf('function runtimeProjectId'));

test('close callable is individually deployable and registered for the emulator harness', () => {
  assert.ok(functions.includes('const closeMofumofuRoom = onCall(callableOptions, closeHandler);'));
  assert.ok(functions.includes('  closeMofumofuRoom,'));
  assert.ok(functions.includes('proxyActionHandler, closeHandler },'));
  assert.ok(aggregator.includes('exports.closeMofumofuRoom = mofumofuOnline.closeMofumofuRoom;'));
  assert.ok(closeFn.includes("exactFields(request.data, ['roomId', 'actionId']);"));
  assert.ok(closeFn.includes('actionIdFrom(request.data)'));
});

test('close reuses the existing actionId + fingerprint idempotency', () => {
  assert.ok(closeFn.includes("const fingerprint = actionFingerprint('close', uid, roomId, {});"));
  assert.ok(closeFn.includes('replayAction(initialActionSnap.data(), fingerprint)'));
  assert.ok(closeFn.includes('replayAction(actionSnap.data(), fingerprint)'));
  assert.ok(closeFn.indexOf('initialActionSnap') < closeFn.indexOf('consumeRateLimit'), 'a replay must be answered before the rate limit');
  assert.ok(closeFn.includes('tx.create(r.action(actionId), { fingerprint, stateToken'));
});

test('close reuses the existing rate-limit design, with no new secret and no plaintext IP', () => {
  assert.ok(constants.includes('const CREATE_UID_RATE_LIMIT = 6;'));
  assert.ok(functions.includes('consumeRateLimit(`create_uid_${digest(uid)}`, CREATE_UID_RATE_LIMIT)'));
  assert.ok(closeFn.includes('consumeRateLimit(`close_uid_${digest(uid)}`, CREATE_UID_RATE_LIMIT, now)'));
  assert.ok(closeFn.includes('consumeRateLimit(`close_ip_${ipHash(request)}`, IP_RATE_LIMIT, now)'));
  assert.equal(closeFn.includes('defineSecret('), false, 'close must not define a new secret');
  assert.equal(/(?:ip|address|remoteAddress)\s*:\s*requestIp\(/.test(closeFn), false, 'no plaintext IP writes');
  assert.equal(functions.match(/defineSecret\(/g).length, 1, 'only the existing HMAC secret exists');
});

test('close is host-only, waiting-only, invalidates the invite, and deletes like the existing cleanup', () => {
  assert.ok(closeFn.includes("if (room.hostUid !== uid) fail('permission-denied'"));
  assert.ok(closeFn.includes("if (room.status !== 'waiting') fail('failed-precondition'"));
  const txBody = closeFn.slice(closeFn.indexOf('runTransaction'), closeFn.indexOf('recursiveDelete'));
  for (const token of ['room.hostUid !== uid', "room.status !== 'waiting'", "tx.update(inviteRef, { status: 'closed', revokedAt: now })"]) assert.ok(txBody.includes(token), `the transaction must settle ${token}`);
  assert.ok(closeFn.indexOf('recursiveDelete(r.room)') > closeFn.indexOf('runTransaction'), 'the delete runs after the transaction commits');
  assert.ok(closeFn.includes("collection('mofumofuOnlineRoomSecrets').doc(roomId).delete()"));
});

test('close tells a cleanup-removed room apart from a legitimate replay', () => {
  assert.ok(closeFn.includes("if (!roomSnap.exists) fail('not-found', '部屋が見つかりません。');"));
  assert.ok(closeFn.indexOf('initialActionSnap.exists') < closeFn.indexOf('if (!roomSnap.exists)'));
  assert.ok(closeFn.includes('initialActionSnap.exists) return replayAction'));
});

test('client keeps 部屋を閉じる gated until the callable is deployed', () => {
  assert.ok(client.includes('const CLOSE_ROOM_ENABLED = false;'));
  assert.ok(client.includes("$('close-room').hidden = !(CLOSE_ROOM_ENABLED && hostWaitingRoom(room));"));
  assert.ok(client.includes("$('close-room').addEventListener('click', () => { if (!CLOSE_ROOM_ENABLED || !hostWaitingRoom(state.room)) return;"));
  assert.ok(client.includes('if (!CLOSE_ROOM_ENABLED || state.closeBusy || !hostWaitingRoom(state.room)) return;'));
  assert.ok(client.includes("await call('closeMofumofuRoom', state.closeRequest);"));
  assert.equal(client.includes('console.log'), false, 'no console logging');
  assert.ok(html.includes('id="close-room" type="button" aria-haspopup="dialog" hidden'));
  const host = client.slice(client.indexOf('function hostWaitingRoom'), client.indexOf('function showRoom'));
  assert.ok(host.includes("room.status === 'waiting'") && host.includes('room.hostUid === auth.currentUser?.uid'), 'only the waiting host sees the button');
});

test('the confirm dialog uses the agreed wording', () => {
  assert.ok(html.includes('この部屋を閉じますか？'));
  assert.ok(html.includes('id="close-room-confirm"'));
  assert.ok(html.includes('id="close-room-cancel"'));
  assert.ok(html.includes('部屋を閉じる'));
  assert.ok(html.indexOf('この部屋を閉じますか？') > html.indexOf('id="close-room-dialog"'));
});

test('both seats return to the entry screen when the room disappears', () => {
  assert.ok(client.includes("handleRoomGone('部屋を閉じました。');"));
  assert.ok(client.includes('handleRoomGone(roomGoneNotice(state.room));'));
  assert.ok(client.includes('if (!snap.exists()) { handleRoomGone(roomGoneNotice(state.room)); return; }'));
  assert.ok(client.includes('function handleRoomGone(notice = null) {'));
  assert.ok(client.includes('recoverFromRoomGone(notice);'));
  assert.ok(recovery.includes('state.closeRequest = null;'));
  assert.ok(client.includes("'reconnect-wait', 'close-room']) $(id).hidden = true;"));
});

test('roomGoneNotice separates a host close from a TTL cleanup', () => {
  assert.equal(roomGoneNotice({ joinExpiresAt: { toMillis: () => 1_800_000_000_000 } }, 1_700_000_000_000), '部屋が閉じられました。');
  assert.equal(roomGoneNotice({ joinExpiresAt: { toMillis: () => 1 } }, 1_700_000_000_000), '保存していた部屋は終了しました。接続しました。');
  assert.equal(roomGoneNotice(null, 1_700_000_000_000), '保存していた部屋は終了しました。接続しました。');
});

test('recovery clears the saved room, seat, and dialog state', () => {
  const storage = { store: { mofumofuRoomId: 'r', mofumofuSeatId: 'A' }, removeItem(k) { delete this.store[k]; } };
  const state = { roomId: 'r', seatId: 'A', room: {}, cards: [1], presence: {}, connectionId: 'c', closeRequest: { roomId: 'r' }, closeBusy: true };
  let shown = null; let reset = false;
  const recover = createRoomGoneRecovery({ state, storage, message: (text) => { shown = text; }, resetEntryView: () => { reset = true; } });
  recover('部屋が閉じられました。');
  assert.equal(shown, '部屋が閉じられました。');
  assert.equal(state.roomId, null);
  assert.equal(state.closeRequest, null);
  assert.equal(state.closeBusy, false);
  assert.equal(reset, true);
  assert.equal(storage.store.mofumofuRoomId, undefined);
  assert.equal(storage.store.mofumofuSeatId, undefined);
});

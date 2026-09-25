import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

test('online UI renders the solo-game step flow', () => {
  const html = read('toybox/mofumofu-gathering/online/index.html');
  for (const token of ['id="claimButtons"', 'id="targetButtons"', 'id="judgeHand"', 'id="presence-list"', 'id="self-seat"', 'id="log"', 'id="tableCardSub"', 'data-judgment="truth"', 'data-judgment="lie"', '① 渡すカードを選ぶ', '② 何の動物だと言う？', '③ 誰に渡す？', 'おはなし']) assert.ok(html.includes(token), `index.html missing ${token}`);
  assert.ok(!html.includes('<select'), 'index.html must not use select elements');
  assert.ok(!html.includes('id="offer-card"'), 'index.html must not keep the old offer select');
});

test('online script drives the new UI without legacy ids', () => {
  const script = read('toybox/mofumofu-gathering/online/script.js');
  for (const token of ['ui.selectedUid', 'ui.claim', 'claimButtons', 'targetButtons', 'dataset.target', 'seatNode', 'renderLobbySeats', 'pushLog', 'observeRoomEvents', 'tableCardMain']) assert.ok(script.includes(token), `script.js missing ${token}`);
  for (const token of ["$('offer-card')", "$('claim-animal')", "$('target-player')", "$('elimination-notice')", "$('offer')", '<option']) assert.ok(!script.includes(token), `script.js must not use ${token}`);
});

test('online cards use the official artwork and keep labels accessible', () => {
  const script = read('toybox/mofumofu-gathering/online/script.js');
  assert.equal(script.split("node.append(cardImage(card.animalType, ''))").length - 1, 2, 'hand and judge-hand cards must both use the official image');
  assert.ok(script.includes("cardImage(offer.claimAnimal, labels[offer.claimAnimal])"), 'table card must use the official image');
  assert.ok(script.includes("polar: 'polar-bear.png'"), 'all 8 animal ids must map to the official files');
});

test('online renders the gathering loss, two winners, and the one-time logo show', () => {
  const script = read('toybox/mofumofu-gathering/online/script.js');
  for (const token of ['Array.isArray(finalResult.winnerPlayerIds)', 'gatheringReasonText', 'showGatheringLogo', 'ui.gatheringShown = true', "winnerPlayerIds.includes(player.playerId)"]) assert.ok(script.includes(token), `script.js missing ${token}`);
  assert.ok(!script.includes('もふもふ回避'), 'the gathering result must not reuse the solo save title');
  const html = read('toybox/mofumofu-gathering/online/index.html');
  for (const token of ['id="gathering-overlay"', 'assets/mofumofu-gathering/mofumofu-logo.png']) assert.ok(html.includes(token), `index.html missing ${token}`);
});

test('online labels use the viewer perspective', () => {
  const script = read('toybox/mofumofu-gathering/online/script.js');
  assert.ok(script.includes("playerId === state.seatId ? 'あなた' : '相手';"), 'seatName must speak from the viewer seat');
  assert.ok(!script.includes('プレイヤー'), 'script.js must not label seats as プレイヤー');
  const presence = script.slice(script.indexOf('function renderPresence() {'), script.indexOf('async function authorizePresence'));
  assert.ok(presence.includes('.filter((playerId) => playerId !== state.seatId)'), 'top seats exclude the viewer');
  assert.ok(presence.includes("$('self-seat').replaceChildren(seatNode(room, state.seatId, true))"), 'self seat is always rendered below');
  assert.ok(script.includes("showControlStatus(controlText, ownControl !== 'human')"), 'control-return notice is temporary while human');
  const html = read('toybox/mofumofu-gathering/online/index.html');
  assert.ok(html.includes('id="control-status" class="control-chip"'), 'control notice renders as a small chip, not a banner');
});

test('invite code is held in state and sessionStorage and restored only for the waiting host', () => {
  const script = read('toybox/mofumofu-gathering/online/script.js');
  for (const token of ['const INVITE_CODE_RE = /^[A-Za-z0-9]{8}$/;', 'function rememberInvite(roomId, code)', 'function restoreInvite(roomId)', 'function forgetInvite(roomId)', 'function renderInvite(room)', 'rememberInvite(value.roomId, value.inviteCode)', 'renderInvite(room);', "sessionStorage.setItem(inviteKey(roomId), code)", "sessionStorage.getItem(inviteKey(roomId))", "sessionStorage.removeItem(inviteKey(roomId))", 'forgetInvite(); remember(value.roomId, value.seatId)', 'forgetInvite(state.roomId);']) assert.ok(script.includes(token), `script.js missing ${token}`);
  assert.ok(!script.includes("$('shown-invite').textContent = value.inviteCode"), 'create must not write the code straight into the DOM only');
  assert.ok(!script.includes("localStorage.setItem('mofumofuInvite"), 'plain invite code must not go to localStorage');
  assert.ok(!script.includes('console.log'), 'no console logging');
  const renderBlock = script.slice(script.indexOf('function renderInvite(room)'), script.indexOf('function renderLobbySeats'));
  for (const token of ["room.status === 'waiting'", 'room.hostUid === auth.currentUser?.uid', "state.seatId === 'A'", '部屋をつくり直してください。']) assert.ok(renderBlock.includes(token), `renderInvite missing ${token}`);
  const resetBlock = script.slice(script.indexOf('resetEntryView: () => {'), script.indexOf('function setConnectionState'));
  assert.ok(resetBlock.includes('forgetInvite();'), 'room recovery must clear the stored invite');
  const html = read('toybox/mofumofu-gathering/online/index.html');
  assert.ok(html.includes('id="invite-note"'), 'note must be script-driven');
  const entry = read('toybox/mofumofu-gathering/online-entry.js');
  assert.ok(entry.includes('const ONLINE_PUBLIC_ENABLED = true;'), 'public flag stays enabled');
});

test('lobby keeps the room id small and auxiliary and gives the waiting host an invite-only copy button', () => {
  const script = read('toybox/mofumofu-gathering/online/script.js');
  const html = read('toybox/mofumofu-gathering/online/index.html');
  const css = read('toybox/mofumofu-gathering/online/style.css');
  for (const token of ['async function copyText(value, button, resetLabel)', 'await navigator.clipboard.writeText(value)', "document.execCommand('copy')", 'コピーしました！', 'コピーできませんでした', "$('copy-invite').addEventListener", "$('copy-room-id').addEventListener", "copyText(code, $('copy-invite'), 'コピー')", "copyText(state.roomId, $('copy-room-id'), '部屋IDをコピー')", 'ui.copyTimer']) assert.ok(script.includes(token), `script.js missing ${token}`);
  assert.ok(!script.includes('console.log'), 'no console logging');
  assert.ok(!script.includes('clipboard.writeText(`'), 'clipboard must never get a composed payload');
  assert.ok(script.includes("$('room-id').textContent = state.roomId ? `${state.roomId.slice(0, 8)}…` : '';"), 'room id must be abbreviated on screen');
  assert.ok(!script.includes("$('room-id').textContent = state.roomId;"), 'the full uuid must not be displayed as-is');
  assert.ok(script.includes("$('room-id').setAttribute('aria-label', $('room-id').title);"), 'full room id stays reachable for assistive tech');
  const renderBlock = script.slice(script.indexOf('function renderInvite(room)'), script.indexOf('function renderLobbySeats'));
  for (const token of ["$('copy-invite').hidden = true;", "$('copy-invite').hidden = !code;"]) assert.ok(renderBlock.includes(token), `renderInvite missing ${token}`);
  for (const token of ['id="copy-invite"', 'id="copy-room-id"', '部屋IDをコピー', '部屋ID：', 'class="invite-box"']) assert.ok(html.includes(token), `index.html missing ${token}`);
  assert.ok(html.includes('id="copy-invite" type="button" hidden'), 'copy button starts hidden');
  assert.ok(!html.includes('部屋 <span id="room-id"'), 'the huge uuid headline must be gone');
  for (const token of ['.room-id-line{', '.invite-box{', '.invite-copy{', 'min-height:44px']) assert.ok(css.includes(token), `style.css missing ${token}`);
  const entry = read('toybox/mofumofu-gathering/online-entry.js');
  assert.ok(entry.includes('const ONLINE_PUBLIC_ENABLED = true;'), 'public flag stays enabled');
});

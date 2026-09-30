import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const requireFunctions = createRequire(new URL('../functions/package.json', import.meta.url));
const contract = requireFunctions('./mofumofu-multi/contract.js');
const rules = requireFunctions('./mofumofu-multi/rules.js');
const client = await import('../toybox/mofumofu-gathering/online/multi/multi-leave.js');
const resume = await import('../toybox/mofumofu-gathering/online/multi/multi-resume.js');
const script = readFileSync(new URL('../toybox/mofumofu-gathering/online/multi/script.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../toybox/mofumofu-gathering/online/multi/index.html', import.meta.url), 'utf8');
const server = readFileSync(new URL('../functions/mofumofu-multi/index.js', import.meta.url), 'utf8');
const storage = () => {
  const items = new Map();
  return { getItem: (key) => items.get(key) || null, setItem: (key, value) => items.set(key, value),
    removeItem: (key) => items.delete(key) };
};
const playing = (count = 4) => {
  const seatOrder = rules.SEAT_IDS.slice(0, count);
  const state = rules.createInitialState({ playerCount: count, idFactory: (() => {
    let id = 0; return () => String(++id);
  })(), randomInt: (max) => Math.floor(max / 2) });
  state.seatOrder = seatOrder;
  return state;
};

test('既存leaveGame: 4人継続、次手番と非手番、秘密手札・捨て札、left席の除外', () => {
  const base = playing();
  const oldHand = [...base.hands.S1];
  const next = rules.leaveGame(base, 'S1');
  assert.equal(next.status, 'playing');
  assert.equal(next.currentTurnPlayerId, 'S2');
  assert.deepEqual(next.hands.S1, []);
  assert.deepEqual(next.discard, oldHand);
  assert.equal(next.handCounts.S1, 0);
  assert.equal(contract.roomWritesAfterLeave(next).playerStatus.S1, 'left');
  assert.deepEqual(next.faceUpCards.S1, base.faceUpCards.S1);
  assert.equal(rules.validTargets(next, 'S2').includes('S1'), false);
  const later = rules.leaveGame(playing(5), 'S5');
  assert.equal(later.currentTurnPlayerId, 'S1');
  assert.equal(later.status, 'playing');
});

test('既存leaveGame: 3人から2人で終了、判定待ち当事者拒否・非当事者可', () => {
  const state = playing(3);
  const ended = rules.leaveGame(state, 'S3');
  assert.equal(ended.finishReason, 'too-few-active');
  assert.deepEqual(ended.winnerPlayerIds, ['S1', 'S2']);
  assert.deepEqual(ended.leftPlayerIds, ['S3']);
  assert.equal(ended.finalResult.players.find((player) => player.seatId === 'S3').status, 'left');
  const four = playing();
  const offered = rules.applyOffer(four, { fromPlayerId: 'S1', toPlayerId: 'S2',
    cardId: four.hands.S1[0].cardId, claimAnimal: four.hands.S1[0].animalType });
  for (const seat of ['S1', 'S2']) assert.throws(() => contract.runRules(() => rules.leaveGame(offered, seat)),
    (error) => error.code === 'failed-precondition' && /判定/.test(error.message));
  const after = rules.leaveGame(offered, 'S3');
  assert.deepEqual(contract.serverStateAfterOffer(after, 1).pendingOffer, offered.pendingOffer);
  assert.equal(after.status, 'playing');
});

test('playing activeだけ退出導線、判定当事者には理由、finishedは別の新しく遊ぶ', () => {
  const state = { roomId: 'r', seatId: 'S1', connectionState: 'connected',
    room: { status: 'playing', playerStatus: { S1: 'active' } }, leaveBusy: false };
  assert.deepEqual(client.leaveView(state), { visible: true, label: 'ゲームから退出', disabled: false, note: '' });
  const pending = { ...state, room: { ...state.room, publicOffer: { status: 'pending', fromPlayerId: 'S1', toPlayerId: 'S2' } } };
  assert.equal(client.leaveView(pending).disabled, true);
  assert.match(client.leaveView(pending).note, /判定/);
  assert.equal(client.leaveView({ ...state, room: { status: 'waiting' } }).visible, false);
  assert.equal(client.leaveView({ ...state, room: { status: 'finished' } }).visible, false);
  assert.equal(client.leaveView({ ...state, connectionState: 'syncing' }).disabled, true);
  assert.match(html, /id="leave-game"/);
  assert.match(html, /id="new-game"/);
  assert.match(script, /globalThis\.confirm\('このゲームから退出しますか/);
  assert.doesNotMatch(script, /visibilitychange[^\n]*leaveMofumofuMultiGame|pageshow[^\n]*leaveMofumofuMultiGame/);
});

test('通信不明の元actionIdを保存・再読込し、成功後だけ端末を解除する', async () => {
  const local = storage();
  const request = { roomId: 'r', actionId: 'a' };
  client.saveLeaveRequest(local, request);
  assert.deepEqual(client.loadLeaveRequest(local, 'r'), request);
  assert.equal(client.loadLeaveRequest(local, 'other'), null);
  await assert.rejects(client.boundedLeaveResult(new Promise(() => {}), 1), /leave-result-timeout/);
  assert.deepEqual(client.loadLeaveRequest(local, 'r'), request);
  client.clearLeaveRequest(local);
  assert.equal(client.loadLeaveRequest(local, 'r'), null);
  assert.match(script, /if \(!existing\) \{\s*saveLeaveRequest/);
  assert.match(script, /const request = existing \|\| \{ roomId: state\.roomId, actionId: newId\(\) \}/);
  assert.match(script, /if \(result\?\.roomId !== request\.roomId\) throw/);
  assert.match(script, /clearMultiLocalRoom\(\{ state, storage: localStorage/);
  assert.match(script, /state\.leaveRequest = loadLeaveRequest\(localStorage, saved\.roomId\)/);
});

test('既存finished cleanupと新規入口を維持し、clientはFirestoreへ書かない', () => {
  assert.equal(resume.canForgetFinishedRoom({ roomId: 'r', seatId: 'S1', room: { status: 'finished' },
    finishedConfirmedRoomId: 'r', connectionState: 'connected' }), true);
  assert.equal(resume.canForgetFinishedRoom({ roomId: 'r', seatId: 'S1', room: { status: 'finished' },
    finishedConfirmedRoomId: 'r', connectionState: 'connected', leaveRequest: { roomId: 'r' } }), false);
  assert.doesNotMatch(script, /\b(setDoc|updateDoc|deleteDoc|addDoc)\b/);
  assert.match(script, /clearTimeout\(ui\.flashTimer\); clearTimeout\(ui\.logoTimer\); clearTimeout\(ui\.copyTimer\)/);
  assert.match(server, /const leaveMofumofuMultiGame = onCall\(callableOptions/);
  assert.match(server, /const seatId = seatIdOrNull\(memberSnap\.exists \? memberSnap\.data\(\) : null\)/);
  assert.match(server, /tx\.set\(r\.server, contract\.serverStateAfterOffer\(next, deleteAt\)\)/);
  assert.match(server, /const roomWrites = contract\.roomWritesAfterLeave\(next\)/);
});

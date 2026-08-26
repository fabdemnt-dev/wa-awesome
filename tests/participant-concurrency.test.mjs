import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeParticipantRoles,
  setParticipantRole,
  hasParticipantRoleOverlap,
  canClaimHost,
} from '../participant-utils.js';

// Firestore transactionが競合後に最新スナップショットで再実行される動作を、
// 純粋関数へ順番に適用することで再現する。
function applyRoleUpdate(data, name, role) {
  return { ...data, ...setParticipantRole(data, name, role) };
}

test('異なる参加者の同時入室を再試行モデルで保持する', () => {
  const initial = { players: ['ホスト'], spectators: [] };
  const afterA = applyRoleUpdate(initial, 'あ', 'player');
  const afterB = applyRoleUpdate(afterA, 'い', 'player');

  assert.deepEqual(afterB.players, ['ホスト', 'あ', 'い']);
  assert.deepEqual(afterB.spectators, []);
  assert.deepEqual(hasParticipantRoleOverlap(afterB), []);
});

test('同じ名前の同時操作は最後に確定した役割だけを残す', () => {
  const initial = { players: ['ホスト'], spectators: [] };
  const afterPlayer = applyRoleUpdate(initial, '参加者', 'player');
  const afterSpectatorRetry = applyRoleUpdate(afterPlayer, '参加者', 'spectator');

  assert.deepEqual(afterSpectatorRetry.players, ['ホスト']);
  assert.deepEqual(afterSpectatorRetry.spectators, ['参加者']);
  assert.deepEqual(hasParticipantRoleOverlap(afterSpectatorRetry), []);
});

test('既存の壊れた重複データを含む状態でも次の更新で重複を解消する', () => {
  const broken = { players: ['あ', '参加者'], spectators: ['参加者', 'い'] };
  const normalized = normalizeParticipantRoles(broken);
  const repaired = applyRoleUpdate(normalized, 'い', 'player');

  assert.deepEqual(repaired.players, ['あ', '参加者', 'い']);
  assert.deepEqual(repaired.spectators, []);
  assert.deepEqual(hasParticipantRoleOverlap(repaired), []);
});

test('空白だけの名前を役割更新で配列へ追加しない', () => {
  const result = applyRoleUpdate({ players: [], spectators: [] }, '   ', 'player');
  assert.deepEqual(result, { players: [], spectators: [] });
});

test('連続した役割切り替えでも参加者は一方の配列にしか存在しない', () => {
  let state = { players: ['ホスト'], spectators: [] };
  for (const role of ['spectator', 'player', 'spectator', 'player']) {
    state = applyRoleUpdate(state, '参加者', role);
    assert.deepEqual(hasParticipantRoleOverlap(state), []);
    assert.equal(
      Number(state.players.includes('参加者')) + Number(state.spectators.includes('参加者')),
      1,
    );
  }
  assert.deepEqual(state.players, ['ホスト', '参加者']);
  assert.deepEqual(state.spectators, []);
});

test('ラウンド中は別プレイヤーだけが親を引き継げる', () => {
  const playing = { status: 'playing', players: ['親', '子'], currentHost: '親' };

  assert.equal(canClaimHost(playing, '子'), true);
  assert.equal(canClaimHost(playing, '親'), false);
  assert.equal(canClaimHost(playing, '見学者', true), false);
});

test('親が既にplayersから消えた状態では手動引き継ぎ判定を許可しない', () => {
  const hostMissing = { status: 'playing', players: ['子'], currentHost: '親' };
  const notPlaying = { status: 'lobby', players: ['親', '子'], currentHost: '親' };

  assert.equal(canClaimHost(hostMissing, '子'), false);
  assert.equal(canClaimHost(notPlaying, '子'), false);
  assert.equal(canClaimHost({ status: 'playing', players: ['親', '子'] }, '子'), false);
});

export { applyRoleUpdate };

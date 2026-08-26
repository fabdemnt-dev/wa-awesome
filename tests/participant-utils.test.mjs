import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeParticipantName,
  setParticipantRole,
  normalizeParticipantRoles,
  hasParticipantRoleOverlap,
  isValidParticipantName,
  getParticipantStorageKey,
  getParticipantNameByUid,
  getParticipantUidByName,
  migrateParticipantMapToUids,
} from '../participant-utils.js';

test('名前の前後の空白を取り除く', () => {
  assert.equal(normalizeParticipantName('  ひなた  '), 'ひなた');
  assert.equal(isValidParticipantName('  ひなた  '), true);
  assert.equal(isValidParticipantName('   '), false);
});

test('プレイヤーへ移動すると見学者側から削除する', () => {
  assert.deepEqual(
    setParticipantRole({ players: ['あ'], spectators: ['ひなた', 'い'] }, ' ひなた ', 'player'),
    { players: ['あ', 'ひなた'], spectators: ['い'] },
  );
});

test('見学者へ移動するとプレイヤー側から削除する', () => {
  assert.deepEqual(
    setParticipantRole({ players: ['ひなた', 'あ'], spectators: ['い'] }, 'ひなた', 'spectator'),
    { players: ['あ'], spectators: ['い', 'ひなた'] },
  );
});

test('既存の重複データはプレイヤー優先で正規化する', () => {
  const data = { players: ['ひなた', 'ひなた', 'あ'], spectators: ['ひなた', 'い', 'い'] };
  assert.deepEqual(normalizeParticipantRoles(data), {
    players: ['ひなた', 'あ'],
    spectators: ['い'],
  });
  assert.deepEqual(hasParticipantRoleOverlap(normalizeParticipantRoles(data)), []);
});

test('対象外の参加者を変更しない', () => {
  assert.deepEqual(
    setParticipantRole({ players: ['あ'], spectators: ['い'] }, 'う', 'player'),
    { players: ['あ', 'う'], spectators: ['い'] },
  );
});

test('UID対応ルームでは個人データのキーにUIDを使う', () => {
  const data = { participantUids: { 'uid-a': 'あ' } };
  assert.equal(getParticipantStorageKey(data, 'uid-a', 'あ'), 'uid-a');
  assert.equal(getParticipantNameByUid(data, 'uid-a'), 'あ');
  assert.equal(getParticipantUidByName(data, 'あ'), 'uid-a');
});

test('旧形式ルームでは表示名キーへフォールバックする', () => {
  assert.equal(getParticipantStorageKey({}, 'uid-a', 'あ'), 'あ');
  assert.equal(getParticipantNameByUid({}, 'uid-a'), '');
  assert.equal(getParticipantUidByName({}, 'あ'), '');
});

test('表示名キーの個人データをUIDキーへ移行し、未対応データを保持する', () => {
  const data = { participantUids: { 'uid-a': 'あ', 'uid-b': 'い' } };
  assert.deepEqual(
    migrateParticipantMapToUids(data, { あ: ['札A'], い: ['札B'], legacy: ['旧データ'] }),
    { あ: ['札A'], い: ['札B'], legacy: ['旧データ'], 'uid-a': ['札A'], 'uid-b': ['札B'] },
  );
});

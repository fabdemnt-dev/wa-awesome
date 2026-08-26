import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeParticipantName,
  setParticipantRole,
  normalizeParticipantRoles,
  hasParticipantRoleOverlap,
  isValidParticipantName,
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

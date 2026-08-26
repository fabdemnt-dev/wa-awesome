import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getLegacyHaikuHand,
  requireHandUid,
  usesHandSubcollection,
} from '../haiku-hand-storage.js';

test('schemaVersion 2だけが手札サブコレクション形式になる', () => {
  assert.equal(usesHandSubcollection({ schemaVersion: 2 }), true);
  assert.equal(usesHandSubcollection({ schemaVersion: 1 }), false);
  assert.equal(usesHandSubcollection({}), false);
});

test('旧形式の表示名キー手札を読み取れる', () => {
  const data = { hands5: { ひなた: [{ id: 'a' }] }, hands7: { ひなた: [{ id: 'b' }] } };
  assert.deepEqual(getLegacyHaikuHand(data, 5, 'uid-a', 'ひなた'), [{ id: 'a' }]);
  assert.deepEqual(getLegacyHaikuHand(data, 7, 'uid-a', 'ひなた'), [{ id: 'b' }]);
});

test('UID対応済み旧データではUIDキーを優先して読む', () => {
  const data = {
    participantUids: { 'uid-a': 'ひなた' },
    hands5: { 'uid-a': [{ id: 'uid' }], ひなた: [{ id: 'name' }] },
  };
  assert.deepEqual(getLegacyHaikuHand(data, 5, 'uid-a', 'ひなた'), [{ id: 'uid' }]);
});

test('存在しない形式や種類は空配列を返す', () => {
  assert.deepEqual(getLegacyHaikuHand({}, 5, 'uid-a', 'ひなた'), []);
  assert.deepEqual(getLegacyHaikuHand({ hands5: [] }, 5, 'uid-a', 'ひなた'), []);
  assert.deepEqual(getLegacyHaikuHand({ hands5: { ひなた: ['札'] } }, 6, 'uid-a', 'ひなた'), []);
});

test('手札ドキュメントIDにはUIDだけを受け付ける', () => {
  assert.equal(requireHandUid('uid-a'), 'uid-a');
  assert.throws(() => requireHandUid(''), /不正/);
  assert.throws(() => requireHandUid('rooms/other'), /不正/);
  assert.throws(() => requireHandUid('..'), /不正/);
});

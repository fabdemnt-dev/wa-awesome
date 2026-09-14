'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareCopyState, resolveRound } = require('../moon-scale-duel-online/rules');

const base = (overrides = {}) => ({ round: 1, moonShadow: { seat1: 10, seat2: 10 }, ...overrides });

test('満ちる月・欠ける月・上下限をCPU版と同じ順序で解決する', () => {
  const result = resolveRound(base({ actualCards: { seat1: 'waxing', seat2: 'waning' } }));
  assert.deepEqual(result.moonShadowAfter, { seat1: 10, seat2: 10 });
  assert.deepEqual(resolveRound(base({ moonShadow: { seat1: 14, seat2: 2 }, actualCards: { seat1: 'waxing', seat2: 'waning' } })).moonShadowAfter, { seat1: 14, seat2: 2 });
});

test('返照は1枚で増減を反転し、2枚では相殺する', () => {
  const one = resolveRound(base({ actualCards: { seat1: 'reflection', seat2: 'waxing' } }));
  assert.equal(one.reversed, true);
  assert.deepEqual(one.moonShadowAfter, { seat1: 10, seat2: 7 });
  const two = resolveRound(base({ actualCards: { seat1: 'reflection', seat2: 'reflection' } }));
  assert.equal(two.reversed, false);
  assert.equal(two.reflectionCount, 2);
  assert.deepEqual(two.moonShadowAfter, { seat1: 10, seat2: 10 });
});

test('静止は相手だけを無効化し、静止同士は相殺する', () => {
  const blocked = resolveRound(base({ actualCards: { seat1: 'stillness', seat2: 'waxing' } }));
  assert.equal(blocked.effects.seat2.status, 'blocked');
  assert.deepEqual(blocked.moonShadowAfter, { seat1: 10, seat2: 10 });
  const both = resolveRound(base({ actualCards: { seat1: 'stillness', seat2: 'stillness' } }));
  assert.equal(both.effects.seat1.status, 'resolved');
  assert.equal(both.effects.seat2.status, 'resolved');
});

test('新月の誓いは公開時に劣勢の側だけ成立する', () => {
  const valid = resolveRound(base({ moonShadow: { seat1: 5, seat2: 10 }, actualCards: { seat1: 'oath', seat2: 'waxing' } }));
  assert.deepEqual(valid.moonShadowAfter, { seat1: 7, seat2: 10 });
  const failed = resolveRound(base({ actualCards: { seat1: 'oath', seat2: 'waxing' } }));
  assert.equal(failed.effects.seat1.status, 'failed');
  assert.deepEqual(failed.moonShadowAfter, { seat1: 10, seat2: 13 });
});

test('偽りの月は未使用の合法札だけを候補にし、静止と候補0枚を処理する', () => {
  const normal = prepareCopyState({
    actualCards: { seat1: 'falseMoon', seat2: 'waxing' }, moonShadow: { seat1: 5, seat2: 10 },
    usedCards: { seat1: ['falseMoon', 'waxing'], seat2: ['waxing'] },
  });
  assert.deepEqual(normal.candidates.seat1, ['waning', 'reflection', 'oath']);
  assert.equal(normal.status.seat1, 'awaiting');
  const blocked = prepareCopyState({ actualCards: { seat1: 'falseMoon', seat2: 'stillness' }, moonShadow: { seat1: 10, seat2: 10 }, usedCards: { seat1: ['falseMoon'], seat2: ['stillness'] } });
  assert.equal(blocked.status.seat1, 'blocked');
  assert.deepEqual(blocked.candidates.seat1, []);
  const failed = prepareCopyState({ actualCards: { seat1: 'falseMoon', seat2: 'waxing' }, moonShadow: { seat1: 10, seat2: 10 }, usedCards: { seat1: ['falseMoon', 'waxing', 'waning', 'reflection', 'oath'], seat2: ['waxing'] } });
  assert.equal(failed.status.seat1, 'failed');
});

test('双方の偽りの月を独立した秘密候補として準備し、選択後に解決する', () => {
  const prepared = prepareCopyState({ actualCards: { seat1: 'falseMoon', seat2: 'falseMoon' }, moonShadow: { seat1: 6, seat2: 9 }, usedCards: { seat1: ['falseMoon'], seat2: ['falseMoon'] } });
  assert.equal(prepared.status.seat1, 'awaiting');
  assert.equal(prepared.status.seat2, 'awaiting');
  assert.equal(prepared.candidates.seat1.includes('oath'), true);
  assert.equal(prepared.candidates.seat2.includes('oath'), false);
  const result = resolveRound(base({ moonShadow: { seat1: 6, seat2: 9 }, actualCards: { seat1: 'falseMoon', seat2: 'falseMoon' }, copyTargets: { seat1: 'oath', seat2: 'waxing' }, falseStatus: { seat1: 'copied', seat2: 'copied' } }));
  assert.deepEqual(result.moonShadowAfter, { seat1: 7, seat2: 10 });
});

test('0到達と第6ラウンドの決着をCPU版と同様に判定する', () => {
  assert.equal(resolveRound(base({ moonShadow: { seat1: 3, seat2: 10 }, actualCards: { seat1: 'waxing', seat2: 'reflection' } })).outcome, 'seat2');
  assert.equal(resolveRound(base({ moonShadow: { seat1: 0, seat2: 0 }, actualCards: { seat1: 'stillness', seat2: 'stillness' } })).outcome, 'draw');
  assert.equal(resolveRound(base({ round: 6, moonShadow: { seat1: 9, seat2: 8 }, actualCards: { seat1: 'stillness', seat2: 'stillness' } })).outcome, 'seat1');
  assert.equal(resolveRound(base({ round: 6, moonShadow: { seat1: 8, seat2: 8 }, actualCards: { seat1: 'stillness', seat2: 'stillness' } })).outcome, 'draw');
});

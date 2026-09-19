'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGame, validateSubmission, resolveRound, totalValue } = require('../deep-mining-agreement-online/rules');

const members = (count) => Array.from({ length: count }, (_, index) => ({ seatId: `seat${index + 1}`, displayName: `P${index + 1}` }));
for (const count of [2, 3, 4]) {
  test(`${count}-player server game starts and finishes`, () => {
    const game = createGame(members(count), 123 + count);
    while (!game.ended) {
      for (const player of game.players.filter((item) => item.active)) game.submissions[player.id] = { action: 'reinforce', scout: false, accusationTarget: null };
      resolveRound(game);
    }
    assert.equal(game.endReason, 'rounds');
    assert.equal(game.history.length, 8);
    assert.ok(game.players.every((player) => Number.isFinite(totalValue(player))));
  });
}

test('secret action remains private while public history reports mining', () => {
  const game = createGame(members(2), 10); game.round = 3; game.detectedSecretMining = true;
  game.submissions = { seat1: { action: 'secret', scout: false, accusationTarget: null }, seat2: { action: 'mine', scout: false, accusationTarget: null } };
  resolveRound(game);
  assert.equal(game.history[0].publicActions.seat1, 'mine');
  assert.equal(game.players[0].secretOre[game.history[0].oreId], 1);
  assert.equal(game.history[0].secretCount, 1);
});

test('turn ownership rules reject unavailable, duplicate-target, and inactive actions', () => {
  const game = createGame(members(2), 10);
  assert.throws(() => validateSubmission(game, 'seat1', { action: 'secret' }), /選べません/);
  assert.throws(() => validateSubmission(game, 'seat9', { action: 'mine' }), /行動できません/);
  game.round = 3; game.detectedSecretMining = true;
  assert.throws(() => validateSubmission(game, 'seat1', { action: 'mine', accusationTarget: 'seat1' }), /告発対象/);
});

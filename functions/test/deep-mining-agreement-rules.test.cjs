'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGame, validateSubmission, resolveRound, totalValue, addNpcSubmissions } = require('../deep-mining-agreement-online/rules');

const members = (count) => Array.from({ length: count }, (_, index) => ({ seatId: `seat${index + 1}`, displayName: `P${index + 1}` }));
for (const count of [2, 3, 4]) {
  test(`${count} humans plus ${4 - count} NPCs start and finish as four seats`, () => {
    const game = createGame(members(count), 123 + count);
    assert.equal(game.players.length, 4);
    assert.equal(game.players.filter((player) => player.isHuman).length, count);
    assert.equal(game.players.filter((player) => !player.isHuman).length, 4 - count);
    while (!game.ended) {
      for (const player of game.players.filter((item) => item.active && item.isHuman)) game.submissions[player.id] = { action: 'reinforce', scout: false, accusationTarget: null };
      addNpcSubmissions(game);
      resolveRound(game);
    }
    assert.equal(game.endReason, 'rounds');
    assert.equal(game.history.length, 8);
    assert.ok(game.players.every((player) => Number.isFinite(totalValue(player))));
  });
}

test('secret action remains private while public history reports mining', () => {
  const game = createGame(members(2), 10); game.round = 3; game.detectedSecretMining = true;
  game.submissions = { seat1: { action: 'secret', scout: false, accusationTarget: null }, seat2: { action: 'mine', scout: false, accusationTarget: null } }; addNpcSubmissions(game);
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

test('NPC decisions are generated only for active NPC seats', () => {
  const game = createGame(members(2), 77);
  game.submissions.seat1 = { action: 'reinforce', scout: false, accusationTarget: null };
  game.submissions.seat2 = { action: 'reinforce', scout: false, accusationTarget: null };
  assert.deepEqual(Object.keys(game.submissions), ['seat1', 'seat2']);
  addNpcSubmissions(game);
  assert.deepEqual(Object.keys(game.submissions), ['seat1', 'seat2', 'seat3', 'seat4']);
  assert.ok(game.submissions.seat3.action);
  assert.ok(game.submissions.seat4.action);
});

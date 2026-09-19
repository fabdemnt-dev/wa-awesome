import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createGame, npcWeights as soloNpcWeights, simulateRemaining } from '../deep-mining-agreement/engine.js';

const require = createRequire(import.meta.url);
const onlineRules = require('../functions/deep-mining-agreement-online/rules.js');

test('existing solo game starts with one human and three CPUs and reaches a result', () => {
  const game = createGame({ seed: 42 });
  assert.equal(game.players.length, 4);
  assert.equal(game.players.filter((player) => player.isHuman).length, 1);
  simulateRemaining(game);
  assert.equal(game.ended, true);
  assert.ok(game.players.every((player) => Number.isInteger(player.rank)));
});

test('the shared solo engine remains a fixed four-seat game', () => {
  const game = createGame({ seed: 104 });
  assert.equal(game.players.length, 4);
  assert.equal(game.players.filter((player) => player.isHuman).length, 1);
  assert.equal(game.players.filter((player) => !player.isHuman).length, 3);
});

for (const humanCount of [2, 3, 4]) {
  test(`${humanCount} online humans produce exactly four ranked seats`, () => {
    const members = Array.from({ length: humanCount }, (_, index) => ({ seatId: `seat${index + 1}`, displayName: `P${index + 1}` }));
    const game = onlineRules.createGame(members, 200 + humanCount);
    while (!game.ended) {
      for (const player of game.players.filter((item) => item.active && item.isHuman)) game.submissions[player.id] = { action: 'reinforce', scout: false, accusationTarget: null };
      onlineRules.addNpcSubmissions(game);
      onlineRules.resolveRound(game);
    }
    assert.equal(game.players.length, 4);
    assert.equal(game.players.filter((player) => player.isHuman).length, humanCount);
    assert.equal(game.history.length, 8);
    assert.ok(game.players.every((player) => Number.isInteger(player.rank)));
  });
}

test('online NPC action weights stay aligned with the solo NPC logic', () => {
  const solo = createGame({ seed: 303 });
  const online = onlineRules.createGame([
    { seatId: 'seat1', displayName: 'P1' },
    { seatId: 'seat2', displayName: 'P2' },
  ], 303);
  for (const profile of ['greedy', 'tactician']) {
    const soloNpc = solo.players.find((player) => player.profile === profile);
    const onlineNpc = online.players.find((player) => player.profile === profile);
    for (const round of [1, 3, 5, 8]) {
      solo.round = round;
      online.round = round;
      solo.danger = 65;
      online.danger = 65;
      assert.deepEqual(onlineRules.npcWeights(online, onlineNpc), soloNpcWeights(solo, soloNpc));
    }
  }
});

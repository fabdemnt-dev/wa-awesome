import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, resolveRound, simulateRemaining, totalValue } from '../deep-mining-agreement/engine.js';

test('existing solo game starts with one human and three CPUs and reaches a result', () => {
  const game = createGame({ seed: 42 });
  assert.equal(game.players.length, 4);
  assert.equal(game.players.filter((player) => player.isHuman).length, 1);
  simulateRemaining(game);
  assert.equal(game.ended, true);
  assert.ok(game.players.every((player) => Number.isInteger(player.rank)));
});

for (const count of [2, 3, 4]) {
  test(`${count} human players can complete the same eight-round game`, () => {
    const players = Array.from({ length: count }, (_, index) => ({ id: `seat${index + 1}`, name: `P${index + 1}`, isHuman: true }));
    const game = createGame({ seed: 100 + count, players });
    while (!game.ended) {
      const actions = Object.fromEntries(game.players.filter((player) => player.active).map((player) => [player.id, game.round === 8 ? 'reinforce' : 'mine']));
      resolveRound(game, { playerActions: actions, playerScouts: {}, playerAccusations: {} });
    }
    assert.equal(game.players.length, count);
    assert.ok(['rounds', 'collapse'].includes(game.endReason));
    assert.ok(game.players.every((player) => Number.isFinite(totalValue(player))));
  });
}

test('multiplayer rejects unavailable and missing player actions', () => {
  const game = createGame({ players: [{ id: 'seat1', name: 'A' }, { id: 'seat2', name: 'B' }] });
  assert.throws(() => resolveRound(game, { playerActions: { seat1: 'secret', seat2: 'mine' } }), /unavailable/);
  assert.throws(() => resolveRound(game, { playerActions: { seat1: 'mine' } }), /unavailable/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as soloEngine from '../deep-mining-agreement/engine.js';
import { createGame, npcWeights as soloNpcWeights, simulateRemaining } from '../deep-mining-agreement/engine.js';
import { npcPortrait } from '../deep-mining-agreement/online-portraits.js';

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

test('solo result history counts completed rounds after early endings, full games, and replay', () => {
  const root = { innerHTML: '', addEventListener() {}, focus() {} };
  const window = { scrollTo() {} };
  const source = readFileSync(new URL('../deep-mining-agreement/app.js', import.meta.url), 'utf8');
  // Run the actual renderer with its real engine, without a browser dependency.
  runInNewContext(source.replace(/^import \{[\s\S]*?\} from "\.\/engine\.js";/, ''), {
    ...soloEngine,
    document: { querySelector: () => root },
    window,
  });
  const api = window.__deepMiningAgreement;

  for (const [rounds, reason] of [[6, 'collapse'], [8, 'rounds'], [5, 'all-retreated'], [8, 'rounds']]) {
    api.beginGame();
    const game = api.getState();
    assert.equal(game.history.length, 0, 'replay starts with an empty history');
    game.oreSequence = Array(8).fill('iron');
    for (let round = 1; round <= rounds; round += 1) {
      const lastRound = round === rounds;
      const action = lastRound && reason === 'collapse' ? 'mine'
        : lastRound && reason === 'all-retreated' ? 'retreat' : 'reinforce';
      if (lastRound && reason === 'collapse') game.danger = 99;
      soloEngine.resolveRound(game, {
        humanAction: action,
        npcActions: { safety: action, greedy: action, tactician: action },
        npcScouts: { safety: false, greedy: false, tactician: false },
        npcAccusations: { safety: null, greedy: null, tactician: null },
      });
    }
    assert.equal(game.ended, true);
    assert.equal(game.endReason, reason);
    assert.equal(game.history.length, rounds);
    api.renderGame();
    assert.match(root.innerHTML, /id="result-heading"/);
    assert.equal(root.innerHTML.match(/<details class="panel history"><summary>(.*?)<\/summary>/)?.[1], `全${rounds}ラウンドの履歴`);
    assert.equal((root.innerHTML.match(/class="history-item"/g) || []).length, rounds);
  }
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
    assert.deepEqual(game.players.map(npcPortrait).filter(Boolean).map(({ src }) => src), {
      2: ['assets/characters/gaku.png', 'assets/characters/shion.png'],
      3: ['assets/characters/shion.png'],
      4: [],
    }[humanCount]);
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

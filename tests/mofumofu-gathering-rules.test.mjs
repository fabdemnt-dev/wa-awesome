import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

function loadSoloGatheringState() {
  const script = read('toybox/mofumofu-gathering/script.js');
  const animals = script.match(/const ANIMALS = \[[\s\S]*?\];/)[0];
  const fn = script.match(/function gatheringState\(faceUp\) \{[\s\S]*?\n\}/)[0];
  return new Function(`${animals}\n${fn}\nreturn gatheringState;`)();
}
function loadFunctionsGatheringState() {
  const source = read('functions/mofumofu-online/index.js');
  const animals = source.match(/const ANIMALS = \[[\s\S]*?\];/)[0];
  const countByAnimal = source.match(/function countByAnimal\(cards = \[\]\) \{[\s\S]*?\n\}/)[0];
  const fn = source.match(/function gatheringState\(cards\) \{[\s\S]*?\n\}/)[0];
  return new Function(`${animals}\n${countByAnimal}\n${fn}\nreturn gatheringState;`)();
}
const zeroFaceUp = () => Object.fromEntries(['cat', 'rabbit', 'bear', 'chick', 'fox', 'penguin', 'panda', 'polar'].map((a) => [a, 0]));
const cardsOf = (counts) => Object.entries(counts).flatMap(([animalType, n]) => Array.from({ length: n }, () => ({ animalType })));

test('solo判定: 同種4枚で敗北、3枚では継続', () => {
  const gatheringState = loadSoloGatheringState();
  const faceUp = zeroFaceUp(); faceUp.cat = 4;
  assert.deepEqual(gatheringState(faceUp), { fourOfAKind: 'cat', allEightTypes: false, gathering: true });
  const three = zeroFaceUp(); three.bear = 3;
  assert.equal(gatheringState(three).gathering, false);
});

test('solo判定: 8種類すべてで敗北、7種類では継続', () => {
  const gatheringState = loadSoloGatheringState();
  const all = zeroFaceUp();
  for (const a of ['cat', 'rabbit', 'bear', 'chick', 'fox', 'penguin', 'panda', 'polar']) all[a] = 1;
  assert.deepEqual(gatheringState(all), { fourOfAKind: null, allEightTypes: true, gathering: true });
  const seven = zeroFaceUp();
  for (const a of ['cat', 'rabbit', 'bear', 'chick', 'fox', 'penguin', 'panda']) seven[a] = 1;
  const state = gatheringState(seven);
  assert.equal(state.gathering, false);
  assert.equal(state.allEightTypes, false);
});

test('solo判定: 4枚+8種類の同時成立は両方の事実を保持する', () => {
  const gatheringState = loadSoloGatheringState();
  const faceUp = zeroFaceUp();
  for (const a of ['rabbit', 'bear', 'chick', 'fox', 'penguin', 'panda', 'polar']) faceUp[a] = 1;
  faceUp.cat = 4;
  assert.deepEqual(gatheringState(faceUp), { fourOfAKind: 'cat', allEightTypes: true, gathering: true });
});

test('Functions判定: 同種4枚・8種類・3枚・7種類・同時成立', () => {
  const gatheringState = loadFunctionsGatheringState();
  assert.deepEqual(gatheringState(cardsOf({ cat: 4 })), { fourOfAKind: 'cat', allEightTypes: false, gathering: true });
  assert.deepEqual(gatheringState(cardsOf({ cat: 1, rabbit: 1, bear: 1, chick: 1, fox: 1, penguin: 1, panda: 1, polar: 1 })), { fourOfAKind: null, allEightTypes: true, gathering: true });
  assert.deepEqual(gatheringState(cardsOf({ bear: 3 })), { fourOfAKind: null, allEightTypes: false, gathering: false });
  const seven = gatheringState(cardsOf({ cat: 1, rabbit: 1, bear: 1, chick: 1, fox: 1, penguin: 1, panda: 1 }));
  assert.equal(seven.gathering, false);
  assert.deepEqual(gatheringState(cardsOf({ cat: 4, rabbit: 1, bear: 1, chick: 1, fox: 1, penguin: 1, panda: 1, polar: 1 })), { fourOfAKind: 'cat', allEightTypes: true, gathering: true });
  assert.equal(gatheringState([]).gathering, false);
});

test('集合判定は表向きカードだけを受け、手札を含まない', () => {
  const script = read('toybox/mofumofu-gathering/script.js');
  assert.ok(script.includes('gatheringState(receiver.faceUp)'), 'solo must judge faceUp only');
  const source = read('functions/mofumofu-online/index.js');
  assert.ok(source.includes('const gathering = gatheringState(room.faceUpCards[recipient]);'), 'online must judge faceUpCards only');
});

test('online: 集合成立は同一transactionで即終了し、勝者2人と終了理由を保存する', () => {
  const source = read('functions/mofumofu-online/index.js');
  assert.ok(source.includes("finishReason: gathering.fourOfAKind && gathering.allEightTypes ? 'four-and-eight' : gathering.fourOfAKind ? 'four-of-a-kind' : 'all-eight-types'"), 'three finish reasons must be distinguishable');
  assert.ok(source.includes("winnerPlayerIds: PLAYERS.filter((playerId) => room.playerStatus[playerId] === 'active')"), 'explicit winners list required');
  assert.ok(source.includes('if (winnerPlayerIds) result.winnerPlayerIds = winnerPlayerIds;'), 'winnerPlayerIds only added for gathering finishes (backward compatible)');
  assert.ok(source.includes('function buildFinalResult(room, finishReason, winnerPlayerId, draw, finishedAt, winnerPlayerIds = null)'));
  const resolverStart = source.indexOf('function resolveFaceUp');
  const elseBlock = source.indexOf('} else {\n    finish = finishIfNeeded(room, server, hands);\n  }');
  const leftoverOldFinish = source.indexOf('const finish = finishIfNeeded');
  assert.ok(resolverStart !== -1, 'resolver found');
  assert.ok(elseBlock > resolverStart, 'resolver picks either the gathering finish or the normal one');
  assert.ok(leftoverOldFinish === -1 || leftoverOldFinish > elseBlock, 'gathering finish must not be overwritten');
});

test('online: 8種類のみの敗北に架空のeliminationAnimalを入れない', () => {
  const source = read('functions/mofumofu-online/index.js');
  assert.ok(source.includes('eliminationAnimal: gathering.fourOfAKind'), 'eliminationAnimal falls back to null for all-eight-types');
});

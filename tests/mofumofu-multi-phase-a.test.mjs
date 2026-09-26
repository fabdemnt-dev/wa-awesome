import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// 既存の online integration テストと同じ読み込み方式（functions/ は CommonJS）。
const functionRequire = createRequire(new URL('../functions/package.json', import.meta.url));
const rules = functionRequire('./mofumofu-multi/rules.js');

const {
  ANIMALS, DECK_SIZE, MIN_PLAYERS, MAX_PLAYERS, SEAT_IDS,
  PLAYER_STATUS, FINISH_REASON, GATHERING_REASON,
  validatePlayerCount, handSizeFor, leftoversFor, generateSeats, validateSeatOrder,
  createDeck, shuffle, dealDeck, createInitialState, countByAnimal, faceUpTotal, gatheringState,
  judgeSuccess, activeSeats, nextActivePlayer, validTargets,
  applyOffer, applyJudgment, leaveGame,
  finishByGathering, finishByHandEmpty, finishByTooFewActive,
  cardConservation, toPublicRoom, toServerSecrets,
} = rules;

const EXPECTED = { 3: { hand: 10, leftovers: 2 }, 4: { hand: 8, leftovers: 0 }, 5: { hand: 6, leftovers: 2 }, 6: { hand: 5, leftovers: 2 } };
const COUNTS = [3, 4, 5, 6];

let idSeq = 0;
const nextId = () => `id-${(idSeq += 1)}`;
// 決定的な乱数（LCG）。テストの再現性のためだけに使う。
function seeded(seed) {
  let value = seed >>> 0;
  return (max) => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value % max;
  };
}
function newState(playerCount, seed = 1, extra = {}) {
  return createInitialState({ playerCount, idFactory: nextId, randomInt: seeded(seed), ...extra });
}
// 終了ロジック専用のフィクスチャ。実際の32枚保存則は別テスト（カード保存）で実フローを使って検証する。
function fixture(state, faceUpBySeat = {}) {
  const next = structuredClone(state);
  for (const [seat, animals] of Object.entries(faceUpBySeat)) {
    next.faceUpCards[seat] = animals.map((animalType, index) => ({ cardId: `fx-${seat}-${index}`, animalType }));
  }
  return next;
}
function emptyHand(state, seat) {
  const next = structuredClone(state);
  next.discard = [...next.discard, ...next.hands[seat]];
  next.hands[seat] = [];
  next.handCounts[seat] = 0;
  return next;
}
function assertConserved(state, label) {
  const conservation = cardConservation(state);
  assert.equal(conservation.total, DECK_SIZE, `${label}: カード総数が32枚 (${JSON.stringify(conservation)})`);
}
function offerAndJudge(state, { fromPlayerId, toPlayerId, cardId, claimAnimal, judgment, byPlayerId = null }) {
  return applyJudgment(applyOffer(state, { fromPlayerId, toPlayerId, cardId, claimAnimal }), { judgment, byPlayerId });
}

/* ------------------------------------------------------------------ 人数 */

test('人数: 2人は拒否、3〜6人は成功、7人は拒否', () => {
  for (const invalid of [2, 7, 0, -1, 6.5, '3', null, undefined, NaN]) {
    assert.throws(() => validatePlayerCount(invalid), (error) => error.code === 'invalid-player-count', `拒否されるべき: ${String(invalid)}`);
  }
  for (const valid of [MIN_PLAYERS, 4, 5, MAX_PLAYERS]) assert.equal(validatePlayerCount(valid), valid);
  assert.equal(MIN_PLAYERS, 3);
  assert.equal(MAX_PLAYERS, 6);
});

/* ------------------------------------------------------------------ 配布 */

test('配布: 人数別の手札枚数・余り・総数32枚', () => {
  for (const playerCount of COUNTS) {
    const state = newState(playerCount);
    const { hand, leftovers } = EXPECTED[playerCount];
    assert.equal(handSizeFor(playerCount), hand);
    assert.equal(leftoversFor(playerCount), leftovers);
    assert.equal(state.seatOrder.length, playerCount);
    for (const seat of state.seatOrder) assert.equal(state.hands[seat].length, hand, `${playerCount}人: ${seat}の手札`);
    assert.equal(state.leftovers.length, leftovers, `${playerCount}人: 余り`);
    assert.equal(hand * playerCount + leftovers, DECK_SIZE);
    assertConserved(state, `${playerCount}人の初期状態`);
  }
});

test('配布: 32枚・重複なし・8種×4維持', () => {
  const deck = createDeck({ idFactory: nextId });
  assert.equal(deck.length, DECK_SIZE);
  assert.equal(new Set(deck.map((card) => card.cardId)).size, DECK_SIZE);
  const counts = countByAnimal(deck);
  for (const animalType of ANIMALS) assert.equal(counts[animalType], 4, `${animalType}は4枚`);
  assert.equal(Object.keys(counts).length, 8);
  for (const playerCount of COUNTS) {
    const state = newState(playerCount, 7);
    const all = [...state.leftovers];
    for (const seat of state.seatOrder) all.push(...state.hands[seat]);
    assert.equal(all.length, DECK_SIZE);
    assert.equal(new Set(all.map((card) => card.cardId)).size, DECK_SIZE);
    assert.deepEqual(countByAnimal(all), countByAnimal(deck));
  }
});

test('配布: 不正なデッキは拒否される', () => {
  const deck = createDeck({ idFactory: nextId });
  assert.throws(() => dealDeck(deck.slice(0, 31), generateSeats(3)), (error) => error.code === 'invalid-deck');
  const duplicated = deck.map((card) => ({ ...card }));
  duplicated[1] = { ...duplicated[1], cardId: duplicated[0].cardId };
  assert.throws(() => dealDeck(duplicated, generateSeats(3)), (error) => error.code === 'duplicate-card');
  const wrongAnimal = deck.map((card) => ({ ...card }));
  wrongAnimal[0] = { cardId: wrongAnimal[0].cardId, animalType: 'dragon' };
  assert.throws(() => dealDeck(wrongAnimal, generateSeats(3)), (error) => error.code === 'invalid-card');
  const skewed = deck.map((card, index) => (index === 0 ? { cardId: card.cardId, animalType: ANIMALS[1] } : card));
  assert.throws(() => dealDeck(skewed, generateSeats(3)), (error) => error.code === 'invalid-deck-composition');
});

test('shuffle: 元配列を変更せず、同じ要素集合を返す', () => {
  const deck = createDeck({ idFactory: nextId });
  const frozen = [...deck];
  const shuffled = shuffle(deck, seeded(42));
  assert.deepEqual(deck, frozen);
  assert.equal(shuffled.length, DECK_SIZE);
  assert.deepEqual(new Set(shuffled.map((card) => card.cardId)), new Set(deck.map((card) => card.cardId)));
});

/* -------------------------------------------------------------------- 席 */

test('席: S1〜S6を参加順に払い出す', () => {
  assert.deepEqual(generateSeats(3), ['S1', 'S2', 'S3']);
  assert.deepEqual(generateSeats(6), SEAT_IDS);
  assert.deepEqual(generateSeats(4), ['S1', 'S2', 'S3', 'S4']);
  for (const invalid of [2, 7]) assert.throws(() => generateSeats(invalid), (error) => error.code === 'invalid-player-count');
});

test('席: 参加順（seatOrder）が保持され、不正な席指定は拒否される', () => {
  const state = createInitialState({ playerCount: 3, seats: ['S1', 'S2', 'S3'], idFactory: nextId, randomInt: seeded(3) });
  assert.deepEqual(state.seatOrder, ['S1', 'S2', 'S3']);
  assert.equal(state.currentTurnPlayerId, 'S1');
  assert.deepEqual(Object.keys(state.playerStatus), ['S1', 'S2', 'S3']);
  assert.deepEqual(Object.keys(state.faceUpCards), ['S1', 'S2', 'S3']);
  assert.deepEqual(Object.keys(state.handCounts), ['S1', 'S2', 'S3']);
  assert.equal(state.playerStatus.S1, PLAYER_STATUS.ACTIVE);
  for (const seat of state.seatOrder) assert.equal(state.playerUids[seat], null);
  assert.throws(() => validateSeatOrder(['S1', 'S1', 'S2'], 3), (error) => error.code === 'invalid-seat');
  assert.throws(() => validateSeatOrder(['S1', 'S2', 'S7'], 3), (error) => error.code === 'invalid-seat');
  assert.throws(() => validateSeatOrder(['S1', 'S2'], 3), (error) => error.code === 'invalid-seat-order');
  assert.throws(() => createInitialState({ playerCount: 3, seats: ['S1', 'S2', 'S9'], idFactory: nextId }), (error) => error.code === 'invalid-seat');
});

/* ------------------------------------------------------------------ 手番 */

test('手番: seatOrder順に進み、末尾から先頭へ巡回する', () => {
  const order = generateSeats(4);
  const status = Object.fromEntries(order.map((seat) => [seat, PLAYER_STATUS.ACTIVE]));
  assert.equal(nextActivePlayer('S1', order, status), 'S2');
  assert.equal(nextActivePlayer('S3', order, status), 'S4');
  assert.equal(nextActivePlayer('S4', order, status), 'S1');
  assert.throws(() => nextActivePlayer('S9', order, status), (error) => error.code === 'invalid-seat');
});

test('手番: leftをスキップし、他にactiveが無ければnull', () => {
  const order = generateSeats(5);
  const status = Object.fromEntries(order.map((seat) => [seat, PLAYER_STATUS.ACTIVE]));
  status.S2 = PLAYER_STATUS.LEFT;
  status.S3 = PLAYER_STATUS.LEFT;
  assert.equal(nextActivePlayer('S1', order, status), 'S4');
  assert.equal(nextActivePlayer('S4', order, status), 'S5');
  assert.equal(nextActivePlayer('S5', order, status), 'S1');
  // 既存server（functions/mofumofu-online の nextPlayerId）と同じく、他にactiveが無ければ自分自身を返す。
  // 全員がleftならnull。
  const alone = { S1: PLAYER_STATUS.ACTIVE, S2: PLAYER_STATUS.LEFT, S3: PLAYER_STATUS.LEFT };
  assert.equal(nextActivePlayer('S1', ['S1', 'S2', 'S3'], alone), 'S1');
  const allLeft = { S1: PLAYER_STATUS.LEFT, S2: PLAYER_STATUS.LEFT, S3: PLAYER_STATUS.LEFT };
  assert.equal(nextActivePlayer('S1', ['S1', 'S2', 'S3'], allLeft), null);
});

test('手番: 実際の進行でactive席だけを巡回する', () => {
  let state = newState(4, 11);
  const seen = [];
  for (let index = 0; index < 4; index += 1) {
    seen.push(state.currentTurnPlayerId);
    const from = state.currentTurnPlayerId;
    const to = validTargets(state, from)[0];
    const card = state.hands[from][0];
    state = offerAndJudge(state, { fromPlayerId: from, toPlayerId: to, cardId: card.cardId, claimAnimal: card.animalType, judgment: 'truth' });
    if (state.status === 'finished') break;
  }
  assert.deepEqual(seen.slice(0, 4), ['S1', 'S2', 'S3', 'S4']);
});

/* ---------------------------------------------------------------- target */

test('target: 自分以外のactive席のみ（最大5人）', () => {
  const state6 = newState(6, 5);
  assert.deepEqual(validTargets(state6, 'S3'), ['S1', 'S2', 'S4', 'S5', 'S6']);
  assert.equal(validTargets(state6, 'S1').length, 5);
  assert.equal(validTargets(state6, 'S1').includes('S1'), false);
  const left = structuredClone(state6);
  left.playerStatus.S4 = PLAYER_STATUS.LEFT;
  assert.deepEqual(validTargets(left, 'S1'), ['S2', 'S3', 'S5', 'S6']);
  assert.throws(() => validTargets(state6, 'S9'), (error) => error.code === 'invalid-seat');
});

test('target: 自分・left・不明な席へのofferは拒否される', () => {
  const state = newState(4, 9);
  const card = state.hands.S1[0];
  const base = { fromPlayerId: 'S1', cardId: card.cardId, claimAnimal: card.animalType };
  assert.throws(() => applyOffer(state, { ...base, toPlayerId: 'S1' }), (error) => error.code === 'invalid-target');
  assert.throws(() => applyOffer(state, { ...base, toPlayerId: 'S7' }), (error) => error.code === 'invalid-target');
  const left = structuredClone(state);
  left.playerStatus.S3 = PLAYER_STATUS.LEFT;
  assert.throws(() => applyOffer(left, { ...base, toPlayerId: 'S3' }), (error) => error.code === 'invalid-target');
  assert.throws(() => applyOffer(state, { fromPlayerId: 'S2', cardId: state.hands.S2[0].cardId, claimAnimal: 'cat', toPlayerId: 'S1' }), (error) => error.code === 'not-your-turn');
});

/* ------------------------------------------------------------------ 集合 */

test('集合: 同種3枚は継続、4枚で成立', () => {
  assert.equal(gatheringState([{ animalType: 'cat' }, { animalType: 'cat' }, { animalType: 'cat' }]).gathering, false);
  const four = gatheringState([{ animalType: 'cat' }, { animalType: 'cat' }, { animalType: 'cat' }, { animalType: 'cat' }]);
  assert.equal(four.gathering, true);
  assert.equal(four.reason, GATHERING_REASON.FOUR_OF_A_KIND);
  assert.equal(four.fourOfAKind, 'cat');
  assert.equal(four.allEightTypes, false);
  assert.equal(gatheringState([]).gathering, false);
});

test('集合: 7種類は継続、8種類で成立', () => {
  const seven = ANIMALS.slice(0, 7).map((animalType) => ({ animalType }));
  assert.equal(gatheringState(seven).gathering, false);
  const eight = ANIMALS.map((animalType) => ({ animalType }));
  const state = gatheringState(eight);
  assert.equal(state.gathering, true);
  assert.equal(state.allEightTypes, true);
  assert.equal(state.fourOfAKind, null);
  assert.equal(state.reason, GATHERING_REASON.ALL_EIGHT_TYPES);
});

test('集合: 4枚と8種類が同時なら four-and-eight', () => {
  const cards = [...ANIMALS.map((animalType) => ({ animalType })), { animalType: 'cat' }, { animalType: 'cat' }, { animalType: 'cat' }];
  const state = gatheringState(cards);
  assert.equal(state.gathering, true);
  assert.equal(state.reason, GATHERING_REASON.FOUR_AND_EIGHT);
  assert.equal(state.fourOfAKind, 'cat');
});

test('集合: 手札に同種4枚あっても集合判定へ含めない', () => {
  const state = newState(3, 13);
  // 手札に「ねこ」4枚を集めた状態を作る（表向きは0枚のまま）。
  const prepared = structuredClone(state);
  const cats = [];
  for (const seat of prepared.seatOrder) {
    prepared.hands[seat] = prepared.hands[seat].filter((card) => (card.animalType === 'cat' ? (cats.push(card), false) : true));
  }
  prepared.leftovers = prepared.leftovers.filter((card) => (card.animalType === 'cat' ? (cats.push(card), false) : true));
  assert.equal(cats.length, 4, 'ねこは4枚そろえられた');
  prepared.hands.S1 = [...prepared.hands.S1, ...cats];
  prepared.handCounts.S1 = prepared.hands.S1.length;
  assert.equal(countByAnimal(prepared.hands.S1).cat, 4);
  assert.equal(gatheringState(prepared.faceUpCards.S1).gathering, false, '手札4枚だけでは集合しない');
  const after = offerAndJudge(prepared, { fromPlayerId: 'S1', toPlayerId: 'S2', cardId: cats[0].cardId, claimAnimal: 'cat', judgment: 'truth' });
  assert.equal(after.status, 'playing');
  assert.equal(after.loserPlayerIds.length, 0);
  assert.equal(faceUpTotal(after.faceUpCards.S1), 1, '表向きは1枚だけ');
  assert.equal(countByAnimal(after.hands.S1).cat, 3, '手札に残った3枚は集合判定へ入らない');
});

/* ---------------------------------------------------------------- winner */

test('集合終了: 3〜6人で敗者以外のactive全員が勝者（2〜5人）', () => {
  for (const playerCount of COUNTS) {
    const state = newState(playerCount, 21);
    const loser = state.seatOrder[0];
    const prepared = fixture(state, { [loser]: ['cat', 'cat', 'cat', 'cat'] });
    const finished = finishByGathering(prepared, loser);
    assert.equal(finished.status, 'finished');
    assert.equal(finished.finishReason, FINISH_REASON.GATHERING);
    assert.equal(finished.gatheringReason, GATHERING_REASON.FOUR_OF_A_KIND);
    assert.deepEqual(finished.loserPlayerIds, [loser]);
    assert.equal(finished.winnerPlayerIds.length, playerCount - 1, `${playerCount}人: 勝者${playerCount - 1}人`);
    assert.equal(finished.winnerPlayerIds.includes(loser), false);
    assert.equal(finished.draw, false);
    assert.equal(finished.finalResult.winnerPlayerIds.length, playerCount - 1);
    assert.equal(finished.currentTurnPlayerId, null);
    assert.equal(finished.turnState, 'finished');
    const snapshot = finished.finalResult.players.find((player) => player.seatId === loser);
    assert.equal(snapshot.status, PLAYER_STATUS.ACTIVE);
    assert.equal(finished.finalResult.players.every((player) => typeof player.handCount === 'number'), true);
  }
});

test('集合終了: leftは勝者に含めない', () => {
  const state = newState(6, 31);
  const afterLeave = leaveGame(state, 'S6');
  assert.equal(afterLeave.status, 'playing');
  const prepared = fixture(afterLeave, { S1: ['bear', 'bear', 'bear', 'bear'] });
  const finished = finishByGathering(prepared, 'S1');
  assert.deepEqual(finished.leftPlayerIds, ['S6']);
  assert.deepEqual(finished.winnerPlayerIds, ['S2', 'S3', 'S4', 'S5']);
  assert.equal(finished.winnerPlayerIds.includes('S6'), false);
  assert.equal(finished.winnerPlayerIds.includes('S1'), false);
  assert.equal(finished.finalResult.players.find((player) => player.seatId === 'S6').status, PLAYER_STATUS.LEFT);
});

test('集合終了: 判定で4枚そろうと即終了する（実フロー）', () => {
  const state = newState(4, 41);
  // S1がすでに表向き3枚。そこへ「ほんと？」で判定成功し、4枚そろって即終了する実フロー。
  const prepared = fixture(state, { S1: ['fox', 'fox', 'fox'] });
  const card = { cardId: 'flow-fox', animalType: 'fox' };
  const withCard = structuredClone(prepared);
  withCard.hands.S1 = [...withCard.hands.S1, card];
  withCard.handCounts.S1 += 1;
  const finished = offerAndJudge(withCard, { fromPlayerId: 'S1', toPlayerId: 'S2', cardId: card.cardId, claimAnimal: 'fox', judgment: 'truth' });
  assert.equal(finished.finishReason, FINISH_REASON.GATHERING);
  assert.equal(finished.gatheringReason, GATHERING_REASON.FOUR_OF_A_KIND);
  assert.deepEqual(finished.loserPlayerIds, ['S1']);
  assert.deepEqual(finished.winnerPlayerIds, ['S2', 'S3', 'S4']);
  assert.equal(finished.publicOffer.status, 'completed');
  assert.equal(finished.publicOffer.faceUpRecipientPlayerId, 'S1');
});

/* ------------------------------------------------------------ 判定の認可 */

test('判定: 受け取った本人だけが判定できる（純粋ルール）', () => {
  assert.equal(judgeSuccess('cat', 'cat', 'truth'), true);
  assert.equal(judgeSuccess('cat', 'cat', 'lie'), false);
  assert.equal(judgeSuccess('cat', 'bear', 'lie'), true);
  assert.equal(judgeSuccess('cat', 'bear', 'truth'), false);
  assert.throws(() => judgeSuccess('cat', 'cat', 'maybe'), (error) => error.code === 'invalid-judgment');
  assert.throws(() => judgeSuccess('dragon', 'cat', 'truth'), (error) => error.code === 'invalid-claim');
  const state = newState(4, 51);
  const card = state.hands.S1[0];
  const offered = applyOffer(state, { fromPlayerId: 'S1', toPlayerId: 'S3', cardId: card.cardId, claimAnimal: card.animalType });
  assert.throws(() => applyJudgment(offered, { judgment: 'truth', byPlayerId: 'S2' }), (error) => error.code === 'not-the-judge');
  assert.throws(() => applyJudgment(offered, { judgment: 'truth', byPlayerId: 'S4' }), (error) => error.code === 'not-the-judge');
  const judged = applyJudgment(offered, { judgment: 'truth', byPlayerId: 'S3' });
  assert.equal(judged.status, 'playing');
});

test('判定: 成功は渡した側、失敗は受け取った側が表向きで受け取る', () => {
  const state = newState(3, 61);
  const card = state.hands.S1[0];
  const truth = offerAndJudge(state, { fromPlayerId: 'S1', toPlayerId: 'S2', cardId: card.cardId, claimAnimal: card.animalType, judgment: 'truth' });
  assert.equal(faceUpTotal(truth.faceUpCards.S1), 1);
  assert.equal(faceUpTotal(truth.faceUpCards.S2), 0);
  const lie = offerAndJudge(state, { fromPlayerId: 'S1', toPlayerId: 'S2', cardId: card.cardId, claimAnimal: card.animalType, judgment: 'lie' });
  assert.equal(faceUpTotal(lie.faceUpCards.S1), 0);
  assert.equal(faceUpTotal(lie.faceUpCards.S2), 1);
  assert.equal(lie.publicOffer.success, false);
  assert.equal(lie.publicOffer.faceUpRecipientPlayerId, 'S2');
});

test('進行: offer→検証（手札に無い・二重offer・終了後）', () => {
  const state = newState(3, 71);
  const card = state.hands.S1[0];
  assert.throws(() => applyOffer(state, { fromPlayerId: 'S1', toPlayerId: 'S2', cardId: 'missing', claimAnimal: 'cat' }), (error) => error.code === 'card-not-in-hand');
  assert.throws(() => applyOffer(state, { fromPlayerId: 'S1', toPlayerId: 'S2', cardId: card.cardId, claimAnimal: 'dragon' }), (error) => error.code === 'invalid-claim');
  const offered = applyOffer(state, { fromPlayerId: 'S1', toPlayerId: 'S2', cardId: card.cardId, claimAnimal: card.animalType });
  assert.equal(offered.handCounts.S1, 9);
  assert.equal(offered.hands.S1.length, 9);
  assert.equal(offered.turnState, 'awaitingJudgment');
  assert.throws(() => applyOffer(offered, { fromPlayerId: 'S1', toPlayerId: 'S2', cardId: card.cardId, claimAnimal: 'cat' }), (error) => error.code === 'not-awaiting-offer');
  assert.throws(() => applyJudgment(offered, { judgment: 'maybe' }), (error) => error.code === 'invalid-judgment');
  const judged = applyJudgment(fixture(offered, { S2: ['cat', 'cat', 'cat'] }), { judgment: 'truth' });
  assert.equal(judged.status, 'playing');
  assert.equal(judged.currentTurnPlayerId, 'S2');
  const second = applyOffer(judged, { fromPlayerId: 'S2', toPlayerId: 'S3', cardId: judged.hands.S2[0].cardId, claimAnimal: 'cat' });
  assert.equal(second.turnState, 'awaitingJudgment');
  assert.throws(() => applyOffer(second, { fromPlayerId: 'S2', toPlayerId: 'S1', cardId: second.hands.S2[0].cardId, claimAnimal: 'cat' }), (error) => error.code === 'not-awaiting-offer');
  const ended = finishByHandEmpty(emptyHand(judged, 'S1'));
  assert.throws(() => applyOffer(ended, { fromPlayerId: 'S2', toPlayerId: 'S1', cardId: 'x', claimAnimal: 'cat' }), (error) => error.code === 'not-playing');
});

/* ------------------------------------------------------------ hand-empty */

test('hand-empty: 0枚になった本人は自動敗者ではなく、最少の席が勝者', () => {
  const state = newState(3, 81);
  const shortened = emptyHand(state, 'S1');
  const prepared = fixture(shortened, { S1: ['cat', 'cat', 'cat', 'cat', 'cat'], S2: [], S3: ['bear', 'bear'] });
  const finished = finishByHandEmpty(prepared);
  assert.equal(finished.status, 'finished');
  assert.equal(finished.finishReason, FINISH_REASON.HAND_EMPTY);
  assert.deepEqual(finished.winnerPlayerIds, ['S2']);
  assert.deepEqual(finished.loserPlayerIds, []);
  assert.equal(finished.draw, false);
  assert.equal(finished.gatheringReason, null);
});

test('hand-empty: 3〜6人すべてで最少1人が勝者になる', () => {
  for (const playerCount of COUNTS) {
    const state = newState(playerCount, 91);
    const totals = Object.fromEntries(state.seatOrder.map((seat, index) => [seat, Array.from({ length: index }, () => 'cat')]));
    const finished = finishByHandEmpty(fixture(emptyHand(state, state.seatOrder.at(-1)), totals));
    assert.equal(finished.finishReason, FINISH_REASON.HAND_EMPTY);
    assert.deepEqual(finished.winnerPlayerIds, ['S1'], `${playerCount}人: 最少はS1`);
    assert.equal(finished.draw, false);
  }
});

test('hand-empty: 最少が複数なら全員が同率勝者（draw=true）', () => {
  const five = newState(5, 101);
  const tie = fixture(emptyHand(five, 'S5'), { S1: [], S2: [], S3: ['cat', 'cat', 'cat'], S4: ['cat'], S5: ['cat'] });
  const finished = finishByHandEmpty(tie);
  assert.deepEqual(finished.winnerPlayerIds, ['S1', 'S2']);
  assert.equal(finished.draw, true);
  assert.equal(finished.winnerPlayerIds.length, 2);

  const six = newState(6, 111);
  const threeWay = fixture(emptyHand(six, 'S6'), { S1: ['cat', 'cat'], S2: ['cat', 'cat'], S3: ['cat', 'cat'], S4: ['cat', 'cat', 'cat'], S5: ['cat', 'cat', 'cat'], S6: ['cat', 'cat', 'cat'] });
  const tied = finishByHandEmpty(threeWay);
  assert.deepEqual(tied.winnerPlayerIds, ['S1', 'S2', 'S3']);
  assert.equal(tied.draw, true);

  const four = newState(4, 121);
  const allTied = fixture(emptyHand(four, 'S4'), { S1: [], S2: [], S3: [], S4: ['cat'] });
  const everyone = finishByHandEmpty(allTied);
  assert.deepEqual(everyone.winnerPlayerIds, ['S1', 'S2', 'S3']);
  assert.equal(everyone.draw, true);
});

test('hand-empty: leftは比較対象から外れ、勝者にも含めない', () => {
  const state = newState(5, 131);
  const afterLeave = leaveGame(state, 'S1');
  const prepared = fixture(emptyHand(afterLeave, 'S5'), { S1: [], S2: ['cat', 'cat'], S3: ['cat'], S4: ['cat', 'cat', 'cat'], S5: ['cat', 'cat'] });
  const finished = finishByHandEmpty(prepared);
  assert.deepEqual(finished.winnerPlayerIds, ['S3']);
  assert.equal(finished.winnerPlayerIds.includes('S1'), false);
  assert.deepEqual(finished.leftPlayerIds, ['S1']);
});

test('hand-empty: 手札が0枚になった時点の実フローで終了する', () => {
  const state = newState(3, 141);
  const shortened = emptyHand(state, 'S1');
  const card = { cardId: 'last-card', animalType: 'cat' };
  const withLast = structuredClone(shortened);
  withLast.hands.S1 = [card];
  withLast.handCounts.S1 = 1;
  const prepared = fixture(withLast, { S1: ['cat', 'cat', 'cat', 'cat'], S2: [], S3: ['cat', 'cat'] });
  const finished = offerAndJudge(prepared, { fromPlayerId: 'S1', toPlayerId: 'S2', cardId: card.cardId, claimAnimal: 'cat', judgment: 'lie' });
  assert.equal(finished.status, 'finished');
  assert.equal(finished.finishReason, FINISH_REASON.HAND_EMPTY);
  assert.deepEqual(finished.winnerPlayerIds, ['S2']);
  assert.equal(finished.loserPlayerIds.includes('S1'), false);
  assert.equal(finished.handCounts.S1, 0);
});

/* ----------------------------------------------------- too-few-active */

test('too-few-active: 3人から1人退出でactive2人→即終了、残り2人が勝者', () => {
  const state = newState(3, 151);
  const finished = leaveGame(state, 'S3');
  assert.equal(finished.status, 'finished');
  assert.equal(finished.finishReason, FINISH_REASON.TOO_FEW_ACTIVE);
  assert.deepEqual(finished.winnerPlayerIds, ['S1', 'S2']);
  assert.deepEqual(finished.loserPlayerIds, []);
  assert.deepEqual(finished.leftPlayerIds, ['S3']);
  assert.equal(finished.draw, false);
  assert.equal(finished.currentTurnPlayerId, null);
  assert.equal(finished.playerStatus.S3, PLAYER_STATUS.LEFT);
  assert.equal(finished.finalResult.players.find((player) => player.seatId === 'S3').status, PLAYER_STATUS.LEFT);
  assert.equal(finished.finalResult.winnerPlayerIds.includes('S3'), false);
});

test('too-few-active: 6人から3人退出までは継続し、active3→2で終了', () => {
  let state = newState(6, 161);
  for (const seat of ['S6', 'S5', 'S4']) {
    state = leaveGame(state, seat);
    assert.equal(state.status, 'playing', `${seat}退出後はまだ継続`);
  }
  assert.deepEqual(activeSeats(state), ['S1', 'S2', 'S3']);
  // leftPlayerIdsは退出順ではなくseatOrder順で保持する（決定的な並び）。
  assert.deepEqual(state.leftPlayerIds, ['S4', 'S5', 'S6']);
  const finished = leaveGame(state, 'S3');
  assert.equal(finished.status, 'finished');
  assert.equal(finished.finishReason, FINISH_REASON.TOO_FEW_ACTIVE);
  assert.deepEqual(finished.winnerPlayerIds, ['S1', 'S2']);
  assert.deepEqual(finished.leftPlayerIds, ['S3', 'S4', 'S5', 'S6']);
  assertConserved(finished, 'too-few-active');
});

test('退出: 手番保持者が退出したら次のactiveへ進む', () => {
  const state = newState(5, 171);
  assert.equal(state.currentTurnPlayerId, 'S1');
  const after = leaveGame(state, 'S1');
  assert.equal(after.status, 'playing');
  assert.equal(after.currentTurnPlayerId, 'S2');
  assert.equal(after.turnState, 'awaitingOffer');
  assert.equal(after.handCounts.S1, 0);
});

test('退出: 判定待ちの当事者は退出できず、left二重退出も拒否される', () => {
  const state = newState(4, 181);
  const card = state.hands.S1[0];
  const offered = applyOffer(state, { fromPlayerId: 'S1', toPlayerId: 'S2', cardId: card.cardId, claimAnimal: card.animalType });
  assert.throws(() => leaveGame(offered, 'S1'), (error) => error.code === 'pending-offer-involves-seat');
  assert.throws(() => leaveGame(offered, 'S2'), (error) => error.code === 'pending-offer-involves-seat');
  assert.equal(leaveGame(offered, 'S3').status, 'playing');
  const left = leaveGame(state, 'S4');
  assert.equal(left.status, 'playing');
  assert.throws(() => leaveGame(left, 'S4'), (error) => error.code === 'not-active');
  assert.throws(() => leaveGame(left, 'S9'), (error) => error.code === 'invalid-seat');
});

/* ---------------------------------------------------------- カードの保存 */

test('カード保存: 実フローの全段階で手札＋保留＋表向き＋余り＋捨て札＝32枚', () => {
  for (const playerCount of COUNTS) {
    let state = newState(playerCount, 191);
    assertConserved(state, `${playerCount}人: 初期`);
    let guard = 0;
    while (state.status === 'playing' && guard < 60) {
      const from = state.currentTurnPlayerId;
      const to = validTargets(state, from)[0];
      const card = state.hands[from][0];
      const offered = applyOffer(state, { fromPlayerId: from, toPlayerId: to, cardId: card.cardId, claimAnimal: card.animalType });
      assertConserved(offered, `${playerCount}人: 保留中`);
      assert.equal(offered.leftovers.length, leftoversFor(playerCount));
      state = applyJudgment(offered, { judgment: guard % 2 === 0 ? 'truth' : 'lie' });
      assertConserved(state, `${playerCount}人: 判定後`);
      guard += 1;
    }
    assert.equal(state.status, 'finished', `${playerCount}人: ${guard}ターンで終了`);
    assert.ok([FINISH_REASON.GATHERING, FINISH_REASON.HAND_EMPTY, FINISH_REASON.TOO_FEW_ACTIVE].includes(state.finishReason));
    assert.equal(state.finalResult.finishReason, state.finishReason);
  }
});

test('カード保存: 退出しても32枚を維持する', () => {
  const state = newState(6, 201);
  const before = cardConservation(state);
  const after = leaveGame(state, 'S4');
  assert.equal(after.discard.length, before.discard + before.hand / 6);
  assertConserved(after, '退出後');
});

/* ------------------------------------------------------- 公開／秘密の分離 */

test('公開room: 手札の実体と余りカードを含まず、handCountsとfaceUpだけを公開する', () => {
  const state = newState(4, 211);
  const publicRoom = toPublicRoom(state);
  const secrets = toServerSecrets(state);
  assert.equal(Object.hasOwn(publicRoom, 'hands'), false);
  assert.equal(Object.hasOwn(publicRoom, 'leftovers'), false);
  assert.deepEqual(Object.keys(publicRoom.handCounts), state.seatOrder);
  assert.deepEqual(Object.keys(publicRoom.faceUpCards), state.seatOrder);
  assert.deepEqual(Object.keys(publicRoom.playerStatus), state.seatOrder);
  assert.deepEqual(Object.keys(secrets.hands), state.seatOrder);
  assert.equal(secrets.leftovers.length, leftoversFor(4));
  for (const seat of state.seatOrder) {
    assert.equal(publicRoom.handCounts[seat], secrets.hands[seat].length);
    assert.equal(publicRoom.handCounts[seat], handSizeFor(4));
  }
  const leaked = JSON.stringify(publicRoom);
  for (const seat of state.seatOrder) for (const card of secrets.hands[seat]) assert.equal(leaked.includes(card.cardId), false, '手札のカードIDが公開roomへ漏れていない');
  publicRoom.handCounts.S1 = 999;
  assert.equal(state.handCounts.S1, handSizeFor(4), '元の状態を変更しない');
});

test('結果契約: 終了理由と勝敗を曖昧なく表現する', () => {
  const state = newState(5, 221);
  const gathering = finishByGathering(fixture(state, { S1: ['cat', 'cat', 'cat', 'cat'] }), 'S1');
  assert.deepEqual(Object.keys(gathering.finalResult).sort(), ['draw', 'finishReason', 'gatheringReason', 'leftPlayerIds', 'loserPlayerIds', 'players', 'winnerPlayerIds'].sort());
  assert.equal(gathering.finalResult.finishReason, 'gathering');
  assert.equal(gathering.finalResult.gatheringReason, 'four-of-a-kind');
  const fourOnly = [0, 1, 2, 3].map(() => ({ animalType: 'cat' }));
  const eightOnly = ANIMALS.map((animalType) => ({ animalType }));
  const fourAndEight = [...eightOnly, { animalType: 'cat' }, { animalType: 'cat' }, { animalType: 'cat' }];
  assert.equal(gatheringState(fourOnly).reason, GATHERING_REASON.FOUR_OF_A_KIND);
  assert.equal(gatheringState(eightOnly).reason, GATHERING_REASON.ALL_EIGHT_TYPES);
  assert.equal(gatheringState(fourAndEight).reason, GATHERING_REASON.FOUR_AND_EIGHT);
  const handEmpty = finishByHandEmpty(fixture(emptyHand(state, 'S1'), { S1: ['cat'], S2: [], S3: ['cat', 'cat'], S4: ['cat', 'cat', 'cat'], S5: ['cat', 'cat', 'cat', 'cat'] }));
  assert.equal(handEmpty.finalResult.finishReason, 'hand-empty');
  assert.equal(handEmpty.finalResult.gatheringReason, null);
  assert.deepEqual(handEmpty.finalResult.winnerPlayerIds, ['S2']);
  const tooFew = leaveGame(leaveGame(newState(5, 231), 'S5'), 'S4');
  assert.equal(tooFew.finalResult.finishReason, 'too-few-active');
  assert.deepEqual(tooFew.finalResult.leftPlayerIds, ['S4', 'S5']);
  assert.equal(tooFew.finalResult.players.length, 5);
  for (const player of tooFew.finalResult.players) {
    assert.equal(typeof player.handCount, 'number');
    assert.equal(typeof player.faceUpCardsTotal, 'number');
    assert.equal(Object.keys(player.faceUpCardsByAnimal).length, 8);
    assert.equal(SEAT_IDS.includes(player.seatId), true);
  }
  const tooFewFinished = leaveGame(tooFew, 'S3');
  assert.deepEqual(tooFewFinished.winnerPlayerIds, ['S1', 'S2']);
});

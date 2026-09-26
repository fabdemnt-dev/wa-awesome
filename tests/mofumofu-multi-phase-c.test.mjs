import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Phase C の純粋契約テスト。Firestoreを使わず、contract.js の契約核と rules.js（Phase A）の
// 遷移を直接組み合わせて make / judge / 集合 / hand-empty / turn を検証する。
const functionRequire = createRequire(new URL('../functions/package.json', import.meta.url));
const contract = functionRequire('./mofumofu-multi/contract.js');
const rules = functionRequire('./mofumofu-multi/rules.js');

const {
  ANIMALS, SEAT_IDS, TURN_STATE, ROOM_STATUS, PLAYER_STATUS, MIN_ACTIVE_PLAYERS,
} = rules;

let cardSeq = 0;
function seeded(seed) {
  let value = seed >>> 0;
  return (max) => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value % max;
  };
}
const otherAnimal = (animal) => ANIMALS.find((candidate) => candidate !== animal);

// Phase B の start 成功後と同じ形（公開room＋秘密）を持ち、handler と同じ順序で検証する最小サーバ。
function createHarness(playerCount, seed = 7) {
  cardSeq = 0;
  const seats = SEAT_IDS.slice(0, playerCount);
  const uidOf = Object.fromEntries(seats.map((seat) => [seat, `uid-${seat}`]));
  const seatOfUid = Object.fromEntries(seats.map((seat) => [uidOf[seat], seat]));
  const initial = rules.createInitialState({
    playerCount,
    seats,
    idFactory: () => `c${(cardSeq += 1)}`,
    randomInt: seeded(seed),
  });
  const handsByUid = Object.fromEntries(seats.map((seat) => [uidOf[seat], initial.hands[seat]]));
  const room = {
    schemaVersion: contract.SCHEMA_VERSION,
    kind: contract.KIND,
    roomId: 'room-1',
    hostUid: uidOf.S1,
    status: ROOM_STATUS.PLAYING,
    seatOrder: [...seats],
    players: Object.fromEntries(seats.map((seat) => [seat, { seatId: seat, joined: true, joinedAt: 0, displayName: null }])),
    playerUids: { ...uidOf },
    playerStatus: Object.fromEntries(seats.map((seat) => [seat, PLAYER_STATUS.ACTIVE])),
    handCounts: Object.fromEntries(seats.map((seat) => [seat, handsByUid[uidOf[seat]].length])),
    faceUpCards: Object.fromEntries(seats.map((seat) => [seat, []])),
    currentTurnPlayerId: seats[0],
    turnState: TURN_STATE.AWAITING_OFFER,
    turnNumber: 0,
    publicOffer: null,
    winnerPlayerIds: [],
    loserPlayerIds: [],
    leftPlayerIds: [],
    draw: false,
    finishReason: null,
    gatheringReason: null,
    finalResult: null,
  };
  let secret = { seatOrder: [...seats], pendingOffer: null, leftovers: [...initial.leftovers], discard: [] };
  const snapshot = () => contract.rulesStateFromRoom(room, {
    handsByUid,
    leftovers: secret.leftovers,
    discard: secret.discard,
    pendingOffer: secret.pendingOffer,
  });

  function make(uid, { cardId, claimedAnimalType, targetPlayerId, actionId = 'act-make' }) {
    const seatId = seatOfUid[uid] || null;
    const precondition = contract.offerPrecondition(room, { seatId, targetPlayerId, claimedAnimalType, cardId });
    if (!precondition.ok) return { ok: false, code: precondition.code, message: precondition.message };
    const before = snapshot();
    let next;
    try {
      next = contract.runRules(() => rules.applyOffer(before, {
        fromPlayerId: seatId, toPlayerId: targetPlayerId, cardId, claimAnimal: claimedAnimalType, actionId,
      }));
    } catch (error) {
      return { ok: false, code: error.code, message: error.message };
    }
    for (const [seat, cards] of Object.entries(contract.changedHands(before, next))) handsByUid[uidOf[seat]] = cards;
    Object.assign(room, contract.roomWritesAfterOffer(next));
    secret = contract.serverStateAfterOffer(next, secret.deleteAt);
    return { ok: true, result: contract.offerResult(room.roomId, next, seatId), next };
  }
  function judge(uid, { judgment, actionId = 'act-judge' }) {
    const seatId = seatOfUid[uid] || null;
    const precondition = contract.judgmentPrecondition(room, secret, { seatId, judgment });
    if (!precondition.ok) return { ok: false, code: precondition.code, message: precondition.message };
    const before = snapshot();
    let next;
    try {
      next = contract.runRules(() => rules.applyJudgment(before, { judgment, byPlayerId: seatId }));
    } catch (error) {
      return { ok: false, code: error.code, message: error.message };
    }
    for (const [seat, cards] of Object.entries(contract.changedHands(before, next))) handsByUid[uidOf[seat]] = cards;
    Object.assign(room, contract.roomWritesAfterJudgment(next));
    secret = contract.serverStateAfterJudgment(next, secret.deleteAt);
    return { ok: true, result: contract.judgmentResult(room.roomId, next, judgment), next };
  }
  // claim を実カードと一致させ、judgment で受取席を確定させる（truth=出した本人 / lie=相手）。
  function routeTo(uid, card, recipientSeat) {
    const offererSeat = seatOfUid[uid];
    const target = recipientSeat === offererSeat ? seats.find((seat) => seat !== offererSeat) : recipientSeat;
    const made = make(uid, { cardId: card.cardId, claimedAnimalType: card.animalType, targetPlayerId: target });
    if (!made.ok) return made;
    return judge(uidOf[target], { judgment: recipientSeat === offererSeat ? 'truth' : 'lie' });
  }
  return {
    room, uidOf, seatOfUid, seats,
    secret: () => secret,
    hands: () => handsByUid,
    setHand(seat, cards) { handsByUid[uidOf[seat]] = cards; room.handCounts[seat] = cards.length; },
    setFaceUp(seat, cards) { room.faceUpCards[seat] = cards; },
    setStatus(seat, status) { room.playerStatus[seat] = status; },
    setTurn(seat) { room.currentTurnPlayerId = seat; room.turnState = TURN_STATE.AWAITING_OFFER; },
    snapshot, make, judge, routeTo,
    handOf(seat) { return handsByUid[uidOf[seat]]; },
    offererSeat() { return room.currentTurnPlayerId; },
  };
}
const card = (animal, id) => ({ cardId: id || `${animal}-x-${(cardSeq += 1)}`, animalType: animal });

/* ------------------------------------------------------------------- make */

test('make: 手番playerがカードを1枚出すと公開roomへ実カードを漏らさず、handCountsが1減る', () => {
  const h = createHarness(3);
  const seat = h.offererSeat();
  const target = h.seats.find((candidate) => candidate !== seat);
  const played = h.handOf(seat)[0];
  const before = h.handOf(seat).length;
  const result = h.make(h.uidOf[seat], {
    cardId: played.cardId, claimedAnimalType: played.animalType, targetPlayerId: target,
  });
  assert.equal(result.ok, true);
  assert.equal(h.room.turnState, TURN_STATE.AWAITING_JUDGMENT);
  assert.equal(h.room.currentTurnPlayerId, seat, 'Phase A契約では手番者は判定まで変わらない');
  assert.equal(h.room.handCounts[seat], before - 1);
  assert.equal(h.handOf(seat).length, before - 1);
  // 公開publicOfferは判定に必要な公開情報だけ
  assert.deepEqual(h.room.publicOffer, {
    actionId: 'act-make', fromPlayerId: seat, toPlayerId: target, claimAnimal: played.animalType, status: 'pending',
  });
  assert.deepEqual(contract.publicOfferViolations(h.room.publicOffer), []);
  assert.equal('actualAnimal' in h.room.publicOffer, false);
  assert.equal('card' in h.room.publicOffer, false);
  // 実カードは秘密領域（serverState）だけ
  assert.equal(h.secret().pendingOffer.card.cardId, played.cardId);
  assert.equal(h.secret().pendingOffer.card.animalType, played.animalType);
  assert.equal(h.secret().pendingOffer.toPlayerId, target);
  assert.equal(JSON.stringify(h.room).includes(played.cardId), false, '公開roomへ実カードIDが漏れている');
});

test('make: 公開roomへ書くfieldに秘密が含まれない（pendingOffer/leftovers/cardsは書かない）', () => {
  const h = createHarness(3);
  const seat = h.offererSeat();
  const played = h.handOf(seat)[0];
  h.make(h.uidOf[seat], { cardId: played.cardId, claimedAnimalType: played.animalType, targetPlayerId: h.seats[1] });
  assert.deepEqual(Object.keys(h.room).filter((key) => ['hands', 'leftovers', 'pendingOffer', 'cards', 'discard'].includes(key)), []);
  assert.deepEqual(contract.publicRoomViolations(h.room), []);
  // 32枚保存則（手札＋保留＋表向き＋余り＋捨て札）
  const conservation = rules.cardConservation(h.snapshot());
  assert.equal(conservation.total, 32);
  assert.equal(conservation.pendingOffer, 1);
});

test('make: 非member・手番外・left・不正入力・他人カードを拒否する', () => {
  const h = createHarness(3);
  const seat = h.offererSeat();
  const other = h.seats[1];
  const played = h.handOf(seat)[0];
  const base = { cardId: played.cardId, claimedAnimalType: played.animalType, targetPlayerId: other };

  assert.deepEqual(h.make('uid-nobody', base), { ok: false, code: 'permission-denied', message: contract.NOT_MEMBER_ERROR });
  assert.deepEqual(h.make(h.uidOf[other], { ...base, cardId: h.handOf(other)[0].cardId }),
    { ok: false, code: 'failed-precondition', message: contract.NOT_YOUR_TURN_ERROR });
  assert.deepEqual(h.make(h.uidOf[seat], { ...base, targetPlayerId: seat }),
    { ok: false, code: 'failed-precondition', message: contract.SELF_TARGET_ERROR });
  assert.deepEqual(h.make(h.uidOf[seat], { ...base, targetPlayerId: 'S9' }),
    { ok: false, code: 'invalid-argument', message: contract.INVALID_TARGET_ERROR });
  assert.deepEqual(h.make(h.uidOf[seat], { ...base, claimedAnimalType: 'dragon' }),
    { ok: false, code: 'invalid-argument', message: contract.INVALID_CLAIM_ERROR });
  assert.deepEqual(h.make(h.uidOf[seat], { ...base, cardId: 'no-such-card' }),
    { ok: false, code: 'failed-precondition', message: 'そのカードは手札にありません。' });
  assert.deepEqual(h.make(h.uidOf[seat], { ...base, cardId: h.handOf(other)[0].cardId }),
    { ok: false, code: 'failed-precondition', message: 'そのカードは手札にありません。' });

  h.setStatus(other, PLAYER_STATUS.LEFT);
  assert.deepEqual(h.make(h.uidOf[seat], base),
    { ok: false, code: 'failed-precondition', message: contract.TARGET_NOT_ACTIVE_ERROR });
  h.setStatus(other, PLAYER_STATUS.ACTIVE);
  h.setStatus(seat, PLAYER_STATUS.LEFT);
  assert.deepEqual(h.make(h.uidOf[seat], base), { ok: false, code: 'permission-denied', message: contract.NOT_ACTIVE_ERROR });
});

/* ------------------------------------------------------------------ judge */

test('judge: 受取人本人だけが判定できる（第三者・渡した本人は拒否）', () => {
  const h = createHarness(4);
  const seat = h.offererSeat();
  const target = h.seats[1];
  const third = h.seats[2];
  const played = h.handOf(seat)[0];

  assert.deepEqual(h.judge(h.uidOf[target], { judgment: 'truth' }),
    { ok: false, code: 'failed-precondition', message: contract.AWAIT_JUDGMENT_ERROR });

  h.make(h.uidOf[seat], { cardId: played.cardId, claimedAnimalType: played.animalType, targetPlayerId: target });
  assert.deepEqual(h.judge(h.uidOf[third], { judgment: 'truth' }),
    { ok: false, code: 'permission-denied', message: contract.NOT_JUDGE_ERROR });
  assert.deepEqual(h.judge(h.uidOf[seat], { judgment: 'truth' }),
    { ok: false, code: 'permission-denied', message: contract.NOT_JUDGE_ERROR });
  assert.deepEqual(h.judge(h.uidOf[target], { judgment: 'maybe' }),
    { ok: false, code: 'invalid-argument', message: contract.INVALID_JUDGMENT_ERROR });
  assert.equal(h.room.turnState, TURN_STATE.AWAITING_JUDGMENT);
  assert.equal(h.secret().pendingOffer.toPlayerId, target);
});

test('judge: 本当/うその4通りで正しい席へ表向きカードが入る', () => {
  // (宣言一致, 判定) → 成功可否と受取席
  const cases = [
    { claimMatches: true, judgment: 'truth', success: true },
    { claimMatches: true, judgment: 'lie', success: false },
    { claimMatches: false, judgment: 'truth', success: false },
    { claimMatches: false, judgment: 'lie', success: true },
  ];
  for (const scenario of cases) {
    const h = createHarness(4);
    const seat = h.offererSeat();
    const target = h.seats[1];
    const played = h.handOf(seat)[0];
    const claim = scenario.claimMatches ? played.animalType : otherAnimal(played.animalType);
    const made = h.make(h.uidOf[seat], { cardId: played.cardId, claimedAnimalType: claim, targetPlayerId: target });
    assert.equal(made.ok, true);
    const judged = h.judge(h.uidOf[target], { judgment: scenario.judgment });
    assert.equal(judged.ok, true, JSON.stringify(judged));
    const recipient = scenario.success ? seat : target;
    assert.equal(h.room.publicOffer.status, 'completed');
    assert.equal(h.room.publicOffer.actualAnimal, played.animalType);
    assert.equal(h.room.publicOffer.judgment, scenario.judgment);
    assert.equal(h.room.publicOffer.success, scenario.success);
    assert.equal(h.room.publicOffer.faceUpRecipientPlayerId, recipient);
    const expectedFaceUp = [played.animalType];
    if (recipient !== seat) assert.deepEqual(h.room.faceUpCards[recipient].map((c) => c.animalType), expectedFaceUp);
    const other = recipient === seat ? target : seat;
    assert.deepEqual(h.room.faceUpCards[other], []);
    // 表向き1枚・保留なし・32枚保存
    assert.equal(h.secret().pendingOffer, null);
    assert.equal(rules.cardConservation(h.snapshot()).total, 32);
    assert.equal(h.room.handCounts[seat], h.handOf(seat).length);
    assert.deepEqual(contract.publicOfferViolations(h.room.publicOffer), []);
  }
});

/* ------------------------------------------------------------------- 集合 */

test('集合: 同じ動物4枚で終了し、敗者以外のactiveが全員winner（3〜6人）', () => {
  for (const playerCount of [3, 4, 5, 6]) {
    const h = createHarness(playerCount);
    const collector = h.seats[1];
    h.setFaceUp(collector, [card('cat', 'f1'), card('cat', 'f2'), card('cat', 'f3')]);
    h.setHand(h.offererSeat(), [card('cat', 'incoming'), card('fox', 'spare')]);
    const result = h.routeTo(h.uidOf[h.offererSeat()], card('cat', 'incoming'), collector);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(h.room.status, ROOM_STATUS.FINISHED);
    assert.equal(h.room.finishReason, 'gathering');
    assert.equal(h.room.gatheringReason, 'four-of-a-kind');
    assert.deepEqual(h.room.loserPlayerIds, [collector]);
    assert.deepEqual(h.room.winnerPlayerIds, h.seats.filter((seat) => seat !== collector));
    assert.equal(h.room.winnerPlayerIds.length, playerCount - 1);
    assert.equal(h.room.draw, false);
    // 集合成立時はhand-empty判定へ進まない（全員まだ手札が残っている）
    assert.equal(h.seats.every((seat) => h.room.handCounts[seat] > 0), true);
    assert.equal(h.room.finalResult.finishReason, 'gathering');
    assert.equal(h.room.finalResult.players.length, playerCount);
  }
});

test('集合: 3枚では継続し、4枚目で終了する。8種類でも終了し、four-and-eightも判別する', () => {
  const three = createHarness(3);
  const collector = three.seats[1];
  three.setFaceUp(collector, [card('cat', 'a1'), card('cat', 'a2'), card('cat', 'a3')]);
  three.setHand(three.offererSeat(), [card('fox', 'd1'), card('bear', 'spare-3')]);
  const threeResult = three.routeTo(three.uidOf[three.offererSeat()], card('fox', 'd1'), collector);
  assert.equal(threeResult.ok, true, JSON.stringify(threeResult));
  assert.equal(three.room.status, ROOM_STATUS.PLAYING, '3枚では終了してはいけない');
  assert.equal(three.room.turnState, TURN_STATE.AWAITING_OFFER);
  assert.deepEqual(three.room.faceUpCards[collector].map((c) => c.animalType), ['cat', 'cat', 'cat', 'fox']);

  const seven = createHarness(3);
  const sevenSeats = seven.seats[1];
  seven.setFaceUp(sevenSeats, ['cat', 'polar', 'rabbit', 'bear', 'chick', 'fox', 'penguin'].map((animal, index) => card(animal, `s${index}`)));
  seven.setHand(seven.offererSeat(), [card('cat', 'dup'), card('bear', 'spare-7')]);
  const sevenResult = seven.routeTo(seven.uidOf[seven.offererSeat()], card('cat', 'dup'), sevenSeats);
  assert.equal(sevenResult.ok, true, JSON.stringify(sevenResult));
  assert.equal(seven.room.status, ROOM_STATUS.PLAYING, '7種類では終了してはいけない');
  assert.equal(seven.room.faceUpCards[sevenSeats].length, 8);

  const eight = createHarness(3);
  const eightSeats = eight.seats[1];
  eight.setFaceUp(eightSeats, ['cat', 'rabbit', 'bear', 'chick', 'fox', 'penguin', 'panda'].map((animal, index) => card(animal, `e${index}`)));
  eight.setHand(eight.offererSeat(), [card('polar', 'e-polar'), card('bear', 'spare-8')]);
  const eightResult = eight.routeTo(eight.uidOf[eight.offererSeat()], card('polar', 'e-polar'), eightSeats);
  assert.equal(eightResult.ok, true, JSON.stringify(eightResult));
  assert.equal(eight.room.status, ROOM_STATUS.FINISHED);
  assert.equal(eight.room.gatheringReason, 'all-eight-types');

  const both = createHarness(4);
  const bothSeats = both.seats[1];
  both.setFaceUp(bothSeats, [
    card('cat', 'b1'), card('cat', 'b2'), card('cat', 'b3'),
    ...['polar', 'rabbit', 'bear', 'chick', 'fox', 'penguin', 'panda'].map((animal, index) => card(animal, `b${index}`)),
  ]);
  both.setHand(both.offererSeat(), [card('cat', 'b-cat'), card('bear', 'spare-b')]);
  const bothResult = both.routeTo(both.uidOf[both.offererSeat()], card('cat', 'b-cat'), bothSeats);
  assert.equal(bothResult.ok, true, JSON.stringify(bothResult));
  assert.equal(both.room.gatheringReason, 'four-and-eight');
  assert.deepEqual(both.room.winnerPlayerIds, both.seats.filter((seat) => seat !== bothSeats));
});

/* -------------------------------------------------------------- hand-empty */

test('hand-empty: 0枚になった本人は自動敗者ではなく、表向き最少のactiveがwinner（同率はdraw）', () => {
  const single = createHarness(3);
  const empty = single.seats[0];
  single.setHand(empty, [card('cat', 'last')]);
  single.setFaceUp(single.seats[1], [card('fox', 's1')]);
  single.setFaceUp(single.seats[2], [card('cat', 's2'), card('fox', 's3')]);
  const result = single.routeTo(single.uidOf[empty], card('cat', 'last'), single.seats[1]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(single.room.status, ROOM_STATUS.FINISHED);
  assert.equal(single.room.finishReason, 'hand-empty');
  assert.equal(single.room.gatheringReason, null);
  assert.equal(single.room.handCounts[empty], 0);
  assert.deepEqual(single.room.winnerPlayerIds, [empty], '0枚になった本人を自動敗者にしてはいけない');
  assert.deepEqual(single.room.loserPlayerIds, []);
  assert.equal(single.room.draw, false);
  assert.equal(single.room.finalResult.finishReason, 'hand-empty');

  const tied = createHarness(3);
  const tiedEmpty = tied.seats[0];
  tied.setHand(tiedEmpty, [card('cat', 'last')]);
  tied.setFaceUp(tied.seats[1], [card('bear', 't1')]);
  tied.setFaceUp(tied.seats[2], []);
  tied.routeTo(tied.uidOf[tiedEmpty], card('cat', 'last'), tied.seats[1]);
  assert.equal(tied.room.draw, true);
  assert.deepEqual(tied.room.winnerPlayerIds, [tied.seats[0], tied.seats[2]]);
  assert.deepEqual(tied.room.loserPlayerIds, []);
});

test('hand-empty: 3〜6人すべてで終了し、leftは勝者候補から除外される', () => {
  for (const playerCount of [3, 4, 5, 6]) {
    const h = createHarness(playerCount);
    const empty = h.seats[0];
    h.setHand(empty, [card('cat', 'last')]);
    h.setFaceUp(h.seats[1], [card('fox', 'x1')]);
    h.seats.slice(2).forEach((seat, index) => h.setFaceUp(seat, [card('fox', `x${index + 2}`)]));
    h.routeTo(h.uidOf[empty], card('cat', 'last'), h.seats[1]);
    assert.equal(h.room.finishReason, 'hand-empty', `${playerCount}人`);
    assert.deepEqual(expectedHandEmptyWinners(h), [empty], `${playerCount}人の勝者は${empty}`);
    assert.deepEqual(h.room.winnerPlayerIds, expectedHandEmptyWinners(h), `${playerCount}人`);
    assert.equal(h.room.finalResult.players.length, playerCount);
  }
  // leftは勝者比較から外れる（activeだけを見る）
  const left = createHarness(4);
  left.setStatus(left.seats[3], PLAYER_STATUS.LEFT);
  const leftEmpty = left.seats[0];
  left.setHand(leftEmpty, [card('cat', 'last')]);
  left.setFaceUp(left.seats[1], [card('fox', 'l1')]);
  left.setFaceUp(left.seats[2], [card('fox', 'l2')]);
  left.routeTo(left.uidOf[leftEmpty], card('cat', 'last'), left.seats[1]);
  assert.equal(left.room.finishReason, 'hand-empty');
  assert.equal(left.room.winnerPlayerIds.includes(left.seats[3]), false);
  assert.deepEqual(left.room.winnerPlayerIds, expectedHandEmptyWinners(left));
  assert.deepEqual(left.room.leftPlayerIds, [left.seats[3]]);
});

/* -------------------------------------------------------------------- turn */

test('turn: S1→S2・S6→S1・leftスキップ・turnNumberがPhase A契約どおり進む', () => {
  const three = createHarness(3);
  const seat = three.offererSeat();
  const played = three.handOf(seat)[0];
  three.make(three.uidOf[seat], { cardId: played.cardId, claimedAnimalType: played.animalType, targetPlayerId: three.seats[1] });
  three.judge(three.uidOf[three.seats[1]], { judgment: 'truth' });
  assert.equal(three.room.currentTurnPlayerId, three.seats[1]);
  assert.equal(three.room.turnState, TURN_STATE.AWAITING_OFFER);
  assert.equal(three.room.turnNumber, 1);

  const six = createHarness(6);
  six.setTurn('S6');
  const last = six.handOf('S6')[0];
  six.make(six.uidOf.S6, { cardId: last.cardId, claimedAnimalType: last.animalType, targetPlayerId: 'S1' });
  six.judge(six.uidOf.S1, { judgment: 'lie' });
  assert.equal(six.room.currentTurnPlayerId, 'S1');
  assert.equal(six.room.turnNumber, 1);

  const skipped = createHarness(4);
  skipped.setStatus('S2', PLAYER_STATUS.LEFT);
  const first = skipped.handOf('S1')[0];
  skipped.make(skipped.uidOf.S1, { cardId: first.cardId, claimedAnimalType: first.animalType, targetPlayerId: 'S3' });
  skipped.judge(skipped.uidOf.S3, { judgment: 'truth' });
  assert.equal(skipped.room.currentTurnPlayerId, 'S3', 'leftの席はスキップする');
});

test('finished後: make / judge を拒否し、進行もしない', () => {
  const h = createHarness(3);
  const collector = h.seats[1];
  h.setFaceUp(collector, [card('cat', 'f1'), card('cat', 'f2'), card('cat', 'f3')]);
  h.setHand(h.offererSeat(), [card('cat', 'incoming')]);
  h.routeTo(h.uidOf[h.offererSeat()], card('cat', 'incoming'), collector);
  assert.equal(h.room.status, ROOM_STATUS.FINISHED);
  const turnNumber = h.room.turnNumber;
  const nextSeat = h.room.seatOrder.find((seat) => seat !== h.offererSeat());
  assert.deepEqual(h.make(h.uidOf[nextSeat], { cardId: 'any', claimedAnimalType: 'cat', targetPlayerId: collector }),
    { ok: false, code: 'failed-precondition', message: contract.NOT_PLAYING_ERROR });
  assert.deepEqual(h.judge(h.uidOf[nextSeat], { judgment: 'truth' }),
    { ok: false, code: 'failed-precondition', message: contract.NOT_PLAYING_ERROR });
  assert.equal(h.room.turnNumber, turnNumber);
  assert.equal(h.room.turnState, TURN_STATE.FINISHED);
  assert.equal(h.room.currentTurnPlayerId, null);
});

/* -------------------------------------------------------- 冪等性・race 相当 */

test('冪等: make/judge の actionId は同一payloadのみ初回結果を返す', () => {
  const makeFingerprint = contract.actionFingerprint('multi-make-offer', 'uid-S1', 'room-1', {
    cardId: 'cat-x-1', claimedAnimalType: 'cat', targetPlayerId: 'S2',
  });
  const judgeFingerprint = contract.actionFingerprint('multi-judge-offer', 'uid-S2', 'room-1', { judgment: 'truth' });
  assert.deepEqual(makeFingerprint, {
    type: 'multi-make-offer', uid: 'uid-S1', roomId: 'room-1', cardId: 'cat-x-1', claimedAnimalType: 'cat', targetPlayerId: 'S2',
  });
  assert.equal(contract.sameFingerprint(makeFingerprint, { ...makeFingerprint }), true);
  assert.equal(contract.sameFingerprint(makeFingerprint, { ...makeFingerprint, cardId: 'cat-x-2' }), false);
  assert.equal(contract.sameFingerprint(judgeFingerprint, { ...judgeFingerprint, judgment: 'lie' }), false);
  assert.throws(() => contract.replayAction({ fingerprint: judgeFingerprint, result: { ok: 1 } }, makeFingerprint),
    (error) => error.isContractError && error.code === 'already-exists');
  assert.deepEqual(contract.replayAction({ fingerprint: judgeFingerprint, result: { ok: 1 } }, judgeFingerprint), { ok: 1 });
});

test('race相当: 直列化後の二重適用（二重make・二重judge）を純粋層でも拒否する', () => {
  const h = createHarness(3);
  const seat = h.offererSeat();
  const first = h.handOf(seat)[0];
  const second = h.handOf(seat)[1];
  assert.equal(h.make(h.uidOf[seat], { cardId: first.cardId, claimedAnimalType: first.animalType, targetPlayerId: h.seats[1] }).ok, true);
  // 1件目が成立した後の2件目（transaction再試行後の状態）は成立しない
  assert.deepEqual(h.make(h.uidOf[seat], { cardId: second.cardId, claimedAnimalType: second.animalType, targetPlayerId: h.seats[2] }),
    { ok: false, code: 'failed-precondition', message: contract.AWAIT_OFFER_ERROR });
  assert.equal(h.judge(h.uidOf[h.seats[1]], { judgment: 'truth' }).ok, true);
  assert.deepEqual(h.judge(h.uidOf[h.seats[1]], { judgment: 'lie' }),
    { ok: false, code: 'failed-precondition', message: contract.AWAIT_JUDGMENT_ERROR });
  assert.equal(h.room.turnNumber, 1, '判定は1回だけ進む');
  assert.equal(rules.cardConservation(h.snapshot()).total, 32);
});

/* ------------------------------------------------------------------ 完走 */

test('完走: 3〜6人で開始から終了まで到達し、毎ターン32枚が保存される', () => {
  for (const playerCount of [3, 4, 5, 6]) {
    const h = createHarness(playerCount, 11 + playerCount);
    const random = seeded(100 + playerCount);
    let turns = 0;
    while (h.room.status === ROOM_STATUS.PLAYING && turns < 400) {
      const seat = h.room.currentTurnPlayerId;
      const played = (h.handOf(seat) || [])[0];
      assert.ok(played, `${playerCount}人: 手番${seat}の手札が空のまま継続している`);
      const target = h.seats.find((candidate) => candidate !== seat);
      const judgment = random(2) === 0 ? 'truth' : 'lie';
      const made = h.make(h.uidOf[seat], { cardId: played.cardId, claimedAnimalType: played.animalType, targetPlayerId: target });
      assert.equal(made.ok, true, JSON.stringify(made));
      const judged = h.judge(h.uidOf[target], { judgment });
      assert.equal(judged.ok, true, JSON.stringify(judged));
      assert.equal(rules.cardConservation(h.snapshot()).total, 32, `${playerCount}人: ${turns}手目でカードが保存されていない`);
      assert.deepEqual(contract.publicRoomViolations(h.room), []);
      turns += 1;
    }
    assert.equal(h.room.status, ROOM_STATUS.FINISHED, `${playerCount}人が終了しない`);
    assert.ok(['gathering', 'hand-empty', 'too-few-active'].includes(h.room.finishReason));
    assert.equal(h.room.turnState, TURN_STATE.FINISHED);
    assert.equal(h.room.currentTurnPlayerId, null);
    const final = h.room.finalResult;
    assert.equal(final.players.length, playerCount);
    assert.equal(final.finishReason, h.room.finishReason);
    assert.deepEqual(final.winnerPlayerIds, h.room.winnerPlayerIds);
    for (const winner of final.winnerPlayerIds) {
      assert.equal(h.room.playerStatus[winner], PLAYER_STATUS.ACTIVE);
    }
    if (h.room.finishReason === 'gathering') {
      assert.equal(final.loserPlayerIds.length, 1);
      assert.equal(final.draw, false);
      assert.deepEqual(final.winnerPlayerIds, h.seats.filter((seat) => seat !== final.loserPlayerIds[0]));
    }
    if (h.room.finishReason === 'hand-empty') {
      assert.deepEqual(final.loserPlayerIds, []);
      const active = h.seats.filter((seat) => h.room.playerStatus[seat] === PLAYER_STATUS.ACTIVE);
      const totals = active.map((seat) => ({ seat, total: rules.faceUpTotal(h.room.faceUpCards[seat]) }));
      const minimum = Math.min(...totals.map((item) => item.total));
      assert.deepEqual(final.winnerPlayerIds, totals.filter((item) => item.total === minimum).map((item) => item.seat));
      assert.equal(final.draw, final.winnerPlayerIds.length > 1);
    }
    assert.equal(activeCount(h) >= MIN_ACTIVE_PLAYERS, true);
  }
});
// hand-empty の勝者は「activeのうち表向き合計が最少の席（同率は全員）」という契約そのものを再計算する。
function expectedHandEmptyWinners(h) {
  const active = h.seats.filter((seat) => h.room.playerStatus[seat] === PLAYER_STATUS.ACTIVE);
  const totals = active.map((seat) => ({ seat, total: rules.faceUpTotal(h.room.faceUpCards[seat]) }));
  const minimum = Math.min(...totals.map((item) => item.total));
  return totals.filter((item) => item.total === minimum).map((item) => item.seat);
}
function activeCount(h) {
  return h.seats.filter((seat) => h.room.playerStatus[seat] === PLAYER_STATUS.ACTIVE).length;
}

test('Phase C の契約定数と公開範囲は Phase B の設計を壊していない', () => {
  assert.deepEqual(contract.JUDGMENTS, { TRUTH: 'truth', LIE: 'lie' });
  assert.deepEqual(contract.OFFER_FIELDS, ['roomId', 'actionId', 'cardId', 'claimedAnimalType', 'targetPlayerId']);
  assert.deepEqual(contract.JUDGE_FIELDS, ['roomId', 'actionId', 'judgment']);
  assert.equal(contract.MAKE_UID_RATE_LIMIT > 0 && contract.MAKE_IP_RATE_LIMIT >= contract.MAKE_UID_RATE_LIMIT, true);
  assert.equal(contract.JUDGE_UID_RATE_LIMIT > 0, true);
  assert.deepEqual(contract.requireAnimalType('cat'), 'cat');
  assert.throws(() => contract.requireAnimalType('dragon'), (error) => error.code === 'invalid-argument');
  assert.equal(contract.requireJudgment('lie'), 'lie');
  assert.throws(() => contract.requireJudgment('truthy'), (error) => error.code === 'invalid-argument');
  assert.equal(contract.requireCardId('cat-0-1'), 'cat-0-1');
  assert.throws(() => contract.requireCardId(''), (error) => error.code === 'invalid-argument');
  assert.equal(contract.requireSeatValue('S6'), 'S6');
  assert.throws(() => contract.requireSeatValue('S7'), (error) => error.code === 'invalid-argument');
  // Phase B のcollection・定数は変わっていない（新モード分離の維持）
  assert.equal(contract.COLLECTIONS.rooms, 'mofumofuMultiRooms');
  assert.equal(contract.COLLECTIONS.invites, 'mofumofuMultiRoomInvites');
  assert.equal(contract.WAITING_TTL_MS, 30 * 60 * 1000);
  assert.equal(contract.KIND, 'multi');
});

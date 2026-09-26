'use strict';

/**
 * もふもふ大集合！ 人間3〜6人オンライン版 Phase A: 純粋ルール核。
 *
 * このファイルは Firebase（Admin SDK / Firestore / Functions / RTDB）へ一切依存しない。
 * 既存の「2人＋こはる」オンライン版（functions/mofumofu-online/）とは独立した系統であり、
 * 既存モジュールを参照せず、既存モジュールからも参照されない（functions/index.js は無変更）。
 *
 * 端末依存の入力（乱数・カードID生成）は注入可能にしてあり、テストでは決定的な値を渡せる。
 * 既定値のみ node:crypto を使う。
 *
 * 席: 固定A/B/koharuは使わない。S1〜S6を参加順（= seatOrder）で割り当てる。
 * 状態: すべて plain object。各遷移関数は入力を変更せず、新しい状態を返す。
 */

const { randomInt, randomUUID } = require('node:crypto');

const ANIMALS = ['cat', 'rabbit', 'bear', 'chick', 'fox', 'penguin', 'panda', 'polar'];
const COPIES_PER_ANIMAL = 4;
const DECK_SIZE = ANIMALS.length * COPIES_PER_ANIMAL;
const FOUR_OF_A_KIND_COUNT = 4;

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 6;
const SEAT_IDS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'];

// 人数別の初期手札と余り（山札）。合計は常に32枚。
const HAND_SIZE_BY_PLAYER_COUNT = { 3: 10, 4: 8, 5: 6, 6: 5 };
const LEFTOVERS_BY_PLAYER_COUNT = { 3: 2, 4: 0, 5: 2, 6: 2 };

// activeがこの人数を下回った時点で終了する（明示退出だけが原因になり得る）。
const MIN_ACTIVE_PLAYERS = 3;

const PLAYER_STATUS = { ACTIVE: 'active', LEFT: 'left' };
const ROOM_STATUS = { WAITING: 'waiting', PLAYING: 'playing', FINISHED: 'finished' };
const TURN_STATE = {
  WAITING: 'waiting',
  AWAITING_OFFER: 'awaitingOffer',
  AWAITING_JUDGMENT: 'awaitingJudgment',
  FINISHED: 'finished',
};
const FINISH_REASON = {
  GATHERING: 'gathering',
  HAND_EMPTY: 'hand-empty',
  TOO_FEW_ACTIVE: 'too-few-active',
};
const GATHERING_REASON = {
  FOUR_OF_A_KIND: 'four-of-a-kind',
  ALL_EIGHT_TYPES: 'all-eight-types',
  FOUR_AND_EIGHT: 'four-and-eight',
};
const JUDGMENTS = ['truth', 'lie'];

function fail(code, message) {
  const error = new Error(message || code);
  error.code = code;
  throw error;
}
function plain(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function copyCard(card) { return { cardId: card.cardId, animalType: card.animalType }; }
function copyCards(cards) { return (Array.isArray(cards) ? cards : []).map(copyCard); }

/* ---------------------------------------------------------------- 人数・席 */

function validatePlayerCount(count) {
  if (!Number.isInteger(count)) fail('invalid-player-count', '人数は整数で指定してください。');
  if (count < MIN_PLAYERS || count > MAX_PLAYERS) fail('invalid-player-count', `人数は${MIN_PLAYERS}〜${MAX_PLAYERS}人です。`);
  return count;
}
function handSizeFor(playerCount) { return HAND_SIZE_BY_PLAYER_COUNT[validatePlayerCount(playerCount)]; }
function leftoversFor(playerCount) { return LEFTOVERS_BY_PLAYER_COUNT[validatePlayerCount(playerCount)]; }

function generateSeats(playerCount) {
  return SEAT_IDS.slice(0, validatePlayerCount(playerCount));
}
function validateSeatOrder(seats, playerCount) {
  const expected = playerCount === undefined ? seats?.length : validatePlayerCount(playerCount);
  if (!Array.isArray(seats) || seats.length !== expected) fail('invalid-seat-order', '席数が人数と一致しません。');
  const seen = new Set();
  for (const seat of seats) {
    if (!SEAT_IDS.includes(seat)) fail('invalid-seat', `不明な席です: ${seat}`);
    if (seen.has(seat)) fail('invalid-seat', `席が重複しています: ${seat}`);
    seen.add(seat);
  }
  return [...seats];
}
function requireSeat(state, seatId) {
  if (!state?.seatOrder?.includes(seatId)) fail('invalid-seat', `不明な席です: ${seatId}`);
  return seatId;
}

/* ------------------------------------------------------------ デッキ・配布 */

function createDeck({ idFactory = randomUUID } = {}) {
  const cards = [];
  for (const animalType of ANIMALS) {
    for (let copy = 0; copy < COPIES_PER_ANIMAL; copy += 1) {
      cards.push({ cardId: `${animalType}-${copy}-${idFactory()}`, animalType });
    }
  }
  return cards;
}
function shuffle(cards, randomIntFn = randomInt) {
  const result = [...cards];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomIntFn(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
function assertWholeDeck(cards) {
  if (!Array.isArray(cards) || cards.length !== DECK_SIZE) fail('invalid-deck', `デッキは${DECK_SIZE}枚です。`);
  const ids = new Set();
  for (const card of cards) {
    if (!plain(card) || typeof card.cardId !== 'string' || !card.cardId) fail('invalid-card', 'カード形式が正しくありません。');
    if (!ANIMALS.includes(card.animalType)) fail('invalid-card', `不明な動物です: ${card.animalType}`);
    if (ids.has(card.cardId)) fail('duplicate-card', `カードIDが重複しています: ${card.cardId}`);
    ids.add(card.cardId);
  }
  const counts = countByAnimal(cards);
  for (const animalType of ANIMALS) {
    if (counts[animalType] !== COPIES_PER_ANIMAL) fail('invalid-deck-composition', `${animalType}の枚数が${COPIES_PER_ANIMAL}枚ではありません。`);
  }
  return cards;
}
// 席順に handSize 枚ずつ配り、残りを leftovers として返す（ゲーム中は引かない・補充しない）。
function dealDeck(cards, seats) {
  assertWholeDeck(cards);
  const order = validateSeatOrder(seats);
  const handSize = handSizeFor(order.length);
  const hands = {};
  for (let index = 0; index < order.length; index += 1) {
    hands[order[index]] = copyCards(cards.slice(index * handSize, (index + 1) * handSize));
  }
  const leftovers = copyCards(cards.slice(order.length * handSize));
  if (leftovers.length !== leftoversFor(order.length)) fail('invalid-leftovers', '余りカードの枚数が想定と一致しません。');
  return { hands, leftovers };
}

/* ------------------------------------------------------------------- 集計 */

function countByAnimal(cards) {
  const counts = Object.fromEntries(ANIMALS.map((animalType) => [animalType, 0]));
  for (const card of Array.isArray(cards) ? cards : []) {
    if (card && ANIMALS.includes(card.animalType)) counts[card.animalType] += 1;
  }
  return counts;
}
function faceUpTotal(cards) {
  return Object.values(countByAnimal(cards)).reduce((sum, count) => sum + count, 0);
}
// 表向きカードだけを見る純粋判定（手札は含めない）。
function gatheringState(cards) {
  const counts = countByAnimal(cards);
  const fourOfAKind = ANIMALS.find((animalType) => counts[animalType] >= FOUR_OF_A_KIND_COUNT) || null;
  const allEightTypes = ANIMALS.every((animalType) => counts[animalType] >= 1);
  const gathering = Boolean(fourOfAKind || allEightTypes);
  const reason = fourOfAKind && allEightTypes ? GATHERING_REASON.FOUR_AND_EIGHT
    : fourOfAKind ? GATHERING_REASON.FOUR_OF_A_KIND
      : allEightTypes ? GATHERING_REASON.ALL_EIGHT_TYPES
        : null;
  return { fourOfAKind, allEightTypes, gathering, reason };
}
function judgeSuccess(claimAnimal, actualAnimal, judgment) {
  if (!ANIMALS.includes(claimAnimal)) fail('invalid-claim', `不明な宣言です: ${claimAnimal}`);
  if (!ANIMALS.includes(actualAnimal)) fail('invalid-card', `不明な動物です: ${actualAnimal}`);
  if (!JUDGMENTS.includes(judgment)) fail('invalid-judgment', `不明な判定です: ${judgment}`);
  return (claimAnimal === actualAnimal) === (judgment === 'truth');
}
function activeSeats(state) {
  return state.seatOrder.filter((seat) => state.playerStatus[seat] === PLAYER_STATUS.ACTIVE);
}
// seatOrder順で次のactive席。他にactiveが無ければnull。left等の非activeはスキップする。
function nextActivePlayer(currentSeatId, seatOrder, playerStatus) {
  const index = seatOrder.indexOf(currentSeatId);
  if (index < 0) fail('invalid-seat', `不明な席です: ${currentSeatId}`);
  for (let offset = 1; offset <= seatOrder.length; offset += 1) {
    const seat = seatOrder[(index + offset) % seatOrder.length];
    if ((playerStatus?.[seat] || PLAYER_STATUS.ACTIVE) === PLAYER_STATUS.ACTIVE) return seat;
  }
  return null;
}
// 手番者がカードを渡せる相手: 自分以外のactive席（最大5人）。NPC例外はない。
function validTargets(state, seatId) {
  requireSeat(state, seatId);
  return activeSeats(state).filter((seat) => seat !== seatId);
}

/* ------------------------------------------------------------------- 状態 */

function cloneState(state) {
  return {
    ...state,
    seatOrder: [...state.seatOrder],
    players: Object.fromEntries(Object.entries(state.players).map(([seat, player]) => [seat, { ...player }])),
    playerUids: { ...state.playerUids },
    playerStatus: { ...state.playerStatus },
    faceUpCards: Object.fromEntries(Object.entries(state.faceUpCards).map(([seat, cards]) => [seat, copyCards(cards)])),
    handCounts: { ...state.handCounts },
    hands: Object.fromEntries(Object.entries(state.hands).map(([seat, cards]) => [seat, copyCards(cards)])),
    leftovers: copyCards(state.leftovers),
    discard: copyCards(state.discard),
    pendingOffer: state.pendingOffer ? { ...state.pendingOffer, card: copyCard(state.pendingOffer.card) } : null,
    publicOffer: state.publicOffer ? { ...state.publicOffer } : null,
    winnerPlayerIds: [...state.winnerPlayerIds],
    loserPlayerIds: [...state.loserPlayerIds],
    leftPlayerIds: [...state.leftPlayerIds],
    finalResult: state.finalResult ? structuredClone(state.finalResult) : null,
  };
}
// 公開roomへ載せる手札枚数は、秘密の手札配列から毎回作り直す（唯一の正本は hands）。
function syncHandCounts(state) {
  for (const seat of state.seatOrder) state.handCounts[seat] = (state.hands[seat] || []).length;
}

function createInitialState({
  playerCount,
  seats,
  displayNames = {},
  idFactory = randomUUID,
  randomInt: randomIntFn = randomInt,
} = {}) {
  const count = validatePlayerCount(playerCount);
  const order = seats === undefined ? generateSeats(count) : validateSeatOrder(seats, count);
  const deck = assertWholeDeck(shuffle(createDeck({ idFactory }), randomIntFn));
  const { hands, leftovers } = dealDeck(deck, order);
  const players = {};
  const playerUids = {};
  const playerStatus = {};
  const faceUpCards = {};
  const handCounts = {};
  for (const seat of order) {
    const displayName = plain(displayNames) && typeof displayNames[seat] === 'string' ? displayNames[seat] : null;
    players[seat] = { seatId: seat, joined: true, displayName };
    playerUids[seat] = null;
    playerStatus[seat] = PLAYER_STATUS.ACTIVE;
    faceUpCards[seat] = [];
    handCounts[seat] = hands[seat].length;
  }
  return {
    schemaVersion: 1,
    kind: 'multi',
    playerCount: count,
    seatOrder: [...order],
    players,
    playerUids,
    playerStatus,
    faceUpCards,
    handCounts,
    hands,
    leftovers,
    discard: [],
    status: ROOM_STATUS.PLAYING,
    currentTurnPlayerId: order[0],
    turnState: TURN_STATE.AWAITING_OFFER,
    turnNumber: 0,
    pendingOffer: null,
    publicOffer: null,
    winnerPlayerIds: [],
    loserPlayerIds: [],
    leftPlayerIds: [],
    draw: false,
    finishReason: null,
    gatheringReason: null,
    finalResult: null,
  };
}

/* ------------------------------------------------------------------ 進行 */

function requirePlaying(state) {
  if (state.status !== ROOM_STATUS.PLAYING) fail('not-playing', 'ゲームは終了しています。');
}
function requireActive(state, seatId) {
  requireSeat(state, seatId);
  if (state.playerStatus[seatId] !== PLAYER_STATUS.ACTIVE) fail('not-active', `席${seatId}は参加中ではありません。`);
  return seatId;
}

// 手札から1枚を保留（pendingOffer）へ移す。手札の内容は公開しない（handCountsだけ更新）。
function applyOffer(state, { fromPlayerId, toPlayerId, cardId, claimAnimal, actionId = null } = {}) {
  requirePlaying(state);
  if (state.turnState !== TURN_STATE.AWAITING_OFFER) fail('not-awaiting-offer', 'いまはカードを渡せません。');
  if (state.currentTurnPlayerId !== fromPlayerId) fail('not-your-turn', '手番ではありません。');
  requireActive(state, fromPlayerId);
  if (state.pendingOffer) fail('pending-offer', '判定待ちのカードがあります。');
  if (typeof cardId !== 'string' || !cardId) fail('invalid-card', 'カードが正しくありません。');
  if (!ANIMALS.includes(claimAnimal)) fail('invalid-claim', '宣言が正しくありません。');
  if (!validTargets(state, fromPlayerId).includes(toPlayerId)) fail('invalid-target', '渡せない相手です。');
  const next = cloneState(state);
  const index = next.hands[fromPlayerId].findIndex((card) => card.cardId === cardId);
  if (index < 0) fail('card-not-in-hand', 'そのカードは手札にありません。');
  const [card] = next.hands[fromPlayerId].splice(index, 1);
  next.pendingOffer = { actionId, fromPlayerId, toPlayerId, claimAnimal, card: copyCard(card) };
  next.publicOffer = { actionId, fromPlayerId, toPlayerId, claimAnimal, status: 'pending' };
  next.turnState = TURN_STATE.AWAITING_JUDGMENT;
  syncHandCounts(next);
  return next;
}

// 受け取った本人だけが判定できる（byPlayerIdを渡した場合は受取人と一致しない限り拒否）。
function applyJudgment(state, { judgment, byPlayerId = null } = {}) {
  requirePlaying(state);
  if (state.turnState !== TURN_STATE.AWAITING_JUDGMENT) fail('not-awaiting-judgment', 'いまは判定できません。');
  const pending = state.pendingOffer;
  if (!pending) fail('no-pending-offer', '判定待ちのカードがありません。');
  if (byPlayerId !== null && byPlayerId !== pending.toPlayerId) fail('not-the-judge', '判定できるのは受け取った本人だけです。');
  if (!JUDGMENTS.includes(judgment)) fail('invalid-judgment', `不明な判定です: ${judgment}`);
  const success = judgeSuccess(pending.claimAnimal, pending.card.animalType, judgment);
  const recipient = success ? pending.fromPlayerId : pending.toPlayerId;

  const next = cloneState(state);
  next.faceUpCards[recipient] = [...next.faceUpCards[recipient], copyCard(pending.card)];
  next.pendingOffer = null;
  next.publicOffer = {
    ...state.publicOffer,
    status: 'completed',
    actualAnimal: pending.card.animalType,
    judgment,
    success,
    faceUpRecipientPlayerId: recipient,
  };
  next.turnNumber = (state.turnNumber || 0) + 1;

  // 優先順位: 集合成立（即終了）→ 手札切れ → 進行。
  const gathering = gatheringState(next.faceUpCards[recipient]);
  if (gathering.gathering) return finishByGathering(next, recipient);
  if (activeSeats(next).some((seat) => next.handCounts[seat] === 0)) return finishByHandEmpty(next);
  const active = activeSeats(next);
  if (active.length < MIN_ACTIVE_PLAYERS) return finishByTooFewActive(next);
  const following = nextActivePlayer(pending.fromPlayerId, next.seatOrder, next.playerStatus);
  if (following === null) return finishByTooFewActive(next);
  next.currentTurnPlayerId = following;
  next.turnState = TURN_STATE.AWAITING_OFFER;
  return next;
}

// 明示退出。通信切れ・ブラウザ終了・バックグラウンドは退出にしない（Phase Aではpresenceを扱わない）。
// 判定待ちの当事者は退出できない（宙に浮いた保留カードを作らないためのPhase A制約）。
function leaveGame(state, seatId) {
  requirePlaying(state);
  requireActive(state, seatId);
  const pending = state.pendingOffer;
  if (pending && (pending.fromPlayerId === seatId || pending.toPlayerId === seatId)) {
    fail('pending-offer-involves-seat', '判定待ちの当事者は退出できません。');
  }
  const next = cloneState(state);
  next.playerStatus[seatId] = PLAYER_STATUS.LEFT;
  // 退出の記録は退出順ではなくseatOrder順で保持する（UI・結果表示を決定的にする）。
  next.leftPlayerIds = next.seatOrder.filter((seat) => next.playerStatus[seat] === PLAYER_STATUS.LEFT);
  // 退出者の手札は捨て札へ移し、カード総数32枚を保つ。表向きカードは結果表示のため残す。
  next.discard = [...next.discard, ...next.hands[seatId]];
  next.hands[seatId] = [];
  syncHandCounts(next);
  if (activeSeats(next).length < MIN_ACTIVE_PLAYERS) return finishByTooFewActive(next);
  if (next.currentTurnPlayerId === seatId) {
    const following = nextActivePlayer(seatId, next.seatOrder, next.playerStatus);
    if (following === null) return finishByTooFewActive(next);
    next.currentTurnPlayerId = following;
    next.turnState = TURN_STATE.AWAITING_OFFER;
  }
  return next;
}

/* -------------------------------------------------------------- 終了処理 */

function finish(state, { finishReason, winnerPlayerIds, loserPlayerIds = [], leftPlayerIds, draw = false, gatheringReason = null }) {
  const next = cloneState(state);
  next.status = ROOM_STATUS.FINISHED;
  next.turnState = TURN_STATE.FINISHED;
  next.currentTurnPlayerId = null;
  next.pendingOffer = null;
  next.finishReason = finishReason;
  next.gatheringReason = gatheringReason;
  next.winnerPlayerIds = [...winnerPlayerIds];
  next.loserPlayerIds = [...loserPlayerIds];
  next.leftPlayerIds = [...(leftPlayerIds || next.seatOrder.filter((seat) => next.playerStatus[seat] === PLAYER_STATUS.LEFT))];
  next.draw = draw;
  next.finalResult = buildFinalResult(next);
  return next;
}
// 集合成立: 敗者以外のactive全員が勝者（3人→2人、6人→5人）。脱落戦・続行は行わない。
function finishByGathering(state, loserPlayerId) {
  requirePlaying(state);
  requireActive(state, loserPlayerId);
  const gathering = gatheringState(state.faceUpCards[loserPlayerId]);
  if (!gathering.gathering) fail('no-gathering', '集合が成立していません。');
  return finish(state, {
    finishReason: FINISH_REASON.GATHERING,
    gatheringReason: gathering.reason,
    winnerPlayerIds: activeSeats(state).filter((seat) => seat !== loserPlayerId),
    loserPlayerIds: [loserPlayerId],
    draw: false,
  });
}
// 手札切れ: 0枚になった本人は自動的な敗者ではない。active全員の表向き合計が最少の席が勝者（同数は全員同率）。
function finishByHandEmpty(state) {
  requirePlaying(state);
  const active = activeSeats(state);
  const totals = active.map((seat) => ({ seatId: seat, total: faceUpTotal(state.faceUpCards[seat]) }));
  const minimum = Math.min(...totals.map(({ total }) => total));
  const winners = totals.filter(({ total }) => total === minimum).map(({ seatId }) => seatId);
  return finish(state, {
    finishReason: FINISH_REASON.HAND_EMPTY,
    winnerPlayerIds: winners,
    loserPlayerIds: [],
    draw: winners.length > 1,
  });
}
// 明示退出によりactiveが2人以下になった時点で終了。残ったactiveが勝者。leftは勝者に含めない。
function finishByTooFewActive(state) {
  requirePlaying(state);
  return finish(state, {
    finishReason: FINISH_REASON.TOO_FEW_ACTIVE,
    winnerPlayerIds: activeSeats(state),
    loserPlayerIds: [],
    draw: false,
  });
}

function buildFinalResult(state) {
  return {
    finishReason: state.finishReason,
    gatheringReason: state.gatheringReason,
    winnerPlayerIds: [...state.winnerPlayerIds],
    loserPlayerIds: [...state.loserPlayerIds],
    leftPlayerIds: [...state.leftPlayerIds],
    draw: state.draw,
    players: state.seatOrder.map((seat) => ({
      seatId: seat,
      displayName: state.players[seat]?.displayName ?? null,
      status: state.playerStatus[seat],
      handCount: state.handCounts[seat] || 0,
      faceUpCardsByAnimal: countByAnimal(state.faceUpCards[seat]),
      faceUpCardsTotal: faceUpTotal(state.faceUpCards[seat]),
    })),
  };
}

// 32枚の保存則チェック用（手札＋保留＋表向き＋余り＋捨て札）。
function cardConservation(state) {
  const hand = state.seatOrder.reduce((sum, seat) => sum + (state.hands[seat] || []).length, 0);
  const faceUp = state.seatOrder.reduce((sum, seat) => sum + (state.faceUpCards[seat] || []).length, 0);
  const pendingOffer = state.pendingOffer ? 1 : 0;
  const leftovers = (state.leftovers || []).length;
  const discard = (state.discard || []).length;
  return { hand, pendingOffer, faceUp, leftovers, discard, total: hand + pendingOffer + faceUp + leftovers + discard, deckSize: DECK_SIZE };
}

/* ------------------------------------------------------ 公開／秘密の分離 */

// 公開room: カードの内容（手札・余り）を含めない。handCountsとfaceUpCardsだけが公開対象。
function toPublicRoom(state) {
  const { hands, leftovers, ...publicRoom } = cloneState(state);
  return publicRoom;
}
// 秘密領域（server専用）: 手札の実体と余りカード。クライアントからは読ませない前提。
function toServerSecrets(state) {
  return { hands: Object.fromEntries(state.seatOrder.map((seat) => [seat, copyCards(state.hands[seat])])), leftovers: copyCards(state.leftovers) };
}

module.exports = {
  ANIMALS,
  COPIES_PER_ANIMAL,
  DECK_SIZE,
  FOUR_OF_A_KIND_COUNT,
  MIN_PLAYERS,
  MAX_PLAYERS,
  MIN_ACTIVE_PLAYERS,
  SEAT_IDS,
  HAND_SIZE_BY_PLAYER_COUNT,
  LEFTOVERS_BY_PLAYER_COUNT,
  PLAYER_STATUS,
  ROOM_STATUS,
  TURN_STATE,
  FINISH_REASON,
  GATHERING_REASON,
  validatePlayerCount,
  handSizeFor,
  leftoversFor,
  generateSeats,
  validateSeatOrder,
  createDeck,
  shuffle,
  assertWholeDeck,
  dealDeck,
  createInitialState,
  countByAnimal,
  faceUpTotal,
  gatheringState,
  judgeSuccess,
  activeSeats,
  nextActivePlayer,
  validTargets,
  applyOffer,
  applyJudgment,
  leaveGame,
  finishByGathering,
  finishByHandEmpty,
  finishByTooFewActive,
  buildFinalResult,
  cardConservation,
  toPublicRoom,
  toServerSecrets,
};

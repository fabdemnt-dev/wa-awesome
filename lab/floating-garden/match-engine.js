/** Serializable deterministic rules. No DOM, clock, network or ambient randomness. */
import { createGarden, createTile, placeTile, placeStone, scoreGarden, validateGarden, TERRAIN, STONES } from './engine.js?v=20261001-score-details';

export const MATCH_VERSION = 'floating-garden-match-1';
export const POWER = Object.freeze({ initial: 4, max: 6, meditate: 1, give: 2, invite: 3, welcome: 2, stone: 3 });
const names = ['あなた', '月の庭', '森の庭', '結晶の庭'];
const filled = (player) => player.garden.every(Boolean);
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const note = (state, message) => state.log.push(message);

function shuffledDeck(count, seed) {
  let value = 2166136261;
  for (const char of String(seed)) value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0;
  const next = () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 4294967296; };
  const kinds = Object.keys(TERRAIN);
  const deck = Array.from({ length: count * 20 }, (_, index) => ({ id: `tile-${index}`, ...createTile(kinds[index % 5], Math.floor(index / 5) % 2 ? 'bend' : 'straight') }));
  for (let index = deck.length - 1; index > 0; index -= 1) { const other = Math.floor(next() * (index + 1)); [deck[index], deck[other]] = [deck[other], deck[index]]; }
  return deck;
}

export function createMatch({ playerCount = 4, seed = 'garden-1', humanSeat = 0 } = {}) {
  if (![2, 3, 4].includes(playerCount)) fail('invalid-player-count', '参加人数は2〜4人です');
  if (!Number.isInteger(humanSeat) || humanSeat < -1 || humanSeat >= playerCount) fail('invalid-human-seat', '操作する席を確認してください');
  if (!['string', 'number'].includes(typeof seed) || (typeof seed === 'number' && !Number.isFinite(seed))) fail('invalid-seed', '山札の合言葉を確認してください');
  const state = { version: MATCH_VERSION, seed: String(seed), revision: 0, players: Array.from({ length: playerCount }, (_, seat) => ({ seat, id: `p${seat}`, name: seat === humanSeat ? 'あなた' : names[seat] === 'あなた' ? '星の庭' : names[seat], isHuman: seat === humanSeat, garden: createGarden(), tileIds: Array(16).fill(null), power: POWER.initial, storage: null, careCount: 0 })), deck: shuffledDeck(playerCount, seed), deckCursor: 0, round: 1, phase: 'normal', activeSeat: 0, prioritySeat: 1, step: 'source', drawn: null, offerTarget: null, inviteSeats: [], inviteIndex: 0, requests: [], placementSeat: null, afterPlacement: null, finalSeat: 0, log: ['庭づくりを始めます。通常12巡、その後は全員の庭を仕上げます'] };
  assertMatchInvariants(state);
  return state;
}

export function getDecision(state) {
  if (state.phase === 'finished') return null;
  let seat = state.activeSeat;
  if (state.step === 'offer-response') seat = state.offerTarget;
  else if (state.step === 'invite-response') seat = state.inviteSeats[state.inviteIndex];
  else if (state.step === 'place') seat = state.placementSeat;
  else if (state.phase === 'final-stone') seat = state.finalSeat;
  return { seat, kind: state.step };
}

/** Only public information; even a reproducible seed would leak the remaining order. */
export function publicMatch(state) {
  const { deck, deckCursor, seed, ...visible } = structuredClone(state);
  return { ...visible, deckRemaining: deck.length - deckCursor };
}

export function legalActions(state) {
  const decision = getDecision(state);
  if (!decision) return [];
  const seat = decision.seat;
  const player = state.players[seat];
  const action = (type, extra = {}) => ({ type, seat, ...extra, revision: state.revision });
  const stoneActions = () => player.power < POWER.stone ? [] : Object.keys(STONES).filter((stone) => !player.garden.some((tile) => tile?.stone === stone)).flatMap((stone) => player.garden.flatMap((tile, index) => tile && !tile.stone ? [action('stone', { index, stone })] : []));
  if (state.step === 'source') return [action('draw'), ...(player.storage ? [action('use-storage')] : [])];
  if (state.step === 'choose') return [action('self'), ...(state.drawn.canOffer ? state.players.filter((other) => other.seat !== seat && !filled(other)).map((other) => action('offer', { target: other.seat })) : []), ...(state.drawn.canStore ? [action('store')] : [])];
  if (state.step === 'offer-response') return [action('accept'), action('decline')];
  if (state.step === 'invite-response') return [action('request-invite'), action('pass-invite')];
  if (state.step === 'welcome') return [...(player.power >= POWER.welcome ? [action('welcome')] : []), action('yield')];
  if (state.step === 'place') return player.garden.flatMap((tile, index) => tile ? [] : Array.from({ length: 4 }, (_, rotation) => action('place', { index, rotation })));
  if (state.step === 'care') return [action('meditate'), ...stoneActions()];
  if (state.step === 'final-stone') return [action('pass-final'), ...stoneActions()];
  fail('invalid-step', '進行状態を確認してください');
}

function draw(state, source, protectedTile) {
  if (state.deckCursor >= state.deck.length) fail('deck-exhausted', '山札が足りません');
  state.drawn = { tile: { ...state.deck[state.deckCursor++] }, ownerSeat: state.activeSeat, source, protected: protectedTile, canOffer: !protectedTile, canStore: !protectedTile };
  note(state, `${state.players[state.activeSeat].name}が${TERRAIN[state.drawn.tile.terrain].name}を引きました${protectedTile ? '（必ず自庭に置く保護タイル）' : ''}`);
  if (protectedTile) setPlacement(state, state.activeSeat, 'care');
  else state.step = 'choose';
}

function setPlacement(state, seat, after) { state.step = 'place'; state.placementSeat = seat; state.afterPlacement = after; }
function selfUse(state) {
  const seats = Array.from({ length: state.players.length }, (_, offset) => (state.prioritySeat + offset) % state.players.length).filter((seat) => seat !== state.activeSeat && !filled(state.players[seat]) && state.players[seat].power >= POWER.invite);
  state.drawn.canOffer = false;
  state.drawn.canStore = false;
  state.inviteSeats = seats; state.inviteIndex = 0; state.requests = [];
  if (state.phase === 'normal' && !state.drawn.protected && seats.length) state.step = 'invite-response';
  else setPlacement(state, state.activeSeat, 'care');
}
function startTurn(state) {
  state.drawn = null; state.offerTarget = null; state.inviteSeats = []; state.requests = []; state.inviteIndex = 0; state.placementSeat = null; state.afterPlacement = null;
  const player = state.players[state.activeSeat];
  if (filled(player)) { state.step = 'care'; return; }
  if (state.phase === 'finishing') {
    if (player.storage) {
      state.drawn = { tile: player.storage, ownerSeat: state.activeSeat, source: 'storage', protected: true, canOffer: false, canStore: false };
      player.storage = null; setPlacement(state, state.activeSeat, 'care');
    } else draw(state, 'finishing', true);
  } else state.step = 'source';
}
function finishCare(state) {
  state.players[state.activeSeat].careCount += 1;
  if (state.activeSeat < state.players.length - 1) state.activeSeat += 1;
  else {
    if (state.players.every(filled)) {
      state.phase = 'final-stone'; state.step = 'final-stone'; state.drawn = null; state.finalSeat = 0;
      note(state, '全員の庭が完成しました。最後に石を1個置くか、見送ります');
      return;
    }
    state.round += 1; state.activeSeat = 0;
    if (state.round > 12) state.phase = 'finishing';
    if (state.round > 16) fail('incomplete-gardens', '16巡までに庭が完成していません');
    note(state, `${state.phase === 'finishing' ? '仕上げ' : '通常'} ${state.round}巡目`);
  }
  startTurn(state);
}
function finishFinal(state) {
  if (++state.finalSeat >= state.players.length) { state.phase = 'finished'; state.step = 'finished'; note(state, 'すべての庭を採点しました。同点は同じ順位です'); }
}

export function applyMatchAction(state, command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) fail('invalid-action', '操作を確認してください');
  const exact = legalActions(state).find((action) => Object.keys(action).length === Object.keys(command).length && Object.entries(action).every(([key, value]) => command[key] === value));
  if (!exact) fail(command.revision !== state.revision ? 'stale-action' : 'illegal-action', 'いまはその操作を選べません。最新の手番を確認してください');
  const next = structuredClone(state);
  const player = next.players[command.seat];
  switch (command.type) {
    case 'draw': draw(next, 'draw', false); break;
    case 'use-storage':
      next.drawn = { tile: player.storage, ownerSeat: command.seat, source: 'storage', protected: false, canOffer: true, canStore: false }; player.storage = null; next.step = 'choose';
      note(next, `${player.name}が保管していた1枚を使います`); break;
    case 'self': selfUse(next); break;
    case 'offer': next.drawn.canOffer = false; next.offerTarget = command.target; next.step = 'offer-response'; note(next, `${player.name}が${next.players[command.target].name}に1枚を譲る提案をしました`); break;
    case 'accept':
      next.players[next.activeSeat].power = Math.min(POWER.max, next.players[next.activeSeat].power + POWER.give);
      next.drawn.protected = true; next.drawn.canStore = false; setPlacement(next, command.seat, 'replacement');
      note(next, `${player.name}が譲り受けました。${next.players[next.activeSeat].name}の力+2（上限6）`); break;
    case 'decline': next.step = 'choose'; note(next, `${player.name}が提案を見送りました。別の相手には再提案できません`); break;
    case 'store': {
      const previous = player.storage; player.storage = next.drawn.tile;
      note(next, `${player.name}が引いた1枚を保管しました`);
      if (previous) { next.drawn = { tile: previous, ownerSeat: command.seat, source: 'storage-swap', protected: false, canOffer: false, canStore: false }; selfUse(next); }
      else draw(next, 'replacement', true);
      break;
    }
    case 'request-invite': case 'pass-invite':
      if (command.type === 'request-invite') { next.requests.push(command.seat); note(next, `${player.name}が精霊を招く希望を出しました（撤回なし）`); }
      if (++next.inviteIndex < next.inviteSeats.length) break;
      if (next.requests.length) next.step = 'welcome'; else setPlacement(next, next.activeSeat, 'care');
      break;
    case 'welcome': player.power -= POWER.welcome; next.drawn.protected = true; setPlacement(next, next.activeSeat, 'care'); note(next, `${player.name}が力2で庭に迎えました。招く側は力を使いません`); break;
    case 'yield': {
      const receiver = next.requests[0]; next.players[receiver].power -= POWER.invite; next.prioritySeat = (receiver + 1) % next.players.length;
      next.drawn.protected = true; setPlacement(next, receiver, 'replacement');
      note(next, `${next.players[receiver].name}が優先順により力3で招きました。${player.name}には保護代替を用意します`); break;
    }
    case 'place': {
      player.garden = placeTile(player.garden, command.index, { ...next.drawn.tile, rotation: command.rotation }); player.tileIds[command.index] = next.drawn.tile.id;
      const replacement = next.afterPlacement === 'replacement'; next.drawn = null;
      note(next, `${player.name}の庭が${player.garden.filter(Boolean).length}/16マスになりました`);
      if (replacement) draw(next, 'replacement', true); else next.step = 'care';
      break;
    }
    case 'meditate': player.power = Math.min(POWER.max, player.power + POWER.meditate); note(next, `${player.name}が瞑想しました。力+1（上限6）`); finishCare(next); break;
    case 'stone': player.garden = placeStone(player.garden, command.index, command.stone); player.power -= POWER.stone; note(next, `${player.name}が力3で${STONES[command.stone].name}を置きました`); if (next.phase === 'final-stone') finishFinal(next); else finishCare(next); break;
    case 'pass-final': note(next, `${player.name}が最後の石を見送りました`); finishFinal(next); break;
    default: fail('invalid-action', '操作を確認してください');
  }
  next.revision += 1;
  assertMatchInvariants(next);
  return next;
}

export function rankMatch(state) {
  const scores = state.players.map((player) => ({ seat: player.seat, score: scoreGarden(player.garden).total }));
  return scores.map((item) => ({ ...item, rank: 1 + scores.filter((other) => other.score > item.score).length })).sort((a, b) => a.rank - b.rank || a.seat - b.seat);
}

/** Run after every transition, including gifts, invitations, storage and final stones. */
export function assertMatchInvariants(state) {
  const ids = [];
  const originals = new Map(state.deck.map((tile) => [tile.id, tile]));
  const record = (tile, id) => {
    const original = originals.get(id);
    if (!original || tile.terrain !== original.terrain || tile.shape !== original.shape) fail('tile-identity', 'タイルの種類が山札の記録と一致しません');
    ids.push(id);
  };
  if (state.deck.length !== state.players.length * 20 || state.deckCursor > state.deck.length || state.deckCursor < 0) fail('invalid-deck', '山札の枚数が不正です');
  for (const player of state.players) {
    validateGarden(player.garden);
    if (!Number.isInteger(player.power) || player.power < 0 || player.power > POWER.max) fail('invalid-power', '力の範囲が不正です');
    if (player.tileIds.length !== 16) fail('invalid-tile-ids', '配置記録が不正です');
    player.garden.forEach((tile, index) => { if (Boolean(tile) !== Boolean(player.tileIds[index])) fail('tile-id-mismatch', '配置記録が一致しません'); if (tile) record(tile, player.tileIds[index]); });
    if (player.storage) { createTile(player.storage.terrain, player.storage.shape, player.storage.rotation); if (player.storage.stone !== null) fail('stored-stone', '保管タイルに石は置けません'); record(player.storage, player.storage.id); }
    if (player.careCount < 0 || player.careCount > 16 || !Number.isInteger(player.careCount)) fail('invalid-care', '手入れ回数が不正です');
  }
  if (state.drawn) record(state.drawn.tile, state.drawn.tile.id);
  ids.push(...state.deck.slice(state.deckCursor).map((tile) => tile.id));
  if (ids.length !== state.deck.length || new Set(ids).size !== ids.length || ids.some((id) => !originals.has(id))) fail('tile-conservation', 'タイルの在庫が一致しません');
  if (state.round < 1 || state.round > 16) fail('invalid-round', '巡数が不正です');
  const care = state.players.map((player) => player.careCount);
  if (Math.max(...care) - Math.min(...care) > 1) fail('unequal-care', '手入れ回数が一致しません');
  if (['final-stone', 'finished'].includes(state.phase) && (!state.players.every(filled) || new Set(care).size !== 1)) fail('unfinished-final', '最後の配置の前に全員の庭を完成させます');
  return true;
}

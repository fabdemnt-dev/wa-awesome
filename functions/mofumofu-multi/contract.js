'use strict';

/**
 * もふもふ大集合！ 人間3〜6人オンライン版 Phase B: 契約核（純粋）。
 *
 * Firebase（Admin SDK / Firestore / Functions）へ依存しない。index.js の transaction は
 * このファイルの純粋関数で決めた結論だけを書き込む。既存の2人＋こはる版
 * （functions/mofumofu-online/）とは別系統で、既存collectionへ新モードroomを混ぜない。
 *
 * 秘密と公開の分離:
 *   - 公開room（mofumofuMultiRooms/{roomId}）: handCounts / faceUpCards / players / playerStatus などだけ。
 *   - 秘密（privateHands/{uid}・serverState/current・roomSecrets・invites）: 手札実体・leftovers・
 *     pendingOffer・平文invite。公開roomへは絶対に入れない（publicRoomViolations で検証できる）。
 */

const crypto = require('node:crypto');

const {
  SEAT_IDS,
  MIN_PLAYERS,
  MAX_PLAYERS,
  PLAYER_STATUS,
  TURN_STATE,
} = require('./rules');

// 3〜6人版専用collection。既存の mofumofuOnlineXxx とは一切共有しない。
const COLLECTIONS = Object.freeze({
  rooms: 'mofumofuMultiRooms',
  members: 'members',
  privateHands: 'privateHands',
  serverState: 'serverState',
  invites: 'mofumofuMultiRoomInvites',
  roomSecrets: 'mofumofuMultiRoomSecrets',
  actionRequests: 'mofumofuMultiActionRequests',
  rateLimits: 'mofumofuMultiRateLimits',
});

const SCHEMA_VERSION = 2;
const KIND = 'multi';

// 招待コードは既存版と同じ8文字alphabet・digest方式。平文はFirestoreへ保存しない。
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INVITE_LENGTH = 8;
const INVITE_RETRIES = 3;

// 既存オンライン版と同じ期限・rate limit値を使い、documentは専用collectionへ分離する。
const WAITING_TTL_MS = 30 * 60 * 1000;
const PLAYING_TTL_MS = 24 * 60 * 60 * 1000;
const FINISHED_TTL_MS = 6 * 60 * 60 * 1000;
const ACTION_TTL_MS = 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_FAILURE_LIMIT = 8;
const RATE_TTL_MS = 2 * RATE_WINDOW_MS;
const IP_RATE_LIMIT = 100;
const CREATE_UID_RATE_LIMIT = 6;
const START_UID_RATE_LIMIT = 6;

const INVITE_ERROR = 'この招待コードでは参加できません。';
const EXPIRED_ERROR = 'この部屋の参加期限が切れています。';
const FULL_ERROR = 'この部屋は満員です。';
const ALREADY_STARTED_ERROR = 'ゲームは開始済みです。';

// HttpsErrorへ変換できるエラーコードだけを使う（index.jsがcallable境界で変換する）。
class ContractError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ContractError';
    this.code = code;
    this.isContractError = true;
  }
}
function fail(code, message) { throw new ContractError(code, message); }

/* --------------------------------------------------------------- 招待コード */

function newInviteCode() {
  const bytes = crypto.randomBytes(INVITE_LENGTH);
  return Array.from(bytes, (byte) => INVITE_ALPHABET[byte % INVITE_ALPHABET.length]).join('');
}
function inviteCodePattern() { return `^[${INVITE_ALPHABET}]{${INVITE_LENGTH}}$`; }
function isInviteCode(value) {
  return typeof value === 'string' && new RegExp(inviteCodePattern()).test(value);
}
// 入力の正規化（trim＋大文字化）と形式検証。形式不正は既存版と同じ failed-precondition。
function normalizeInviteCode(value) {
  if (typeof value !== 'string') fail('invalid-argument', '招待コードを入力してください。');
  const code = value.trim().toUpperCase();
  if (!isInviteCode(code)) fail('failed-precondition', INVITE_ERROR);
  return code;
}
function inviteCodeDigest(code) { return crypto.createHash('sha256').update(code).digest('hex'); }
function digest(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function rateKey(kind, value) { return `${kind}_${value}`; }

/* ----------------------------------------------------------- 初期document */

function initialRoomFields({ roomId, hostUid, now, deleteAt }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: KIND,
    roomId,
    status: 'waiting',
    hostUid,
    createdAt: now,
    joinExpiresAt: now + WAITING_TTL_MS,
    startedAt: null,
    dealt: false,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    seatOrder: ['S1'],
    players: { S1: { seatId: 'S1', joined: true, joinedAt: now, displayName: null } },
    playerUids: { S1: hostUid },
    playerStatus: { S1: PLAYER_STATUS.ACTIVE },
    handCounts: { S1: 0 },
    faceUpCards: { S1: [] },
    currentTurnPlayerId: null,
    turnState: TURN_STATE.WAITING,
    turnNumber: 0,
    publicOffer: null,
    winnerPlayerIds: [],
    loserPlayerIds: [],
    leftPlayerIds: [],
    draw: false,
    finishReason: null,
    gatheringReason: null,
    finalResult: null,
    deleteAt,
  };
}
function initialMemberFields({ uid, seatId, joinedAt, deleteAt }) {
  return { uid, seatId, joinedAt, deleteAt };
}
function initialSecretFields({ inviteDigest, createdAt, deleteAt }) {
  return { inviteDigest, createdAt, deleteAt };
}
function initialInviteFields({ roomId, now, deleteAt }) {
  return { roomId, status: 'active', createdAt: now, expiresAt: now + WAITING_TTL_MS, revokedAt: null, deleteAt };
}

/* ------------------------------------------------------------ join の判定 */

function seatForUid(room, uid) {
  return (room?.seatOrder || []).find((seat) => room.playerUids?.[seat] === uid) || null;
}
function occupiedSeats(room) {
  return (room?.seatOrder || []).filter((seat) => Boolean(room.playerUids?.[seat]));
}
function playerCountOf(room) { return occupiedSeats(room).length; }
function isRoomFull(room) { return playerCountOf(room) >= MAX_PLAYERS; }
function nextFreeSeat(room) {
  const used = new Set(room?.seatOrder || []);
  return SEAT_IDS.find((seat) => !used.has(seat)) || null;
}
function inviteStatusAfterJoin(playerCount) {
  return playerCount >= MAX_PLAYERS ? 'full' : 'active';
}

// 判定順は「本人の再参加 → invite実在 → 部屋の進行状態 → 満員 → 空席 → 期限」。
// 満員（inviteがfull、または6人在席）は resource-exhausted で「満員」と伝える。
function joinDecision(room, invite, { uid, now }) {
  const existingSeat = seatForUid(room, uid);
  if (existingSeat) return { ok: true, action: 'existing-seat', seatId: existingSeat, playerCount: playerCountOf(room) };
  if (!invite || invite.status === 'revoked') return { ok: false, code: 'failed-precondition', message: INVITE_ERROR };
  if (room.status === 'playing' || room.status === 'finished') return { ok: false, code: 'failed-precondition', message: ALREADY_STARTED_ERROR };
  if (room.status !== 'waiting') return { ok: false, code: 'failed-precondition', message: INVITE_ERROR };
  if (!(Number(invite.expiresAt) > now)) return { ok: false, code: 'failed-precondition', message: INVITE_ERROR };
  const count = playerCountOf(room);
  if (count >= MAX_PLAYERS || (room.seatOrder || []).length >= MAX_PLAYERS) return { ok: false, code: 'resource-exhausted', message: FULL_ERROR };
  // inviteがfullなのに空席がある場合は状態不整合として拒否する。
  if (invite.status !== 'active') return { ok: false, code: 'failed-precondition', message: INVITE_ERROR };
  if (!(Number(room.joinExpiresAt) > now)) return { ok: false, code: 'failed-precondition', message: EXPIRED_ERROR };
  const seatId = nextFreeSeat(room);
  if (!seatId) return { ok: false, code: 'resource-exhausted', message: FULL_ERROR };
  return { ok: true, action: 'join', seatId, playerCount: count + 1 };
}
function joinRoomUpdate(room, seatId, uid, now) {
  return {
    seatOrder: [...(room.seatOrder || []), seatId],
    [`players.${seatId}`]: { seatId, joined: true, joinedAt: now, displayName: null },
    [`playerUids.${seatId}`]: uid,
    [`playerStatus.${seatId}`]: PLAYER_STATUS.ACTIVE,
    [`handCounts.${seatId}`]: 0,
    [`faceUpCards.${seatId}`]: [],
  };
}

/* ----------------------------------------------------------- start の判定 */

function startDecision(room, { uid, now }) {
  if (!room || room.kind !== KIND) return { ok: false, code: 'not-found', message: '部屋が見つかりません。' };
  if (room.hostUid !== uid) return { ok: false, code: 'permission-denied', message: 'ホストだけが開始できます。' };
  if (room.status !== 'waiting' || room.dealt || room.startedAt) {
    return { ok: false, code: 'already-exists', message: ALREADY_STARTED_ERROR };
  }
  const count = playerCountOf(room);
  if (count < MIN_PLAYERS) return { ok: false, code: 'failed-precondition', message: `${MIN_PLAYERS}人そろっていません。` };
  if (count > MAX_PLAYERS) return { ok: false, code: 'failed-precondition', message: '人数が上限を超えています。' };
  if (!Number(room.joinExpiresAt) || Number(room.joinExpiresAt) <= now) {
    return { ok: false, code: 'failed-precondition', message: EXPIRED_ERROR };
  }
  const seatOrder = room.seatOrder || [];
  const expected = SEAT_IDS.slice(0, count);
  if (seatOrder.length !== count || seatOrder.join(',') !== expected.join(',')) {
    return { ok: false, code: 'failed-precondition', message: '参加状態が不整合です。' };
  }
  for (const seat of seatOrder) {
    if (!room.playerUids?.[seat]) return { ok: false, code: 'failed-precondition', message: '参加状態が不整合です。' };
    if (room.playerStatus?.[seat] !== PLAYER_STATUS.ACTIVE) {
      return { ok: false, code: 'failed-precondition', message: '参加状態が不整合です。' };
    }
    if (Number(room.handCounts?.[seat] || 0) !== 0) {
      return { ok: false, code: 'failed-precondition', message: '配布済みの状態です。' };
    }
  }
  return { ok: true, playerCount: count, seatOrder: [...seatOrder] };
}
// Phase A契約の手札を uid 単位へ割り当てる（privateHands/{uid} へ本人分だけ保存するため）。
function handsByUid(seatOrder, playerUids, hands) {
  const result = {};
  for (const seat of seatOrder) {
    const uid = playerUids?.[seat];
    if (!uid) continue;
    result[uid] = [...(hands?.[seat] || [])];
  }
  return result;
}
function roomAfterStart(room, { now, handSize, deleteAt }) {
  return {
    status: 'playing',
    startedAt: now,
    dealt: true,
    seatOrder: [...(room.seatOrder || [])],
    handCounts: Object.fromEntries((room.seatOrder || []).map((seat) => [seat, handSize])),
    currentTurnPlayerId: (room.seatOrder || [])[0],
    turnState: TURN_STATE.AWAITING_OFFER,
    turnNumber: 0,
    deleteAt,
  };
}

/* ------------------------------------------------- actionId（冪等性）契約 */

function actionFingerprint(type, uid, roomId, fields = {}) {
  return { type, uid, roomId, ...fields };
}
function sameFingerprint(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}
// 同一actionId＋同一payloadは初回結果を返す。payload違いは already-exists で拒否する。
function replayAction(action, fingerprint) {
  if (!action || !sameFingerprint(action.fingerprint, fingerprint)) {
    fail('already-exists', 'このアクションIDは使用済みです。');
  }
  return action.result;
}

/* --------------------------------------------------- 公開roomの漏洩チェック */

const FORBIDDEN_PUBLIC_KEYS = Object.freeze(['hands', 'leftovers', 'pendingOffer', 'npcHand', 'discard', 'inviteCode', 'inviteDigest', 'secret']);
// 公開roomへ秘密が混ざっていないかを機械的に確認する（integrationテストで使用）。
function publicRoomViolations(room) {
  const violations = [];
  for (const key of FORBIDDEN_PUBLIC_KEYS) if (Object.hasOwn(room || {}, key)) violations.push(key);
  return violations;
}

module.exports = {
  COLLECTIONS,
  SCHEMA_VERSION,
  KIND,
  INVITE_ALPHABET,
  INVITE_LENGTH,
  INVITE_RETRIES,
  WAITING_TTL_MS,
  PLAYING_TTL_MS,
  FINISHED_TTL_MS,
  ACTION_TTL_MS,
  RATE_WINDOW_MS,
  RATE_FAILURE_LIMIT,
  RATE_TTL_MS,
  IP_RATE_LIMIT,
  CREATE_UID_RATE_LIMIT,
  START_UID_RATE_LIMIT,
  INVITE_ERROR,
  EXPIRED_ERROR,
  FULL_ERROR,
  ALREADY_STARTED_ERROR,
  ContractError,
  newInviteCode,
  inviteCodePattern,
  isInviteCode,
  normalizeInviteCode,
  inviteCodeDigest,
  digest,
  rateKey,
  initialRoomFields,
  initialMemberFields,
  initialSecretFields,
  initialInviteFields,
  seatForUid,
  occupiedSeats,
  playerCountOf,
  isRoomFull,
  nextFreeSeat,
  inviteStatusAfterJoin,
  joinDecision,
  joinRoomUpdate,
  startDecision,
  handsByUid,
  roomAfterStart,
  actionFingerprint,
  sameFingerprint,
  replayAction,
  publicRoomViolations,
  FORBIDDEN_PUBLIC_KEYS,
};

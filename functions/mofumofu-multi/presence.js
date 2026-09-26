'use strict';

/**
 * もふもふ大集合！ 人間3〜6人オンライン版 Phase D: presence / resume の契約核（純粋）。
 *
 * Firebase（Admin SDK / RTDB / Functions）へ依存しない。index.js はこのファイルが決めた結論だけを
 * 実行する。既存の2人＋こはる版（functions/mofumofu-online/）とは完全に別系統で、既存RTDBルート
 * （mofumofuOnlinePresence / mofumofuOnlinePresenceAccess）・既存Callable・既存Rulesは変更しない。
 *
 * 切断の意味（Phase D 確定事項）:
 *   - 通信切れ・ブラウザ終了・バックグラウンドでは playerStatus を 'left' にしない。
 *   - 120秒(stale)は「再接続待ち」表示のための接続状態であり、正式退出ではない。
 *   - presence側から手番スキップ・カード操作・ゲーム終了を起こさない（presenceは接続情報のみ）。
 *   - 復帰は同じseatへ戻すだけで、新しいseatは払い出さない。
 */

const crypto = require('node:crypto');

const { SEAT_IDS } = require('./rules');
const { KIND, ContractError, seatForUid, playerCountOf } = require('./contract');

// 3〜6人版専用の新RTDBルート。既存の2人＋こはる版とは共有しない。
const RTDB_ROOTS = Object.freeze({
  presence: 'mofumofuMultiPresence',
  access: 'mofumofuMultiPresenceAccess',
});

// 既存2人＋こはる版とまったく同じ基本周期・境界・期限を使う（独自値を作らない）。
// 既存版: HEARTBEAT_MS = 15000 / STALE_MS = 120000 / PRESENCE_ACCESS_TTL_MS = 300000。
const HEARTBEAT_INTERVAL_MS = 15 * 1000;
const PRESENCE_STALE_MS = 2 * 60 * 1000;
const PRESENCE_ACCESS_TTL_MS = 5 * 60 * 1000;

const CONNECTION_STATES = Object.freeze({ CONNECTED: 'connected', RECONNECTING: 'reconnecting' });
const PRESENCE_STATES = Object.freeze(['online', 'disconnected']);
// RTDBのconnection nodeに許すfieldは既存Rulesと同じ7つだけ。
const CONNECTION_FIELDS = Object.freeze([
  'uid', 'roomId', 'seatId', 'connectionId', 'state', 'lastHeartbeatAt', 'connectedAt',
]);
// 既存Rulesと同じUUID v4形式。形式不正のconnectionIdはRulesでも本ファイルでも拒否する。
const CONNECTION_ID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const SEAT_PATTERN = '^S[1-6]$';
const UUID_RE = new RegExp(CONNECTION_ID_PATTERN);
const SEAT_RE = new RegExp(SEAT_PATTERN);

// presence nodeへ絶対に入れてはいけない秘密（機械的に検査できるようにする）。
const PRESENCE_FORBIDDEN_KEYS = Object.freeze([
  'cards', 'cardId', 'animalType', 'actualAnimal', 'hand', 'hands', 'pendingOffer', 'leftovers',
  'discard', 'inviteCode', 'inviteDigest', 'secret', 'serverState', 'finalResult',
]);
// resume応答に絶対に入れてはいけない秘密。
const RESUME_FORBIDDEN_KEYS = Object.freeze([
  'serverState', 'leftovers', 'pendingOffer', 'hands', 'inviteCode', 'inviteDigest', 'secret',
]);
// 公開offerとしてclientへ見せてよいfield（pending中は実animalTypeを落とす）。
const PUBLIC_OFFER_FIELDS = Object.freeze([
  'status', 'fromPlayerId', 'toPlayerId', 'claimAnimal', 'actualAnimal', 'success', 'faceUpRecipientPlayerId',
]);
// resumeはgame stateを変更しない。差分検査に使う公開field。
const GAME_STATE_FIELDS = Object.freeze([
  'status', 'dealt', 'seatOrder', 'playerStatus', 'handCounts', 'faceUpCards', 'currentTurnPlayerId',
  'turnState', 'turnNumber', 'publicOffer', 'winnerPlayerIds', 'loserPlayerIds', 'leftPlayerIds',
  'draw', 'finishReason', 'gatheringReason', 'finalResult',
]);

// 接続認可・resumeは再接続のたびに呼ばれるため、create/joinより高い上限の別カウンタにする。
const AUTHORIZE_UID_RATE_LIMIT = 120;
const AUTHORIZE_IP_RATE_LIMIT = 300;
const RESUME_UID_RATE_LIMIT = 120;
const RESUME_IP_RATE_LIMIT = 300;

const ROOM_GONE_ERROR = '部屋が見つかりません。';
const NOT_MEMBER_ERROR = 'この部屋の参加者ではありません。';
const ROOM_EXPIRED_ERROR = 'この部屋は保存期限が切れています。';
const ROOM_STATUS_ERROR = 'いまは接続できません。';
const PRESENCE_STALE_LEFT_NOTE = 'staleは正式退出ではありません。';

// Phase Eのclientが「保存room解除・入口復帰」を判断できるよう、失敗理由を区別して返す。
const SESSION_REASONS = Object.freeze({
  ROOM_NOT_FOUND: 'room-not-found',
  NOT_MEMBER: 'not-member',
  ROOM_EXPIRED: 'room-expired',
  ROOM_STATUS: 'room-status',
});

/* ------------------------------------------------------------------ 基本形 */

function plain(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function isConnectionId(value) { return typeof value === 'string' && UUID_RE.test(value); }
function newConnectionId() { return crypto.randomUUID(); }
function isSeatId(value) { return typeof value === 'string' && SEAT_IDS.includes(value) && SEAT_RE.test(value); }
function connectionPath(roomId, uid, connectionId) {
  return `${RTDB_ROOTS.presence}/${roomId}/${uid}/connections/${connectionId}`;
}
function accessPath(roomId, uid) { return `${RTDB_ROOTS.access}/${roomId}/${uid}`; }
function deny(code, message, reason) { return { ok: false, code, message, reason }; }
// ContractErrorにreasonを載せ、index.jsがHttpsErrorへdetails付きで変換する。
function sessionError(code, message, reason) {
  const error = new ContractError(code, message);
  error.reason = reason;
  return error;
}
function millisOf(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  if (typeof value.toMillis === 'function') return value.toMillis();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/* --------------------------------------------------------- connection記録 */

// Rulesと同じ許可fieldだけかどうかを機械的に検査する（余計なfieldの混入検出）。
function connectionViolations(record) {
  if (!plain(record)) return ['record'];
  const violations = [];
  for (const key of Object.keys(record)) {
    if (PRESENCE_FORBIDDEN_KEYS.includes(key) || !CONNECTION_FIELDS.includes(key)) violations.push(key);
  }
  return violations;
}
// state形式（online / disconnected）と型・形式をまとめて検査する。
function connectionValid(record) {
  if (connectionViolations(record).length) return false;
  if (!CONNECTION_STATES_ONLY(record.state)) return false;
  if (!isConnectionId(record.connectionId)) return false;
  if (!isSeatId(record.seatId)) return false;
  if (typeof record.uid !== 'string' || typeof record.roomId !== 'string') return false;
  if (!Number.isFinite(Number(record.lastHeartbeatAt)) || !Number.isFinite(Number(record.connectedAt))) return false;
  return true;
}
function CONNECTION_STATES_ONLY(state) { return PRESENCE_STATES.includes(state); }
function heartbeatRecord({ uid, roomId, seatId, connectionId, now = Date.now(), connectedAt, state = 'online' }) {
  return {
    uid,
    roomId,
    seatId,
    connectionId,
    state,
    lastHeartbeatAt: now,
    connectedAt: connectedAt == null ? now : connectedAt,
  };
}
function disconnectRecord(record, now = Date.now()) {
  return { ...record, state: 'disconnected', lastHeartbeatAt: now };
}

/* -------------------------------------------------------- 接続状態の判定 */

// 既存2人＋こはる版と同じ判定: state==='online' かつ lastHeartbeatAt >= now - 120秒。
// ちょうど120秒は「まだ接続中」（既存版と同じ意味）で、121秒からstaleになる。
function connectionOnline(connection, now = Date.now()) {
  return plain(connection)
    && connection.state === 'online'
    && Number.isFinite(Number(connection.lastHeartbeatAt))
    && Number(connection.lastHeartbeatAt) >= now - PRESENCE_STALE_MS;
}
// 複数connectionのうち1つでも生きていれば connected。全部staleなら再接続待ち。
function presenceState(value, now = Date.now()) {
  const connections = Object.values(value?.connections || {}).filter(plain);
  const lastHeartbeatAt = connections.reduce(
    (latest, connection) => Math.max(latest, Number(connection.lastHeartbeatAt) || 0), 0,
  );
  const onlineConnectionCount = connections.filter((connection) => connectionOnline(connection, now)).length;
  const online = onlineConnectionCount > 0;
  return {
    online,
    state: online ? CONNECTION_STATES.CONNECTED : CONNECTION_STATES.RECONNECTING,
    stale: !online && connections.length > 0,
    lastHeartbeatAt,
    connectionCount: connections.length,
    onlineConnectionCount,
  };
}
function heartbeatContract() {
  return { intervalMs: HEARTBEAT_INTERVAL_MS, staleMs: PRESENCE_STALE_MS, accessTtlMs: PRESENCE_ACCESS_TTL_MS };
}

/* -------------------------------------------------- presenceAccess（認可） */

// server（Callable）がFirestore正本から解決した seatId だけを書く。client申告は使わない。
function accessFields({ uid, roomId, seatId, expiresAt }) {
  return { uid, roomId, seatId, expiresAt };
}
function accessValid(access, { uid, roomId, now = Date.now() }) {
  return plain(access)
    && access.uid === uid
    && access.roomId === roomId
    && isSeatId(access.seatId)
    && Number(access.expiresAt) > now;
}
// authorize / resume 共通の事前条件（Auth確認はindex.js側）。
// 判定順: 部屋 → member（seat解決） → 状態 → 保存期限。
function presenceAccessDecision(room, { uid, now = Date.now() }) {
  if (!room || room.kind !== KIND) return deny('not-found', ROOM_GONE_ERROR, SESSION_REASONS.ROOM_NOT_FOUND);
  const seatId = seatForUid(room, uid);
  if (!seatId || !isSeatId(seatId)) return deny('permission-denied', NOT_MEMBER_ERROR, SESSION_REASONS.NOT_MEMBER);
  if (!['waiting', 'playing', 'finished'].includes(room.status)) {
    return deny('failed-precondition', ROOM_STATUS_ERROR, SESSION_REASONS.ROOM_STATUS);
  }
  const deleteAt = millisOf(room.deleteAt);
  if (deleteAt > 0 && deleteAt <= now) {
    return deny('failed-precondition', ROOM_EXPIRED_ERROR, SESSION_REASONS.ROOM_EXPIRED);
  }
  return { ok: true, seatId };
}
const authorizePrecondition = presenceAccessDecision;
const resumePrecondition = presenceAccessDecision;

/* ------------------------------------------------------------- resume応答 */

// pending中は実animalType・判定結果を落とし、UIが公開情報だけで判断できる形にする。
function publicOfferView(offer) {
  if (!plain(offer)) return null;
  const view = {};
  for (const key of PUBLIC_OFFER_FIELDS) if (Object.hasOwn(offer, key)) view[key] = offer[key];
  if (view.status === 'pending') {
    delete view.actualAnimal;
    delete view.success;
    delete view.faceUpRecipientPlayerId;
  }
  return view;
}
function publicRoomView(room) {
  const seatOrder = [...(room?.seatOrder || [])];
  return {
    roomId: room?.roomId || null,
    status: room?.status || null,
    hostUid: room?.hostUid || null,
    seatOrder,
    players: { ...(room?.players || {}) },
    playerStatus: { ...(room?.playerStatus || {}) },
    dealt: Boolean(room?.dealt),
    currentTurnPlayerId: room?.currentTurnPlayerId ?? null,
    turnState: room?.turnState || null,
    turnNumber: Number(room?.turnNumber || 0),
    publicOffer: publicOfferView(room?.publicOffer),
    faceUpCards: Object.fromEntries(seatOrder.map((seat) => [seat, [...(room?.faceUpCards?.[seat] || [])]])),
    handCounts: Object.fromEntries(seatOrder.map((seat) => [seat, Number(room?.handCounts?.[seat] || 0)])),
    playerCount: playerCountOf(room),
    winnerPlayerIds: [...(room?.winnerPlayerIds || [])],
    loserPlayerIds: [...(room?.loserPlayerIds || [])],
    leftPlayerIds: [...(room?.leftPlayerIds || [])],
    draw: Boolean(room?.draw),
    finishReason: room?.finishReason ?? null,
    gatheringReason: room?.gatheringReason ?? null,
  };
}
/**
 * resumeの応答。自分のseat・自分のprivate handだけを返す。
 * waiting: 手札なし（未配布） / playing: 自分の手札のみ / finished: finalResultのみ。
 * awaitingJudgmentで自分が受取人なら mustJudge=true（公開offerだけで判断できる）。
 */
function resumeResult({ roomId, room, seatId, handCards = null, handStatus = 'pending' }) {
  const view = publicRoomView(room);
  const status = view.status;
  const left = view.playerStatus?.[seatId] === 'left' || view.leftPlayerIds.includes(seatId);
  let cards = null;
  let resolvedHandStatus = 'pending';
  if (status === 'playing') {
    if (left) { cards = []; resolvedHandStatus = 'left'; }
    else if (handStatus === 'ready') { cards = [...(handCards || [])]; resolvedHandStatus = 'ready'; }
    else { cards = null; resolvedHandStatus = handStatus === 'left' ? 'left' : 'retry'; }
  } else if (status === 'finished') {
    cards = [];
    resolvedHandStatus = left ? 'left' : 'finished';
  } else {
    cards = null;
    resolvedHandStatus = left ? 'left' : 'pending';
  }
  const finished = status === 'finished';
  return {
    roomId: roomId || view.roomId,
    status,
    seatId,
    ...view,
    handStatus: resolvedHandStatus,
    handCount: cards ? cards.length : Number(view.handCounts?.[seatId] || 0),
    cards,
    // 自分の手番を続行できる（勝手にnext turnへ進めない）。
    isMyTurn: !finished && status === 'playing' && view.turnState === 'awaitingOffer'
      && view.currentTurnPlayerId === seatId && !left,
    // 自分が判定する必要がある（pendingOfferの実カードは返さない）。
    mustJudge: !finished && status === 'playing' && view.turnState === 'awaitingJudgment'
      && view.publicOffer?.status === 'pending' && view.publicOffer?.toPlayerId === seatId && !left,
    finalResult: finished && room?.finalResult ? structuredClone(room.finalResult) : null,
  };
}
// resume応答に秘密が混入していないかを機械的に検査する（integrationテストで使用）。
function resumeViolations(result) {
  const violations = [];
  if (!plain(result)) return ['result'];
  for (const key of RESUME_FORBIDDEN_KEYS) if (Object.hasOwn(result, key)) violations.push(key);
  if (result.cards != null && !Array.isArray(result.cards)) violations.push('cards');
  if (result.publicOffer && Object.hasOwn(result.publicOffer, 'actualAnimal') && result.publicOffer.status === 'pending') {
    violations.push('publicOffer.actualAnimal');
  }
  return violations;
}
function gameStateSnapshot(room) {
  const snapshot = {};
  for (const key of GAME_STATE_FIELDS) snapshot[key] = room?.[key] ?? null;
  return snapshot;
}
// resume/presenceがgame stateを書き換えていないことを差分で検査する。
function gameStateChanged(before, after) {
  return JSON.stringify(gameStateSnapshot(before)) !== JSON.stringify(gameStateSnapshot(after));
}
// 公開offerに実カードが混ざっていないかを検査する。
function publicOfferViolations(offer) {
  if (!offer) return [];
  const violations = [];
  if (offer.status === 'pending' && (Object.hasOwn(offer, 'actualAnimal') || Object.hasOwn(offer, 'card'))) {
    violations.push('actualAnimal');
  }
  for (const key of ['card', 'cards', 'hand', 'hands', 'leftovers']) if (Object.hasOwn(offer, key)) violations.push(key);
  return violations;
}

module.exports = {
  RTDB_ROOTS,
  HEARTBEAT_INTERVAL_MS,
  PRESENCE_STALE_MS,
  PRESENCE_ACCESS_TTL_MS,
  CONNECTION_STATES,
  PRESENCE_STATES,
  CONNECTION_FIELDS,
  CONNECTION_ID_PATTERN,
  SEAT_PATTERN,
  PRESENCE_FORBIDDEN_KEYS,
  RESUME_FORBIDDEN_KEYS,
  PUBLIC_OFFER_FIELDS,
  GAME_STATE_FIELDS,
  AUTHORIZE_UID_RATE_LIMIT,
  AUTHORIZE_IP_RATE_LIMIT,
  RESUME_UID_RATE_LIMIT,
  RESUME_IP_RATE_LIMIT,
  ROOM_GONE_ERROR,
  NOT_MEMBER_ERROR,
  ROOM_EXPIRED_ERROR,
  ROOM_STATUS_ERROR,
  PRESENCE_STALE_LEFT_NOTE,
  SESSION_REASONS,
  plain,
  isConnectionId,
  newConnectionId,
  isSeatId,
  connectionPath,
  accessPath,
  deny,
  sessionError,
  millisOf,
  connectionViolations,
  connectionValid,
  heartbeatRecord,
  disconnectRecord,
  connectionOnline,
  presenceState,
  heartbeatContract,
  accessFields,
  accessValid,
  presenceAccessDecision,
  authorizePrecondition,
  resumePrecondition,
  publicOfferView,
  publicRoomView,
  resumeResult,
  resumeViolations,
  gameStateSnapshot,
  gameStateChanged,
  publicOfferViolations,
};

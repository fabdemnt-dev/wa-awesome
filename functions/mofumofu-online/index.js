'use strict';

const crypto = require('node:crypto');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getDatabase } = require('firebase-admin/database');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');

const REGION = 'asia-northeast1';
const ANIMALS = ['cat', 'rabbit', 'bear', 'chick', 'fox', 'penguin', 'panda', 'polar'];
const PLAYERS = ['A', 'B', 'koharu'];
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INVITE_LENGTH = 8;
const INVITE_RETRIES = 3;
const WAITING_TTL_MS = 30 * 60 * 1000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_FAILURE_LIMIT = 8;
const PRESENCE_ACCESS_TTL_MS = 5 * 60 * 1000;
const PRESENCE_STALE_MS = 2 * 60 * 1000;
const PLAYING_TTL_MS = 24 * 60 * 60 * 1000;
const FINISHED_TTL_MS = 6 * 60 * 60 * 1000;
const ACTION_TTL_MS = 24 * 60 * 60 * 1000;
const RATE_TTL_MS = 2 * RATE_WINDOW_MS;
// Shared networks must not lock out normal rooms; this is a coarse abuse backstop,
// while the stricter per-UID join limit remains authoritative.
const IP_RATE_LIMIT = 100;
const ipHmacKey = defineSecret('MOFUMOFU_ONLINE_IP_HMAC_KEY');
const enforceAppCheck = process.env.MOFUMOFU_ENFORCE_APP_CHECK === 'true';
const callableOptions = {
  region: REGION,
  cors: ['https://fabdemnt-dev.github.io'],
  enforceAppCheck,
  secrets: [ipHmacKey],
};

function db() { return getFirestore(); }
function presenceDb() {
  const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  if (process.env.FIREBASE_DATABASE_EMULATOR_HOST && projectId) {
    return getDatabase(undefined, `https://${projectId}-default-rtdb.firebaseio.com`);
  }
  const databaseURL = process.env.MOFUMOFU_RTDB_URL;
  if (!databaseURL) fail('failed-precondition', 'サーバー設定を確認してください。');
  return getDatabase(undefined, databaseURL);
}
function expiry(milliseconds) { return Timestamp.fromMillis(Date.now() + milliseconds); }
function secretValue(secret, fallback) {
  try { return secret.value() || fallback; } catch { return fallback; }
}
function ipSecret() {
  const fallbackAllowed = !!process.env.FUNCTIONS_EMULATOR || process.env.NODE_ENV === 'test' || process.env.MOFUMOFU_DIRECT_HANDLERS === '1';
  const value = secretValue(ipHmacKey, '');
  if (value) return value;
  if (fallbackAllowed) return 'mofumofu-emulator-ip-key';
  fail('failed-precondition', 'サーバー設定を確認してください。');
}
function requestIp(request) {
  return request.rawRequest?.ip || request.rawRequest?.socket?.remoteAddress || 'unknown';
}
function ipHash(request, day = new Date().toISOString().slice(0, 10)) {
  return crypto.createHmac('sha256', ipSecret()).update(`${day}\n${requestIp(request)}`).digest('base64url');
}
function fail(code, message) { throw new HttpsError(code, message); }
function authUid(request) {
  const uid = request.auth?.uid;
  if (!uid) fail('unauthenticated', '認証が必要です。');
  return uid;
}
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function exactFields(data, allowed) {
  if (!plain(data) || Object.keys(data).some((key) => !allowed.includes(key))) {
    fail('invalid-argument', '入力形式が正しくありません。');
  }
}
function uuid(value, label = 'ID') {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    fail('invalid-argument', `${label}が正しくありません。`);
  }
  return value.toLowerCase();
}
function roomIdFrom(data) { return uuid(data?.roomId, 'ルームID'); }
function actionIdFrom(data) { return uuid(data?.actionId, 'アクションID'); }
function connectionIdFrom(data) { return uuid(data?.connectionId, '接続ID'); }
function inviteCode(value) {
  if (typeof value !== 'string') fail('invalid-argument', '招待コードを入力してください。');
  const code = value.trim().toUpperCase();
  if (!new RegExp(`^[${INVITE_ALPHABET}]{${INVITE_LENGTH}}$`).test(code)) {
    fail('failed-precondition', 'この招待コードでは参加できません。');
  }
  return code;
}
function digest(code) { return crypto.createHash('sha256').update(code).digest('hex'); }
function newInviteCode() {
  const bytes = crypto.randomBytes(INVITE_LENGTH);
  return Array.from(bytes, (byte) => INVITE_ALPHABET[byte % INVITE_ALPHABET.length]).join('');
}
function shuffle(cards) {
  const result = [...cards];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
function deck() {
  return ANIMALS.flatMap((animalType) => Array.from({ length: 4 }, (_, copy) => ({
    cardId: `${animalType}-${copy}-${crypto.randomUUID()}`,
    animalType,
  })));
}
function randomUnit() { return crypto.randomInt(0, 0x100000000) / 0x100000000; }
function chooseNpcClaim(actualAnimal, truthRoll = randomUnit(), lieRoll = randomUnit()) {
  if (!ANIMALS.includes(actualAnimal)) throw new Error('invalid actualAnimal');
  if (truthRoll < 0.72) return actualAnimal;
  const lies = ANIMALS.filter((animal) => animal !== actualAnimal);
  return lies[Math.min(lies.length - 1, Math.floor(lieRoll * lies.length))];
}
function chooseNpcJudgment(history = {}, roll = randomUnit()) {
  const total = Number.isInteger(history.total) && history.total > 0 ? history.total : 0;
  const truth = Number.isInteger(history.truth) && history.truth >= 0 ? history.truth : 0;
  const estimatedTruth = Math.max(0.28, Math.min(0.72, total ? truth / total : 0.5));
  return roll < estimatedTruth ? 'truth' : 'lie';
}
function nextPlayerId(fromPlayerId, playerStatus = { A: 'active', B: 'active', koharu: 'active' }) {
  const index = PLAYERS.indexOf(fromPlayerId);
  if (index < 0) throw new Error('invalid player');
  for (let offset = 1; offset <= PLAYERS.length; offset += 1) {
    const candidate = PLAYERS[(index + offset) % PLAYERS.length];
    if (playerStatus[candidate] === 'active') return candidate;
  }
  return null;
}
function refs(roomId) {
  const store = db();
  const room = store.collection('mofumofuOnlineRooms').doc(roomId);
  return {
    room,
    member: (uid) => room.collection('members').doc(uid),
    hand: (uid) => room.collection('privateHands').doc(uid),
    server: room.collection('serverState').doc('current'),
    secret: store.collection('mofumofuOnlineRoomSecrets').doc(roomId),
    action: (id) => store.collection('mofumofuOnlineActionRequests').doc(id),
  };
}
function publicRoom(roomId, hostUid, now, expiresAt) {
  return {
    schemaVersion: 1,
    roomId,
    status: 'waiting',
    hostUid,
    createdAt: now,
    joinExpiresAt: expiresAt,
    startedAt: null,
    dealt: false,
    players: { A: { joined: true }, B: { joined: false }, koharu: { joined: true, npc: true } },
    playerUids: { A: hostUid, B: null },
    playerStatus: { A: 'active', B: 'pending', koharu: 'active' },
    currentTurnPlayerId: null,
    turnState: 'waiting',
    turnNumber: 0,
    publicOffer: null,
    faceUpCards: { A: [], B: [], koharu: [] },
    eliminationSnapshots: {},
    winnerPlayerId: null,
    draw: false,
    finishReason: null,
    finalResult: null,
    deleteAt: expiry(WAITING_TTL_MS),
    controlModes: { A: { mode: 'human', generation: 0 }, B: { mode: 'human', generation: 0 } },
  };
}
function publicResult(room, seatId, handStatus, cards) {
  return { room, seatId, handStatus, cards };
}
function memberSeat(room, uid) {
  if (room.playerUids?.A === uid) return 'A';
  if (room.playerUids?.B === uid) return 'B';
  return null;
}
function requireMember(room, uid) {
  const seat = memberSeat(room, uid);
  if (!seat) fail('permission-denied', 'この部屋の参加者ではありません。');
  return seat;
}
function presenceConnectionOnline(connection, now = Date.now()) {
  return plain(connection)
    && connection.state === 'online'
    && Number.isFinite(connection.lastHeartbeatAt)
    && connection.lastHeartbeatAt >= now - PRESENCE_STALE_MS;
}
function uidPresenceOnline(value, now = Date.now()) {
  return plain(value?.connections)
    && Object.values(value.connections).some((connection) => presenceConnectionOnline(connection, now));
}
function uidPresenceState(value, now = Date.now()) {
  const connections = Object.values(value?.connections || {}).filter(plain);
  const lastHeartbeatAt = connections.reduce((latest, connection) => Math.max(latest, Number(connection.lastHeartbeatAt) || 0), 0);
  return { online: connections.some((connection) => presenceConnectionOnline(connection, now)), lastHeartbeatAt };
}
async function seatPresenceState(room, seatId, now = Date.now()) {
  const uid = room.playerUids?.[seatId];
  if (!uid) return { online: false, lastHeartbeatAt: 0 };
  const snapshot = await presenceDb().ref(`mofumofuOnlinePresence/${room.roomId}/${uid}`).get();
  return uidPresenceState(snapshot.val(), now);
}
function controlFor(room, seatId) {
  return room.controlModes?.[seatId] || { mode: 'human', generation: 0 };
}
async function onlineHumanSeats(room, now = Date.now()) {
  const snapshot = await presenceDb().ref(`mofumofuOnlinePresence/${room.roomId}`).get();
  const presence = snapshot.val() || {};
  return ['A', 'B'].filter((seatId) => {
    const uid = room.playerUids?.[seatId];
    return uid && uidPresenceOnline(presence[uid], now);
  });
}
function actionFingerprint(type, uid, roomId, fields) { return { type, uid, roomId, ...fields }; }
function sameFingerprint(a, b) {
  const keys = Object.keys(a);
  return plain(a) && plain(b) && keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}
function replayAction(action, fingerprint) {
  if (!action || !sameFingerprint(action.fingerprint, fingerprint)) {
    fail('already-exists', 'このアクションIDは使用済みです。');
  }
  return action.result;
}
function judgeSuccess(claimAnimal, actualAnimal, judgment) {
  return (claimAnimal === actualAnimal) === (judgment === 'truth');
}
function safeOffer(offer) {
  if (!offer) return null;
  const result = {
    actionId: offer.actionId,
    fromPlayerId: offer.fromPlayerId,
    toPlayerId: offer.toPlayerId,
    claimAnimal: offer.claimAnimal,
    status: offer.status,
  };
  if (offer.status === 'completed') {
    Object.assign(result, {
      actualAnimal: offer.actualAnimal,
      judgment: offer.judgment,
      success: offer.success,
      faceUpRecipientPlayerId: offer.faceUpRecipientPlayerId,
    });
  }
  return result;
}

function countByAnimal(cards = []) {
  const counts = Object.fromEntries(ANIMALS.map((animal) => [animal, 0]));
  for (const card of cards) if (ANIMALS.includes(card?.animalType)) counts[card.animalType] += 1;
  return counts;
}
function publicPlayerSnapshot(playerId, status, cards, elimination = null) {
  const faceUpCardsByAnimal = countByAnimal(cards);
  return {
    playerId,
    status,
    eliminated: status === 'eliminated',
    eliminationAnimal: elimination?.eliminationAnimal || null,
    faceUpCardsByAnimal,
    faceUpCardsTotal: Object.values(faceUpCardsByAnimal).reduce((sum, count) => sum + count, 0),
    eliminatedAt: elimination?.eliminatedAt || null,
  };
}
function buildFinalResult(room, finishReason, winnerPlayerId, draw, finishedAt) {
  const players = PLAYERS.map((playerId) => room.eliminationSnapshots?.[playerId]
    || publicPlayerSnapshot(playerId, room.playerStatus[playerId], room.faceUpCards[playerId]));
  return { winnerPlayerId, draw, finishReason, players, finishedAt };
}
function handFor(playerId, server, hands) {
  return playerId === 'koharu' ? server.npcHand || [] : hands[playerId] || [];
}
function finishIfNeeded(room, server, hands) {
  const active = PLAYERS.filter((playerId) => room.playerStatus[playerId] === 'active');
  if (active.length === 1) return { finishReason: 'last-player-standing', winnerPlayerId: active[0], draw: false };
  // The offline beginTurn ends immediately when any active player's hand is empty,
  // including while all three players remain active.
  if (active.some((playerId) => handFor(playerId, server, hands).length === 0)) {
    const totals = active.map((playerId) => ({ playerId, total: (room.faceUpCards[playerId] || []).length }));
    const minimum = Math.min(...totals.map(({ total }) => total));
    const winners = totals.filter(({ total }) => total === minimum).map(({ playerId }) => playerId);
    return { finishReason: 'hand-empty', winnerPlayerId: winners.length === 1 ? winners[0] : null, draw: winners.length > 1 };
  }
  return null;
}
function resolveFaceUp(roomValue, serverValue, handsValue, pending, judgment, now) {
  const room = structuredClone(roomValue);
  const server = structuredClone(serverValue);
  const hands = { A: [...handsValue.A], B: [...handsValue.B] };
  const offer = completedOffer(pending, judgment);
  const recipient = offer.faceUpRecipientPlayerId;
  room.faceUpCards[recipient] = [...(room.faceUpCards[recipient] || []), pending.card];
  server.pendingOffer = null;
  let eliminatedPlayerId = null;
  if (room.faceUpCards[recipient].filter((card) => card.animalType === pending.card.animalType).length >= 4) {
    eliminatedPlayerId = recipient;
    const publicCards = room.faceUpCards[recipient];
    const snapshot = publicPlayerSnapshot(recipient, 'eliminated', publicCards, { eliminationAnimal: pending.card.animalType, eliminatedAt: now });
    room.eliminationSnapshots = { ...(room.eliminationSnapshots || {}), [recipient]: snapshot };
    room.playerStatus = { ...room.playerStatus, [recipient]: 'eliminated' };
    const secretCards = recipient === 'koharu' ? server.npcHand || [] : hands[recipient];
    server.discard = [...(server.discard || []), ...secretCards, ...publicCards];
    if (recipient === 'koharu') server.npcHand = [];
    else hands[recipient] = [];
    room.faceUpCards[recipient] = [];
  }
  const finish = finishIfNeeded(room, server, hands);
  let advance;
  if (finish) {
    advance = { currentTurnPlayerId: null, turnState: 'finished', turnNumber: (room.turnNumber || 0) + 1 };
    Object.assign(room, advance, { status: 'finished', ...finish, finalResult: buildFinalResult(room, finish.finishReason, finish.winnerPlayerId, finish.draw, now) });
    room.deleteAt = Timestamp.fromMillis(now + FINISHED_TTL_MS);
  } else {
    const next = nextPlayerId(pending.fromPlayerId, room.playerStatus);
    advance = { currentTurnPlayerId: next, turnState: next === 'koharu' ? 'awaitingNpcPhase' : 'awaitingOffer', turnNumber: (room.turnNumber || 0) + 1 };
    Object.assign(room, advance);
  }
  return { room, server, hands, offer, eliminatedPlayerId, finish, advance };
}

async function deleteExpiredTopLevel(collectionName, now, limit = 100) {
  const snapshot = await db().collection(collectionName).where('deleteAt', '<=', now).limit(limit).get();
  if (snapshot.empty) return 0;
  const batch = db().batch();
  snapshot.docs.forEach((document) => batch.delete(document.ref));
  await batch.commit();
  return snapshot.size;
}

async function cleanupMofumofuDataNow(nowMillis = Date.now()) {
  const now = Timestamp.fromMillis(nowMillis);
  const expiredRooms = await db().collection('mofumofuOnlineRooms').where('deleteAt', '<=', now).limit(50).get();
  for (const room of expiredRooms.docs) await db().recursiveDelete(room.ref);
  const deleted = { rooms: expiredRooms.size };
  for (const collectionName of ['mofumofuOnlineRoomInvites', 'mofumofuOnlineRateLimits', 'mofumofuOnlineActionRequests', 'mofumofuOnlineRoomSecrets']) {
    deleted[collectionName] = await deleteExpiredTopLevel(collectionName, now);
  }

  const root = presenceDb();
  const [accessSnapshot, presenceSnapshot] = await Promise.all([
    root.ref('mofumofuOnlinePresenceAccess').get(),
    root.ref('mofumofuOnlinePresence').get(),
  ]);
  const updates = {};
  for (const [roomId, users] of Object.entries(accessSnapshot.val() || {})) {
    for (const [uid, access] of Object.entries(users || {})) {
      if (!Number.isFinite(access?.expiresAt) || access.expiresAt <= nowMillis) updates[`mofumofuOnlinePresenceAccess/${roomId}/${uid}`] = null;
    }
  }
  for (const [roomId, users] of Object.entries(presenceSnapshot.val() || {})) {
    for (const [uid, value] of Object.entries(users || {})) {
      for (const [connectionId, connection] of Object.entries(value?.connections || {})) {
        if (!Number.isFinite(connection?.lastHeartbeatAt) || connection.lastHeartbeatAt < nowMillis - PRESENCE_STALE_MS) {
          updates[`mofumofuOnlinePresence/${roomId}/${uid}/connections/${connectionId}`] = null;
        }
      }
    }
  }
  if (Object.keys(updates).length) await root.ref().update(updates);
  deleted.realtimePaths = Object.keys(updates).length;
  return deleted;
}

async function createHandler(request) {
  exactFields(request.data || {}, []);
  const uid = authUid(request);
  const store = db();
  await consumeRateLimit(`create_uid_${digest(uid)}`, 6);
  await consumeRateLimit(`create_ip_${ipHash(request)}`, IP_RATE_LIMIT);
  for (let attempt = 0; attempt < INVITE_RETRIES; attempt += 1) {
    const code = newInviteCode();
    const inviteDigest = digest(code);
    const roomId = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + WAITING_TTL_MS;
    const inviteRef = store.collection('mofumofuOnlineRoomInvites').doc(inviteDigest);
    const r = refs(roomId);
    try {
      await store.runTransaction(async (tx) => {
        const inviteSnap = await tx.get(inviteRef);
        if (inviteSnap.exists) fail('already-exists', '招待コードが衝突しました。');
        tx.create(r.room, publicRoom(roomId, uid, now, expiresAt));
        const deleteAt = expiry(WAITING_TTL_MS);
        tx.create(r.member(uid), { uid, playerId: 'A', joinedAt: now, deleteAt });
        tx.create(r.secret, { inviteDigest, createdAt: now, deleteAt });
        tx.create(inviteRef, { roomId, status: 'active', createdAt: now, expiresAt, revokedAt: null, deleteAt });
      });
      return { roomId, inviteCode: code, status: 'waiting', seatId: 'A' };
    } catch (error) {
      if (error instanceof HttpsError && error.code === 'already-exists' && attempt + 1 < INVITE_RETRIES) continue;
      throw error;
    }
  }
  fail('resource-exhausted', '部屋を作成できませんでした。');
}

async function consumeRateLimit(key, limit = RATE_FAILURE_LIMIT, now = Date.now()) {
  const rateRef = db().collection('mofumofuOnlineRateLimits').doc(key);
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(rateRef);
    const value = snap.exists ? snap.data() : null;
    const started = value?.windowStartedAt?.toMillis?.() || Number(value?.windowStartedAt) || 0;
    const withinWindow = now - started < RATE_WINDOW_MS;
    const count = withinWindow ? Number(value?.count || 0) : 0;
    if (count >= limit) fail('resource-exhausted', 'しばらく待ってから再試行してください。');
    tx.set(rateRef, {
      count: count + 1,
      windowStartedAt: count ? value.windowStartedAt : Timestamp.fromMillis(now),
      updatedAt: Timestamp.fromMillis(now),
      deleteAt: Timestamp.fromMillis(now + RATE_TTL_MS),
    });
  });
}

async function checkRateLimit(tx, rateRef, now) {
  const snap = await tx.get(rateRef);
  if (!snap.exists) return { count: 0, windowStartedAt: now };
  const value = snap.data();
  const started = value.windowStartedAt?.toMillis?.() || Number(value.windowStartedAt) || 0;
  if (now - started >= RATE_WINDOW_MS) return { count: 0, windowStartedAt: Timestamp.fromMillis(now) };
  if (value.count >= RATE_FAILURE_LIMIT) fail('resource-exhausted', 'しばらく待ってから再試行してください。');
  return value;
}
async function recordJoinFailure(uid, expectedDigest = null) {
  const store = db();
  const rateRef = store.collection('mofumofuOnlineRateLimits').doc(uid);
  const now = Date.now();
  await store.runTransaction(async (tx) => {
    const state = await checkRateLimit(tx, rateRef, now);
    tx.set(rateRef, { count: state.count + 1, windowStartedAt: state.windowStartedAt, updatedAt: now, expectedDigest, deleteAt: Timestamp.fromMillis(now + RATE_TTL_MS) });
  });
}
async function joinHandler(request) {
  exactFields(request.data, ['inviteCode']);
  const uid = authUid(request);
  const code = inviteCode(request.data.inviteCode);
  const inviteDigest = digest(code);
  const store = db();
  const rateRef = store.collection('mofumofuOnlineRateLimits').doc(uid);
  const inviteRef = store.collection('mofumofuOnlineRoomInvites').doc(inviteDigest);
  const now = Date.now();
  await consumeRateLimit(`join_ip_${ipHash(request)}`, IP_RATE_LIMIT, now);
  try {
    return await store.runTransaction(async (tx) => {
      await checkRateLimit(tx, rateRef, now);
      const inviteSnap = await tx.get(inviteRef);
      if (!inviteSnap.exists) fail('failed-precondition', 'この招待コードでは参加できません。');
      const invite = inviteSnap.data();
      const r = refs(invite.roomId);
      const roomSnap = await tx.get(r.room);
      if (!roomSnap.exists) fail('failed-precondition', 'この招待コードでは参加できません。');
      const room = roomSnap.data();
      const existingSeat = memberSeat(room, uid);
      if (existingSeat) {
        tx.delete(rateRef);
        return { roomId: invite.roomId, seatId: existingSeat, status: room.status };
      }
      if (invite.status !== 'active' || invite.expiresAt <= now || room.status !== 'waiting' || room.joinExpiresAt <= now || room.playerUids.B) {
        fail('failed-precondition', 'この招待コードでは参加できません。');
      }
      tx.update(r.room, {
        'players.B.joined': true,
        'playerUids.B': uid,
        'playerStatus.B': 'active',
      });
      tx.create(r.member(uid), { uid, playerId: 'B', joinedAt: now, deleteAt: expiry(PLAYING_TTL_MS) });
      tx.update(inviteRef, { status: 'full', revokedAt: now });
      tx.delete(rateRef);
      return { roomId: invite.roomId, seatId: 'B', status: 'waiting' };
    });
  } catch (error) {
    if (error instanceof HttpsError && error.code === 'failed-precondition') {
      await recordJoinFailure(uid, inviteDigest);
    }
    throw error;
  }
}

async function startHandler(request) {
  exactFields(request.data, ['roomId']);
  const uid = authUid(request);
  const roomId = roomIdFrom(request.data);
  const r = refs(roomId);
  const store = db();
  const shuffled = shuffle(deck());
  const now = Date.now();
  return store.runTransaction(async (tx) => {
    const roomSnap = await tx.get(r.room);
    const secretSnap = await tx.get(r.secret);
    if (!roomSnap.exists || !secretSnap.exists) fail('not-found', '部屋が見つかりません。');
    const room = roomSnap.data();
    if (room.hostUid !== uid) fail('permission-denied', 'ホストだけが開始できます。');
    if (room.status !== 'waiting' || room.dealt || room.startedAt) fail('already-exists', 'ゲームは開始済みです。');
    if (!room.playerUids.A || !room.playerUids.B) fail('failed-precondition', '2人そろっていません。');
    if (room.joinExpiresAt <= now) fail('failed-precondition', 'この部屋の開始期限が切れています。');
    const inviteRef = store.collection('mofumofuOnlineRoomInvites').doc(secretSnap.data().inviteDigest);
    const inviteSnap = await tx.get(inviteRef);
    if (!inviteSnap.exists) fail('failed-precondition', '招待情報がありません。');
    const handA = shuffled.slice(0, 10);
    const handB = shuffled.slice(10, 20);
    const npcHand = shuffled.slice(20, 30);
    const leftovers = shuffled.slice(30);
    const deleteAt = expiry(PLAYING_TTL_MS);
    tx.set(r.hand(room.playerUids.A), { cards: handA, deleteAt });
    tx.set(r.hand(room.playerUids.B), { cards: handB, deleteAt });
    tx.set(r.server, { npcHand, leftovers, discard: [], pendingOffer: null, proxyLease: null, claimHistory: { A: { truth: 0, total: 0 }, B: { truth: 0, total: 0 } }, deleteAt });
    tx.update(r.member(room.playerUids.A), { deleteAt });
    tx.update(r.member(room.playerUids.B), { deleteAt });
    tx.update(r.secret, { deleteAt });
    tx.update(r.room, { status: 'playing', startedAt: now, dealt: true, currentTurnPlayerId: 'A', turnState: 'awaitingOffer', turnNumber: 0, deleteAt });
    tx.update(inviteRef, { status: 'started', revokedAt: now, deleteAt });
    return { roomId, status: 'playing', currentTurnPlayerId: 'A' };
  });
}

async function resumeHandler(request) {
  exactFields(request.data, ['roomId']);
  const uid = authUid(request);
  const roomId = roomIdFrom(request.data);
  const r = refs(roomId);
  const initialSnap = await r.room.get();
  if (!initialSnap.exists) fail('not-found', '部屋が見つかりません。');
  const initialRoom = initialSnap.data();
  const initialSeat = requireMember(initialRoom, uid);
  const presence = await seatPresenceState(initialRoom, initialSeat);
  return db().runTransaction(async (tx) => {
    const roomSnap = await tx.get(r.room);
    if (!roomSnap.exists) fail('not-found', '部屋が見つかりません。');
    const room = roomSnap.data();
    const seatId = requireMember(room, uid);
    let control = controlFor(room, seatId);
    if (presence.online && control.mode === 'npc-controlled' && room.status === 'playing' && room.playerStatus?.[seatId] === 'active') {
      control = { ...control, mode: 'return-pending', returnRequestedAt: Date.now() };
    } else if (presence.online && control.mode === 'return-pending' && room.status === 'playing' && room.playerStatus?.[seatId] === 'active') {
      control = { mode: 'human', generation: control.generation, returnedAt: Date.now() };
    }
    let cards = null;
    let handStatus = 'pending';
    if ((room.status === 'playing' || room.status === 'finished') && room.dealt) {
      const handSnap = await tx.get(r.hand(uid));
      if (!handSnap.exists) return publicResult({ ...room, publicOffer: safeOffer(room.publicOffer) }, seatId, 'retry', null);
      if (room.status === 'finished' || room.playerStatus?.[seatId] === 'eliminated') {
        cards = [];
        handStatus = room.playerStatus?.[seatId] === 'eliminated' ? 'eliminated' : 'finished';
      } else {
        cards = handSnap.data().cards || [];
        handStatus = 'ready';
      }
    }
    if (control.mode !== controlFor(room, seatId).mode) tx.update(r.room, { [`controlModes.${seatId}`]: control });
    const resultRoom = { ...room, controlModes: { ...(room.controlModes || {}), [seatId]: control }, publicOffer: safeOffer(room.publicOffer) };
    return publicResult(resultRoom, seatId, handStatus, cards);
  });
}

async function startProxyHandler(request) {
  exactFields(request.data, ['roomId', 'actionId']);
  const callerUid = authUid(request);
  const roomId = roomIdFrom(request.data);
  const actionId = actionIdFrom(request.data);
  const r = refs(roomId);
  const initialSnap = await r.room.get();
  if (!initialSnap.exists) fail('not-found', '部屋が見つかりません。');
  const initialRoom = initialSnap.data();
  requireMember(initialRoom, callerUid);
  const seatId = initialRoom.turnState === 'awaitingJudgment' ? initialRoom.publicOffer?.toPlayerId : initialRoom.currentTurnPlayerId;
  if (!['A', 'B'].includes(seatId)) fail('failed-precondition', '代理が必要な席ではありません。');
  const presence = await seatPresenceState(initialRoom, seatId);
  const now = Date.now();
  if (presence.online || !presence.lastHeartbeatAt || now - presence.lastHeartbeatAt < PRESENCE_STALE_MS) fail('failed-precondition', '長時間切断ではありません。');
  const fingerprint = actionFingerprint('proxy-start', callerUid, roomId, { seatId });
  return db().runTransaction(async (tx) => {
    const [actionSnap, roomSnap] = await Promise.all([tx.get(r.action(actionId)), tx.get(r.room)]);
    if (actionSnap.exists) return replayAction(actionSnap.data(), fingerprint);
    if (!roomSnap.exists) fail('not-found', '部屋が見つかりません。');
    const room = roomSnap.data(); requireMember(room, callerUid);
    if (room.status !== 'playing' || room.playerStatus?.[seatId] !== 'active') fail('failed-precondition', '代理を開始できません。');
    const old = controlFor(room, seatId);
    if (old.mode !== 'human') fail('already-exists', '代理は開始済みです。');
    const control = { mode: 'npc-controlled', generation: old.generation + 1, startedAt: now, lastHeartbeatAt: presence.lastHeartbeatAt };
    const result = { roomId, seatId, mode: control.mode, generation: control.generation };
    tx.update(r.room, { [`controlModes.${seatId}`]: control });
    tx.create(r.action(actionId), { fingerprint, stateToken: `${room.turnNumber}:${seatId}:proxy-start`, result, completedAt: now, deleteAt: expiry(ACTION_TTL_MS) });
    return result;
  });
}

async function authorizePresenceHandler(request) {
  exactFields(request.data, ['roomId', 'connectionId']);
  const uid = authUid(request);
  const roomId = roomIdFrom(request.data);
  const connectionId = connectionIdFrom(request.data);
  const roomSnap = await refs(roomId).room.get();
  if (!roomSnap.exists) fail('not-found', '部屋が見つかりません。');
  const seatId = requireMember(roomSnap.data(), uid);
  const expiresAt = Date.now() + PRESENCE_ACCESS_TTL_MS;
  await presenceDb().ref(`mofumofuOnlinePresenceAccess/${roomId}/${uid}`).set({ uid, roomId, seatId, expiresAt });
  return { roomId, seatId, connectionId, expiresAt };
}

async function makeHandler(request) {
  exactFields(request.data, ['roomId', 'cardId', 'claimAnimal', 'targetPlayerId', 'actionId']);
  const uid = authUid(request);
  const roomId = roomIdFrom(request.data);
  const actionId = actionIdFrom(request.data);
  const { cardId, claimAnimal, targetPlayerId } = request.data;
  if (typeof cardId !== 'string' || cardId.length < 5 || cardId.length > 120) fail('invalid-argument', 'カードIDが正しくありません。');
  if (!ANIMALS.includes(claimAnimal)) fail('invalid-argument', '宣言が正しくありません。');
  if (!PLAYERS.includes(targetPlayerId)) fail('invalid-argument', '相手が正しくありません。');
  const r = refs(roomId);
  const fingerprint = actionFingerprint('make', uid, roomId, { cardId, claimAnimal, targetPlayerId });
  return db().runTransaction(async (tx) => {
    const [actionSnap, roomSnap, handSnap, serverSnap] = await Promise.all([
      tx.get(r.action(actionId)), tx.get(r.room), tx.get(r.hand(uid)), tx.get(r.server),
    ]);
    if (!roomSnap.exists || !handSnap.exists || !serverSnap.exists) fail('failed-precondition', 'ゲーム状態がありません。');
    const room = roomSnap.data();
    const seatId = requireMember(room, uid);
    const stateToken = `${room.turnNumber}:${room.currentTurnPlayerId}:${room.turnState}`;
    if (actionSnap.exists) return replayAction(actionSnap.data(), fingerprint);
    if (room.status !== 'playing' || room.turnState !== 'awaitingOffer' || room.currentTurnPlayerId !== seatId) fail('failed-precondition', '現在はカードを渡せません。');
    if (controlFor(room, seatId).mode !== 'human') fail('failed-precondition', 'NPC代理中は本人が操作できません。');
    if (room.playerStatus?.[seatId] !== 'active') fail('failed-precondition', '脱落後はカードを渡せません。');
    if (targetPlayerId === seatId || (targetPlayerId !== 'koharu' && !room.players?.[targetPlayerId]?.joined)) fail('invalid-argument', '相手が正しくありません。');
    if (room.playerStatus?.[targetPlayerId] !== 'active') fail('failed-precondition', '脱落した相手にはカードを渡せません。');
    const server = serverSnap.data();
    if (server.pendingOffer || room.publicOffer?.status === 'pending') fail('failed-precondition', '判定待ちのカードがあります。');
    const cards = handSnap.data().cards || [];
    const index = cards.findIndex((card) => card.cardId === cardId);
    if (index < 0) fail('permission-denied', 'そのカードは手札にありません。');
    const [card] = cards.splice(index, 1);
    const pending = { actionId, fromPlayerId: seatId, toPlayerId: targetPlayerId, claimAnimal, card };
    const offer = { actionId, fromPlayerId: seatId, toPlayerId: targetPlayerId, claimAnimal, status: 'pending' };
    const turnState = targetPlayerId === 'koharu' ? 'awaitingNpcPhase' : 'awaitingJudgment';
    const result = { roomId, actionId, offer, turnState };
    tx.update(r.hand(uid), { cards });
    tx.update(r.server, { pendingOffer: pending });
    tx.update(r.room, { publicOffer: offer, turnState });
    tx.create(r.action(actionId), { fingerprint, stateToken, result, completedAt: Date.now(), deleteAt: expiry(ACTION_TTL_MS) });
    return result;
  });
}

function completedOffer(pending, judgment) {
  const success = judgeSuccess(pending.claimAnimal, pending.card.animalType, judgment);
  const faceUpRecipientPlayerId = success ? pending.fromPlayerId : pending.toPlayerId;
  return {
    actionId: pending.actionId,
    fromPlayerId: pending.fromPlayerId,
    toPlayerId: pending.toPlayerId,
    claimAnimal: pending.claimAnimal,
    status: 'completed',
    actualAnimal: pending.card.animalType,
    judgment,
    success,
    faceUpRecipientPlayerId,
  };
}
async function judgeHandler(request) {
  exactFields(request.data, ['roomId', 'actionId', 'judgment']);
  const uid = authUid(request);
  const roomId = roomIdFrom(request.data);
  const actionId = actionIdFrom(request.data);
  const { judgment } = request.data;
  if (!['truth', 'lie'].includes(judgment)) fail('invalid-argument', '判定が正しくありません。');
  const r = refs(roomId);
  const fingerprint = actionFingerprint('judge', uid, roomId, { actionId, judgment });
  return db().runTransaction(async (tx) => {
    const roomSnap = await tx.get(r.room);
    if (!roomSnap.exists) fail('failed-precondition', 'ゲーム状態がありません。');
    const room = roomSnap.data();
    const [judgeActionSnap, serverSnap, handASnap, handBSnap, secretSnap] = await Promise.all([
      tx.get(r.action(`judge-${actionId}`)), tx.get(r.server), tx.get(r.hand(room.playerUids.A)), tx.get(r.hand(room.playerUids.B)), tx.get(r.secret),
    ]);
    if (!serverSnap.exists || !handASnap.exists || !handBSnap.exists || !secretSnap.exists) fail('failed-precondition', 'ゲーム状態がありません。');
    const inviteRef = db().collection('mofumofuOnlineRoomInvites').doc(secretSnap.data().inviteDigest);
    const inviteSnap = await tx.get(inviteRef);
    const seatId = requireMember(room, uid);
    const stateToken = `${room.turnNumber}:${actionId}:judge`;
    if (judgeActionSnap.exists) return replayAction(judgeActionSnap.data(), fingerprint);
    if (room.status !== 'playing' || room.turnState !== 'awaitingJudgment') fail('failed-precondition', '現在は判定できません。');
    if (controlFor(room, seatId).mode !== 'human') fail('failed-precondition', 'NPC代理中は本人が操作できません。');
    if (room.playerStatus?.[seatId] !== 'active') fail('failed-precondition', '脱落後は判定できません。');
    const pending = serverSnap.data().pendingOffer;
    if (!pending || pending.actionId !== actionId || pending.toPlayerId !== seatId || room.publicOffer?.status !== 'pending') fail('permission-denied', 'この判定は行えません。');
    if (room.playerStatus?.[pending.fromPlayerId] !== 'active' || room.playerStatus?.[pending.toPlayerId] !== 'active') fail('failed-precondition', '脱落した参加者の判定はできません。');
    const now = Date.now();
    const resolved = resolveFaceUp(room, serverSnap.data(), { A: handASnap.data().cards || [], B: handBSnap.data().cards || [] }, pending, judgment, now);
    const history = { ...(serverSnap.data().claimHistory || {}) };
    if (pending.fromPlayerId !== 'koharu') {
      const entry = { ...(history[pending.fromPlayerId] || { truth: 0, total: 0 }) };
      entry.total += 1;
      if (pending.claimAnimal === pending.card.animalType) entry.truth += 1;
      history[pending.fromPlayerId] = entry;
    }
    resolved.server.claimHistory = history;
    resolved.room.publicOffer = resolved.offer;
    const result = { roomId, actionId, offer: resolved.offer, eliminatedPlayerId: resolved.eliminatedPlayerId, finish: resolved.finish, ...resolved.advance };
    tx.set(r.server, resolved.server);
    tx.update(r.hand(room.playerUids.A), { cards: resolved.hands.A });
    tx.update(r.hand(room.playerUids.B), { cards: resolved.hands.B });
    tx.set(r.room, resolved.room);
    if (resolved.finish && inviteSnap.exists) tx.update(inviteRef, { status: 'ended', revokedAt: now });
    tx.create(r.action(`judge-${actionId}`), { fingerprint, stateToken, result, completedAt: now, deleteAt: expiry(ACTION_TTL_MS) });
    return result;
  });
}

async function npcHandler(request) {
  exactFields(request.data, ['roomId', 'actionId']);
  const uid = authUid(request);
  const roomId = roomIdFrom(request.data);
  const actionId = actionIdFrom(request.data);
  const r = refs(roomId);
  const fingerprint = actionFingerprint('npc', uid, roomId, { actionId });
  const initialRoomSnap = await r.room.get();
  if (!initialRoomSnap.exists) fail('failed-precondition', 'ゲーム状態がありません。');
  requireMember(initialRoomSnap.data(), uid);
  let onlineSeats = null;
  if (initialRoomSnap.data().status === 'playing'
      && initialRoomSnap.data().turnState === 'awaitingNpcPhase'
      && initialRoomSnap.data().currentTurnPlayerId === 'koharu') {
    onlineSeats = await onlineHumanSeats(initialRoomSnap.data());
  }
  return db().runTransaction(async (tx) => {
    const roomSnap = await tx.get(r.room);
    if (!roomSnap.exists) fail('failed-precondition', 'ゲーム状態がありません。');
    const room = roomSnap.data();
    const [actionSnap, serverSnap, handASnap, handBSnap, secretSnap] = await Promise.all([
      tx.get(r.action(actionId)), tx.get(r.server), tx.get(r.hand(room.playerUids.A)), tx.get(r.hand(room.playerUids.B)), tx.get(r.secret),
    ]);
    if (!serverSnap.exists || !handASnap.exists || !handBSnap.exists || !secretSnap.exists) fail('failed-precondition', 'ゲーム状態がありません。');
    const inviteRef = db().collection('mofumofuOnlineRoomInvites').doc(secretSnap.data().inviteDigest);
    const inviteSnap = await tx.get(inviteRef);
    requireMember(room, uid);
    const stateToken = `${room.turnNumber}:${room.currentTurnPlayerId}:${room.turnState}:${room.publicOffer?.actionId || 'none'}`;
    if (actionSnap.exists) return replayAction(actionSnap.data(), fingerprint);
    if (room.status !== 'playing' || room.turnState !== 'awaitingNpcPhase') fail('failed-precondition', 'こはるの処理は必要ありません。');
    const server = serverSnap.data();
    const hands = { A: handASnap.data().cards || [], B: handBSnap.data().cards || [] };
    const now = Date.now();
    let result;
    if (server.pendingOffer?.toPlayerId === 'koharu') {
      const pending = server.pendingOffer;
      if (room.playerStatus?.koharu !== 'active' || room.playerStatus?.[pending.fromPlayerId] !== 'active') fail('failed-precondition', '脱落した参加者の判定はできません。');
      const judgment = chooseNpcJudgment(server.claimHistory?.[pending.fromPlayerId]);
      const resolved = resolveFaceUp(room, server, hands, pending, judgment, now);
      const history = { ...(server.claimHistory || {}) };
      const entry = { ...(history[pending.fromPlayerId] || { truth: 0, total: 0 }) };
      entry.total += 1;
      if (pending.claimAnimal === pending.card.animalType) entry.truth += 1;
      history[pending.fromPlayerId] = entry;
      resolved.server.claimHistory = history;
      resolved.room.publicOffer = resolved.offer;
      result = { roomId, actionId, mode: 'npcJudgment', offer: resolved.offer, eliminatedPlayerId: resolved.eliminatedPlayerId, finish: resolved.finish, ...resolved.advance };
      tx.set(r.server, resolved.server);
      tx.update(r.hand(room.playerUids.A), { cards: resolved.hands.A });
      tx.update(r.hand(room.playerUids.B), { cards: resolved.hands.B });
      tx.set(r.room, resolved.room);
      if (resolved.finish && inviteSnap.exists) tx.update(inviteRef, { status: 'ended', revokedAt: now });
    } else if (room.currentTurnPlayerId === 'koharu' && !server.pendingOffer) {
      if (room.playerStatus?.koharu !== 'active') fail('failed-precondition', '脱落したこはるは行動できません。');
      const npcHand = [...(server.npcHand || [])];
      if (!npcHand.length) {
        const finish = finishIfNeeded(room, server, hands);
        if (!finish) fail('failed-precondition', 'こはるの手札がありません。');
        const finishedRoom = structuredClone(room);
        const advance = { currentTurnPlayerId: null, turnState: 'finished', turnNumber: (room.turnNumber || 0) + 1 };
        Object.assign(finishedRoom, advance, { status: 'finished', ...finish, finalResult: buildFinalResult(finishedRoom, finish.finishReason, finish.winnerPlayerId, finish.draw, now) });
        result = { roomId, actionId, mode: 'npcFinish', finish, ...advance };
        tx.set(r.room, finishedRoom);
        if (inviteSnap.exists) tx.update(inviteRef, { status: 'ended', revokedAt: now });
      } else {
      const index = crypto.randomInt(npcHand.length);
      const [card] = npcHand.splice(index, 1);
      const claimAnimal = chooseNpcClaim(card.animalType);
      const humans = ['A', 'B'].filter((seat) => room.players?.[seat]?.joined
        && room.playerStatus?.[seat] === 'active'
        && onlineSeats?.includes(seat));
      if (!humans.length) fail('failed-precondition', '接続中の相手を待っています。');
      const targetPlayerId = humans[(room.turnNumber || 0) % humans.length];
      const pending = { actionId, fromPlayerId: 'koharu', toPlayerId: targetPlayerId, claimAnimal, card };
      const offer = { actionId, fromPlayerId: 'koharu', toPlayerId: targetPlayerId, claimAnimal, status: 'pending' };
      result = { roomId, actionId, mode: 'npcOffer', offer, turnState: 'awaitingJudgment' };
      tx.update(r.server, { npcHand, pendingOffer: pending });
      tx.update(r.room, { publicOffer: offer, turnState: 'awaitingJudgment' });
      }
    } else {
      fail('failed-precondition', 'こはるの処理は必要ありません。');
    }
    tx.create(r.action(actionId), { fingerprint, stateToken, result, completedAt: now, deleteAt: expiry(ACTION_TTL_MS) });
    return result;
  });
}

async function proxyActionHandler(request) {
  exactFields(request.data, ['roomId', 'actionId']);
  const callerUid = authUid(request); const roomId = roomIdFrom(request.data); const actionId = actionIdFrom(request.data);
  const r = refs(roomId); const fingerprint = actionFingerprint('proxy-action', callerUid, roomId, {});
  return db().runTransaction(async (tx) => {
    const roomSnap = await tx.get(r.room);
    if (!roomSnap.exists) fail('not-found', '部屋が見つかりません。');
    const room = roomSnap.data(); requireMember(room, callerUid);
    const [actionSnap, serverSnap, handASnap, handBSnap, secretSnap] = await Promise.all([
      tx.get(r.action(actionId)), tx.get(r.server), tx.get(r.hand(room.playerUids.A)), tx.get(r.hand(room.playerUids.B)), tx.get(r.secret),
    ]);
    if (actionSnap.exists) return replayAction(actionSnap.data(), fingerprint);
    if (room.status !== 'playing' || !serverSnap.exists || !handASnap.exists || !handBSnap.exists) fail('failed-precondition', '代理行動を実行できません。');
    const server = serverSnap.data(); const hands = { A: handASnap.data().cards || [], B: handBSnap.data().cards || [] }; const now = Date.now();
    const seatId = room.turnState === 'awaitingJudgment' ? server.pendingOffer?.toPlayerId : room.currentTurnPlayerId;
    if (!['A', 'B'].includes(seatId) || controlFor(room, seatId).mode !== 'npc-controlled' || room.playerStatus?.[seatId] !== 'active') fail('failed-precondition', 'NPC代理中の席ではありません。');
    let result;
    if (room.turnState === 'awaitingOffer' && room.currentTurnPlayerId === seatId && !server.pendingOffer) {
      const cards = [...hands[seatId]];
      if (!cards.length) fail('failed-precondition', '代理対象の手札がありません。');
      const [card] = cards.splice(crypto.randomInt(cards.length), 1);
      const claimAnimal = chooseNpcClaim(card.animalType);
      const targets = PLAYERS.filter((candidate) => candidate !== seatId && room.playerStatus?.[candidate] === 'active');
      if (!targets.length) fail('failed-precondition', '渡せる相手がいません。');
      const targetPlayerId = targets[(room.turnNumber || 0) % targets.length];
      const pending = { actionId, fromPlayerId: seatId, toPlayerId: targetPlayerId, claimAnimal, card, proxyGeneration: controlFor(room, seatId).generation };
      const offer = { actionId, fromPlayerId: seatId, toPlayerId: targetPlayerId, claimAnimal, status: 'pending' };
      const turnState = targetPlayerId === 'koharu' ? 'awaitingNpcPhase' : 'awaitingJudgment';
      hands[seatId] = cards; server.pendingOffer = pending; room.publicOffer = offer; room.turnState = turnState;
      result = { roomId, actionId, mode: 'proxyOffer', seatId, offer, turnState };
    } else if (room.turnState === 'awaitingJudgment' && server.pendingOffer?.toPlayerId === seatId) {
      const pending = server.pendingOffer;
      const judgment = chooseNpcJudgment(server.claimHistory?.[pending.fromPlayerId]);
      const resolved = resolveFaceUp(room, server, hands, pending, judgment, now);
      const history = { ...(resolved.server.claimHistory || {}) };
      if (pending.fromPlayerId !== 'koharu') {
        const entry = { ...(history[pending.fromPlayerId] || { truth: 0, total: 0 }) };
        entry.total += 1; if (pending.claimAnimal === pending.card.animalType) entry.truth += 1; history[pending.fromPlayerId] = entry;
      }
      resolved.server.claimHistory = history; resolved.room.publicOffer = resolved.offer;
      Object.assign(room, resolved.room); Object.assign(server, resolved.server); Object.assign(hands, resolved.hands);
      result = { roomId, actionId, mode: 'proxyJudgment', seatId, offer: resolved.offer, eliminatedPlayerId: resolved.eliminatedPlayerId, finish: resolved.finish, ...resolved.advance };
    } else fail('failed-precondition', '代理行動の手番ではありません。');
    if (room.status === 'finished' || room.playerStatus?.[seatId] === 'eliminated') room.controlModes[seatId] = { ...controlFor(room, seatId), mode: 'ended', endedAt: now };
    tx.set(r.server, server); tx.update(r.hand(room.playerUids.A), { cards: hands.A }); tx.update(r.hand(room.playerUids.B), { cards: hands.B }); tx.set(r.room, room);
    if (room.status === 'finished' && secretSnap.exists) {
      const inviteRef = db().collection('mofumofuOnlineRoomInvites').doc(secretSnap.data().inviteDigest); tx.update(inviteRef, { status: 'ended', revokedAt: now });
    }
    tx.create(r.action(actionId), { fingerprint, stateToken: `${room.turnNumber}:${seatId}:proxy`, result, completedAt: now, deleteAt: expiry(ACTION_TTL_MS) });
    return result;
  });
}

const createMofumofuRoom = onCall(callableOptions, createHandler);
const joinMofumofuRoom = onCall(callableOptions, joinHandler);
const startMofumofuGame = onCall(callableOptions, startHandler);
const resumeMofumofuRoom = onCall(callableOptions, resumeHandler);
const authorizeMofumofuPresence = onCall(callableOptions, authorizePresenceHandler);
const makeMofumofuOffer = onCall(callableOptions, makeHandler);
const judgeMofumofuOffer = onCall(callableOptions, judgeHandler);
const runMofumofuNpcTurn = onCall(callableOptions, npcHandler);
const startMofumofuNpcProxy = onCall(callableOptions, startProxyHandler);
const runMofumofuNpcProxyAction = onCall(callableOptions, proxyActionHandler);
const cleanupMofumofuOnline = onSchedule({ region: REGION, schedule: 'every 60 minutes', timeZone: 'Asia/Tokyo' }, () => cleanupMofumofuDataNow());

module.exports = {
  createMofumofuRoom,
  joinMofumofuRoom,
  startMofumofuGame,
  resumeMofumofuRoom,
  authorizeMofumofuPresence,
  makeMofumofuOffer,
  judgeMofumofuOffer,
  runMofumofuNpcTurn,
  startMofumofuNpcProxy,
  runMofumofuNpcProxyAction,
  cleanupMofumofuOnline,
  _handlers: { createHandler, joinHandler, startHandler, resumeHandler, authorizePresenceHandler, makeHandler, judgeHandler, npcHandler, startProxyHandler, proxyActionHandler },
  _test: { ANIMALS, PRESENCE_ACCESS_TTL_MS, PRESENCE_STALE_MS, WAITING_TTL_MS, PLAYING_TTL_MS, FINISHED_TTL_MS, ACTION_TTL_MS, RATE_TTL_MS, callableOptions, ipHash, cleanupMofumofuDataNow, presenceConnectionOnline, uidPresenceOnline, uidPresenceState, chooseNpcClaim, chooseNpcJudgment, nextPlayerId, judgeSuccess, digest, sameFingerprint, countByAnimal, finishIfNeeded, resolveFaceUp },
};

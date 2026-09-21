'use strict';

const crypto = require('node:crypto');
const { getFirestore } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');

const PROJECT_ID = 'demo-mofumofu-online';
const REGION = 'asia-northeast1';
const ANIMALS = ['cat', 'rabbit', 'bear', 'chick', 'fox', 'penguin', 'panda', 'polar'];
const PLAYERS = ['A', 'B', 'koharu'];
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INVITE_LENGTH = 8;
const INVITE_RETRIES = 3;
const WAITING_TTL_MS = 30 * 60 * 1000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_FAILURE_LIMIT = 8;
const callableOptions = { region: REGION, cors: true };

function db() { return getFirestore(); }
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
  } else {
    const next = nextPlayerId(pending.fromPlayerId, room.playerStatus);
    advance = { currentTurnPlayerId: next, turnState: next === 'koharu' ? 'awaitingNpcPhase' : 'awaitingOffer', turnNumber: (room.turnNumber || 0) + 1 };
    Object.assign(room, advance);
  }
  return { room, server, hands, offer, eliminatedPlayerId, finish, advance };
}

async function createHandler(request) {
  exactFields(request.data || {}, []);
  const uid = authUid(request);
  const store = db();
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
        tx.create(r.member(uid), { uid, playerId: 'A', joinedAt: now });
        tx.create(r.secret, { inviteDigest, createdAt: now });
        tx.create(inviteRef, { roomId, status: 'active', createdAt: now, expiresAt, revokedAt: null });
      });
      return { roomId, inviteCode: code, status: 'waiting', seatId: 'A' };
    } catch (error) {
      if (error instanceof HttpsError && error.code === 'already-exists' && attempt + 1 < INVITE_RETRIES) continue;
      throw error;
    }
  }
  fail('resource-exhausted', '部屋を作成できませんでした。');
}

async function checkRateLimit(tx, rateRef, now) {
  const snap = await tx.get(rateRef);
  if (!snap.exists) return { count: 0, windowStartedAt: now };
  const value = snap.data();
  if (now - value.windowStartedAt >= RATE_WINDOW_MS) return { count: 0, windowStartedAt: now };
  if (value.count >= RATE_FAILURE_LIMIT) fail('resource-exhausted', 'しばらく待ってから再試行してください。');
  return value;
}
async function recordJoinFailure(uid, expectedDigest = null) {
  const store = db();
  const rateRef = store.collection('mofumofuOnlineRateLimits').doc(uid);
  const now = Date.now();
  await store.runTransaction(async (tx) => {
    const state = await checkRateLimit(tx, rateRef, now);
    tx.set(rateRef, { count: state.count + 1, windowStartedAt: state.windowStartedAt, updatedAt: now, expectedDigest });
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
      tx.create(r.member(uid), { uid, playerId: 'B', joinedAt: now });
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
    tx.set(r.hand(room.playerUids.A), { cards: handA });
    tx.set(r.hand(room.playerUids.B), { cards: handB });
    tx.set(r.server, { npcHand, leftovers, discard: [], pendingOffer: null, claimHistory: { A: { truth: 0, total: 0 }, B: { truth: 0, total: 0 } } });
    tx.update(r.room, { status: 'playing', startedAt: now, dealt: true, currentTurnPlayerId: 'A', turnState: 'awaitingOffer', turnNumber: 0 });
    tx.update(inviteRef, { status: 'started', revokedAt: now });
    return { roomId, status: 'playing', currentTurnPlayerId: 'A' };
  });
}

async function resumeHandler(request) {
  exactFields(request.data, ['roomId']);
  const uid = authUid(request);
  const roomId = roomIdFrom(request.data);
  const r = refs(roomId);
  return db().runTransaction(async (tx) => {
    const roomSnap = await tx.get(r.room);
    if (!roomSnap.exists) fail('not-found', '部屋が見つかりません。');
    const room = roomSnap.data();
    const seatId = requireMember(room, uid);
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
    return publicResult({ ...room, publicOffer: safeOffer(room.publicOffer) }, seatId, handStatus, cards);
  });
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
    tx.create(r.action(actionId), { fingerprint, stateToken, result, completedAt: Date.now() });
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
    tx.create(r.action(`judge-${actionId}`), { fingerprint, stateToken, result, completedAt: now });
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
      const humans = ['A', 'B'].filter((seat) => room.players?.[seat]?.joined && room.playerStatus?.[seat] === 'active');
      if (!humans.length) fail('failed-precondition', 'カードを渡せる相手がいません。');
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
    tx.create(r.action(actionId), { fingerprint, stateToken, result, completedAt: now });
    return result;
  });
}

const createMofumofuRoom = onCall(callableOptions, createHandler);
const joinMofumofuRoom = onCall(callableOptions, joinHandler);
const startMofumofuGame = onCall(callableOptions, startHandler);
const resumeMofumofuRoom = onCall(callableOptions, resumeHandler);
const makeMofumofuOffer = onCall(callableOptions, makeHandler);
const judgeMofumofuOffer = onCall(callableOptions, judgeHandler);
const runMofumofuNpcTurn = onCall(callableOptions, npcHandler);

module.exports = {
  createMofumofuRoom,
  joinMofumofuRoom,
  startMofumofuGame,
  resumeMofumofuRoom,
  makeMofumofuOffer,
  judgeMofumofuOffer,
  runMofumofuNpcTurn,
  _handlers: { createHandler, joinHandler, startHandler, resumeHandler, makeHandler, judgeHandler, npcHandler },
  _test: { ANIMALS, PROJECT_ID, chooseNpcClaim, chooseNpcJudgment, nextPlayerId, judgeSuccess, digest, sameFingerprint, countByAnimal, finishIfNeeded, resolveFaceUp },
};

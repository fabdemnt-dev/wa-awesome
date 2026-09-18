'use strict';

const { getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getDatabase } = require('firebase-admin/database');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const crypto = require('node:crypto');
const { createInviteCode, parseInviteCode, mac, safeEqual, hashIp } = require('./invite-code');
const { prepareCopyState, resolveRound } = require('./rules');

if (!getApps().length) initializeApp();
const db = getFirestore();
const rtdb = getDatabase();
const inviteKey = defineSecret('MOON_SCALE_DUEL_INVITE_HMAC_KEY');
const ipKey = defineSecret('MOON_SCALE_DUEL_IP_HMAC_KEY');
const REGION = 'asia-northeast1';
const ROOM_TTL_MILLIS = 24 * 60 * 60 * 1000;
const NEXT_ROUND_WAIT_MILLIS = 120 * 1000;
const WAIT_EXTENSION_MILLIS = 60 * 1000;
const CARD_IDS = Object.freeze(['waxing', 'waning', 'reflection', 'stillness', 'falseMoon', 'oath']);
const SEAT_IDS = Object.freeze(['seat1', 'seat2']);

const callableOptions = {
  region: REGION,
  cors: ['https://fabdemnt-dev.github.io', /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/],
  minInstances: 0,
  maxInstances: 5,
  enforceAppCheck: false,
  secrets: [inviteKey, ipKey],
};

function fail(code, message) { throw new HttpsError(code, message); }
function uidOf(request) {
  if (!request.auth?.uid) fail('unauthenticated', '匿名ログインが必要です。');
  return request.auth.uid;
}
function cleanText(value, max, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) fail('invalid-argument', `${label}は1〜${max}文字で入力してください。`);
  return text;
}
function requestIdOf(request) {
  const requestId = cleanText(request.data?.requestId, 80, 'リクエストID');
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(requestId)) fail('invalid-argument', 'リクエストIDが不正です。');
  return requestId;
}
function roomIdOf(request) {
  const roomId = cleanText(request.data?.roomId, 80, 'ルームID');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(roomId)) {
    fail('invalid-argument', 'ルームIDが不正です。');
  }
  return roomId;
}
function keyValue(secret, fallback) {
  try { return secret.value() || fallback; } catch { return fallback; }
}
function inviteSecret() { return keyValue(inviteKey, 'emulator-moon-scale-duel-invite-key'); }
function ipSecret() { return keyValue(ipKey, 'emulator-moon-scale-duel-ip-key'); }
function requestIp(request) { return request.rawRequest?.ip || request.rawRequest?.socket?.remoteAddress || 'unknown'; }
function randomId() { return crypto.randomUUID(); }
function roomRef(roomId) { return db.collection('moonScaleDuelRooms').doc(roomId); }
function actionRef(uid, requestId) { return db.collection('moonScaleDuelActionRequests').doc(`${uid}_${requestId}`); }
const TRANSACTION_DIAGNOSTIC_ENABLED = process.env.MOON_SCALE_DUEL_TRANSACTION_LIFECYCLE_DIAGNOSTIC === '1';
function transactionDiagnostic(callable, roomId, gameId) {
  if (!TRANSACTION_DIAGNOSTIC_ENABLED) {
    return {
      beginAttempt: () => 0,
      read: (_attempt, _label, read) => read(),
      writePlan: () => {},
      callbackComplete: () => {},
      success: () => {},
      reject: () => {},
    };
  }
  const correlationId = `corr-${crypto.randomBytes(8).toString('hex')}`;
  const scope = crypto.createHash('sha256').update(`${roomId}\0${gameId}`).digest('hex').slice(0, 12);
  const startedAt = Date.now();
  let attempts = 0;
  let lastStage = 'created';
  const safeError = (error) => ({
    errorCode: String(error?.code || error?.name || 'unknown').slice(0, 80),
    errorMessage: String(error?.message || 'unknown')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, '[redacted-id]')
      .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted-token]')
      .slice(0, 240),
  });
  const emit = (stage, details = {}) => {
    lastStage = stage;
    console.log(`MOON_SCALE_DUEL_TRANSACTION_LIFECYCLE ${JSON.stringify({
      callable, correlationId, scope, stage, elapsedMs: Date.now() - startedAt, ...details,
    })}`);
  };
  emit('run_transaction_start', { startedAt: new Date(startedAt).toISOString() });
  return {
    beginAttempt() {
      attempts += 1;
      emit('callback_start', { attempt: attempts, startedAt: new Date().toISOString() });
      return attempts;
    },
    async read(attempt, label, read) {
      emit('read_start', { attempt, documentType: label });
      try {
        const snapshot = await read();
        emit('read_complete', { attempt, documentType: label });
        return snapshot;
      } catch (error) {
        emit('read_failure', { attempt, documentType: label, ...safeError(error) });
        throw error;
      }
    },
    writePlan(attempt, documentTypes) {
      emit('write_plan', { attempt, documentTypes });
    },
    callbackComplete(attempt, outcome = 'normal') {
      emit('callback_complete', { attempt, outcome });
    },
    success() {
      emit('run_transaction_success', { attempts });
    },
    reject(error) {
      emit('run_transaction_reject', { attempts, lastStage, ...safeError(error) });
    },
  };
}
function payloadHash(type, payload) {
  return crypto.createHash('sha256').update(JSON.stringify({ type, ...payload })).digest('base64url');
}
function expiresAtFromNow() { return Timestamp.fromMillis(Date.now() + ROOM_TTL_MILLIS); }
function deadlineFromNow(milliseconds) { return Timestamp.fromMillis(Date.now() + milliseconds); }
function hasValidExpiry(data, nowMillis = Date.now()) {
  const millis = data?.expiresAt?.toMillis?.();
  return Number.isFinite(millis) && millis > nowMillis;
}
function assertReplay(action, expectedHash) {
  if (action.payloadHash !== expectedHash) fail('already-exists', '同じリクエストIDを別の操作に再利用できません。');
  return action.result;
}

async function consumeRateLimit(key, limit, windowSeconds) {
  const ref = db.collection('moonScaleDuelRateLimits').doc(key);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const current = snap.exists ? snap.data() : null;
    const start = current?.windowStart?.toMillis?.() || 0;
    const withinWindow = now - start < windowSeconds * 1000;
    const count = withinWindow ? Number(current?.count || 0) : 0;
    if (count >= limit) fail('resource-exhausted', '試行回数が多すぎます。しばらく待ってからもう一度お試しください。');
    tx.set(ref, {
      count: count + 1,
      windowStart: count === 0 ? Timestamp.fromMillis(now) : current.windowStart,
      expiresAt: Timestamp.fromMillis(now + windowSeconds * 2000),
    });
  });
}

async function grantPresence(roomId, uid) {
  await rtdb.ref(`moonScaleDuelRoomAccess/${roomId}/${uid}`).set(true);
}

async function requireMember(roomId, uid) {
  const member = await roomRef(roomId).collection('members').doc(uid).get();
  if (!member.exists || member.data().leftAt) fail('permission-denied', 'この部屋には参加していません。');
  return member.data();
}

function publicRoom(roomId, data) {
  return {
    id: roomId,
    status: data.status,
    hostSeatId: 'seat1',
    humanCount: Number(data.humanCount || 0),
    humanLimit: 2,
    gameId: data.gameId || null,
    stateVersion: Number(data.stateVersion || 0),
    expiresAtMillis: data.expiresAt?.toMillis?.() || null,
  };
}
function publicMember(data) {
  return {
    displayName: data.displayName,
    role: data.role,
    seatId: data.seatId,
  };
}
function publicSeat(data, membersBySeat) {
  return {
    seatId: data.seatId,
    seatIndex: data.seatIndex,
    occupied: data.controllerType === 'human',
    displayName: membersBySeat[data.seatId]?.displayName || null,
  };
}
function publicRoundResult(data) {
  if (!data) return null;
  const seats = ['seat1', 'seat2'];
  const pair = (value) => Object.fromEntries(seats.map((seatId) => [seatId, value?.[seatId] ?? null]));
  const effects = Object.fromEntries(seats.map((seatId) => {
    const effect = data.effects?.[seatId];
    return [seatId, effect ? {
      actualCardId: effect.actualCardId || null,
      effectiveCardId: effect.effectiveCardId || null,
      copyTargetId: effect.copyTargetId || null,
      status: effect.status || null,
    } : null];
  }));
  return {
    round: Number(data.round),
    actualCards: pair(data.actualCards),
    effectiveCards: pair(data.effectiveCards),
    copyTargets: pair(data.copyTargets),
    effects,
    reflectionCount: Number(data.reflectionCount || 0),
    reversed: data.reversed === true,
    moonShadowBefore: pair(data.moonShadowBefore),
    moonShadowAfter: pair(data.moonShadowAfter),
    outcome: data.outcome || null,
    messages: Array.isArray(data.messages) ? data.messages.filter((item) => typeof item === 'string') : [],
  };
}
function publicHistory(data) {
  if (!Array.isArray(data)) return [];
  return data.map((item) => publicRoundResult(item)).filter(Boolean);
}
function completionResult(roundResult) {
  if (!roundResult?.outcome) return null;
  return {
    type: 'completed',
    outcome: roundResult.outcome,
    round: Number(roundResult.round),
    moonShadow: { ...roundResult.moonShadowAfter },
  };
}
function publicFinalResult(data) {
  if (data?.type === 'completed' && ['seat1', 'seat2', 'draw'].includes(data.outcome)) {
    return {
      type: 'completed', outcome: data.outcome, round: Number(data.round),
      moonShadow: { seat1: Number(data.moonShadow?.seat1), seat2: Number(data.moonShadow?.seat2) },
    };
  }
  if (data?.type === 'aborted') return { type: 'aborted', reason: data.reason || null, round: Number(data.round) };
  return null;
}
function resolutionPhase(roundResult) { return roundResult?.outcome ? 'ended' : 'round-result'; }
function publicGame(data) {
  if (!data) return null;
  return {
    gameId: data.gameId,
    phase: data.phase,
    round: data.round,
    stateVersion: data.stateVersion,
    moonShadow: data.moonShadow,
    remainingCardCounts: data.remainingCardCounts,
    nextRoundReady: data.nextRoundReady,
    rematchReady: data.rematchReady,
    deadlineMillis: data.deadline?.toMillis?.() || null,
    result: publicFinalResult(data.result),
    history: publicHistory(data.history),
    serverTimeMillis: Date.now(),
    publicCards: ['cards-revealed', 'choosing-copy', 'round-result', 'ended', 'aborted'].includes(data.phase) && data.publicCards
      ? { seat1: data.publicCards.seat1, seat2: data.publicCards.seat2 }
      : null,
    publicCopies: ['round-result', 'ended', 'aborted'].includes(data.phase) && data.publicCopies
      ? { seat1: data.publicCopies.seat1 || null, seat2: data.publicCopies.seat2 || null }
      : null,
    roundResult: ['round-result', 'ended', 'aborted'].includes(data.phase) ? publicRoundResult(data.roundResult) : null,
  };
}

function privatePlayer(data) {
  if (!data) return null;
  const usedCards = Array.isArray(data.usedCards) ? data.usedCards.filter((id) => CARD_IDS.includes(id)) : [];
  return {
    seatId: data.seatId,
    usedCards,
    availableCards: CARD_IDS.filter((id) => !usedCards.includes(id)),
    submitted: data.submitted === true,
    selectedCardId: data.submitted === true && CARD_IDS.includes(data.selectedCardId) ? data.selectedCardId : null,
    legalCopyTargets: Array.isArray(data.legalCopyTargets)
      ? data.legalCopyTargets.filter((id) => CARD_IDS.includes(id))
      : [],
    copySubmitted: data.copySubmitted === true,
    selectedCopyTarget: data.copySubmitted === true && CARD_IDS.includes(data.selectedCopyTarget)
      ? data.selectedCopyTarget
      : null,
  };
}

function rematchActionInput(request) {
  const roomId = roomIdOf(request);
  const gameId = cleanText(request.data?.gameId, 80, 'ゲームID');
  const stateVersion = Number(request.data?.stateVersion);
  if (!Number.isInteger(stateVersion) || stateVersion < 1) fail('invalid-argument', '状態番号が不正です。');
  return { roomId, gameId, stateVersion };
}

const createRoom = onCall(callableOptions, async (request) => {
  const uid = uidOf(request);
  const requestId = requestIdOf(request);
  const displayName = cleanText(request.data?.displayName, 20, '表示名');
  const hash = payloadHash('createRoom', { displayName });
  const action = actionRef(uid, requestId);
  const previous = await action.get();
  if (previous.exists) {
    const result = assertReplay(previous.data(), hash);
    const invite = createInviteCode(uid, requestId, inviteSecret());
    return { ...result, inviteCode: invite.code };
  }
  const ipHash = hashIp(requestIp(request), ipSecret());
  await Promise.all([
    consumeRateLimit(`create_uid_${uid}`, 10, 600),
    consumeRateLimit(`create_ip_${ipHash}`, 30, 600),
  ]);
  const roomId = randomId();
  const invite = createInviteCode(uid, requestId, inviteSecret());
  const result = await db.runTransaction(async (tx) => {
    const [actionSnap, locatorSnap] = await Promise.all([
      tx.get(action),
      tx.get(db.collection('moonScaleDuelRoomLocators').doc(invite.locator)),
    ]);
    if (actionSnap.exists) return assertReplay(actionSnap.data(), hash);
    if (locatorSnap.exists) fail('aborted', '招待コードを作成できませんでした。別のリクエストでお試しください。');
    const expiresAt = expiresAtFromNow();
    const room = roomRef(roomId);
    const safeResult = { roomId, seatId: 'seat1', stateVersion: 1 };
    tx.set(room, {
      status: 'waiting', hostUid: uid, humanCount: 1, humanLimit: 2,
      gameId: null, gameNumber: 0, stateVersion: 1,
      createdAt: FieldValue.serverTimestamp(), lastValidActionAt: FieldValue.serverTimestamp(),
      expiresAt, endedAt: null, interruptedAt: null,
    });
    tx.set(room.collection('members').doc(uid), {
      uid, displayName, role: 'host', seatId: 'seat1', joinOrder: 0,
      joinedAt: FieldValue.serverTimestamp(), leftAt: null,
    });
    tx.set(room.collection('seats').doc('seat1'), { seatId: 'seat1', seatIndex: 0, controllerType: 'human', occupantUid: uid });
    tx.set(room.collection('seats').doc('seat2'), { seatId: 'seat2', seatIndex: 1, controllerType: 'pending', occupantUid: null });
    tx.set(db.collection('moonScaleDuelRoomLocators').doc(invite.locator), { roomId, status: 'active', expiresAt });
    tx.set(db.collection('moonScaleDuelRoomSecrets').doc(roomId), {
      locator: invite.locator, inviteVersion: 1,
      inviteMac: mac(invite.locator, invite.secret, inviteSecret()),
      createRequestId: requestId, createdAt: FieldValue.serverTimestamp(),
    });
    tx.set(action, { uid, type: 'createRoom', payloadHash: hash, result: safeResult, createdAt: FieldValue.serverTimestamp(), expiresAt });
    return safeResult;
  });
  await grantPresence(result.roomId, uid);
  return { ...result, inviteCode: invite.code };
});

const joinRoom = onCall(callableOptions, async (request) => {
  const uid = uidOf(request);
  const requestId = requestIdOf(request);
  const displayName = cleanText(request.data?.displayName, 20, '表示名');
  const parsed = parseInviteCode(request.data?.inviteCode);
  if (!parsed) fail('invalid-argument', '招待コードが無効または期限切れです。');
  const hash = payloadHash('joinRoom', { displayName, locator: parsed.locator });
  const action = actionRef(uid, requestId);
  const previous = await action.get();
  if (previous.exists) return assertReplay(previous.data(), hash);
  const locatorRef = db.collection('moonScaleDuelRoomLocators').doc(parsed.locator);
  const locatorSnap = await locatorRef.get();
  if (!locatorSnap.exists) fail('not-found', '招待コードが無効または期限切れです。');
  const roomId = locatorSnap.data().roomId;
  const ipHash = hashIp(requestIp(request), ipSecret());
  await Promise.all([
    consumeRateLimit(`join_uid_${uid}`, 10, 600),
    consumeRateLimit(`join_ip_${ipHash}`, 30, 600),
    consumeRateLimit(`join_room_${roomId}`, 100, 600),
  ]);
  const result = await db.runTransaction(async (tx) => {
    const room = roomRef(roomId);
    const [actionSnap, locatorTx, roomSnap, secretSnap, memberSnap, seatSnap] = await Promise.all([
      tx.get(action), tx.get(locatorRef), tx.get(room),
      tx.get(db.collection('moonScaleDuelRoomSecrets').doc(roomId)),
      tx.get(room.collection('members').doc(uid)), tx.get(room.collection('seats').doc('seat2')),
    ]);
    if (actionSnap.exists) return assertReplay(actionSnap.data(), hash);
    if (!locatorTx.exists || locatorTx.data().roomId !== roomId || !hasValidExpiry(locatorTx.data()) ||
        !roomSnap.exists || !hasValidExpiry(roomSnap.data()) || !secretSnap.exists || roomSnap.data().status !== 'waiting') {
      fail('not-found', '招待コードが無効または期限切れです。');
    }
    if (!safeEqual(mac(parsed.locator, parsed.secret, inviteSecret()), secretSnap.data().inviteMac)) {
      fail('not-found', '招待コードが無効または期限切れです。');
    }
    if (memberSnap.exists && !memberSnap.data().leftAt) {
      const existing = { roomId, seatId: memberSnap.data().seatId, stateVersion: roomSnap.data().stateVersion };
      tx.set(action, { uid, type: 'joinRoom', payloadHash: hash, result: existing, createdAt: FieldValue.serverTimestamp(), expiresAt: roomSnap.data().expiresAt });
      return existing;
    }
    if (Number(roomSnap.data().humanCount) >= 2 || seatSnap.data()?.controllerType === 'human') fail('resource-exhausted', '部屋は満員です。');
    const nextVersion = Number(roomSnap.data().stateVersion) + 1;
    const safeResult = { roomId, seatId: 'seat2', stateVersion: nextVersion };
    tx.set(room.collection('members').doc(uid), {
      uid, displayName, role: 'guest', seatId: 'seat2', joinOrder: 1,
      joinedAt: FieldValue.serverTimestamp(), leftAt: null,
    });
    tx.update(room.collection('seats').doc('seat2'), { controllerType: 'human', occupantUid: uid });
    tx.update(room, { humanCount: 2, stateVersion: nextVersion, lastValidActionAt: FieldValue.serverTimestamp() });
    tx.set(action, { uid, type: 'joinRoom', payloadHash: hash, result: safeResult, createdAt: FieldValue.serverTimestamp(), expiresAt: roomSnap.data().expiresAt });
    return safeResult;
  });
  await grantPresence(roomId, uid);
  return result;
});

const startGame = onCall(callableOptions, async (request) => {
  const uid = uidOf(request);
  const requestId = requestIdOf(request);
  const roomId = roomIdOf(request);
  const stateVersion = Number(request.data?.stateVersion);
  if (!Number.isInteger(stateVersion) || stateVersion < 1) fail('invalid-argument', '状態番号が不正です。');
  const hash = payloadHash('startGame', { roomId, stateVersion });
  const action = actionRef(uid, requestId);
  const previous = await action.get();
  if (previous.exists) return assertReplay(previous.data(), hash);
  const gameId = randomId();
  const result = await db.runTransaction(async (tx) => {
    const room = roomRef(roomId);
    const [actionSnap, roomSnap, membersSnap, seatsSnap] = await Promise.all([
      tx.get(action), tx.get(room), tx.get(room.collection('members')), tx.get(room.collection('seats')),
    ]);
    if (actionSnap.exists) return assertReplay(actionSnap.data(), hash);
    if (!roomSnap.exists) fail('not-found', '部屋が見つかりません。');
    const roomData = roomSnap.data();
    if (roomData.hostUid !== uid) fail('permission-denied', 'ホストだけが開始できます。');
    if (roomData.status !== 'waiting' || !hasValidExpiry(roomData)) fail('failed-precondition', '開始できる状態ではありません。');
    if (roomData.stateVersion !== stateVersion) fail('failed-precondition', '画面の状態が更新されています。再読み込みしてください。');
    const activeMembers = membersSnap.docs.filter((doc) => !doc.data().leftAt);
    const occupiedSeats = seatsSnap.docs.filter((doc) => doc.data().controllerType === 'human');
    if (activeMembers.length !== 2 || occupiedSeats.length !== 2 || Number(roomData.humanCount) !== 2) fail('failed-precondition', '対手の参加を待っています。');
    const memberUids = new Set(activeMembers.map((doc) => doc.id));
    if (!occupiedSeats.every((doc) => memberUids.has(doc.data().occupantUid))) fail('failed-precondition', '席の状態が一致しません。');
    const nextVersion = stateVersion + 1;
    const expiresAt = expiresAtFromNow();
    const safeResult = { roomId, gameId, phase: 'selecting-card', round: 1, stateVersion: nextVersion };
    tx.set(room.collection('games').doc(gameId), {
      gameId, gameNumber: Number(roomData.gameNumber || 0) + 1,
      phase: 'selecting-card', round: 1, stateVersion: nextVersion,
      moonShadow: { seat1: 10, seat2: 10 }, remainingCardCounts: { seat1: 6, seat2: 6 },
      nextRoundReady: { seat1: false, seat2: false }, rematchReady: { seat1: false, seat2: false },
      publicCards: null, publicCopies: null, roundResult: null, history: [], deadline: null, result: null,
      startedAt: FieldValue.serverTimestamp(), lastValidActionAt: FieldValue.serverTimestamp(), expiresAt,
    });
    tx.set(room.collection('serverGames').doc(gameId), {
      gameId, phase: 'selecting-card', round: 1,
      usedCards: { seat1: [], seat2: [] }, privateSelections: { seat1: null, seat2: null },
      copyCandidates: { seat1: [], seat2: [] }, copySelections: { seat1: null, seat2: null },
      falseStatus: { seat1: null, seat2: null },
      publicResult: null, history: [], createdAt: FieldValue.serverTimestamp(),
    });
    for (const memberDoc of activeMembers) {
      tx.set(room.collection('privatePlayers').doc(memberDoc.id), {
        roomId, gameId, seatId: memberDoc.data().seatId,
        usedCards: [], submitted: false, legalCopyTargets: [], copySubmitted: false,
        selectedCopyTarget: null, updatedAt: FieldValue.serverTimestamp(),
      });
    }
    tx.update(room, {
      status: 'playing', gameId, gameNumber: Number(roomData.gameNumber || 0) + 1,
      stateVersion: nextVersion, lastValidActionAt: FieldValue.serverTimestamp(), expiresAt,
    });
    tx.set(action, { uid, type: 'startGame', payloadHash: hash, result: safeResult, createdAt: FieldValue.serverTimestamp(), expiresAt });
    return safeResult;
  });
  return result;
});

const submitCard = onCall(callableOptions, async (request) => {
  const uid = uidOf(request);
  const requestId = requestIdOf(request);
  const roomId = roomIdOf(request);
  const gameId = cleanText(request.data?.gameId, 80, 'ゲームID');
  const cardId = cleanText(request.data?.cardId, 30, '月札');
  const round = Number(request.data?.round);
  const stateVersion = Number(request.data?.stateVersion);
  if (!CARD_IDS.includes(cardId)) fail('invalid-argument', '使用できない月札です。');
  if (!Number.isInteger(round) || round < 1 || round > 6) fail('invalid-argument', 'ラウンド番号が不正です。');
  if (!Number.isInteger(stateVersion) || stateVersion < 1) fail('invalid-argument', '状態番号が不正です。');

  const hash = payloadHash('submitCard', { roomId, gameId, round, stateVersion, cardId });
  const action = actionRef(uid, requestId);
  const diagnostic = transactionDiagnostic('moonScaleDuelSubmitCard', roomId, gameId);
  let result;
  try {
    result = await db.runTransaction(async (tx) => {
      const attempt = diagnostic.beginAttempt();
      const room = roomRef(roomId);
      const game = room.collection('games').doc(gameId);
      const serverGame = room.collection('serverGames').doc(gameId);
      const member = room.collection('members').doc(uid);
      const privatePlayerRef = room.collection('privatePlayers').doc(uid);
      const [actionSnap, roomSnap, gameSnap, serverSnap, memberSnap, privateSnap] = await Promise.all([
        diagnostic.read(attempt, 'action', () => tx.get(action)),
        diagnostic.read(attempt, 'room', () => tx.get(room)),
        diagnostic.read(attempt, 'game', () => tx.get(game)),
        diagnostic.read(attempt, 'serverGame', () => tx.get(serverGame)),
        diagnostic.read(attempt, 'member', () => tx.get(member)),
        diagnostic.read(attempt, 'privatePlayer', () => tx.get(privatePlayerRef)),
      ]);
      if (actionSnap.exists) {
        const replay = assertReplay(actionSnap.data(), hash);
        diagnostic.callbackComplete(attempt, 'idempotent-replay');
        return replay;
      }
    if (!roomSnap.exists || roomSnap.data().status !== 'playing' || roomSnap.data().gameId !== gameId || !hasValidExpiry(roomSnap.data())) {
      fail('failed-precondition', 'この決闘には提出できません。');
    }
    if (!memberSnap.exists || memberSnap.data().leftAt) fail('permission-denied', 'この部屋には参加していません。');
    const seatId = memberSnap.data().seatId;
    if (!['seat1', 'seat2'].includes(seatId)) fail('permission-denied', '本人の席を確認できません。');
    if (!gameSnap.exists || !serverSnap.exists || !privateSnap.exists) fail('failed-precondition', 'ゲーム状態を確認できません。');
    const gameData = gameSnap.data();
    const serverData = serverSnap.data();
    const privateData = privateSnap.data();
    if (gameData.phase !== 'selecting-card' || serverData.phase !== 'selecting-card') fail('failed-precondition', '現在は月札を提出できません。');
    if (gameData.round !== round || serverData.round !== round) fail('failed-precondition', 'ラウンドが更新されています。');
    if (gameData.stateVersion !== stateVersion) fail('failed-precondition', '画面の状態が更新されています。再読み込みしてください。');
    if (privateData.roomId !== roomId || privateData.gameId !== gameId || privateData.seatId !== seatId) fail('permission-denied', '本人専用状態が一致しません。');
    const serverUsed = Array.isArray(serverData.usedCards?.[seatId]) ? serverData.usedCards[seatId] : [];
    const playerUsed = Array.isArray(privateData.usedCards) ? privateData.usedCards : [];
    if (serverUsed.includes(cardId) || playerUsed.includes(cardId)) fail('failed-precondition', 'この月札は使用済みです。');
    if (privateData.submitted === true || serverData.privateSelections?.[seatId]) fail('already-exists', 'このラウンドは提出済みです。');

    const selections = {
      seat1: serverData.privateSelections?.seat1 || null,
      seat2: serverData.privateSelections?.seat2 || null,
      [seatId]: { cardId, uid },
    };
    const expiresAt = expiresAtFromNow();
    const bothSubmitted = Boolean(selections.seat1 && selections.seat2);
    const nextVersion = bothSubmitted ? stateVersion + 1 : stateVersion;
    let nextPhase = 'selecting-card';
    let roundResult = null;
    let copyState = { candidates: { seat1: [], seat2: [] }, status: { seat1: null, seat2: null } };
    let publicCards = null;
    let usedCards = serverData.usedCards;
    if (bothSubmitted) {
      publicCards = { seat1: selections.seat1.cardId, seat2: selections.seat2.cardId };
      usedCards = {
        seat1: [...(serverData.usedCards?.seat1 || []), publicCards.seat1],
        seat2: [...(serverData.usedCards?.seat2 || []), publicCards.seat2],
      };
      copyState = prepareCopyState({ actualCards: publicCards, moonShadow: gameData.moonShadow, usedCards });
      nextPhase = Object.values(copyState.status).includes('awaiting') ? 'choosing-copy' : 'round-result';
      if (nextPhase === 'round-result') {
        roundResult = resolveRound({
          round, moonShadow: gameData.moonShadow, actualCards: publicCards,
          copyTargets: {}, falseStatus: copyState.status,
        });
        nextPhase = resolutionPhase(roundResult);
      }
    }
    const safeResult = {
      roomId, gameId, round, phase: nextPhase, stateVersion: nextVersion,
      submitted: true, revealed: bothSubmitted,
    };

    diagnostic.writePlan(attempt, bothSubmitted
      ? ['serverGame', 'privatePlayer', 'game', 'privatePlayers', 'room', 'action']
      : ['serverGame', 'privatePlayer', 'game', 'room', 'action']);
    tx.update(serverGame, {
      privateSelections: selections,
      usedCards,
      phase: nextPhase,
      copyCandidates: copyState.candidates,
      copySelections: { seat1: null, seat2: null },
      falseStatus: copyState.status,
      publicResult: roundResult,
      history: roundResult ? [...(serverData.history || []), roundResult] : (serverData.history || []),
    });
    tx.update(privatePlayerRef, { submitted: true, selectedCardId: cardId, updatedAt: FieldValue.serverTimestamp() });
    if (bothSubmitted) {
      const result = completionResult(roundResult);
      tx.update(game, {
        phase: nextPhase, stateVersion: nextVersion, publicCards,
        publicCopies: roundResult?.copyTargets || null,
        roundResult,
        history: roundResult ? [...(gameData.history || []), roundResult] : (gameData.history || []),
        result,
        moonShadow: roundResult?.moonShadowAfter || gameData.moonShadow,
        remainingCardCounts: { seat1: 6 - usedCards.seat1.length, seat2: 6 - usedCards.seat2.length },
        lastValidActionAt: FieldValue.serverTimestamp(), expiresAt,
      });
      for (const revealedSeat of ['seat1', 'seat2']) {
        const selection = selections[revealedSeat];
        tx.update(room.collection('privatePlayers').doc(selection.uid), {
          usedCards: usedCards[revealedSeat], submitted: true, selectedCardId: selection.cardId,
          legalCopyTargets: copyState.candidates[revealedSeat], copySubmitted: false, selectedCopyTarget: null,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      tx.update(room, {
        stateVersion: nextVersion,
        status: result ? 'ended' : 'playing',
        endedAt: result ? FieldValue.serverTimestamp() : null,
        lastValidActionAt: FieldValue.serverTimestamp(), expiresAt,
      });
    } else {
      tx.update(game, { lastValidActionAt: FieldValue.serverTimestamp(), expiresAt });
      tx.update(room, { lastValidActionAt: FieldValue.serverTimestamp(), expiresAt });
    }
    tx.set(action, {
      uid, type: 'submitCard', payloadHash: hash, result: safeResult,
      createdAt: FieldValue.serverTimestamp(), expiresAt,
    });
      diagnostic.callbackComplete(attempt);
      return safeResult;
    });
    diagnostic.success();
  } catch (error) {
    diagnostic.reject(error);
    throw error;
  }
  return result;
});

const submitCopyTarget = onCall(callableOptions, async (request) => {
  const uid = uidOf(request);
  const requestId = requestIdOf(request);
  const roomId = roomIdOf(request);
  const gameId = cleanText(request.data?.gameId, 80, 'ゲームID');
  const copyTargetId = cleanText(request.data?.copyTargetId, 30, '模倣先');
  const round = Number(request.data?.round);
  const stateVersion = Number(request.data?.stateVersion);
  if (!CARD_IDS.includes(copyTargetId)) fail('invalid-argument', '模倣できない月札です。');
  if (!Number.isInteger(round) || round < 1 || round > 6) fail('invalid-argument', 'ラウンド番号が不正です。');
  if (!Number.isInteger(stateVersion) || stateVersion < 1) fail('invalid-argument', '状態番号が不正です。');

  const hash = payloadHash('submitCopyTarget', { roomId, gameId, round, stateVersion, copyTargetId });
  const action = actionRef(uid, requestId);
  return db.runTransaction(async (tx) => {
    const room = roomRef(roomId);
    const game = room.collection('games').doc(gameId);
    const serverGame = room.collection('serverGames').doc(gameId);
    const member = room.collection('members').doc(uid);
    const ownPrivate = room.collection('privatePlayers').doc(uid);
    const [actionSnap, roomSnap, gameSnap, serverSnap, memberSnap, privateSnap] = await Promise.all([
      tx.get(action), tx.get(room), tx.get(game), tx.get(serverGame), tx.get(member), tx.get(ownPrivate),
    ]);
    if (actionSnap.exists) return assertReplay(actionSnap.data(), hash);
    if (!roomSnap.exists || roomSnap.data().status !== 'playing' || roomSnap.data().gameId !== gameId || !hasValidExpiry(roomSnap.data())) {
      fail('failed-precondition', 'この決闘には提出できません。');
    }
    if (!memberSnap.exists || memberSnap.data().leftAt) fail('permission-denied', 'この部屋には参加していません。');
    const seatId = memberSnap.data().seatId;
    if (!['seat1', 'seat2'].includes(seatId)) fail('permission-denied', '本人の席を確認できません。');
    if (!gameSnap.exists || !serverSnap.exists || !privateSnap.exists) fail('failed-precondition', 'ゲーム状態を確認できません。');
    const gameData = gameSnap.data();
    const serverData = serverSnap.data();
    const privateData = privateSnap.data();
    if (gameData.phase !== 'choosing-copy' || serverData.phase !== 'choosing-copy') fail('failed-precondition', '現在は模倣先を提出できません。');
    if (gameData.round !== round || serverData.round !== round) fail('failed-precondition', 'ラウンドが更新されています。');
    if (gameData.stateVersion !== stateVersion) fail('failed-precondition', '画面の状態が更新されています。再読み込みしてください。');
    if (privateData.roomId !== roomId || privateData.gameId !== gameId || privateData.seatId !== seatId) fail('permission-denied', '本人専用状態が一致しません。');
    const candidates = Array.isArray(serverData.copyCandidates?.[seatId]) ? serverData.copyCandidates[seatId] : [];
    if (serverData.falseStatus?.[seatId] !== 'awaiting' || !candidates.includes(copyTargetId)) fail('failed-precondition', 'その月札は模倣できません。');
    if (privateData.copySubmitted || serverData.copySelections?.[seatId]) fail('already-exists', '模倣先は提出済みです。');

    const selections = { seat1: serverData.copySelections?.seat1 || null, seat2: serverData.copySelections?.seat2 || null, [seatId]: copyTargetId };
    const requiredSeats = ['seat1', 'seat2'].filter((id) => serverData.falseStatus?.[id] === 'awaiting');
    const allSubmitted = requiredSeats.every((id) => CARD_IDS.includes(selections[id]));
    const expiresAt = expiresAtFromNow();
    const nextVersion = allSubmitted ? stateVersion + 1 : stateVersion;
    let roundResult = null;
    if (allSubmitted) {
      roundResult = resolveRound({
        round, moonShadow: gameData.moonShadow, actualCards: gameData.publicCards,
        copyTargets: selections, falseStatus: { ...serverData.falseStatus, ...Object.fromEntries(requiredSeats.map((id) => [id, 'copied'])) },
      });
    }
    const nextPhase = allSubmitted ? resolutionPhase(roundResult) : 'choosing-copy';
    const safeResult = { roomId, gameId, round, phase: nextPhase, stateVersion: nextVersion, submitted: true, resolved: allSubmitted };
    tx.update(ownPrivate, { copySubmitted: true, selectedCopyTarget: copyTargetId, updatedAt: FieldValue.serverTimestamp() });
    tx.update(serverGame, {
      copySelections: selections, phase: nextPhase,
      falseStatus: allSubmitted
        ? { ...serverData.falseStatus, ...Object.fromEntries(requiredSeats.map((id) => [id, 'copied'])) }
        : serverData.falseStatus,
      publicResult: roundResult,
      history: allSubmitted ? [...(serverData.history || []), roundResult] : (serverData.history || []),
    });
    if (allSubmitted) {
      const result = completionResult(roundResult);
      tx.update(game, {
        phase: nextPhase, stateVersion: nextVersion, publicCopies: roundResult.copyTargets,
        roundResult, moonShadow: roundResult.moonShadowAfter,
        history: [...(gameData.history || []), roundResult], result,
        lastValidActionAt: FieldValue.serverTimestamp(), expiresAt,
      });
      tx.update(room, {
        stateVersion: nextVersion,
        status: result ? 'ended' : 'playing',
        endedAt: result ? FieldValue.serverTimestamp() : null,
        lastValidActionAt: FieldValue.serverTimestamp(), expiresAt,
      });
    } else {
      tx.update(game, { lastValidActionAt: FieldValue.serverTimestamp(), expiresAt });
      tx.update(room, { lastValidActionAt: FieldValue.serverTimestamp(), expiresAt });
    }
    tx.set(action, { uid, type: 'submitCopyTarget', payloadHash: hash, result: safeResult, createdAt: FieldValue.serverTimestamp(), expiresAt });
    return safeResult;
  });
});

function roundActionInput(request) {
  const roomId = roomIdOf(request);
  const gameId = cleanText(request.data?.gameId, 80, 'ゲームID');
  const round = Number(request.data?.round);
  const stateVersion = Number(request.data?.stateVersion);
  if (!Number.isInteger(round) || round < 1 || round > 6) fail('invalid-argument', 'ラウンド番号が不正です。');
  if (!Number.isInteger(stateVersion) || stateVersion < 1) fail('invalid-argument', '状態番号が不正です。');
  return { roomId, gameId, round, stateVersion };
}

function verifyRoundWaitState({ roomData, gameData, serverData, memberData, privateData, input }) {
  if (!roomData || roomData.status !== 'playing' || roomData.gameId !== input.gameId || !hasValidExpiry(roomData)) {
    fail('failed-precondition', 'この決闘は進行中ではありません。');
  }
  const seatId = memberData?.seatId;
  if (!SEAT_IDS.includes(seatId) || memberData.leftAt) fail('permission-denied', 'この部屋には参加していません。');
  if (!gameData || !serverData || !privateData) fail('failed-precondition', 'ゲーム状態を確認できません。');
  if (gameData.phase !== 'round-result' || serverData.phase !== 'round-result') fail('failed-precondition', '現在は次ラウンド準備を行えません。');
  if (gameData.round !== input.round || serverData.round !== input.round) fail('failed-precondition', 'ラウンドが更新されています。');
  if (gameData.stateVersion !== input.stateVersion) fail('failed-precondition', '画面の状態が更新されています。再読み込みしてください。');
  if (gameData.result || gameData.roundResult?.outcome || input.round >= 6) fail('failed-precondition', '決闘は終了しています。');
  if (privateData.roomId !== input.roomId || privateData.gameId !== input.gameId || privateData.seatId !== seatId) {
    fail('permission-denied', '本人専用状態が一致しません。');
  }
  return seatId;
}

const readyNextRound = onCall(callableOptions, async (request) => {
  const uid = uidOf(request);
  const requestId = requestIdOf(request);
  const input = roundActionInput(request);
  const hash = payloadHash('readyNextRound', input);
  const action = actionRef(uid, requestId);
  const diagnostic = transactionDiagnostic('moonScaleDuelReadyNextRound', input.roomId, input.gameId);
  try {
    const result = await db.runTransaction(async (tx) => {
      const attempt = diagnostic.beginAttempt();
      const room = roomRef(input.roomId);
      const game = room.collection('games').doc(input.gameId);
      const serverGame = room.collection('serverGames').doc(input.gameId);
      const member = room.collection('members').doc(uid);
      const ownPrivate = room.collection('privatePlayers').doc(uid);
      const [actionSnap, roomSnap, gameSnap, serverSnap, memberSnap, privateSnap] = await Promise.all([
        diagnostic.read(attempt, 'action', () => tx.get(action)),
        diagnostic.read(attempt, 'room', () => tx.get(room)),
        diagnostic.read(attempt, 'game', () => tx.get(game)),
        diagnostic.read(attempt, 'serverGame', () => tx.get(serverGame)),
        diagnostic.read(attempt, 'member', () => tx.get(member)),
        diagnostic.read(attempt, 'privatePlayer', () => tx.get(ownPrivate)),
      ]);
      if (actionSnap.exists) {
        const replay = assertReplay(actionSnap.data(), hash);
        diagnostic.callbackComplete(attempt, 'idempotent-replay');
        return replay;
      }
    const gameData = gameSnap.data();
    const serverData = serverSnap.data();
    const seatId = verifyRoundWaitState({ roomData: roomSnap.data(), gameData, serverData, memberData: memberSnap.data(), privateData: privateSnap.data(), input });
    if (gameData.nextRoundReady?.[seatId]) fail('already-exists', '次ラウンドの準備は完了しています。');
    const other = seatId === 'seat1' ? 'seat2' : 'seat1';
    const ready = { seat1: gameData.nextRoundReady?.seat1 === true, seat2: gameData.nextRoundReady?.seat2 === true, [seatId]: true };
    const bothReady = ready[other] === true;
    const expiresAt = expiresAtFromNow();
    const nextVersion = bothReady ? input.stateVersion + 1 : input.stateVersion;
    const safeResult = { roomId: input.roomId, gameId: input.gameId, round: bothReady ? input.round + 1 : input.round, phase: bothReady ? 'selecting-card' : 'round-result', stateVersion: nextVersion, ready: true, advanced: bothReady };
    diagnostic.writePlan(attempt, bothReady
      ? ['game', 'serverGame', 'privatePlayers', 'room', 'action']
      : ['game', 'room', 'action']);
    if (bothReady) {
      const privateSelections = serverData.privateSelections || {};
      if (!SEAT_IDS.every((id) => privateSelections[id]?.uid)) fail('failed-precondition', '参加者状態を確認できません。');
      tx.update(game, {
        round: input.round + 1, phase: 'selecting-card', stateVersion: nextVersion,
        nextRoundReady: { seat1: false, seat2: false }, deadline: null,
        publicCards: null, publicCopies: null, roundResult: null,
        lastValidActionAt: FieldValue.serverTimestamp(), expiresAt,
      });
      tx.update(serverGame, {
        round: input.round + 1, phase: 'selecting-card',
        privateSelections: { seat1: null, seat2: null },
        copyCandidates: { seat1: [], seat2: [] }, copySelections: { seat1: null, seat2: null },
        falseStatus: { seat1: null, seat2: null }, publicResult: null,
      });
      for (const id of SEAT_IDS) {
        tx.update(room.collection('privatePlayers').doc(privateSelections[id].uid), {
          submitted: false, selectedCardId: null, legalCopyTargets: [], copySubmitted: false,
          selectedCopyTarget: null, updatedAt: FieldValue.serverTimestamp(),
        });
      }
      tx.update(room, { stateVersion: nextVersion, lastValidActionAt: FieldValue.serverTimestamp(), expiresAt });
    } else {
      const deadline = gameData.deadline || deadlineFromNow(NEXT_ROUND_WAIT_MILLIS);
      tx.update(game, { nextRoundReady: ready, deadline, lastValidActionAt: FieldValue.serverTimestamp(), expiresAt });
      tx.update(room, { lastValidActionAt: FieldValue.serverTimestamp(), expiresAt });
    }
    tx.set(action, { uid, type: 'readyNextRound', payloadHash: hash, result: safeResult, createdAt: FieldValue.serverTimestamp(), expiresAt });
      diagnostic.callbackComplete(attempt);
      return safeResult;
    });
    diagnostic.success();
    return result;
  } catch (error) {
    diagnostic.reject(error);
    throw error;
  }
});

function waitControlCallable(type, handler) {
  return onCall(callableOptions, async (request) => {
    const uid = uidOf(request);
    const requestId = requestIdOf(request);
    const input = roundActionInput(request);
    const hash = payloadHash(type, input);
    const action = actionRef(uid, requestId);
    return db.runTransaction(async (tx) => {
      const room = roomRef(input.roomId);
      const game = room.collection('games').doc(input.gameId);
      const serverGame = room.collection('serverGames').doc(input.gameId);
      const member = room.collection('members').doc(uid);
      const ownPrivate = room.collection('privatePlayers').doc(uid);
      const [actionSnap, roomSnap, gameSnap, serverSnap, memberSnap, privateSnap] = await Promise.all([
        tx.get(action), tx.get(room), tx.get(game), tx.get(serverGame), tx.get(member), tx.get(ownPrivate),
      ]);
      if (actionSnap.exists) return assertReplay(actionSnap.data(), hash);
      const gameData = gameSnap.data();
      const serverData = serverSnap.data();
      const seatId = verifyRoundWaitState({ roomData: roomSnap.data(), gameData, serverData, memberData: memberSnap.data(), privateData: privateSnap.data(), input });
      const other = seatId === 'seat1' ? 'seat2' : 'seat1';
      if (gameData.nextRoundReady?.[seatId] !== true || gameData.nextRoundReady?.[other] === true) fail('permission-denied', '待機中のプレイヤーだけが操作できます。');
      const deadlineMillis = gameData.deadline?.toMillis?.();
      if (!Number.isFinite(deadlineMillis) || deadlineMillis > Date.now()) fail('failed-precondition', '待機期限前には操作できません。');
      return handler({ tx, action, hash, uid, input, room, game, serverGame, gameData, serverData, seatId });
    });
  });
}

const extendNextRoundWait = waitControlCallable('extendNextRoundWait', ({ tx, action, hash, uid, input, room, game }) => {
  const nextVersion = input.stateVersion + 1;
  const expiresAt = expiresAtFromNow();
  const deadline = deadlineFromNow(WAIT_EXTENSION_MILLIS);
  const safeResult = { roomId: input.roomId, gameId: input.gameId, round: input.round, phase: 'round-result', stateVersion: nextVersion, deadlineMillis: deadline.toMillis() };
  tx.update(game, { stateVersion: nextVersion, deadline, lastValidActionAt: FieldValue.serverTimestamp(), expiresAt });
  tx.update(room, { stateVersion: nextVersion, lastValidActionAt: FieldValue.serverTimestamp(), expiresAt });
  tx.set(action, { uid, type: 'extendNextRoundWait', payloadHash: hash, result: safeResult, createdAt: FieldValue.serverTimestamp(), expiresAt });
  return safeResult;
});

const abortAfterWait = waitControlCallable('abortAfterWait', ({ tx, action, hash, uid, input, room, game, serverGame, gameData }) => {
  const nextVersion = input.stateVersion + 1;
  const expiresAt = expiresAtFromNow();
  const result = { type: 'aborted', reason: 'next-round-timeout', round: input.round };
  const safeResult = { roomId: input.roomId, gameId: input.gameId, round: input.round, phase: 'aborted', stateVersion: nextVersion, result };
  tx.update(game, { phase: 'aborted', stateVersion: nextVersion, result, deadline: null, interruptedAt: FieldValue.serverTimestamp(), expiresAt });
  tx.update(serverGame, { phase: 'aborted' });
  tx.update(room, { status: 'aborted', stateVersion: nextVersion, interruptedAt: FieldValue.serverTimestamp(), lastValidActionAt: FieldValue.serverTimestamp(), expiresAt });
  tx.set(action, { uid, type: 'abortAfterWait', payloadHash: hash, result: safeResult, createdAt: FieldValue.serverTimestamp(), expiresAt });
  return safeResult;
});

const requestRematch = onCall(callableOptions, async (request) => {
  const uid = uidOf(request);
  const requestId = requestIdOf(request);
  const input = rematchActionInput(request);
  const hash = payloadHash('requestRematch', input);
  const action = actionRef(uid, requestId);
  const newGameId = randomId();
  return db.runTransaction(async (tx) => {
    const room = roomRef(input.roomId);
    const game = room.collection('games').doc(input.gameId);
    const serverGame = room.collection('serverGames').doc(input.gameId);
    const member = room.collection('members').doc(uid);
    const seat1 = room.collection('seats').doc('seat1');
    const seat2 = room.collection('seats').doc('seat2');
    const [actionSnap, roomSnap, gameSnap, serverSnap, memberSnap, seat1Snap, seat2Snap] = await Promise.all([
      tx.get(action), tx.get(room), tx.get(game), tx.get(serverGame), tx.get(member), tx.get(seat1), tx.get(seat2),
    ]);
    if (actionSnap.exists) return assertReplay(actionSnap.data(), hash);
    const roomData = roomSnap.data();
    const gameData = gameSnap.data();
    const memberData = memberSnap.data();
    if (!roomSnap.exists || roomData.status !== 'ended' || roomData.gameId !== input.gameId || !hasValidExpiry(roomData)) {
      fail('failed-precondition', 'この決闘では再戦できません。');
    }
    if (!gameSnap.exists || !serverSnap.exists || gameData.phase !== 'ended' || gameData.result?.type !== 'completed') {
      fail('failed-precondition', '通常終了した決闘だけ再戦できます。');
    }
    if (gameData.stateVersion !== input.stateVersion || roomData.stateVersion !== input.stateVersion) {
      fail('failed-precondition', '画面の状態が更新されています。再読み込みしてください。');
    }
    const seatId = memberData?.seatId;
    if (!SEAT_IDS.includes(seatId) || memberData.leftAt) fail('permission-denied', 'この部屋には参加していません。');
    const seatData = { seat1: seat1Snap.data(), seat2: seat2Snap.data() };
    if (!SEAT_IDS.every((id) => seatData[id]?.controllerType === 'human' && seatData[id]?.occupantUid)) {
      fail('failed-precondition', '参加者状態を確認できません。');
    }
    if (seatData[seatId].occupantUid !== uid) fail('permission-denied', '本人の席を確認できません。');
    if (gameData.rematchReady?.[seatId]) fail('already-exists', '再戦希望は送信済みです。');

    const privateRefs = Object.fromEntries(SEAT_IDS.map((id) => [id, room.collection('privatePlayers').doc(seatData[id].occupantUid)]));
    const privateSnaps = await Promise.all(SEAT_IDS.map((id) => tx.get(privateRefs[id])));
    if (privateSnaps.some((snap) => !snap.exists)) fail('failed-precondition', '参加者状態を確認できません。');
    const otherSeat = seatId === 'seat1' ? 'seat2' : 'seat1';
    const rematchReady = {
      seat1: gameData.rematchReady?.seat1 === true,
      seat2: gameData.rematchReady?.seat2 === true,
      [seatId]: true,
    };
    const startsNewGame = rematchReady[otherSeat] === true;
    const expiresAt = expiresAtFromNow();
    const nextVersion = startsNewGame ? input.stateVersion + 1 : input.stateVersion;
    const nextGameNumber = Number(roomData.gameNumber || gameData.gameNumber || 0) + 1;
    const safeResult = {
      roomId: input.roomId,
      gameId: startsNewGame ? newGameId : input.gameId,
      previousGameId: startsNewGame ? input.gameId : null,
      phase: startsNewGame ? 'selecting-card' : 'ended',
      round: startsNewGame ? 1 : Number(gameData.round),
      stateVersion: nextVersion,
      requested: true,
      started: startsNewGame,
    };

    if (startsNewGame) {
      tx.update(game, { rematchReady });
      tx.set(room.collection('games').doc(newGameId), {
        gameId: newGameId, gameNumber: nextGameNumber,
        phase: 'selecting-card', round: 1, stateVersion: nextVersion,
        moonShadow: { seat1: 10, seat2: 10 }, remainingCardCounts: { seat1: 6, seat2: 6 },
        nextRoundReady: { seat1: false, seat2: false }, rematchReady: { seat1: false, seat2: false },
        publicCards: null, publicCopies: null, roundResult: null, history: [], deadline: null, result: null,
        startedAt: FieldValue.serverTimestamp(), lastValidActionAt: FieldValue.serverTimestamp(), expiresAt,
      });
      tx.set(room.collection('serverGames').doc(newGameId), {
        gameId: newGameId, phase: 'selecting-card', round: 1,
        usedCards: { seat1: [], seat2: [] }, privateSelections: { seat1: null, seat2: null },
        copyCandidates: { seat1: [], seat2: [] }, copySelections: { seat1: null, seat2: null },
        falseStatus: { seat1: null, seat2: null }, publicResult: null, history: [],
        createdAt: FieldValue.serverTimestamp(),
      });
      for (const id of SEAT_IDS) {
        tx.set(privateRefs[id], {
          roomId: input.roomId, gameId: newGameId, seatId: id, usedCards: [], submitted: false,
          selectedCardId: null, legalCopyTargets: [], copySubmitted: false, selectedCopyTarget: null,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      tx.update(room, {
        status: 'playing', gameId: newGameId, gameNumber: nextGameNumber, stateVersion: nextVersion,
        endedAt: null, interruptedAt: null, lastValidActionAt: FieldValue.serverTimestamp(), expiresAt,
      });
    } else {
      tx.update(game, { rematchReady });
    }
    tx.set(action, {
      uid, type: 'requestRematch', payloadHash: hash, result: safeResult,
      createdAt: FieldValue.serverTimestamp(), expiresAt,
    });
    return safeResult;
  });
});

const cancelRematch = onCall(callableOptions, async (request) => {
  const uid = uidOf(request);
  const requestId = requestIdOf(request);
  const input = rematchActionInput(request);
  const hash = payloadHash('cancelRematch', input);
  const action = actionRef(uid, requestId);
  return db.runTransaction(async (tx) => {
    const room = roomRef(input.roomId);
    const game = room.collection('games').doc(input.gameId);
    const member = room.collection('members').doc(uid);
    const ownSeat = room.collection('seats').doc('seat1');
    const otherSeat = room.collection('seats').doc('seat2');
    const [actionSnap, roomSnap, gameSnap, memberSnap, seat1Snap, seat2Snap] = await Promise.all([
      tx.get(action), tx.get(room), tx.get(game), tx.get(member), tx.get(ownSeat), tx.get(otherSeat),
    ]);
    if (actionSnap.exists) return assertReplay(actionSnap.data(), hash);
    const roomData = roomSnap.data();
    const gameData = gameSnap.data();
    const memberData = memberSnap.data();
    if (!roomSnap.exists || roomData.status !== 'ended' || roomData.gameId !== input.gameId || !hasValidExpiry(roomData)) {
      fail('failed-precondition', 'この決闘の再戦希望は取り消せません。');
    }
    if (!gameSnap.exists || gameData.phase !== 'ended' || gameData.result?.type !== 'completed') {
      fail('failed-precondition', '通常終了した決闘だけ操作できます。');
    }
    if (gameData.stateVersion !== input.stateVersion || roomData.stateVersion !== input.stateVersion) {
      fail('failed-precondition', '画面の状態が更新されています。再読み込みしてください。');
    }
    const seatId = memberData?.seatId;
    if (!SEAT_IDS.includes(seatId) || memberData.leftAt) fail('permission-denied', 'この部屋には参加していません。');
    const seatSnap = seatId === 'seat1' ? seat1Snap : seat2Snap;
    if (!seatSnap.exists || seatSnap.data().occupantUid !== uid) fail('permission-denied', '本人の席を確認できません。');
    if (gameData.rematchReady?.[seatId] !== true) fail('failed-precondition', '再戦希望は送信されていません。');
    const rematchReady = {
      seat1: gameData.rematchReady?.seat1 === true,
      seat2: gameData.rematchReady?.seat2 === true,
      [seatId]: false,
    };
    const expiresAt = expiresAtFromNow();
    const safeResult = { ...input, phase: 'ended', requested: false, cancelled: true };
    tx.update(game, { rematchReady });
    tx.set(action, {
      uid, type: 'cancelRematch', payloadHash: hash, result: safeResult,
      createdAt: FieldValue.serverTimestamp(), expiresAt,
    });
    return safeResult;
  });
});

const getSnapshot = onCall(callableOptions, async (request) => {
  const uid = uidOf(request);
  const roomId = roomIdOf(request);
  const member = await requireMember(roomId, uid);
  const roomSnap = await roomRef(roomId).get();
  const room = roomSnap.data();
  const [membersSnap, seatsSnap, privateSnap, secretSnap] = await Promise.all([
    roomSnap.ref.collection('members').get(),
    roomSnap.ref.collection('seats').orderBy('seatIndex').get(),
    roomSnap.ref.collection('privatePlayers').doc(uid).get(),
    member.role === 'host' && room.status === 'waiting' ? db.collection('moonScaleDuelRoomSecrets').doc(roomId).get() : Promise.resolve(null),
  ]);
  const activeMembers = membersSnap.docs
    .filter((doc) => !doc.data().leftAt)
    .map((doc) => doc.data())
    .sort((left, right) => Number(left.joinOrder) - Number(right.joinOrder));
  const membersBySeat = Object.fromEntries(activeMembers.map((item) => [item.seatId, item]));
  let gameData = null;
  if (room.gameId) gameData = (await roomSnap.ref.collection('games').doc(room.gameId).get()).data() || null;
  let inviteCode = null;
  if (secretSnap?.exists) {
    const secret = secretSnap.data();
    const invite = createInviteCode(uid, secret.createRequestId, inviteSecret());
    if (invite.locator === secret.locator) inviteCode = invite.code;
  }
  return {
    room: publicRoom(roomId, room),
    you: publicMember(member),
    members: activeMembers.map((item) => publicMember(item)),
    seats: seatsSnap.docs.map((doc) => publicSeat(doc.data(), membersBySeat)),
    game: publicGame(gameData),
    private: privateSnap.exists ? privatePlayer(privateSnap.data()) : null,
    inviteCode,
  };
});

module.exports = {
  createRoom, joinRoom, getSnapshot, startGame, submitCard, submitCopyTarget,
  readyNextRound, extendNextRoundWait, abortAfterWait, requestRematch, cancelRematch,
  _test: {
    CARD_IDS, publicRoom, publicGame, privatePlayer, publicRoundResult, publicHistory,
    createInviteCode, parseInviteCode, hasValidExpiry, completionResult, publicFinalResult, resolutionPhase,
    NEXT_ROUND_WAIT_MILLIS, WAIT_EXTENSION_MILLIS,
  },
};

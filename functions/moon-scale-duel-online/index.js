'use strict';

const { getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getDatabase } = require('firebase-admin/database');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const crypto = require('node:crypto');
const { createInviteCode, parseInviteCode, mac, safeEqual, hashIp } = require('./invite-code');

if (!getApps().length) initializeApp();
const db = getFirestore();
const rtdb = getDatabase();
const inviteKey = defineSecret('MOON_SCALE_DUEL_INVITE_HMAC_KEY');
const ipKey = defineSecret('MOON_SCALE_DUEL_IP_HMAC_KEY');
const REGION = 'asia-northeast1';
const ROOM_TTL_MILLIS = 24 * 60 * 60 * 1000;
const CARD_IDS = Object.freeze(['waxing', 'waning', 'reflection', 'stillness', 'falseMoon', 'oath']);

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
function payloadHash(type, payload) {
  return crypto.createHash('sha256').update(JSON.stringify({ type, ...payload })).digest('base64url');
}
function expiresAtFromNow() { return Timestamp.fromMillis(Date.now() + ROOM_TTL_MILLIS); }
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
    result: data.result,
    publicCards: data.phase === 'cards-revealed' && data.publicCards
      ? { seat1: data.publicCards.seat1, seat2: data.publicCards.seat2 }
      : null,
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
  };
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
      publicCards: null, deadline: null, result: null,
      startedAt: FieldValue.serverTimestamp(), lastValidActionAt: FieldValue.serverTimestamp(), expiresAt,
    });
    tx.set(room.collection('serverGames').doc(gameId), {
      gameId, phase: 'selecting-card', round: 1,
      usedCards: { seat1: [], seat2: [] }, privateSelections: { seat1: null, seat2: null },
      publicResult: null, createdAt: FieldValue.serverTimestamp(),
    });
    for (const memberDoc of activeMembers) {
      tx.set(room.collection('privatePlayers').doc(memberDoc.id), {
        roomId, gameId, seatId: memberDoc.data().seatId,
        usedCards: [], submitted: false, legalCopyTargets: [], updatedAt: FieldValue.serverTimestamp(),
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
  const result = await db.runTransaction(async (tx) => {
    const room = roomRef(roomId);
    const game = room.collection('games').doc(gameId);
    const serverGame = room.collection('serverGames').doc(gameId);
    const member = room.collection('members').doc(uid);
    const privatePlayerRef = room.collection('privatePlayers').doc(uid);
    const [actionSnap, roomSnap, gameSnap, serverSnap, memberSnap, privateSnap] = await Promise.all([
      tx.get(action), tx.get(room), tx.get(game), tx.get(serverGame), tx.get(member), tx.get(privatePlayerRef),
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
    const safeResult = { roomId, gameId, round, phase: bothSubmitted ? 'cards-revealed' : 'selecting-card', stateVersion: nextVersion, submitted: true, revealed: bothSubmitted };

    tx.update(serverGame, {
      privateSelections: selections,
      phase: bothSubmitted ? 'cards-revealed' : 'selecting-card',
      publicResult: bothSubmitted ? { round, cards: { seat1: selections.seat1.cardId, seat2: selections.seat2.cardId } } : null,
    });
    tx.update(privatePlayerRef, { submitted: true, selectedCardId: cardId, updatedAt: FieldValue.serverTimestamp() });
    if (bothSubmitted) {
      const publicCards = { seat1: selections.seat1.cardId, seat2: selections.seat2.cardId };
      const usedCards = {
        seat1: [...(serverData.usedCards?.seat1 || []), publicCards.seat1],
        seat2: [...(serverData.usedCards?.seat2 || []), publicCards.seat2],
      };
      tx.update(serverGame, { usedCards });
      tx.update(game, {
        phase: 'cards-revealed', stateVersion: nextVersion, publicCards,
        remainingCardCounts: { seat1: 6 - usedCards.seat1.length, seat2: 6 - usedCards.seat2.length },
        lastValidActionAt: FieldValue.serverTimestamp(), expiresAt,
      });
      for (const revealedSeat of ['seat1', 'seat2']) {
        const selection = selections[revealedSeat];
        tx.update(room.collection('privatePlayers').doc(selection.uid), {
          usedCards: usedCards[revealedSeat], submitted: true, selectedCardId: selection.cardId,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      tx.update(room, { stateVersion: nextVersion, lastValidActionAt: FieldValue.serverTimestamp(), expiresAt });
    } else {
      tx.update(game, { lastValidActionAt: FieldValue.serverTimestamp(), expiresAt });
      tx.update(room, { lastValidActionAt: FieldValue.serverTimestamp(), expiresAt });
    }
    tx.set(action, {
      uid, type: 'submitCard', payloadHash: hash, result: safeResult,
      createdAt: FieldValue.serverTimestamp(), expiresAt,
    });
    return safeResult;
  });
  return result;
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
  createRoom, joinRoom, getSnapshot, startGame, submitCard,
  _test: { CARD_IDS, publicRoom, publicGame, privatePlayer, createInviteCode, parseInviteCode, hasValidExpiry },
};

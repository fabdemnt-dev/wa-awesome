'use strict';

const { getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getDatabase } = require('firebase-admin/database');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const crypto = require('node:crypto');
const { createInviteCode, parseInviteCode, mac, safeEqual, hashIp } = require('./invite-code');
const { CARDS, dealHand, chooseField, chooseNpcCard, resolveRound } = require('./game-core');

if (!getApps().length) initializeApp();
const db = getFirestore();
const rtdb = getDatabase();
const inviteKey = defineSecret('SHADOW_CARD_INVITE_HMAC_KEY');
const ipKey = defineSecret('SHADOW_CARD_IP_HMAC_KEY');
const REGION = 'asia-northeast1';
const ROUND_SECONDS = process.env.FUNCTIONS_EMULATOR === 'true' && process.env.SHADOW_CARD_TEST_ROUND_SECONDS
  ? Math.max(1, Number(process.env.SHADOW_CARD_TEST_ROUND_SECONDS)) : 90;
const ROOM_TTL_HOURS = 24;

const callableOptions = {
  region: REGION,
  cors: ['https://fabdemnt-dev.github.io', /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/],
  minInstances: 0,
  maxInstances: 5,
  // Initial release: keep App Check monitoring-only; enforce it in a separate PR after Provider registration and real-device token verification.
  enforceAppCheck: false,
  secrets: [inviteKey, ipKey],
};
const schedulerOptions = { region: REGION, minInstances: 0, maxInstances: 2, secrets: [inviteKey, ipKey] };

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
function keyValue(secret, fallback) {
  try { return secret.value() || fallback; } catch { return fallback; }
}
function inviteSecret() { return keyValue(inviteKey, 'emulator-shadow-card-invite-key'); }
function ipSecret() { return keyValue(ipKey, 'emulator-shadow-card-ip-key'); }
function requestIp(request) { return request.rawRequest?.ip || request.rawRequest?.socket?.remoteAddress || 'unknown'; }
function randomId() { return crypto.randomUUID(); }
function roomRef(roomId) { return db.collection('shadowCardRooms').doc(roomId); }

function hasValidExpiry(data, nowMillis = Date.now()) {
  const expiresAt = data?.expiresAt;
  if (!expiresAt || typeof expiresAt.toMillis !== 'function') return false;
  try {
    const expiresAtMillis = expiresAt.toMillis();
    return Number.isFinite(expiresAtMillis) && expiresAtMillis > nowMillis;
  } catch {
    return false;
  }
}

async function requireMember(roomId, uid) {
  const member = await roomRef(roomId).collection('members').doc(uid).get();
  if (!member.exists || member.data().leftAt) fail('permission-denied', 'このルームには参加していません。');
  return member.data();
}

async function consumeRateLimit(key, limit, windowSeconds) {
  const ref = db.collection('shadowCardRateLimits').doc(key);
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    const now = Date.now();
    const current = snap.exists ? snap.data() : null;
    const windowStart = current?.windowStart?.toMillis?.() || 0;
    const elapsedMillis = now - windowStart;
    const withinWindow = elapsedMillis < windowSeconds * 1000;
    const count = withinWindow ? Number(current?.count || 0) : 0;
    if (count >= limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((windowSeconds * 1000 - elapsedMillis) / 1000));
      const retryAfterMinutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
      fail('resource-exhausted', `試行回数が多すぎます。あと${retryAfterMinutes}分ほど待ってからもう一度お試しください。`);
    }
    transaction.set(ref, {
      count: count + 1,
      windowStart: count === 0 ? Timestamp.fromMillis(now) : current.windowStart,
      expiresAt: Timestamp.fromMillis(now + windowSeconds * 2000),
    });
  });
}

async function grantPresence(roomId, uid) {
  await rtdb.ref(`shadowCardRoomAccess/${roomId}/${uid}`).set(true);
}

async function createRound(roomId, gameId, roundNumber, penalties) {
  const room = roomRef(roomId);
  const game = room.collection('games').doc(gameId);
  const serverRound = room.collection('serverRounds').doc(String(roundNumber));
  const publicRound = room.collection('rounds').doc(String(roundNumber));
  const gameData = (await game.get()).data();
  const seatSnaps = await room.collection('seats').orderBy('seatIndex').get();
  const seats = Object.fromEntries(seatSnaps.docs.map((doc) => [doc.id, doc.data()]));
  const hands = Object.fromEntries(Object.keys(seats).map((seatId) => [seatId, dealHand()]));
  const field = chooseField();
  const previous = roundNumber > 1 ? (await room.collection('results').doc(String(roundNumber - 1)).get()).data() : null;
  const typeCounts = (hand) => hand.reduce((a,id)=>(a[CARDS[id].type]++,a),{offense:0,support:0,interference:0,disruption:0});
  const choices = {};
  Object.entries(seats).forEach(([seatId, seat]) => {
    if (seat.controllerType === 'npc') {
      const team=seat.team, teammate=Object.values(seats).find(s=>s.team===team&&s.controllerType==='human');
      const opponentNpcIds=Object.values(seats).filter(s=>s.team!==team&&s.controllerType==='npc').map(s=>s.npcRole);
      const prevPlayed=previous?.played||{}; const previousCardId=prevPlayed[seatId]?.cardId||null;
      const opponentPreviousInterferenceCount=Object.entries(prevPlayed).filter(([id,c])=>seats[id]?.team!==team&&c.type==='interference').length;
      const gameScores=gameData.scores||{A:0,B:0};
      const context={side:'ally',fieldPoints:field.points,ownScore:gameScores[team],opposingScore:gameScores[team==='A'?'B':'A'],opponentNpcIds,currentPenalty:penalties[team]||0,opponentPreviousInterferenceCount,previousCardId,playerTypeCounts:teammate?typeCounts(hands[teammate.seatId]):{}};
      choices[seatId] = { handIndex: chooseNpcCard(hands[seatId], seat.npcRole, context), automatic: false, npc: true };
    }
  });
  const deadline = Timestamp.fromMillis(Date.now() + ROUND_SECONDS * 1000);
  const batch = db.batch();
  batch.set(serverRound, { roundNumber, hands, choices, penalties, field, resolved: false, createdAt: FieldValue.serverTimestamp() });
  batch.set(publicRound, { roundNumber, field, phase: 'choosing', submittedSeats: Object.keys(choices).length, requiredSeats: 4, deadline, revealed: false });
  Object.entries(seats).forEach(([seatId, seat]) => {
    if (seat.controllerType !== 'human') return;
    batch.set(room.collection('privatePlayers').doc(seat.occupantUid).collection('rounds').doc(String(roundNumber)), {
      roomId, gameId, roundNumber, seatId, hand: hands[seatId], submitted: false, selectedHandIndex: null, automatic: false,
    });
  });
  batch.update(game, { phase: 'choosing', roundNumber, currentPenalties: penalties, stateVersion: FieldValue.increment(1) });
  batch.update(room, { status: 'playing', stateVersion: FieldValue.increment(1), lastActivityAt: FieldValue.serverTimestamp() });
  await batch.commit();
}

async function resolveIfReady(roomId, gameId, roundNumber) {
  const room = roomRef(roomId);
  const serverRef = room.collection('serverRounds').doc(String(roundNumber));
  const publicRef = room.collection('rounds').doc(String(roundNumber));
  const gameRef = room.collection('games').doc(gameId);
  const resultRef = room.collection('results').doc(String(roundNumber));
  return db.runTransaction(async (tx) => {
    const [serverSnap, gameSnap] = await Promise.all([tx.get(serverRef), tx.get(gameRef)]);
    if (!serverSnap.exists || !gameSnap.exists) fail('not-found', 'ラウンドが見つかりません。');
    const server = serverSnap.data();
    if (server.resolved) return { resolved: true, alreadyResolved: true };
    if (Object.keys(server.choices || {}).length !== 4) return { resolved: false };
    const result = resolveRound({ hands: server.hands, choices: server.choices, penalties: server.penalties, roundNumber, field: server.field });
    const game = gameSnap.data();
    const scores = { ...game.scores };
    if (result.outcome !== 'draw') scores[result.outcome] += server.field.points;
    tx.update(serverRef, { resolved: true, resolvedAt: FieldValue.serverTimestamp(), result });
    tx.update(publicRef, { phase: 'resolved', submittedSeats: 4, revealed: true, resolvedAt: FieldValue.serverTimestamp() });
    tx.set(resultRef, { ...result, roundNumber, scoresAfter: scores, publishedAt: FieldValue.serverTimestamp() });
    tx.update(gameRef, { phase: roundNumber >= 5 ? 'finished' : 'round-result', scores, nextPenalties: result.nextPenalties, stateVersion: FieldValue.increment(1) });
    tx.update(room, { status: roundNumber >= 5 ? 'finished' : 'playing', stateVersion: FieldValue.increment(1), lastActivityAt: FieldValue.serverTimestamp() });
    return { resolved: true, outcome: result.outcome, scores };
  });
}

const createRoom = onCall(callableOptions, async (request) => {
  const uid = uidOf(request);
  const displayName = cleanText(request.data?.displayName, 20, '表示名');
  const ipHash = hashIp(requestIp(request), ipSecret());
  await Promise.all([consumeRateLimit(`create_uid_${uid}`, 10, 600), consumeRateLimit(`create_ip_${ipHash}`, 30, 600)]);
  const roomId = randomId();
  let invite;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    invite = createInviteCode();
    const locatorRef = db.collection('shadowCardRoomLocators').doc(invite.locator);
    const available = await db.runTransaction(async (tx) => {
      const existing = await tx.get(locatorRef);
      if (existing.exists) return false;
      const expiresAt = Timestamp.fromMillis(Date.now() + ROOM_TTL_HOURS * 3600_000);
      tx.set(roomRef(roomId), { status: 'waiting', hostUid: uid, humanLimit: 2, gameId: null, stateVersion: 1, gameVersion: 1, createdAt: FieldValue.serverTimestamp(), lastActivityAt: FieldValue.serverTimestamp(), expiresAt });
      tx.set(roomRef(roomId).collection('members').doc(uid), { uid, displayName, role: 'host', seatId: 'seat0', joinedAt: FieldValue.serverTimestamp(), leftAt: null });
      ['seat0', 'seat1', 'seat2', 'seat3'].forEach((seatId, index) => tx.set(roomRef(roomId).collection('seats').doc(seatId), {
        seatId, seatIndex: index, team: index < 2 ? 'A' : 'B', controllerType: index === 0 ? 'human' : 'pending', occupantUid: index === 0 ? uid : null, npcRole: null,
      }));
      tx.set(locatorRef, { roomId, status: 'active', expiresAt });
      tx.set(db.collection('shadowCardRoomSecrets').doc(roomId), { locator: invite.locator, inviteVersion: 1, inviteMac: mac(invite.locator, invite.secret, inviteSecret()), createdAt: FieldValue.serverTimestamp() });
      return true;
    });
    if (available) break;
    invite = null;
  }
  if (!invite) fail('aborted', '招待コードを作成できませんでした。');
  await grantPresence(roomId, uid);
  return { roomId, inviteCode: invite.code, seatId: 'seat0', stateVersion: 1 };
});

const joinRoom = onCall(callableOptions, async (request) => {
  const uid = uidOf(request);
  const displayName = cleanText(request.data?.displayName, 20, '表示名');
  const parsed = parseInviteCode(request.data?.inviteCode);
  if (!parsed) fail('invalid-argument', '招待コードが無効または期限切れです。');
  const locatorRef = db.collection('shadowCardRoomLocators').doc(parsed.locator);
  const locatorSnap = await locatorRef.get();
  if (!locatorSnap.exists) fail('not-found', '招待コードが無効または期限切れです。');
  const roomId = locatorSnap.data().roomId;
  if (typeof roomId !== 'string' || !roomId) fail('not-found', '招待コードが無効または期限切れです。');
  const ipHash = hashIp(requestIp(request), ipSecret());
  await Promise.all([
    consumeRateLimit(`join_uid_${uid}`, 10, 600),
    consumeRateLimit(`join_ip_${ipHash}`, 30, 600),
    consumeRateLimit(`join_room_${roomId}`, 100, 600),
  ]);
  await db.runTransaction(async (tx) => {
    const [locatorTxSnap, roomSnap, secretSnap, memberSnap] = await Promise.all([
      tx.get(locatorRef), tx.get(roomRef(roomId)), tx.get(db.collection('shadowCardRoomSecrets').doc(roomId)), tx.get(roomRef(roomId).collection('members').doc(uid)),
    ]);
    if (!locatorTxSnap.exists || locatorTxSnap.data().roomId !== roomId || !hasValidExpiry(locatorTxSnap.data()) || !roomSnap.exists || !hasValidExpiry(roomSnap.data()) || !secretSnap.exists || roomSnap.data().status !== 'waiting') fail('not-found', '招待コードが無効または期限切れです。');
    if (!safeEqual(mac(parsed.locator, parsed.secret, inviteSecret()), secretSnap.data().inviteMac)) fail('not-found', '招待コードが無効または期限切れです。');
    if (memberSnap.exists && !memberSnap.data().leftAt) return;
    const seatRef = roomRef(roomId).collection('seats').doc('seat2');
    const seatSnap = await tx.get(seatRef);
    if (seatSnap.data()?.controllerType === 'human') fail('resource-exhausted', 'ルームは満員です。');
    tx.set(roomRef(roomId).collection('members').doc(uid), { uid, displayName, role: 'guest', seatId: 'seat2', joinedAt: FieldValue.serverTimestamp(), leftAt: null });
    tx.update(seatRef, { controllerType: 'human', occupantUid: uid, npcRole: null });
    tx.update(roomRef(roomId), { stateVersion: FieldValue.increment(1), lastActivityAt: FieldValue.serverTimestamp() });
  });
  await grantPresence(roomId, uid);
  return { roomId, seatId: 'seat2' };
});

const startGame = onCall(callableOptions, async (request) => {
  const uid = uidOf(request);
  const roomId = cleanText(request.data?.roomId, 80, 'ルームID');
  const gameId = randomId();
  await db.runTransaction(async (tx) => {
    const roomSnap = await tx.get(roomRef(roomId));
    if (!roomSnap.exists) fail('not-found', 'ルームが見つかりません。');
    const room = roomSnap.data();
    if (room.hostUid !== uid) fail('permission-denied', 'ホストだけが開始できます。');
    if (room.status !== 'waiting') fail('failed-precondition', '開始できる状態ではありません。');
    const guestSeat = await tx.get(roomRef(roomId).collection('seats').doc('seat2'));
    if (guestSeat.data()?.controllerType !== 'human') fail('failed-precondition', '対戦相手を待っています。');
    tx.update(roomRef(roomId).collection('seats').doc('seat1'), { controllerType: 'npc', npcRole: 'support' });
    tx.update(roomRef(roomId).collection('seats').doc('seat3'), { controllerType: 'npc', npcRole: 'aggressive' });
    tx.set(roomRef(roomId).collection('games').doc(gameId), { gameId, phase: 'starting', roundNumber: 0, scores: { A: 0, B: 0 }, currentPenalties: { A: 0, B: 0 }, nextPenalties: { A: 0, B: 0 }, stateVersion: 1, startedAt: FieldValue.serverTimestamp() });
    tx.update(roomRef(roomId), { status: 'playing', gameId, stateVersion: FieldValue.increment(1) });
  });
  await createRound(roomId, gameId, 1, { A: 0, B: 0 });
  return { roomId, gameId, roundNumber: 1 };
});

const submitChoice = onCall(callableOptions, async (request) => {
  const uid = uidOf(request);
  const roomId = cleanText(request.data?.roomId, 80, 'ルームID');
  const gameId = cleanText(request.data?.gameId, 80, 'ゲームID');
  const roundNumber = Number(request.data?.roundNumber);
  const handIndex = Number(request.data?.handIndex);
  const requestId = cleanText(request.data?.requestId, 80, 'リクエストID');
  const stateVersion = Number(request.data?.stateVersion);
  if (!Number.isInteger(roundNumber) || roundNumber < 1 || roundNumber > 5 || !Number.isInteger(handIndex) || handIndex < 0 || handIndex > 3) fail('invalid-argument', 'カード選択が不正です。');
  const member = await requireMember(roomId, uid);
  const actionRef = db.collection('shadowCardActionRequests').doc(`${uid}_${requestId}`);
  await db.runTransaction(async (tx) => {
    const [action, gameSnap, serverSnap, privateSnap] = await Promise.all([
      tx.get(actionRef), tx.get(roomRef(roomId).collection('games').doc(gameId)), tx.get(roomRef(roomId).collection('serverRounds').doc(String(roundNumber))), tx.get(roomRef(roomId).collection('privatePlayers').doc(uid).collection('rounds').doc(String(roundNumber))),
    ]);
    if (action.exists) return;
    if (!gameSnap.exists || gameSnap.data().roundNumber !== roundNumber || gameSnap.data().phase !== 'choosing') fail('failed-precondition', '現在のラウンドには提出できません。');
    if (!Number.isInteger(stateVersion) || stateVersion !== gameSnap.data().stateVersion) fail('failed-precondition', '画面の状態が更新されています。再読み込みしてください。');
    if (!serverSnap.exists || serverSnap.data().resolved || !privateSnap.exists) fail('failed-precondition', '手札が見つかりません。');
    const server = serverSnap.data();
    if (server.choices?.[member.seatId]) fail('already-exists', 'このラウンドは提出済みです。');
    const choices = { ...server.choices, [member.seatId]: { handIndex, automatic: false, npc: false, uid } };
    tx.update(serverSnap.ref, { choices });
    tx.update(privateSnap.ref, { submitted: true, selectedHandIndex: handIndex, submittedAt: FieldValue.serverTimestamp() });
    tx.update(roomRef(roomId).collection('rounds').doc(String(roundNumber)), { submittedSeats: Object.keys(choices).length });
    tx.set(actionRef, { uid, roomId, gameId, roundNumber, type: 'submit', createdAt: FieldValue.serverTimestamp() });
  });
  return resolveIfReady(roomId, gameId, roundNumber);
});

const continueGame = onCall(callableOptions, async (request) => {
  const uid = uidOf(request);
  const roomId = cleanText(request.data?.roomId, 80, 'ルームID');
  await requireMember(roomId, uid);
  const room = (await roomRef(roomId).get()).data();
  const gameRef = roomRef(roomId).collection('games').doc(room.gameId);
  let next;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(gameRef); const game = snap.data();
    if (game.phase === 'finished' || game.roundNumber >= 5) { next = null; return; }
    if (game.phase !== 'round-result') fail('failed-precondition', '次へ進める状態ではありません。');
    next = { roundNumber: game.roundNumber + 1, penalties: game.nextPenalties || { A: 0, B: 0 } };
    tx.update(gameRef, { phase: 'advancing', stateVersion: FieldValue.increment(1) });
  });
  if (!next) return { finished: true };
  await createRound(roomId, room.gameId, next.roundNumber, next.penalties);
  return { finished: false, roundNumber: next.roundNumber };
});

const getSnapshot = onCall(callableOptions, async (request) => {
  const uid = uidOf(request);
  const roomId = cleanText(request.data?.roomId, 80, 'ルームID');
  const member = await requireMember(roomId, uid);
  const roomSnap = await roomRef(roomId).get();
  const room = roomSnap.data();
  const [members, seats] = await Promise.all([roomSnap.ref.collection('members').get(), roomSnap.ref.collection('seats').orderBy('seatIndex').get()]);
  let game = null; let round = null; let privateRound = null; let result = null;
  if (room.gameId) {
    game = (await roomSnap.ref.collection('games').doc(room.gameId).get()).data() || null;
    if (game?.roundNumber) {
      round = (await roomSnap.ref.collection('rounds').doc(String(game.roundNumber)).get()).data() || null;
      privateRound = (await roomSnap.ref.collection('privatePlayers').doc(uid).collection('rounds').doc(String(game.roundNumber)).get()).data() || null;
      result = (await roomSnap.ref.collection('results').doc(String(game.roundNumber)).get()).data() || null;
    }
  }
  return { room: { id: roomId, ...room }, member, members: members.docs.map((d) => d.data()), seats: seats.docs.map((d) => d.data()), game, round, privateRound, result };
});

const leaveRoom = onCall(callableOptions, async (request) => {
  const uid = uidOf(request); const roomId = cleanText(request.data?.roomId, 80, 'ルームID');
  const member = await requireMember(roomId, uid); const room = (await roomRef(roomId).get()).data();
  if (room.status !== 'waiting') fail('failed-precondition', 'ゲーム中は退出できません。');
  const batch = db.batch();
  batch.update(roomRef(roomId).collection('members').doc(uid), { leftAt: FieldValue.serverTimestamp() });
  batch.update(roomRef(roomId).collection('seats').doc(member.seatId), { controllerType: 'pending', occupantUid: null });
  batch.update(roomRef(roomId), { stateVersion: FieldValue.increment(1) }); await batch.commit();
  await rtdb.ref(`shadowCardRoomAccess/${roomId}/${uid}`).remove(); return { left: true };
});

async function sweepTimeoutsNow() {
  const expired = await db.collectionGroup('rounds').where('phase', '==', 'choosing').where('deadline', '<=', Timestamp.now()).limit(50).get();
  for (const publicSnap of expired.docs) {
    if (publicSnap.ref.parent.parent?.parent.id !== 'shadowCardRooms') continue;
    const room = publicSnap.ref.parent.parent; const roundNumber = Number(publicSnap.id); const roomSnap = await room.get(); const gameId = roomSnap.data()?.gameId;
    if (!gameId) continue;
    await db.runTransaction(async (tx) => {
      const serverRef = room.collection('serverRounds').doc(String(roundNumber)); const serverSnap = await tx.get(serverRef); if (!serverSnap.exists || serverSnap.data().resolved) return;
      const server = serverSnap.data(); const choices = { ...server.choices };
      ['seat0', 'seat1', 'seat2', 'seat3'].forEach((seatId) => { if (!choices[seatId]) choices[seatId] = { handIndex: crypto.randomInt(4), automatic: true, npc: false }; });
      tx.update(serverRef, { choices }); tx.update(publicSnap.ref, { submittedSeats: 4 });
    });
    await resolveIfReady(room.id, gameId, roundNumber);
  }
  return expired.size;
}

const sweepTimeouts = onSchedule({ ...schedulerOptions, schedule: 'every 1 minutes' }, sweepTimeoutsNow);
const cleanupRooms = onSchedule({ ...schedulerOptions, schedule: 'every 60 minutes' }, async () => {
  const old = await db.collection('shadowCardRooms').where('expiresAt', '<=', Timestamp.now()).limit(100).get();
  for (const doc of old.docs) await doc.ref.update({ status: 'closed' });
});
function isRoomEligibleForCleanup(data, nowMillis = Date.now()) {
  return ['finished','closed'].includes(data?.status) && data?.expiresAt?.toMillis?.() <= nowMillis;
}
async function cleanupAnonymousDataNow(nowMillis = Date.now()) {
  const expired = await db.collection('shadowCardRooms').where('expiresAt','<=',Timestamp.fromMillis(nowMillis)).limit(100).get(); let removed=0;
  for (const snap of expired.docs) {
    if (!isRoomEligibleForCleanup(snap.data(),nowMillis)) continue;
    const secretRef=db.collection('shadowCardRoomSecrets').doc(snap.id); const secret=(await secretRef.get()).data();
    if (secret?.locator) await db.collection('shadowCardRoomLocators').doc(secret.locator).delete();
    await db.recursiveDelete(snap.ref); await secretRef.delete(); removed += 1;
  }
  return removed;
}
const cleanupAnonymousData = onSchedule({ ...schedulerOptions, schedule: 'every day 04:00', timeZone: 'Asia/Tokyo' }, () => cleanupAnonymousDataNow());
const testSweepTimeouts = process.env.FUNCTIONS_EMULATOR === 'true'
  ? onCall({ ...callableOptions, secrets: [] }, async () => ({ swept: await sweepTimeoutsNow() })) : null;

module.exports = { createRoom, joinRoom, leaveRoom, getSnapshot, startGame, submitChoice, continueGame, sweepTimeouts, cleanupRooms, cleanupAnonymousData, testSweepTimeouts, _test: { resolveIfReady, createRound, sweepTimeoutsNow, isRoomEligibleForCleanup, cleanupAnonymousDataNow } };

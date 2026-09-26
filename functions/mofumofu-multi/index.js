'use strict';

/**
 * もふもふ大集合！ 人間3〜6人オンライン版 Phase B: create / join / start。
 *
 * 既存の2人＋こはる版（functions/mofumofu-online/）は一切変更しない別系統。
 * 新しいcollection（mofumofuMultiXxx）と新しいCallableだけを使い、既存Callable・既存collection・
 * RTDB presence・既存Rulesへは触れない。
 *
 * 判定ロジックは contract.js（Firebase非依存の純粋関数）にあり、このファイルは
 * Firestore transaction と認可・rate limit・冪等性の結線だけを担う。
 * 手札の実体・leftovers・pendingOfferは秘密領域にのみ書き、公開roomへは入れない。
 */

const crypto = require('node:crypto');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');

const contract = require('./contract');
const rules = require('./rules');

if (!getApps().length) initializeApp();

const REGION = 'asia-northeast1';
const PRODUCTION_PROJECT_ID = 'wa-awesome';
const STAGING_PROJECT_ID = 'wa-awesome-mofumofu-stg';
const PRODUCTION_ORIGIN = 'https://fabdemnt-dev.github.io';
const STAGING_ORIGIN = 'https://wa-awesome-mofumofu-stg.web.app';
// 既存版と同じHMAC Secretを使う（新Secretは追加しない）。
const ipHmacKey = defineSecret('MOFUMOFU_ONLINE_IP_HMAC_KEY');
const enforceAppCheck = process.env.MOFUMOFU_ENFORCE_APP_CHECK === 'true';

function runtimeProjectId() {
  if (process.env.GCLOUD_PROJECT) return process.env.GCLOUD_PROJECT;
  if (process.env.GOOGLE_CLOUD_PROJECT) return process.env.GOOGLE_CLOUD_PROJECT;
  try { return JSON.parse(process.env.FIREBASE_CONFIG || '{}').projectId || ''; } catch { return ''; }
}
function corsOriginsForProject(projectId) {
  if (projectId === PRODUCTION_PROJECT_ID) return [PRODUCTION_ORIGIN];
  if (projectId === STAGING_PROJECT_ID) return [STAGING_ORIGIN];
  return [];
}
// 既存版と同じcallableOptions方式（region / cors / App Check / Secret）。実環境設定は変更しない。
const callableOptions = {
  region: REGION,
  cors: corsOriginsForProject(runtimeProjectId()),
  enforceAppCheck,
  secrets: [ipHmacKey],
};

function db() { return getFirestore(); }
function expiry(milliseconds) { return Timestamp.fromMillis(Date.now() + milliseconds); }
function fail(code, message) { throw new HttpsError(code, message); }
function authUid(request) {
  const uid = request.auth?.uid;
  if (!uid) fail('unauthenticated', '認証が必要です。');
  return uid;
}
function plain(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
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

function secretValue(secret, fallback) {
  try { return secret.value() || fallback; } catch { return fallback; }
}
function ipSecret() {
  const fallbackAllowed = !!process.env.FUNCTIONS_EMULATOR || process.env.NODE_ENV === 'test' || process.env.MOFUMOFU_DIRECT_HANDLERS === '1';
  const value = secretValue(ipHmacKey, '');
  if (value) return value;
  if (fallbackAllowed) return 'mofumofu-multi-emulator-ip-key';
  fail('failed-precondition', 'サーバー設定を確認してください。');
}
function requestIp(request) {
  return request.rawRequest?.ip || request.rawRequest?.socket?.remoteAddress || 'unknown';
}
// IPは平文保存しない（既存版と同じ日次HMAC）。
function ipHash(request, day = new Date().toISOString().slice(0, 10)) {
  return crypto.createHmac('sha256', ipSecret()).update(`${day}\n${requestIp(request)}`).digest('base64url');
}
// contract.jsの失敗をcallableのHttpsErrorへ変換する（コード文字列は同一）。
function convertContractError(error) {
  if (error?.isContractError) return new HttpsError(error.code, error.message);
  return error;
}

/* ------------------------------------------------------------ collection */

function refs(roomId) {
  const store = db();
  const room = store.collection(contract.COLLECTIONS.rooms).doc(roomId);
  return {
    room,
    member: (uid) => room.collection(contract.COLLECTIONS.members).doc(uid),
    hand: (uid) => room.collection(contract.COLLECTIONS.privateHands).doc(uid),
    server: room.collection(contract.COLLECTIONS.serverState).doc('current'),
    secret: store.collection(contract.COLLECTIONS.roomSecrets).doc(roomId),
    invite: (inviteDigest) => store.collection(contract.COLLECTIONS.invites).doc(inviteDigest),
    action: (actionId) => store.collection(contract.COLLECTIONS.actionRequests).doc(actionId),
  };
}

/* ----------------------------------------------------------- rate limit */

async function consumeRateLimit(key, limit = contract.RATE_FAILURE_LIMIT, now = Date.now()) {
  const rateRef = db().collection(contract.COLLECTIONS.rateLimits).doc(contract.rateKey(key.kind, key.value));
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(rateRef);
    const value = snap.exists ? snap.data() : null;
    const started = value?.windowStartedAt?.toMillis?.() || Number(value?.windowStartedAt) || 0;
    const withinWindow = now - started < contract.RATE_WINDOW_MS;
    const count = withinWindow ? Number(value?.count || 0) : 0;
    if (count >= limit) fail('resource-exhausted', 'しばらく待ってから再試行してください。');
    tx.set(rateRef, {
      count: count + 1,
      windowStartedAt: count ? value.windowStartedAt : Timestamp.fromMillis(now),
      updatedAt: Timestamp.fromMillis(now),
      deleteAt: Timestamp.fromMillis(now + contract.RATE_TTL_MS),
    });
  });
}
async function checkRateLimit(tx, rateRef, now) {
  const snap = await tx.get(rateRef);
  if (!snap.exists) return { count: 0, windowStartedAt: now };
  const value = snap.data();
  const started = value.windowStartedAt?.toMillis?.() || Number(value.windowStartedAt) || 0;
  if (now - started >= contract.RATE_WINDOW_MS) return { count: 0, windowStartedAt: Timestamp.fromMillis(now) };
  if (value.count >= contract.RATE_FAILURE_LIMIT) fail('resource-exhausted', 'しばらく待ってから再試行してください。');
  return value;
}
async function recordJoinFailure(uid, now = Date.now()) {
  const store = db();
  const rateRef = store.collection(contract.COLLECTIONS.rateLimits).doc(contract.rateKey('join_uid', contract.digest(uid)));
  await store.runTransaction(async (tx) => {
    const state = await checkRateLimit(tx, rateRef, now);
    tx.set(rateRef, {
      count: Number(state.count || 0) + 1,
      windowStartedAt: state.windowStartedAt,
      updatedAt: Timestamp.fromMillis(now),
      deleteAt: Timestamp.fromMillis(now + contract.RATE_TTL_MS),
    });
  });
}

/* ---------------------------------------------------------------- create */

async function createHandler(request) {
  exactFields(request.data || {}, ['actionId']);
  const uid = authUid(request);
  const actionId = actionIdFrom(request.data);
  const store = db();
  const actionRef = store.collection(contract.COLLECTIONS.actionRequests).doc(actionId);
  const fingerprint = contract.actionFingerprint('multi-create', uid, '', {});
  // 再送はrate limitを消費せず初回結果を返す（別roomを作らない）。
  const initialActionSnap = await actionRef.get();
  if (initialActionSnap.exists) return contract.replayAction(initialActionSnap.data(), fingerprint);

  const now = Date.now();
  await consumeRateLimit({ kind: 'create_uid', value: contract.digest(uid) }, contract.CREATE_UID_RATE_LIMIT, now);
  await consumeRateLimit({ kind: 'create_ip', value: ipHash(request) }, contract.IP_RATE_LIMIT, now);

  for (let attempt = 0; attempt < contract.INVITE_RETRIES; attempt += 1) {
    const code = contract.newInviteCode();
    const inviteDigest = contract.inviteCodeDigest(code);
    const roomId = crypto.randomUUID();
    const r = refs(roomId);
    const deleteAt = Timestamp.fromMillis(now + contract.WAITING_TTL_MS);
    try {
      await store.runTransaction(async (tx) => {
        const inviteSnap = await tx.get(r.invite(inviteDigest));
        if (inviteSnap.exists) fail('already-exists', '招待コードが衝突しました。');
        tx.create(r.room, contract.initialRoomFields({ roomId, hostUid: uid, now, deleteAt }));
        tx.create(r.member(uid), contract.initialMemberFields({ uid, seatId: 'S1', joinedAt: now, deleteAt }));
        tx.create(r.secret, contract.initialSecretFields({ inviteDigest, createdAt: now, deleteAt }));
        tx.create(r.invite(inviteDigest), contract.initialInviteFields({ roomId, now, deleteAt }));
        // 平文inviteCodeは保存しない。resultにも入れない（再送はroomの同一性だけを保証する）。
        tx.create(actionRef, {
          fingerprint,
          stateToken: 'create',
          result: { roomId, seatId: 'S1', status: 'waiting' },
          completedAt: now,
          deleteAt: Timestamp.fromMillis(now + contract.ACTION_TTL_MS),
        });
      });
      return { roomId, inviteCode: code, seatId: 'S1', status: 'waiting' };
    } catch (error) {
      const converted = convertContractError(error);
      if (converted instanceof HttpsError && converted.code === 'already-exists' && attempt + 1 < contract.INVITE_RETRIES) continue;
      throw converted;
    }
  }
  fail('resource-exhausted', '部屋を作成できませんでした。');
}

/* ------------------------------------------------------------------ join */

async function joinHandler(request) {
  exactFields(request.data, ['inviteCode', 'actionId']);
  const uid = authUid(request);
  const code = contract.normalizeInviteCode(request.data.inviteCode);
  const inviteDigest = contract.inviteCodeDigest(code);
  const actionId = actionIdFrom(request.data);
  const store = db();
  const now = Date.now();
  const actionRef = store.collection(contract.COLLECTIONS.actionRequests).doc(actionId);
  const fingerprint = contract.actionFingerprint('multi-join', uid, '', { inviteDigest });
  const initialActionSnap = await actionRef.get();
  if (initialActionSnap.exists) return contract.replayAction(initialActionSnap.data(), fingerprint);

  const rateRef = store.collection(contract.COLLECTIONS.rateLimits).doc(contract.rateKey('join_uid', contract.digest(uid)));
  await consumeRateLimit({ kind: 'join_ip', value: ipHash(request) }, contract.IP_RATE_LIMIT, now);
  try {
    return await store.runTransaction(async (tx) => {
      await checkRateLimit(tx, rateRef, now);
      const [actionSnap, inviteSnap] = await Promise.all([tx.get(actionRef), tx.get(refs('x').invite(inviteDigest))]);
      if (actionSnap.exists) return contract.replayAction(actionSnap.data(), fingerprint);
      if (!inviteSnap.exists) fail('failed-precondition', contract.INVITE_ERROR);
      const invite = inviteSnap.data();
      const r = refs(invite.roomId);
      const roomSnap = await tx.get(r.room);
      if (!roomSnap.exists) fail('failed-precondition', contract.INVITE_ERROR);
      const room = roomSnap.data();
      const decision = contract.joinDecision(room, invite, { uid, now });
      if (decision.action === 'existing-seat') {
        tx.delete(rateRef);
        return { roomId: invite.roomId, seatId: decision.seatId, status: room.status, rejoined: true };
      }
      if (!decision.ok) fail(decision.code, decision.message);
      const seatId = decision.seatId;
      tx.update(r.room, contract.joinRoomUpdate(room, seatId, uid, now));
      tx.create(r.member(uid), contract.initialMemberFields({
        uid,
        seatId,
        joinedAt: now,
        deleteAt: Timestamp.fromMillis(now + contract.PLAYING_TTL_MS),
      }));
      tx.update(r.invite(inviteDigest), { status: contract.inviteStatusAfterJoin(decision.playerCount), joinedAt: now });
      const result = { roomId: invite.roomId, seatId, status: 'waiting', playerCount: decision.playerCount };
      tx.create(actionRef, {
        fingerprint,
        stateToken: `join:${decision.playerCount}`,
        result,
        completedAt: now,
        deleteAt: Timestamp.fromMillis(now + contract.ACTION_TTL_MS),
      });
      tx.delete(rateRef);
      return result;
    });
  } catch (error) {
    const converted = convertContractError(error);
    if (converted instanceof HttpsError && ['failed-precondition', 'resource-exhausted'].includes(converted.code)) {
      await recordJoinFailure(uid, now);
    }
    throw converted;
  }
}

/* ----------------------------------------------------------------- start */

async function startHandler(request) {
  exactFields(request.data, ['roomId', 'actionId']);
  const uid = authUid(request);
  const roomId = roomIdFrom(request.data);
  const actionId = actionIdFrom(request.data);
  const store = db();
  const r = refs(roomId);
  const now = Date.now();
  const actionRef = store.collection(contract.COLLECTIONS.actionRequests).doc(actionId);
  const fingerprint = contract.actionFingerprint('multi-start', uid, roomId, {});
  const initialActionSnap = await actionRef.get();
  if (initialActionSnap.exists) return contract.replayAction(initialActionSnap.data(), fingerprint);
  await consumeRateLimit({ kind: 'start_uid', value: contract.digest(uid) }, contract.START_UID_RATE_LIMIT, now);

  return store.runTransaction(async (tx) => {
    const actionSnap = await tx.get(actionRef);
    if (actionSnap.exists) return contract.replayAction(actionSnap.data(), fingerprint);
    const [roomSnap, secretSnap] = await Promise.all([tx.get(r.room), tx.get(r.secret)]);
    if (!roomSnap.exists || !secretSnap.exists) fail('not-found', '部屋が見つかりません。');
    const room = roomSnap.data();
    const decision = contract.startDecision(room, { uid, now });
    if (!decision.ok) fail(decision.code, decision.message);
    const seatOrder = decision.seatOrder;
    // member整合（uid・seatの突き合わせ）を同じtransactionで確認する。
    const memberSnaps = await Promise.all(seatOrder.map((seat) => tx.get(r.member(room.playerUids[seat]))));
    for (let index = 0; index < seatOrder.length; index += 1) {
      const snapshot = memberSnaps[index];
      if (!snapshot.exists) fail('failed-precondition', '参加情報が不整合です。');
      if (snapshot.data().uid !== room.playerUids[seatOrder[index]] || snapshot.data().seatId !== seatOrder[index]) {
        fail('failed-precondition', '参加情報が不整合です。');
      }
    }
    const inviteRef = r.invite(secretSnap.data().inviteDigest);
    const inviteSnap = await tx.get(inviteRef);
    if (!inviteSnap.exists) fail('failed-precondition', '招待情報がありません。');

    // Phase Aの純粋核で32枚を配る（人数別 10/8/6/5＋余り2/0/2/2）。
    const handSize = rules.handSizeFor(decision.playerCount);
    const dealt = rules.dealDeck(rules.shuffle(rules.createDeck()), seatOrder);
    const byUid = contract.handsByUid(seatOrder, room.playerUids, dealt.hands);
    const deleteAt = Timestamp.fromMillis(now + contract.PLAYING_TTL_MS);
    for (const [memberUid, cards] of Object.entries(byUid)) {
      tx.set(r.hand(memberUid), { cards, deleteAt });
    }
    // leftovers・pendingOfferは秘密領域のみ。公開roomへは入れない。
    tx.set(r.server, { seatOrder, pendingOffer: null, discard: [], leftovers: dealt.leftovers, deleteAt });
    for (const seat of seatOrder) tx.update(r.member(room.playerUids[seat]), { deleteAt });
    tx.update(r.secret, { deleteAt });
    tx.update(r.room, contract.roomAfterStart(room, { now, handSize, deleteAt }));
    tx.update(inviteRef, { status: 'started', revokedAt: now, deleteAt });
    const result = {
      roomId,
      status: 'playing',
      playerCount: decision.playerCount,
      seatOrder,
      handSize,
      currentTurnPlayerId: seatOrder[0],
      turnState: 'awaitingOffer',
    };
    tx.create(actionRef, {
      fingerprint,
      stateToken: `start:${room.status}`,
      result,
      completedAt: now,
      deleteAt: Timestamp.fromMillis(now + contract.ACTION_TTL_MS),
    });
    return result;
  }).catch((error) => { throw convertContractError(error); });
}

/* -------------------------------------------------------------- cleanup */

// Phase Bではschedulerを登録しない（deploy禁止のため）。Phase Dでcleanupへ結線する。
async function cleanupMofumofuMultiDataNow(nowMillis = Date.now(), limit = 100) {
  const store = db();
  const now = Timestamp.fromMillis(nowMillis);
  const deleted = { rooms: 0 };
  const rooms = await store.collection(contract.COLLECTIONS.rooms).where('deleteAt', '<=', now).limit(50).get();
  for (const room of rooms.docs) { await store.recursiveDelete(room.ref); deleted.rooms += 1; }
  for (const name of [contract.COLLECTIONS.invites, contract.COLLECTIONS.roomSecrets, contract.COLLECTIONS.actionRequests, contract.COLLECTIONS.rateLimits]) {
    const snapshot = await store.collection(name).where('deleteAt', '<=', now).limit(limit).get();
    if (snapshot.empty) { deleted[name] = 0; continue; }
    const batch = store.batch();
    snapshot.docs.forEach((document) => batch.delete(document.ref));
    await batch.commit();
    deleted[name] = snapshot.size;
  }
  return deleted;
}

/* ---------------------------------------------------------------- exports */

const createMofumofuMultiRoom = onCall(callableOptions, (request) => createHandler(request));
const joinMofumofuMultiRoom = onCall(callableOptions, (request) => joinHandler(request));
const startMofumofuMultiGame = onCall(callableOptions, (request) => startHandler(request));

module.exports = {
  createMofumofuMultiRoom,
  joinMofumofuMultiRoom,
  startMofumofuMultiGame,
  _handlers: { createHandler, joinHandler, startHandler, cleanupMofumofuMultiDataNow },
  _test: {
    COLLECTIONS: contract.COLLECTIONS,
    callableOptions,
    runtimeProjectId,
    corsOriginsForProject,
    ipHash,
    refs,
    convertContractError,
    cleanupMofumofuMultiDataNow,
    contract,
    rules,
  },
};

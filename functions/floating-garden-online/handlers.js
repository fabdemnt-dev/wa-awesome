'use strict';

const crypto = require('node:crypto');
const {
  RULES_VERSION, PLAYER_COUNT, ROOM_TTL_MILLIS, RECEIPT_RETENTION_MILLIS, GardenError, fail, exactObject,
  uidOf, requestIdOf, idOf, revisionOf, sanitizeDisplayName, commandOf, hashPayload, uidKey, assertNotExpired,
  requireMember, toPublicSnapshot, publicRoom,
} = require('./contract');
const { createInviteCode, parseInviteCode, inviteMac, safeEqual, hashIp } = require('./invite-code');

// Firebase is intentionally absent here. Production and tests use identical transaction handlers.
let stagedCore;
function loadCore() { return stagedCore ||= import('./core/match-engine.js'); }
const RATE_LIMITS = Object.freeze({
  create: { limit: 5, ipLimit: 20, windowMillis: 600000 },
  join: { limit: 20, ipLimit: 60, windowMillis: 60000 },
  start: { limit: 30, windowMillis: 60000 },
  submit: { limit: 240, windowMillis: 60000 },
  snapshot: { limit: 360, windowMillis: 60000 },
});
function secureMatch(core, randomInt = crypto.randomInt, playerCount = PLAYER_COUNT) {
  const state = core.createMatch({ playerCount, humanSeat: -1, seed: 'server-shuffled' });
  // The seed only supplies the canonical inventory. This independent cryptographic shuffle
  // replaces the entire order; no client seed or LCG output determines online randomness.
  for (let index = state.deck.length - 1; index > 0; index -= 1) {
    const other = randomInt(index + 1);
    if (!Number.isInteger(other) || other < 0 || other > index) throw new Error('Invalid cryptographic random index');
    [state.deck[index], state.deck[other]] = [state.deck[other], state.deck[index]];
  }
  core.assertMatchInvariants(state);
  return state;
}

function createHandlers({ db, now = Date.now, randomUUID = crypto.randomUUID, randomInt = crypto.randomInt,
  inviteSecret, timestampFromMillis = (millis) => millis, coreLoader = loadCore, rateLimits = RATE_LIMITS } = {}) {
  if (!db?.runTransaction || !db?.doc || typeof inviteSecret !== 'function') throw new TypeError('db and inviteSecret are required');
  const roomRef = (id) => db.doc(`floatingGardenRooms/${id}`);
  const memberRef = (id, uid) => db.doc(`floatingGardenRooms/${id}/members/${uid}`);
  const gameRef = (id, gameId) => db.doc(`floatingGardenRooms/${id}/serverGames/${gameId}`);
  const receiptRef = (uid, requestId) => db.doc(`floatingGardenActionRequests/${uidKey(uid)}_${requestId}`);
  const inviteRef = (locator) => db.doc(`floatingGardenInvites/${locator}`);
  function getKey() {
    try {
      const value = inviteSecret();
      if (typeof value !== 'string' || value.length < 32) throw new Error('Missing key');
      return value;
    } catch { fail('unavailable', '招待機能のサーバー設定を確認しています。しばらくしてからお試しください。'); }
  }
  async function replay(tx, snapshot, hash, uid) {
    const data = snapshot.data();
    if (data.payloadHash !== hash) fail('already-exists', '同じリクエストIDを別の操作に再利用できません。', { reason: 'request-id-reused' });
    assertNotExpired(data, now());
    const roomId = data.result.roomId || data.result.room?.id;
    const [roomSnapshot, memberSnapshot] = await Promise.all([tx.get(roomRef(roomId)), tx.get(memberRef(roomId, uid))]);
    const currentRoom = readRoom(roomSnapshot);
    readSelf(memberSnapshot, currentRoom);
    return data.result;
  }
  async function consumeRate(type, uid, request, key, identity = null) {
    const config = rateLimits[type];
    if (!config) throw new Error(`Missing rate policy: ${type}`);
    const entries = [{ ref: db.doc(`floatingGardenRateLimits/${type}_uid_${uidKey(uid)}`), limit: config.limit }];
    if (config.ipLimit) {
      // Only a keyed hash is stored, never the IP address or request headers.
      const ip = request.rawRequest?.ip || request.rawRequest?.socket?.remoteAddress || 'unknown';
      entries.push({ ref: db.doc(`floatingGardenRateLimits/${type}_ip_${hashIp(ip, key)}`), limit: config.ipLimit });
    }
    await db.runTransaction(async (tx) => {
      const snapshots = await Promise.all(entries.map(({ ref }) => tx.get(ref)));
      const timestamp = now();
      // Concurrent identical retries share one admission in this bounded window.
      // A failed attempt cannot brute-force a new payload under the same ticket.
      const admitted = snapshots[0].exists ? snapshots[0].data() : null;
      const admittedWithin = admitted && timestamp >= admitted.windowStartMillis && timestamp - admitted.windowStartMillis < config.windowMillis;
      const admittedHash = identity && admittedWithin && admitted.requests?.[uidKey(identity.requestId)];
      if (admittedHash) {
        if (admittedHash !== identity.hash) fail('already-exists', '同じリクエストIDを別の操作に再利用できません。', { reason: 'request-id-reused' });
        return;
      }
      const changes = entries.map((entry, index) => {
        const old = snapshots[index].exists ? snapshots[index].data() : null;
        const within = old && Number.isSafeInteger(old.windowStartMillis) && timestamp >= old.windowStartMillis && timestamp - old.windowStartMillis < config.windowMillis;
        const count = within ? old.count : 0;
        if (!Number.isSafeInteger(count) || count < 0 || count >= entry.limit) fail('resource-exhausted', '試行回数が多すぎます。少し待ってからお試しください。');
        return { ref: entry.ref, data: { count: count + 1, windowStartMillis: within ? old.windowStartMillis : timestamp,
          ...(index === 0 && identity ? { requests: { ...(within ? old.requests || {} : {}), [uidKey(identity.requestId)]: identity.hash } } : {}),
          expiresAt: timestampFromMillis(timestamp + config.windowMillis * 2) } };
      });
      for (const { ref, data } of changes) tx.set(ref, data);
    });
  }
  function saveReceipt(tx, ref, type, hash, result, expiresAtMillis) {
    // create, never set/update: an accepted identity+payload+result is immutable.
    tx.create(ref, { type, payloadHash: hash, result, createdAtMillis: now(), expiresAtMillis,
      expiresAt: timestampFromMillis(expiresAtMillis + RECEIPT_RETENTION_MILLIS) });
  }
  async function mutate({ request, uid, requestId, type, payload, key }, body) {
    const ref = receiptRef(uid, requestId);
    const hash = hashPayload(type, payload);
    // Fast replay avoids charging a successful retry. The transaction MUST re-read the
    // same receipt below: concurrent requests may both observe this first read missing.
    const previous = await ref.get();
    if (previous.exists) return db.runTransaction(async (tx) => {
      const current = await tx.get(ref);
      if (!current.exists) fail('failed-precondition', '操作記録の保存期限が切れています。', { reason: 'receipt-expired' });
      return replay(tx, current, hash, uid);
    });
    // A separate committed budget counts invalid invite / illegal move attempts too.
    await consumeRate(type, uid, request, key, { requestId, hash });
    return db.runTransaction(async (tx) => {
      const current = await tx.get(ref);
      if (current.exists) return replay(tx, current, hash, uid);
      const { result, expiresAtMillis } = await body(tx);
      saveReceipt(tx, ref, type, hash, result, expiresAtMillis);
      return result;
    });
  }
  function readRoom(snapshot) {
    if (!snapshot.exists) fail('not-found', '部屋が見つかりません。');
    const room = snapshot.data();
    assertNotExpired(room, now());
    if (room.rulesVersion !== RULES_VERSION) fail('failed-precondition', 'ゲームの版が一致しません。', { reason: 'rules-version' });
    return room;
  }
  function readSelf(snapshot, room) {
    const member = snapshot.exists ? snapshot.data() : null;
    const self = requireMember(member, room);
    assertNotExpired(member, now());
    return self;
  }
  function assertRevision(actual, expected) {
    if (actual !== expected) fail('failed-precondition', '状態が更新されています。最新の手番を確認してください。', { reason: 'stale-revision', actualRevision: actual });
  }
  function output(room, self) { return { room: publicRoom(room), self }; }

  async function floatingGardenCreateRoom(request) {
    const uid = uidOf(request);
    exactObject(request.data, ['displayName', 'requestId']);
    const requestId = requestIdOf(request.data.requestId);
    const name = sanitizeDisplayName(request.data.displayName);
    const key = getKey();
    const invitation = createInviteCode(uid, requestId, key);
    const roomId = idOf(randomUUID());
    const result = await mutate({ request, uid, requestId, type: 'create', payload: request.data, key }, async (tx) => {
      const room = roomRef(roomId);
      const locator = inviteRef(invitation.locator);
      const [roomSnapshot, locatorSnapshot] = await Promise.all([tx.get(room), tx.get(locator)]);
      // A locator collision must not overwrite someone else's invitation, even if expired.
      if (roomSnapshot.exists || locatorSnapshot.exists) fail('failed-precondition', '部屋を作成できませんでした。新しいリクエストIDで再試行してください。', { reason: 'identifier-collision' });
      const expiresAtMillis = now() + ROOM_TTL_MILLIS;
      const publicState = {
        id: roomId, status: 'waiting', hostSeat: 0, playerCount: PLAYER_COUNT, gameId: null,
        revision: 1, rulesVersion: RULES_VERSION, expiresAtMillis, players: [{ seat: 0, name }], match: null, scores: [],
      };
      tx.create(room, publicState);
      tx.create(memberRef(roomId, uid), { seat: 0, isHost: true, active: true, expiresAtMillis });
      tx.create(locator, { roomId, verifier: inviteMac(invitation.locator, invitation.secret, key), expiresAtMillis,
        expiresAt: timestampFromMillis(expiresAtMillis) });
      return { result: { roomId, seat: 0 }, expiresAtMillis };
    });
    // Regenerate plaintext only for this authenticated response, never persist it.
    // If the operator rotates the key, fail closed rather than return a new, unusable code.
    const storedInvite = await inviteRef(invitation.locator).get();
    if (!storedInvite.exists || storedInvite.data().roomId !== result.roomId || !Number.isSafeInteger(storedInvite.data().expiresAtMillis) || storedInvite.data().expiresAtMillis <= now() || !safeEqual(storedInvite.data().verifier, inviteMac(invitation.locator, invitation.secret, key))) fail('failed-precondition', 'この招待コードは利用できません。新しい部屋を作成してください。', { reason: 'invitation-unavailable' });
    return { ...result, inviteCode: invitation.code };
  }

  async function floatingGardenJoinRoom(request) {
    const uid = uidOf(request);
    exactObject(request.data, ['inviteCode', 'displayName', 'requestId']);
    const requestId = requestIdOf(request.data.requestId);
    const name = sanitizeDisplayName(request.data.displayName);
    if (typeof request.data.inviteCode !== 'string' || request.data.inviteCode.length > 80) fail('invalid-argument', '招待コードを確認してください。');
    const key = getKey();
    return mutate({ request, uid, requestId, type: 'join', payload: request.data, key }, async (tx) => {
      const parsed = parseInviteCode(request.data.inviteCode);
      if (!parsed) fail('not-found', '招待コードが見つからないか、期限が切れています。');
      const locatorSnapshot = await tx.get(inviteRef(parsed.locator));
      const locator = locatorSnapshot.exists ? locatorSnapshot.data() : null;
      if (!locator || !Number.isSafeInteger(locator.expiresAtMillis) || locator.expiresAtMillis <= now() ||
          !safeEqual(locator.verifier, inviteMac(parsed.locator, parsed.secret, key))) fail('not-found', '招待コードが見つからないか、期限が切れています。');
      const roomId = locator.roomId;
      const [roomSnapshot, memberSnapshot] = await Promise.all([tx.get(roomRef(roomId)), tx.get(memberRef(roomId, uid))]);
      const room = readRoom(roomSnapshot);
      if (memberSnapshot.exists) {
        const self = readSelf(memberSnapshot, room);
        return { result: { roomId, seat: self.seat }, expiresAtMillis: room.expiresAtMillis };
      }
      if (room.status !== 'waiting') fail('failed-precondition', 'この部屋では既に対戦が始まっています。', { reason: 'match-already-started' });
      if (room.players.length >= PLAYER_COUNT) fail('failed-precondition', '部屋は満員です。', { reason: 'room-full' });
      const seat = room.players.length;
      const next = { ...room, revision: room.revision + 1, players: [...room.players, { seat, name }] };
      tx.set(roomRef(roomId), publicRoom(next));
      tx.create(memberRef(roomId, uid), { seat, isHost: false, active: true, expiresAtMillis: room.expiresAtMillis });
      return { result: { roomId, seat }, expiresAtMillis: room.expiresAtMillis };
    });
  }

  async function floatingGardenStartMatch(request) {
    const uid = uidOf(request);
    exactObject(request.data, ['roomId', 'expectedRevision', 'requestId']);
    const roomId = idOf(request.data.roomId);
    const requestId = requestIdOf(request.data.requestId);
    const expectedRevision = revisionOf(request.data.expectedRevision);
    const core = await coreLoader();
    const gameId = idOf(randomUUID(), 'ゲームID');
    // Fix entropy once per incoming call, outside the retried transaction callback.
    const prepared = secureMatch(core, randomInt);
    return mutate({ request, uid, requestId, type: 'start', payload: request.data }, async (tx) => {
      const [roomSnapshot, memberSnapshot, gameSnapshot] = await Promise.all([
        tx.get(roomRef(roomId)), tx.get(memberRef(roomId, uid)), tx.get(gameRef(roomId, gameId)),
      ]);
      const room = readRoom(roomSnapshot);
      const self = readSelf(memberSnapshot, room);
      if (!self.isHost) fail('permission-denied', '開始できるのは部屋を作った人です。');
      assertRevision(room.revision, expectedRevision);
      if (room.status !== 'waiting' || room.gameId) fail('failed-precondition', '既に対戦が始まっています。', { reason: 'match-already-started' });
      if (room.players.length !== PLAYER_COUNT) fail('failed-precondition', '2人が揃ってから始めてください。', { reason: 'room-not-ready' });
      if (gameSnapshot.exists) fail('failed-precondition', 'ゲームIDが重複しました。新しいリクエストIDで再試行してください。');
      const initialState = structuredClone(prepared);
      initialState.players.forEach((player) => { player.name = room.players[player.seat].name; player.isHuman = true; });
      core.assertMatchInvariants(initialState);
      const next = publicRoom({ ...room, status: 'playing', gameId, revision: room.revision + 1, match: toPublicSnapshot(initialState), scores: [] });
      tx.create(gameRef(roomId, gameId), { gameId, rulesVersion: RULES_VERSION, initialState, state: initialState, commands: [],
        expiresAtMillis: room.expiresAtMillis, expiresAt: timestampFromMillis(room.expiresAtMillis) });
      tx.set(roomRef(roomId), next);
      return { result: output(next, self), expiresAtMillis: room.expiresAtMillis };
    });
  }

  async function floatingGardenGetSnapshot(request) {
    const uid = uidOf(request);
    exactObject(request.data, ['roomId']);
    const roomId = idOf(request.data.roomId);
    await consumeRate('snapshot', uid, request);
    return db.runTransaction(async (tx) => {
      const [roomSnapshot, memberSnapshot] = await Promise.all([tx.get(roomRef(roomId)), tx.get(memberRef(roomId, uid))]);
      const room = readRoom(roomSnapshot);
      const self = readSelf(memberSnapshot, room);
      return output(room, self);
    });
  }

  async function floatingGardenSubmitAction(request) {
    const uid = uidOf(request);
    exactObject(request.data, ['roomId', 'gameId', 'rulesVersion', 'expectedRevision', 'requestId', 'command']);
    const roomId = idOf(request.data.roomId);
    const gameId = idOf(request.data.gameId, 'ゲームID');
    const requestId = requestIdOf(request.data.requestId);
    const expectedRevision = revisionOf(request.data.expectedRevision);
    if (request.data.rulesVersion !== RULES_VERSION) fail('failed-precondition', 'ゲームの版が一致しません。', { reason: 'rules-version' });
    const command = commandOf(request.data.command);
    const core = await coreLoader();
    return mutate({ request, uid, requestId, type: 'submit', payload: request.data }, async (tx) => {
      const [roomSnapshot, memberSnapshot, gameSnapshot] = await Promise.all([
        tx.get(roomRef(roomId)), tx.get(memberRef(roomId, uid)), tx.get(gameRef(roomId, gameId)),
      ]);
      const room = readRoom(roomSnapshot);
      const self = readSelf(memberSnapshot, room);
      if (room.gameId !== gameId) fail('failed-precondition', 'ゲームが一致しません。最新の部屋を開いてください。', { reason: 'wrong-game' });
      if (room.status !== 'playing' || !gameSnapshot.exists) fail('failed-precondition', '現在は操作できません。', { reason: room.status === 'finished' ? 'match-finished' : 'match-not-started' });
      const game = gameSnapshot.data();
      assertNotExpired(game, now());
      if (game.rulesVersion !== RULES_VERSION || game.state.version !== RULES_VERSION) fail('failed-precondition', 'ゲームの版が一致しません。', { reason: 'rules-version' });
      const state = game.state;
      assertRevision(state.revision, expectedRevision);
      if (room.match?.revision !== state.revision) fail('internal', '公開状態を再同期できません。');
      if (core.getDecision(state)?.seat !== self.seat) fail('permission-denied', 'いまはあなたが操作する番ではありません。');
      const accepted = { ...command, seat: self.seat, revision: state.revision };
      let nextState;
      try { nextState = core.applyMatchAction(state, accepted); }
      catch (error) {
        if (['illegal-action', 'stale-action', 'invalid-action'].includes(error.code)) fail('failed-precondition', 'いまはその操作を選べません。最新の手番を確認してください。', { reason: 'illegal-action' });
        throw error;
      }
      const finished = nextState.phase === 'finished';
      const next = publicRoom({ ...room, status: finished ? 'finished' : 'playing', revision: room.revision + 1,
        match: toPublicSnapshot(nextState), scores: finished ? core.rankMatch(nextState) : [] });
      tx.update(gameRef(roomId, gameId), { state: nextState, commands: [...game.commands, accepted] });
      tx.set(roomRef(roomId), next);
      return { result: output(next, self), expiresAtMillis: room.expiresAtMillis };
    });
  }
  return { floatingGardenCreateRoom, floatingGardenJoinRoom, floatingGardenStartMatch, floatingGardenGetSnapshot, floatingGardenSubmitAction };
}
module.exports = { createHandlers, loadCore, secureMatch, RATE_LIMITS, GardenError };

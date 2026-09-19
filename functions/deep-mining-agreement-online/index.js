'use strict';
const { getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const crypto = require('node:crypto');
const { createInviteCode, parseInviteCode, mac, safeEqual } = require('./invite-code');
const { requireInviteHmacKey } = require('./secret');
const rules = require('./rules');
if (!getApps().length) initializeApp();
const db = getFirestore();
const inviteKey = defineSecret('DEEP_MINING_AGREEMENT_INVITE_HMAC_KEY');
const options = { region: 'asia-northeast1', cors: ['https://fabdemnt-dev.github.io', /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/], minInstances: 0, maxInstances: 5, enforceAppCheck: false, secrets: [inviteKey] };
const fail = (code, message) => { throw new HttpsError(code, message); };
const uidOf = (request) => request.auth?.uid || fail('unauthenticated', '匿名ログインが必要です。');
const text = (value, max, label) => { const result = typeof value === 'string' ? value.trim() : ''; if (!result || result.length > max) fail('invalid-argument', `${label}が不正です。`); return result; };
const requestId = (request) => { const id = text(request.data?.requestId, 80, 'リクエストID'); if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) fail('invalid-argument', 'リクエストIDが不正です。'); return id; };
const roomId = (request) => { const id = text(request.data?.roomId, 80, 'ルームID'); if (!/^[0-9a-f-]{36}$/i.test(id)) fail('invalid-argument', 'ルームIDが不正です。'); return id; };
const key = () => {
  try { return requireInviteHmacKey(() => inviteKey.value()); }
  catch { return fail('failed-precondition', '招待コード機能の設定が完了していません。'); }
};
const roomRef = (id) => db.collection('deepMiningAgreementRooms').doc(id);
const actionRef = (uid, id) => db.collection('deepMiningAgreementActionRequests').doc(`${uid}_${id}`);
const memberRef = (ref, uid) => ref.collection('deepMiningAgreementMembers').doc(uid);
const syncMemberExpiry = (tx, ref, members, expiresAt) => {
  for (const member of members) tx.set(memberRef(ref, member.uid), { expiresAt }, { merge: true });
};
const hash = (type, payload) => crypto.createHash('sha256').update(JSON.stringify({ type, ...payload })).digest('base64url');
const expiry = () => Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000);
function replay(data, expected) { if (data.payloadHash !== expected) fail('already-exists', '同じリクエストIDを別の操作に再利用できません。'); return data.result; }
function publicPlayer(player, reveal = false) { return { id: player.id, name: player.name, active: player.active, retreated: player.retreated, publicOre: player.publicOre, reinforcement: player.reinforcement, rank: player.rank || null, finalValue: reveal ? rules.totalValue(player) : null, secretOre: reveal ? player.secretOre : undefined, vaultOre: reveal ? player.vaultOre : undefined, discredit: reveal ? player.discredit : undefined, secretActions: reveal ? player.secretActions : undefined, accusationSuccesses: reveal ? player.accusationSuccesses : undefined, accusationFailures: reveal ? player.accusationFailures : undefined, collapseLoss: reveal ? player.collapseLoss : undefined }; }
function snapshot(room, member) {
  const game = room.game || null; const self = game?.players.find((p) => p.id === member.seatId);
  return { room: { id: room.id, status: room.status, playerCount: room.playerCount, hostUid: room.hostUid, stateVersion: room.stateVersion, gameId: room.gameId || null }, self: { seatId: member.seatId, displayName: member.displayName, isHost: room.hostUid === member.uid }, members: room.members.map(({ uid, ...item }) => item), game: game ? { gameId: room.gameId, round: game.round, danger: game.danger, currentOreId: game.oreSequence[game.round - 1] || null, detectedSecretMining: game.detectedSecretMining, players: game.players.map((p) => publicPlayer(p, game.ended)), submittedSeatIds: Object.keys(game.submissions), history: game.history, ended: game.ended, endReason: game.endReason, collapsed: game.collapsed, selfPrivate: self ? { secretOre: self.secretOre, scoutsUsed: self.scoutsUsed, accusationsUsed: self.accusationsUsed, discredit: self.discredit, scoutedOre: self.scoutedRound === game.round ? self.scoutedOre : null } : null } : null };
}
async function memberFor(ref, uid) { const snap = await memberRef(ref, uid).get(); if (!snap.exists || snap.data().leftAt) fail('permission-denied', 'この部屋には参加していません。'); return { uid, ...snap.data() }; }

const createRoom = onCall(options, async (request) => {
  const uid = uidOf(request); const rid = requestId(request); const displayName = text(request.data?.displayName, 20, '表示名'); const playerCount = Number(request.data?.playerCount); if (![2, 3, 4].includes(playerCount)) fail('invalid-argument', '人数は2〜4人です。');
  const payloadHash = hash('create', { displayName, playerCount }); const action = actionRef(uid, rid); const prior = await action.get(); const invite = createInviteCode(uid, rid, key()); if (prior.exists) return { ...replay(prior.data(), payloadHash), inviteCode: invite.code };
  const id = crypto.randomUUID(); const ref = roomRef(id); const result = { roomId: id, stateVersion: 1 }; const expiresAt = expiry();
  await db.runTransaction(async (tx) => { if ((await tx.get(action)).exists) return; const locatorRef = db.collection('deepMiningAgreementRoomLocators').doc(invite.locator); if ((await tx.get(locatorRef)).exists) fail('already-exists', '招待コードが競合しました。'); const member = { uid, displayName, seatId: 'seat1', joinedAt: Timestamp.now(), leftAt: null }; tx.set(ref, { id, status: 'lobby', hostUid: uid, playerCount, stateVersion: 1, gameId: null, members: [member], expiresAt }); tx.set(memberRef(ref, uid), { ...member, expiresAt }); tx.set(locatorRef, { roomId: id, inviteMac: mac(invite.locator, invite.secret, key()), expiresAt }); tx.set(action, { payloadHash, result, expiresAt }); });
  return { ...result, inviteCode: invite.code };
});
const joinRoom = onCall(options, async (request) => {
  const uid = uidOf(request); const rid = requestId(request); const displayName = text(request.data?.displayName, 20, '表示名'); const parsed = parseInviteCode(request.data?.inviteCode); if (!parsed) fail('invalid-argument', '部屋コードが不正です。'); const payloadHash = hash('join', { displayName, locator: parsed.locator }); const action = actionRef(uid, rid); const prior = await action.get(); if (prior.exists) return replay(prior.data(), payloadHash);
  const locator = await db.collection('deepMiningAgreementRoomLocators').doc(parsed.locator).get(); if (!locator.exists || !safeEqual(locator.data().inviteMac, mac(parsed.locator, parsed.secret, key()))) fail('not-found', '部屋が見つかりません。'); const id = locator.data().roomId; const ref = roomRef(id); let result;
  await db.runTransaction(async (tx) => { const [roomSnap, actionSnap] = await Promise.all([tx.get(ref), tx.get(action)]); if (actionSnap.exists) { result = replay(actionSnap.data(), payloadHash); return; } if (!roomSnap.exists) fail('not-found', '部屋が見つかりません。'); const room = roomSnap.data(); const existing = room.members.find((m) => m.uid === uid); const expiresAt = expiry(); if (existing && !existing.leftAt) { result = { roomId: id, stateVersion: room.stateVersion }; } else { if (room.status !== 'lobby') fail('failed-precondition', '開始後の部屋には参加できません。'); if (room.members.filter((m) => !m.leftAt).length >= room.playerCount) fail('resource-exhausted', '部屋は満員です。'); const used = new Set(room.members.map((m) => m.seatId)); const seatId = ['seat1', 'seat2', 'seat3', 'seat4'].find((seat) => !used.has(seat)); const member = { uid, displayName, seatId, joinedAt: Timestamp.now(), leftAt: null }; const members = [...room.members, member]; result = { roomId: id, stateVersion: room.stateVersion + 1 }; tx.update(ref, { members, stateVersion: result.stateVersion, expiresAt }); tx.set(memberRef(ref, uid), { ...member, expiresAt }); syncMemberExpiry(tx, ref, room.members, expiresAt); } tx.set(action, { payloadHash, result, expiresAt }); }); return result;
});
const getSnapshot = onCall(options, async (request) => { const uid = uidOf(request); const id = roomId(request); const ref = roomRef(id); const [roomSnap, member] = await Promise.all([ref.get(), memberFor(ref, uid)]); if (!roomSnap.exists) fail('not-found', '部屋が見つかりません。'); return snapshot(roomSnap.data(), member); });
const startGame = onCall(options, async (request) => {
  const uid = uidOf(request); const id = roomId(request); const rid = requestId(request); const stateVersion = Number(request.data?.stateVersion); const payloadHash = hash('start', { id, stateVersion }); const action = actionRef(uid, rid); const ref = roomRef(id); let result;
  await db.runTransaction(async (tx) => { const [roomSnap, actionSnap] = await Promise.all([tx.get(ref), tx.get(action)]); if (actionSnap.exists) { result = replay(actionSnap.data(), payloadHash); return; } const room = roomSnap.data(); if (!room || room.hostUid !== uid) fail('permission-denied', '親だけが開始できます。'); if (room.status !== 'lobby' || room.stateVersion !== stateVersion) fail('failed-precondition', '部屋の状態が変わりました。'); const members = room.members.filter((m) => !m.leftAt); if (members.length !== room.playerCount) fail('failed-precondition', '必要人数が揃っていません。'); const gameId = crypto.randomUUID(); const game = rules.createGame(members, Date.now()); const expiresAt = expiry(); result = { gameId, stateVersion: stateVersion + 1 }; tx.update(ref, { status: 'playing', gameId, game, stateVersion: result.stateVersion, expiresAt }); syncMemberExpiry(tx, ref, members, expiresAt); tx.set(action, { payloadHash, result, expiresAt }); }); return result;
});
const submitAction = onCall(options, async (request) => {
  const uid = uidOf(request); const id = roomId(request); const rid = requestId(request); const gameId = text(request.data?.gameId, 80, 'ゲームID'); const round = Number(request.data?.round); const stateVersion = Number(request.data?.stateVersion); const input = { action: request.data?.action, scout: request.data?.scout === true, accusationTarget: request.data?.accusationTarget || null }; const payloadHash = hash('submit', { id, gameId, round, stateVersion, input }); const action = actionRef(uid, rid); const ref = roomRef(id); let result;
  await db.runTransaction(async (tx) => { const [roomSnap, memberSnap, actionSnap] = await Promise.all([tx.get(ref), tx.get(memberRef(ref, uid)), tx.get(action)]); if (actionSnap.exists) { result = replay(actionSnap.data(), payloadHash); return; } if (!roomSnap.exists || !memberSnap.exists) fail('permission-denied', 'この部屋には参加していません。'); const room = roomSnap.data(); const member = memberSnap.data(); if (room.gameId !== gameId || room.game.round !== round || room.game.ended) fail('failed-precondition', 'ゲームの状態が変わりました。'); try { rules.validateSubmission(room.game, member.seatId, input); } catch (error) { fail('failed-precondition', error.message); } if (room.game.submissions[member.seatId]) fail('failed-precondition', 'このラウンドは確定済みです。'); room.game.submissions[member.seatId] = input; const active = room.game.players.filter((p) => p.active).map((p) => p.id); if (active.every((seat) => room.game.submissions[seat])) rules.resolveRound(room.game); const nextVersion = room.stateVersion + 1; const expiresAt = expiry(); result = { stateVersion: nextVersion, resolved: room.game.round !== round || room.game.ended }; tx.update(ref, { game: room.game, stateVersion: nextVersion, status: room.game.ended ? 'ended' : 'playing', expiresAt }); syncMemberExpiry(tx, ref, room.members, expiresAt); tx.set(action, { payloadHash, result, expiresAt }); }); return result;
});

module.exports = { createRoom, joinRoom, getSnapshot, startGame, submitAction };

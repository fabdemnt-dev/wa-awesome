'use strict';

const crypto = require('node:crypto');
const RULES_VERSION = 'floating-garden-match-1';
// Online rooms always have two authenticated humans; extra seats are server-owned.
const PLAYER_COUNT = 2;
const MAX_NPC_COUNT = 2;
const MAX_PLAYER_COUNT = PLAYER_COUNT + MAX_NPC_COUNT;
const ROOM_TTL_MILLIS = 24 * 60 * 60 * 1000;
const RECEIPT_RETENTION_MILLIS = 7 * ROOM_TTL_MILLIS;

class GardenError extends Error {
  constructor(code, message, details) { super(message); this.name = 'GardenError'; this.code = code; if (details) this.details = details; }
}
function fail(code, message, details) { throw new GardenError(code, message, details); }
function exactObject(value, keys, label = '入力') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    fail('invalid-argument', `${label}の項目を確認してください。`);
  }
}
function uidOf(request) {
  const uid = request?.auth?.uid;
  if (typeof uid !== 'string' || !uid || uid.length > 128 || /[\x00-\x1f\x7f/]/u.test(uid) || ['.', '..'].includes(uid)) fail('unauthenticated', '匿名ログインが必要です。');
  return uid;
}
function requestIdOf(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(value)) fail('invalid-argument', 'リクエストIDが不正です。');
  return value;
}
function idOf(value, label = '部屋ID') {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) fail('invalid-argument', `${label}が不正です。`);
  return value;
}
function revisionOf(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10000) fail('invalid-argument', '状態番号が不正です。');
  return value;
}
function sanitizeDisplayName(value) {
  if (typeof value !== 'string' || value.length > 200) fail('invalid-argument', '表示名は1〜20文字で入力してください。');
  // Text remains data. The UI must still render names/logs via textContent or HTML escaping.
  const clean = value.normalize('NFKC').replace(/[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069<>]/gu, '').replace(/\s+/gu, ' ').trim();
  if (!clean || [...clean].length > 20) fail('invalid-argument', '表示名は1〜20文字で入力してください。');
  return clean;
}
const COMMAND_FIELDS = Object.freeze({
  draw: [], 'use-storage': [], self: [], offer: ['target'], store: [], accept: [], decline: [],
  'request-invite': [], 'pass-invite': [], welcome: [], yield: [], place: ['index', 'rotation'],
  meditate: [], stone: ['index', 'stone'], 'pass-final': [],
});
function npcCountOf(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_NPC_COUNT) fail('invalid-argument', 'NPCは0〜2人で選んでください。');
  return value;
}
function roomPlayerCount(room) {
  const npcCount = room.npcCount === undefined ? 0 : room.npcCount;
  if (!Number.isInteger(npcCount) || npcCount < 0 || npcCount > MAX_NPC_COUNT || room.playerCount !== PLAYER_COUNT + npcCount) {
    fail('internal', '部屋の参加人数を確認できません。');
  }
  return PLAYER_COUNT + npcCount;
}
function commandOf(value, playerCount = MAX_PLAYER_COUNT) {
  if (!value || !Object.hasOwn(COMMAND_FIELDS, value.type)) fail('invalid-argument', '操作を確認してください。');
  exactObject(value, ['type', ...COMMAND_FIELDS[value.type]], '操作');
  if (Object.hasOwn(value, 'target') && (!Number.isInteger(value.target) || value.target < 0 || value.target >= playerCount)) fail('invalid-argument', '譲る席を確認してください。');
  if (Object.hasOwn(value, 'index') && (!Number.isInteger(value.index) || value.index < 0 || value.index > 15)) fail('invalid-argument', '配置するマスを確認してください。');
  if (Object.hasOwn(value, 'rotation') && (!Number.isInteger(value.rotation) || value.rotation < 0 || value.rotation > 3)) fail('invalid-argument', '回転を確認してください。');
  if (Object.hasOwn(value, 'stone') && !['moon', 'wind', 'color', 'echo'].includes(value.stone)) fail('invalid-argument', '石を確認してください。');
  return { ...value };
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function hashPayload(type, payload) { return crypto.createHash('sha256').update(canonicalJson({ type, payload })).digest('hex'); }
function uidKey(uid) { return crypto.createHash('sha256').update(uid).digest('hex'); }
function assertNotExpired(value, now) {
  if (!Number.isSafeInteger(value?.expiresAtMillis) || value.expiresAtMillis <= now) fail('failed-precondition', '部屋の保存期限が切れています。', { reason: 'room-expired' });
}
function requireMember(member, room) {
  if (!member || member.active !== true || !Number.isInteger(member.seat) || member.seat < 0 || member.seat >= PLAYER_COUNT || member.seat >= room.players.length ||
      room.players[member.seat]?.seat !== member.seat || member.isHost !== (member.seat === 0)) fail('permission-denied', 'この部屋には参加していません。');
  return { seat: member.seat, isHost: member.seat === 0 };
}
function publicTile(tile, includeId = false) {
  if (!tile) return null;
  return { ...(includeId ? { id: tile.id } : {}), terrain: tile.terrain, shape: tile.shape, rotation: tile.rotation, stone: tile.stone };
}
/** Deliberately enumerate nested fields too: future secrets never leak by object spread. */
function toPublicSnapshot(state) {
  return {
    version: state.version, revision: state.revision,
    players: state.players.map((player) => ({
      seat: player.seat, id: `p${player.seat}`, name: player.name, isHuman: player.seat < PLAYER_COUNT,
      garden: player.garden.map((tile) => publicTile(tile)), tileIds: player.tileIds.slice(),
      power: player.power, storage: publicTile(player.storage, true), careCount: player.careCount,
    })),
    deckRemaining: state.deck.length - state.deckCursor,
    round: state.round, phase: state.phase, activeSeat: state.activeSeat, prioritySeat: state.prioritySeat,
    step: state.step,
    drawn: state.drawn ? {
      tile: publicTile(state.drawn.tile, true), ownerSeat: state.drawn.ownerSeat, source: state.drawn.source,
      protected: state.drawn.protected, canOffer: state.drawn.canOffer, canStore: state.drawn.canStore,
    } : null,
    offerTarget: state.offerTarget, inviteSeats: state.inviteSeats.slice(), inviteIndex: state.inviteIndex,
    requests: state.requests.slice(), placementSeat: state.placementSeat, afterPlacement: state.afterPlacement,
    finalSeat: state.finalSeat, log: state.log.filter((line) => typeof line === 'string').slice(),
  };
}
function publicRoom(room) {
  const playerCount = roomPlayerCount(room);
  return {
    id: room.id, status: room.status, hostSeat: 0, playerCount,
    ...(playerCount > PLAYER_COUNT ? { npcCount: playerCount - PLAYER_COUNT } : {}),
    gameId: room.gameId, revision: room.revision, rulesVersion: RULES_VERSION,
    expiresAtMillis: room.expiresAtMillis,
    players: room.players.map((player) => ({ seat: player.seat, name: player.name, ...(player.seat >= PLAYER_COUNT ? { isHuman: false } : {}) })),
    // The stored match was already explicitly projected. Reconstruct its whitelist on reads as well.
    match: room.match ? toPublicSnapshot({ ...room.match, deck: { length: room.match.deckRemaining }, deckCursor: 0 }) : null,
    scores: room.scores.map(({ seat, score, rank }) => ({ seat, score, rank })),
  };
}
module.exports = { RULES_VERSION, PLAYER_COUNT, MAX_NPC_COUNT, MAX_PLAYER_COUNT, ROOM_TTL_MILLIS, RECEIPT_RETENTION_MILLIS, GardenError, fail, exactObject,
  uidOf, requestIdOf, idOf, revisionOf, sanitizeDisplayName, npcCountOf, roomPlayerCount, commandOf, hashPayload, uidKey, assertNotExpired,
  requireMember, publicTile, toPublicSnapshot, publicRoom };

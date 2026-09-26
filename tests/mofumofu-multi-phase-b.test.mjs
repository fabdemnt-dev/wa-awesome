import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

// 既存の online integration テストと同じ読み込み方式（functions/ は CommonJS）。
const functionRequire = createRequire(new URL('../functions/package.json', import.meta.url));
const contract = functionRequire('./mofumofu-multi/contract.js');
const rules = functionRequire('./mofumofu-multi/rules.js');

const {
  COLLECTIONS, SCHEMA_VERSION, KIND, INVITE_ALPHABET, INVITE_LENGTH,
  WAITING_TTL_MS, ACTION_TTL_MS, RATE_WINDOW_MS, RATE_FAILURE_LIMIT,
  INVITE_ERROR, EXPIRED_ERROR, FULL_ERROR, ALREADY_STARTED_ERROR,
  ContractError, newInviteCode, inviteCodePattern, isInviteCode, normalizeInviteCode,
  inviteCodeDigest, digest, rateKey,
  initialRoomFields, initialMemberFields, initialSecretFields, initialInviteFields,
  seatForUid, occupiedSeats, playerCountOf, isRoomFull, nextFreeSeat, inviteStatusAfterJoin,
  joinDecision, joinRoomUpdate, startDecision, handsByUid, roomAfterStart,
  actionFingerprint, sameFingerprint, replayAction, publicRoomViolations, FORBIDDEN_PUBLIC_KEYS,
} = contract;

const { SEAT_IDS, MIN_PLAYERS, MAX_PLAYERS, PLAYER_STATUS, TURN_STATE, handSizeFor, leftoversFor } = rules;

const MULTI_DIR = new URL('../functions/mofumofu-multi/', import.meta.url);
const INDEX_SOURCE = readFileSync(new URL('index.js', MULTI_DIR), 'utf8');
const ONLINE_SOURCE = readFileSync(new URL('../functions/mofumofu-online/index.js', import.meta.url), 'utf8');

const NOW = 1_700_000_000_000;
const DELETE_AT = NOW + 60 * 60 * 1000;

// seat順を持つ waiting room を作る（Firestoreの実docと同じ平坦構造）。
function waitingRoom(uids, { status = 'waiting', joinExpiresAt = NOW + WAITING_TTL_MS } = {}) {
  const seatOrder = SEAT_IDS.slice(0, uids.length);
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: KIND,
    roomId: 'room-1',
    status,
    hostUid: uids[0],
    seatOrder,
    playerUids: Object.fromEntries(seatOrder.map((seat, i) => [seat, uids[i]])),
    playerStatus: Object.fromEntries(seatOrder.map((seat) => [seat, PLAYER_STATUS.ACTIVE])),
    handCounts: Object.fromEntries(seatOrder.map((seat) => [seat, 0])),
    faceUpCards: Object.fromEntries(seatOrder.map((seat) => [seat, []])),
    joinExpiresAt,
    startedAt: null,
    dealt: false,
    currentTurnPlayerId: null,
    turnState: TURN_STATE.WAITING,
  };
}
function activeInvite(now = NOW) {
  return { roomId: 'room-1', status: 'active', createdAt: now, expiresAt: now + WAITING_TTL_MS, revokedAt: null };
}
const ids = (n) => Array.from({ length: n }, (_, i) => `u${i + 1}`);

test('collection名は3〜6人版専用で、既存オンライン版と共有しない', () => {
  const values = Object.values(COLLECTIONS);
  assert.equal(new Set(values).size, values.length, 'collection名が重複している');
  // トップレベルcollectionは専用名。members / privateHands / serverState は room 配下のsubcollection。
  const topLevelKeys = ['rooms', 'invites', 'roomSecrets', 'actionRequests', 'rateLimits'];
  for (const key of topLevelKeys) assert.match(COLLECTIONS[key], /^mofumofuMulti/);
  for (const key of ['members', 'privateHands', 'serverState']) {
    assert.match(COLLECTIONS[key], /^[a-z][A-Za-z]*$/, `${key} がsubcollection名として不自然`);
  }
  const topLevel = topLevelKeys.map((key) => COLLECTIONS[key]);
  const onlineCollections = [...ONLINE_SOURCE.matchAll(/\.collection\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  for (const name of topLevel) {
    assert.ok(!onlineCollections.includes(name), `既存版とcollectionを共有している: ${name}`);
  }
});

test('招待コードは8文字alphabetで、正規化とdigestが安定している', () => {
  assert.equal(INVITE_ALPHABET.includes('I'), false);
  assert.equal(INVITE_ALPHABET.includes('O'), false);
  assert.equal(INVITE_ALPHABET.includes('0'), false);
  const codes = new Set();
  for (let i = 0; i < 200; i += 1) {
    const code = newInviteCode();
    assert.equal(code.length, INVITE_LENGTH);
    assert.ok(isInviteCode(code), `形式不正: ${code}`);
    assert.ok(new RegExp(inviteCodePattern()).test(code));
    codes.add(code);
  }
  assert.ok(codes.size > 190, '招待コードの重複が多すぎる');
  assert.equal(normalizeInviteCode('  abcd2345  '), 'ABCD2345');
  assert.equal(inviteCodeDigest('ABCD2345'), inviteCodeDigest('ABCD2345'));
  assert.match(inviteCodeDigest('ABCD2345'), /^[0-9a-f]{64}$/);
  assert.notEqual(inviteCodeDigest('ABCD2345'), inviteCodeDigest('ABCD2346'));
  assert.match(digest('uid-1'), /^[0-9a-f]{64}$/);
  assert.equal(rateKey('join_uid', 'abc'), 'join_uid_abc');
  assert.throws(() => normalizeInviteCode(123), (e) => e.isContractError && e.code === 'invalid-argument');
  assert.throws(() => normalizeInviteCode('ABCDI234'), (e) => e.isContractError && e.code === 'failed-precondition');
  assert.throws(() => normalizeInviteCode('abcd'), (e) => e.isContractError && e.code === 'failed-precondition');
  assert.equal(isInviteCode('ABCDI234'), false);
});

test('initialRoomFields は公開roomを作り、秘密を一切含めない', () => {
  const room = initialRoomFields({ roomId: 'r1', hostUid: 'u1', now: NOW, deleteAt: DELETE_AT });
  assert.deepEqual(publicRoomViolations(room), []);
  assert.equal(room.status, 'waiting');
  assert.equal(room.kind, KIND);
  assert.equal(room.schemaVersion, SCHEMA_VERSION);
  assert.equal(room.minPlayers, MIN_PLAYERS);
  assert.equal(room.maxPlayers, MAX_PLAYERS);
  assert.deepEqual(room.seatOrder, ['S1']);
  assert.equal(room.playerUids.S1, 'u1');
  assert.equal(room.players.S1.joined, true);
  assert.equal(room.playerStatus.S1, PLAYER_STATUS.ACTIVE);
  assert.deepEqual(room.handCounts, { S1: 0 });
  assert.equal(room.currentTurnPlayerId, null);
  assert.equal(room.turnState, TURN_STATE.WAITING);
  assert.equal(room.dealt, false);
  assert.equal(room.startedAt, null);
  assert.equal(room.joinExpiresAt, NOW + WAITING_TTL_MS);
  assert.equal(room.deleteAt, DELETE_AT);
  assert.equal('inviteCode' in room, false);
  assert.equal('inviteDigest' in room, false);
});

test('初期documentはinviteの平文コードを保持しない（digest方式）', () => {
  const invite = initialInviteFields({ roomId: 'r1', now: NOW, deleteAt: DELETE_AT });
  assert.deepEqual(Object.keys(invite).sort(), ['createdAt', 'deleteAt', 'expiresAt', 'revokedAt', 'roomId', 'status']);
  assert.equal(invite.status, 'active');
  assert.equal(invite.expiresAt, NOW + WAITING_TTL_MS);
  assert.equal('inviteCode' in invite, false);
  for (const value of Object.values(invite)) {
    assert.ok(typeof value !== 'string' || !isInviteCode(value), '平文らしきコードを保存している');
  }
  const secret = initialSecretFields({ inviteDigest: 'x'.repeat(64), createdAt: NOW, deleteAt: DELETE_AT });
  assert.deepEqual(Object.keys(secret).sort(), ['createdAt', 'deleteAt', 'inviteDigest']);
  const member = initialMemberFields({ uid: 'u1', seatId: 'S1', joinedAt: NOW, deleteAt: DELETE_AT });
  assert.deepEqual(member, { uid: 'u1', seatId: 'S1', joinedAt: NOW, deleteAt: DELETE_AT });
});

test('seat計算（seatForUid / occupiedSeats / nextFreeSeat / playerCountOf）', () => {
  const room = waitingRoom(ids(3));
  assert.equal(seatForUid(room, 'u1'), 'S1');
  assert.equal(seatForUid(room, 'u3'), 'S3');
  assert.equal(seatForUid(room, 'nobody'), null);
  assert.deepEqual(occupiedSeats(room), ['S1', 'S2', 'S3']);
  assert.equal(playerCountOf(room), 3);
  assert.equal(nextFreeSeat(room), SEAT_IDS[3]);
  assert.equal(isRoomFull(room), false);
  // 欠番があっても空きseatは若い番号から埋める。
  const gapped = { seatOrder: ['S1', 'S3'], playerUids: { S1: 'a', S3: 'b' } };
  assert.equal(nextFreeSeat(gapped), 'S2');
  const full = waitingRoom(ids(MAX_PLAYERS));
  assert.equal(nextFreeSeat(full), null);
  assert.equal(isRoomFull(full), true);
  assert.equal(inviteStatusAfterJoin(MAX_PLAYERS - 1), 'active');
  assert.equal(inviteStatusAfterJoin(MAX_PLAYERS), 'full');
});

test('joinDecision: 空きseatへ順に着席する', () => {
  const room = waitingRoom(ids(3));
  const decision = joinDecision(room, activeInvite(), { uid: 'u9', now: NOW });
  assert.deepEqual(decision, { ok: true, action: 'join', seatId: SEAT_IDS[3], playerCount: 4 });
  const update = joinRoomUpdate(room, decision.seatId, 'u9', NOW);
  assert.deepEqual(Object.keys(update).sort(), [
    'faceUpCards.S4', 'handCounts.S4', 'playerStatus.S4', 'playerUids.S4', 'players.S4', 'seatOrder',
  ]);
  assert.deepEqual(update.seatOrder, ['S1', 'S2', 'S3', 'S4']);
  assert.equal(update['playerUids.S4'], 'u9');
  assert.equal(update['handCounts.S4'], 0);
  assert.deepEqual(update['faceUpCards.S4'], []);
});

test('joinDecision: 同一UIDは席を増やさず既存seatを返す（満員・invite fullでも）', () => {
  const full = waitingRoom(ids(MAX_PLAYERS));
  const fullInvite = { ...activeInvite(), status: 'full' };
  const decision = joinDecision(full, fullInvite, { uid: 'u3', now: NOW });
  assert.deepEqual(decision, { ok: true, action: 'existing-seat', seatId: 'S3', playerCount: MAX_PLAYERS });
});

test('joinDecision: invite不正・期限切れは failed-precondition', () => {
  const room = waitingRoom(ids(2));
  assert.deepEqual(joinDecision(room, null, { uid: 'x', now: NOW }), { ok: false, code: 'failed-precondition', message: INVITE_ERROR });
  assert.deepEqual(joinDecision(room, { ...activeInvite(), status: 'started' }, { uid: 'x', now: NOW }), { ok: false, code: 'failed-precondition', message: INVITE_ERROR });
  assert.deepEqual(joinDecision(room, { ...activeInvite(), status: 'full' }, { uid: 'x', now: NOW }), { ok: false, code: 'failed-precondition', message: INVITE_ERROR });
  const expiredInvite = { ...activeInvite(), expiresAt: NOW - 1 };
  assert.deepEqual(joinDecision(room, expiredInvite, { uid: 'x', now: NOW }), { ok: false, code: 'failed-precondition', message: INVITE_ERROR });
});

test('joinDecision: 開始済みは ALREADY_STARTED、参加期限切れは EXPIRED_ERROR', () => {
  for (const status of ['playing', 'finished']) {
    const room = waitingRoom(ids(2), { status });
    assert.deepEqual(joinDecision(room, activeInvite(), { uid: 'x', now: NOW }), { ok: false, code: 'failed-precondition', message: ALREADY_STARTED_ERROR });
  }
  // inviteがstartedのまま部屋も開始済みなら、コード不正ではなく開始済みとして伝える。
  const startedInvite = { ...activeInvite(), status: 'started' };
  assert.deepEqual(
    joinDecision(waitingRoom(ids(3), { status: 'playing' }), startedInvite, { uid: 'x', now: NOW }),
    { ok: false, code: 'failed-precondition', message: ALREADY_STARTED_ERROR },
  );
  const stale = waitingRoom(ids(2), { joinExpiresAt: NOW - 1 });
  assert.deepEqual(joinDecision(stale, activeInvite(), { uid: 'x', now: NOW }), { ok: false, code: 'failed-precondition', message: EXPIRED_ERROR });
});

test('joinDecision: 7人目は resource-exhausted で明確に拒否する', () => {
  const full = waitingRoom(ids(MAX_PLAYERS));
  assert.deepEqual(joinDecision(full, activeInvite(), { uid: 'u9', now: NOW }), { ok: false, code: 'resource-exhausted', message: FULL_ERROR });
  // inviteがfullへ更新済みでも、満員の理由を「満員」として返す。
  assert.deepEqual(
    joinDecision(full, { ...activeInvite(), status: 'full' }, { uid: 'u9', now: NOW }),
    { ok: false, code: 'resource-exhausted', message: FULL_ERROR },
  );
  // seatが6つ揃っていなくても uid が6人いれば満員扱い。
  const crowded = { ...waitingRoom(ids(MAX_PLAYERS)), seatOrder: SEAT_IDS.slice(0, MAX_PLAYERS) };
  assert.equal(playerCountOf(crowded), MAX_PLAYERS);
});

test('startDecision: host限定・人数不足拒否・開始済み拒否', () => {
  const room = waitingRoom(ids(3));
  assert.deepEqual(startDecision(null, { uid: 'u1', now: NOW }), { ok: false, code: 'not-found', message: '部屋が見つかりません。' });
  assert.deepEqual(startDecision({ ...room, kind: 'online' }, { uid: 'u1', now: NOW }), { ok: false, code: 'not-found', message: '部屋が見つかりません。' });
  assert.deepEqual(startDecision(room, { uid: 'u2', now: NOW }), { ok: false, code: 'permission-denied', message: 'ホストだけが開始できます。' });
  const two = waitingRoom(ids(2));
  assert.deepEqual(startDecision(two, { uid: 'u1', now: NOW }), { ok: false, code: 'failed-precondition', message: `${MIN_PLAYERS}人そろっていません。` });
  for (const started of [{ ...room, status: 'playing' }, { ...room, dealt: true }, { ...room, startedAt: NOW }]) {
    assert.deepEqual(startDecision(started, { uid: 'u1', now: NOW }), { ok: false, code: 'already-exists', message: ALREADY_STARTED_ERROR });
  }
  const stale = waitingRoom(ids(3), { joinExpiresAt: NOW - 1 });
  assert.deepEqual(startDecision(stale, { uid: 'u1', now: NOW }), { ok: false, code: 'failed-precondition', message: EXPIRED_ERROR });
});

test('startDecision: 3〜6人で成功し、seatOrderを返す', () => {
  for (const count of [3, 4, 5, 6]) {
    const room = waitingRoom(ids(count));
    const decision = startDecision(room, { uid: 'u1', now: NOW });
    assert.equal(decision.ok, true);
    assert.equal(decision.playerCount, count);
    assert.deepEqual(decision.seatOrder, SEAT_IDS.slice(0, count));
  }
});

test('startDecision: 参加状態の不整合を拒否する', () => {
  const room = waitingRoom(ids(3));
  const missing = { ...room, seatOrder: ['S1', 'S3'] };
  assert.equal(startDecision(missing, { uid: 'u1', now: NOW }).code, 'failed-precondition');
  const hole = { ...room, playerUids: { S1: 'u1', S3: 'u3' } };
  assert.equal(startDecision(hole, { uid: 'u1', now: NOW }).code, 'failed-precondition');
  const left = { ...room, playerStatus: { S1: PLAYER_STATUS.ACTIVE, S2: PLAYER_STATUS.LEFT, S3: PLAYER_STATUS.ACTIVE } };
  assert.equal(startDecision(left, { uid: 'u1', now: NOW }).code, 'failed-precondition');
  const dealt = { ...room, handCounts: { S1: 0, S2: 3, S3: 0 } };
  assert.deepEqual(startDecision(dealt, { uid: 'u1', now: NOW }), { ok: false, code: 'failed-precondition', message: '配布済みの状態です。' });
});

test('handsByUid と roomAfterStart は uid 単位の秘密と公開fieldだけを返す', () => {
  const room = waitingRoom(ids(3));
  const hands = { S1: ['c1', 'c2'], S2: ['c3'], S3: [] };
  const byUid = handsByUid(room.seatOrder, room.playerUids, hands);
  assert.deepEqual(byUid, { u1: ['c1', 'c2'], u2: ['c3'], u3: [] });
  byUid.u1.push('extra');
  assert.deepEqual(hands.S1, ['c1', 'c2'], 'Phase A の手札を破壊している');

  const after = roomAfterStart(room, { now: NOW, handSize: handSizeFor(3), deleteAt: DELETE_AT });
  assert.equal(after.status, 'playing');
  assert.equal(after.dealt, true);
  assert.equal(after.startedAt, NOW);
  assert.equal(after.currentTurnPlayerId, 'S1');
  assert.equal(after.turnState, TURN_STATE.AWAITING_OFFER);
  assert.deepEqual(after.handCounts, { S1: handSizeFor(3), S2: handSizeFor(3), S3: handSizeFor(3) });
  assert.equal('hands' in after, false);
  assert.equal('leftovers' in after, false);
  assert.equal('inviteDigest' in after, false);
  assert.equal(after.deleteAt, DELETE_AT);
});

test('人数別の手札数・余りは Phase A 契約と一致する', () => {
  assert.deepEqual([3, 4, 5, 6].map((n) => handSizeFor(n)), [10, 8, 6, 5]);
  assert.deepEqual([3, 4, 5, 6].map((n) => leftoversFor(n)), [2, 0, 2, 2]);
  for (const count of [3, 4, 5, 6]) {
    assert.equal(count * handSizeFor(count) + leftoversFor(count), 32);
  }
});

test('actionId 冪等性: 同一payloadは初回結果、payload違いは already-exists', () => {
  const fingerprint = actionFingerprint('multi-join', 'u1', '', { inviteDigest: 'abc' });
  assert.deepEqual(fingerprint, { type: 'multi-join', uid: 'u1', roomId: '', inviteDigest: 'abc' });
  assert.equal(sameFingerprint(fingerprint, { ...fingerprint }), true);
  assert.equal(sameFingerprint(fingerprint, { ...fingerprint, inviteDigest: 'xyz' }), false);
  assert.equal(sameFingerprint(fingerprint, null), false);
  assert.equal(sameFingerprint(null, null), false);
  const action = { fingerprint, result: { roomId: 'r1', seatId: 'S2' } };
  assert.deepEqual(replayAction(action, fingerprint), { roomId: 'r1', seatId: 'S2' });
  assert.throws(
    () => replayAction(action, { ...fingerprint, inviteDigest: 'xyz' }),
    (e) => e instanceof ContractError && e.isContractError && e.code === 'already-exists',
  );
  assert.throws(() => replayAction(null, fingerprint), (e) => e.code === 'already-exists');
});

test('publicRoomViolations は公開roomへの秘密混入を検出する', () => {
  assert.deepEqual(publicRoomViolations({}), []);
  assert.deepEqual(publicRoomViolations(undefined), []);
  const dirty = { hands: { S1: [] }, leftovers: [], pendingOffer: null, inviteCode: 'ABCD2345', inviteDigest: 'x' };
  assert.deepEqual(publicRoomViolations(dirty).sort(), ['hands', 'inviteCode', 'inviteDigest', 'leftovers', 'pendingOffer']);
  for (const key of FORBIDDEN_PUBLIC_KEYS) assert.deepEqual(publicRoomViolations({ [key]: 1 }), [key]);
});

test('index.js は別系統で、既存版・RTDB・新Secretに依存しない', () => {
  assert.ok(INDEX_SOURCE.includes("./contract"), 'contract.js を参照していない');
  assert.ok(INDEX_SOURCE.includes("./rules"), 'rules.js を参照していない');
  // コメントではなく実際の require だけを見る。
  assert.equal(/require\(\s*['"][^'"]*mofumofu-online/.test(INDEX_SOURCE), false, '既存版モジュールを参照している');
  assert.equal(/require\(\s*['"][^'"]*\/database/.test(INDEX_SOURCE), false, 'RTDBへ依存している');
  assert.equal(INDEX_SOURCE.includes('getDatabase'), false, 'RTDBへ依存している');
  const secrets = [...INDEX_SOURCE.matchAll(/defineSecret\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(secrets, ['MOFUMOFU_ONLINE_IP_HMAC_KEY'], '新Secretを追加している');
  for (const name of ['createMofumofuMultiRoom', 'joinMofumofuMultiRoom', 'startMofumofuMultiGame']) {
    assert.ok(INDEX_SOURCE.includes(name), `Callable名が無い: ${name}`);
  }
  // 実deploy・scheduler登録はPhase Bの対象外。
  assert.equal(INDEX_SOURCE.includes('onSchedule'), false, 'schedulerを登録している');
  assert.ok(INDEX_SOURCE.includes('MOFUMOFU_DIRECT_HANDLERS'), 'テスト用フォールバックが無い');
  assert.equal(ACTION_TTL_MS > 0 && RATE_WINDOW_MS > 0 && RATE_FAILURE_LIMIT > 0, true);
});

test('Phase A の純粋核は変更されずに再利用されている', () => {
  for (const name of ['createDeck', 'shuffle', 'dealDeck', 'handSizeFor', 'leftoversFor', 'validatePlayerCount', 'toPublicRoom']) {
    assert.equal(typeof rules[name], 'function', `rules.${name} が無い`);
  }
  const deck = rules.createDeck();
  assert.equal(deck.length, 32);
  assert.deepEqual(rules.shuffle(deck).length, 32);
});

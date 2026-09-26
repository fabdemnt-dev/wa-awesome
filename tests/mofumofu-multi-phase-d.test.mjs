import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

// Phase D（presence / resume / 一時切断・復帰）の純粋契約テスト。
// Firebaseへは依存せず、presence.js の判断・resume応答の形・秘密分離・Rulesの契約を機械的に確認する。
// RTDB Rulesの実評価は tests/mofumofu-multi-phase-d-rules.test.mjs（Emulator）が担う。
const functionRequire = createRequire(new URL('../functions/package.json', import.meta.url));
const presence = functionRequire('./mofumofu-multi/presence.js');
const rules = functionRequire('./mofumofu-multi/rules.js');

const { SEAT_IDS, PLAYER_STATUS, ROOM_STATUS, TURN_STATE } = rules;
const { SESSION_REASONS } = presence;

const readText = (relative) => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
const indexSource = readText('../functions/mofumofu-multi/index.js');
const databaseRules = JSON.parse(readText('../database.rules.json'));
const firestoreRules = readText('../firestore.rules');

const shaJson = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const shaText = (value) => createHash('sha256').update(value).digest('hex');
// Phase D が既存2人＋こはる版のRulesを変更していないことを固定する（変更したらここで落ちる）。
const ONLINE_PRESENCE_HASH = '7ecd6563001b46c3d5b678f40ea65f4a167e78d63d9da30fe39344890679b216';
const ONLINE_ACCESS_HASH = 'fa00db796f393a060a12142eca2d85baa4a3beecdef8635dcbdc6854e13608d2';
const FIRESTORE_ONLINE_BLOCK_HASH = '982cbddaede60b027323a83a48374db68ec07ec0f88443e6a66325a99faf5445';

const NOW = Date.now();
const card = (animalType, cardId) => ({ cardId, animalType });

/* ------------------------------------------------------------------ fixture */

function baseRoom(count, overrides = {}) {
  const seats = SEAT_IDS.slice(0, count);
  const playerUids = Object.fromEntries(seats.map((seat) => [seat, `uid-${seat}`]));
  const room = {
    schemaVersion: 2,
    kind: 'multi',
    roomId: 'room-phase-d',
    status: ROOM_STATUS.WAITING,
    hostUid: playerUids.S1,
    createdAt: NOW - 60000,
    joinExpiresAt: NOW + 30 * 60 * 1000,
    startedAt: null,
    dealt: false,
    minPlayers: 3,
    maxPlayers: 6,
    seatOrder: seats,
    players: Object.fromEntries(seats.map((seat) => [seat, { seatId: seat, joined: true, joinedAt: NOW }])),
    playerUids,
    playerStatus: Object.fromEntries(seats.map((seat) => [seat, PLAYER_STATUS.ACTIVE])),
    handCounts: Object.fromEntries(seats.map((seat) => [seat, 0])),
    faceUpCards: Object.fromEntries(seats.map((seat) => [seat, []])),
    currentTurnPlayerId: null,
    turnState: TURN_STATE.WAITING,
    turnNumber: 0,
    publicOffer: null,
    winnerPlayerIds: [],
    loserPlayerIds: [],
    leftPlayerIds: [],
    draw: false,
    finishReason: null,
    gatheringReason: null,
    finalResult: null,
    deleteAt: NOW + 6 * 60 * 60 * 1000,
  };
  return { ...room, ...overrides };
}
function playingRoom(count, overrides = {}) {
  return baseRoom(count, {
    status: ROOM_STATUS.PLAYING,
    dealt: true,
    startedAt: NOW - 5000,
    turnState: TURN_STATE.AWAITING_OFFER,
    currentTurnPlayerId: SEAT_IDS[0],
    handCounts: Object.fromEntries(SEAT_IDS.slice(0, count).map((seat) => [seat, rules.handSizeFor(count)])),
    ...overrides,
  });
}
function finishedRoom(count, overrides = {}) {
  const seats = SEAT_IDS.slice(0, count);
  return baseRoom(count, {
    status: ROOM_STATUS.FINISHED,
    dealt: true,
    turnState: TURN_STATE.FINISHED,
    currentTurnPlayerId: null,
    turnNumber: 20,
    finishReason: rules.FINISH_REASON.GATHERING,
    gatheringReason: rules.GATHERING_REASON.ALL_EIGHT_TYPES,
    winnerPlayerIds: seats.slice(0, count - 1),
    loserPlayerIds: [seats[count - 1]],
    finalResult: {
      finishReason: 'gathering',
      gatheringReason: 'all-eight-types',
      winnerPlayerIds: seats.slice(0, count - 1),
      players: seats.map((seat) => ({ seatId: seat, faceUpCardsTotal: 1 })),
    },
    ...overrides,
  });
}
function handlerBody(name) {
  const start = indexSource.indexOf(`async function ${name}(request) {`);
  assert.ok(start >= 0, `${name} が見つからない`);
  const rest = indexSource.slice(start);
  const next = rest.indexOf('\nasync function ');
  return next > 0 ? rest.slice(0, next) : rest;
}

/* ----------------------------------------------------------------- authorize */

test('authorize: 未認証は呼び出し前に拒否し、非member・roomなしも拒否する', () => {
  // index.js は Auth → 入力 → Firestore の順で確認する（AuthはFirebase依存のためsourceで確認）。
  const body = handlerBody('authorizePresenceHandler');
  assert.ok(body.includes('const uid = authUid(request);'), 'Auth必須の確認が無い');
  assert.ok(body.includes("exactFields(request.data, ['roomId']);"), '入力はroomIdだけに限定されていない');
  assert.equal(indexSource.includes('request.data.seatId'), false, 'client申告のseatIdを読んでいる');

  // roomなし / 別kind / 非member。
  assert.deepEqual(presence.authorizePrecondition(null, { uid: 'uid-S1', now: NOW }),
    { ok: false, code: 'not-found', message: presence.ROOM_GONE_ERROR, reason: SESSION_REASONS.ROOM_NOT_FOUND });
  const otherKind = baseRoom(3, { kind: 'two-player' });
  assert.equal(presence.authorizePrecondition(otherKind, { uid: 'uid-S1', now: NOW }).reason, SESSION_REASONS.ROOM_NOT_FOUND);
  const room = baseRoom(3);
  const denied = presence.authorizePrecondition(room, { uid: 'stranger', now: NOW });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'permission-denied');
  assert.equal(denied.reason, SESSION_REASONS.NOT_MEMBER);
});

test('authorize: memberには正しいseatを返し、waiting / playing / finished を許可する', () => {
  for (const count of [3, 4, 5, 6]) {
    const room = baseRoom(count);
    for (const seat of room.seatOrder) {
      const decision = presence.authorizePrecondition(room, { uid: room.playerUids[seat], now: NOW });
      assert.equal(decision.ok, true, `${count}人 ${seat}`);
      assert.equal(decision.seatId, seat);
    }
  }
  for (const status of [ROOM_STATUS.WAITING, ROOM_STATUS.PLAYING, ROOM_STATUS.FINISHED]) {
    const room = baseRoom(3, { status });
    assert.equal(presence.authorizePrecondition(room, { uid: 'uid-S2', now: NOW }).ok, true, status);
  }
  const unknown = baseRoom(3, { status: 'closed' });
  const decision = presence.authorizePrecondition(unknown, { uid: 'uid-S2', now: NOW });
  assert.equal(decision.code, 'failed-precondition');
  assert.equal(decision.reason, SESSION_REASONS.ROOM_STATUS);
});

test('authorize: seatはserverがFirestore正本から解決し、client申告では決まらない', () => {
  const room = baseRoom(6);
  const decision = presence.authorizePrecondition(room, { uid: room.playerUids.S4, now: NOW });
  assert.equal(decision.seatId, 'S4');
  // accessへ書くfieldはuid / roomId / seatId / expiresAt だけ（connectionIdも秘密も入れない）。
  const access = presence.accessFields({ uid: room.playerUids.S4, roomId: room.roomId, seatId: decision.seatId, expiresAt: NOW + 1 });
  assert.deepEqual(Object.keys(access).sort(), ['expiresAt', 'roomId', 'seatId', 'uid']);
  const body = handlerBody('authorizePresenceHandler');
  assert.ok(body.includes('seatId: decision.seatId'), 'server解決のseat以外を書いている可能性がある');
  assert.ok(body.includes('presence.accessPath(roomId, uid)'), 'accessの書込み先が契約と違う');
  // RTDB Rules側もaccessのseatId一致を要求している（静的契約はこのファイルのRTDB Rulesテストで確認）。
  const connection = databaseRules.rules.mofumofuMultiPresence.$roomId.$uid.connections.$connectionId;
  assert.ok(connection['.validate'].includes("newData.child('seatId').val() === root.child('mofumofuMultiPresenceAccess')"));
});

test('access: 5分で失効し、期限ちょうどは失効扱い（既存版と同じ expiresAt > now）', () => {
  assert.equal(presence.PRESENCE_ACCESS_TTL_MS, 5 * 60 * 1000);
  const base = { uid: 'uid-S1', roomId: 'room-phase-d', seatId: 'S1' };
  const expiresAt = NOW + presence.PRESENCE_ACCESS_TTL_MS;
  assert.equal(presence.accessValid({ ...base, expiresAt }, { uid: 'uid-S1', roomId: 'room-phase-d', now: NOW }), true);
  assert.equal(presence.accessValid({ ...base, expiresAt }, { uid: 'uid-S1', roomId: 'room-phase-d', now: expiresAt - 1 }), true);
  assert.equal(presence.accessValid({ ...base, expiresAt }, { uid: 'uid-S1', roomId: 'room-phase-d', now: expiresAt }), false);
  assert.equal(presence.accessValid({ ...base, expiresAt }, { uid: 'uid-S1', roomId: 'room-phase-d', now: expiresAt + 1 }), false);
  // uid / roomId / seat の不一致も拒否する。
  assert.equal(presence.accessValid({ ...base, expiresAt }, { uid: 'other', roomId: 'room-phase-d', now: NOW }), false);
  assert.equal(presence.accessValid({ ...base, expiresAt }, { uid: 'uid-S1', roomId: 'other-room', now: NOW }), false);
  assert.equal(presence.accessValid({ ...base, seatId: 'S7', expiresAt }, { uid: 'uid-S1', roomId: 'room-phase-d', now: NOW }), false);
  assert.equal(presence.accessValid({ ...base, seatId: 'A', expiresAt }, { uid: 'uid-S1', roomId: 'room-phase-d', now: NOW }), false);
  assert.equal(presence.accessValid({ ...base, expiresAt: undefined }, { uid: 'uid-S1', roomId: 'room-phase-d', now: NOW }), false);
});

/* -------------------------------------------------------------------- resume */

test('resume: roomなし / 非member / 保存期限切れ を区別して拒否する（Phase Eの入口復帰用）', () => {
  const missing = presence.resumePrecondition(undefined, { uid: 'uid-S1', now: NOW });
  assert.equal(missing.code, 'not-found');
  assert.equal(missing.reason, SESSION_REASONS.ROOM_NOT_FOUND);
  const room = baseRoom(3);
  const stranger = presence.resumePrecondition(room, { uid: 'stranger', now: NOW });
  assert.equal(stranger.code, 'permission-denied');
  assert.equal(stranger.reason, SESSION_REASONS.NOT_MEMBER);
  // TTL切れ（numberとFirestore Timestampの両方で同じ判定）。
  const byNumber = presence.resumePrecondition(baseRoom(3, { deleteAt: NOW - 1 }), { uid: 'uid-S1', now: NOW });
  assert.equal(byNumber.code, 'failed-precondition');
  assert.equal(byNumber.reason, SESSION_REASONS.ROOM_EXPIRED);
  const byTimestamp = presence.resumePrecondition(
    baseRoom(3, { deleteAt: { toMillis: () => NOW - 1 } }), { uid: 'uid-S1', now: NOW },
  );
  assert.equal(byTimestamp.reason, SESSION_REASONS.ROOM_EXPIRED);
  assert.equal(presence.resumePrecondition(baseRoom(3, { deleteAt: NOW + 1000 }), { uid: 'uid-S1', now: NOW }).ok, true);
});

test('resume(waiting): hostとparticipantが同じseatへ戻り、手札は未配布のまま', () => {
  for (const seat of ['S1', 'S2', 'S3']) {
    const room = baseRoom(3);
    const before = JSON.parse(JSON.stringify(room));
    const result = presence.resumeResult({ roomId: room.roomId, room, seatId: seat, handCards: null, handStatus: 'pending' });
    assert.equal(result.status, ROOM_STATUS.WAITING);
    assert.equal(result.seatId, seat);
    assert.equal(result.cards, null, 'waitingで手札を返している');
    assert.equal(result.handStatus, 'pending');
    assert.equal(result.isMyTurn, false);
    assert.equal(result.mustJudge, false);
    assert.equal(result.finalResult, null);
    assert.equal(result.handCounts[seat], 0);
    assert.deepEqual(presence.resumeViolations(result), []);
    assert.equal(presence.gameStateChanged(before, room), false, 'resumeがroomを書き換えている');
  }
});

test('resume(playing): S1〜S6が同じseatへ戻り、自分の手札だけを取得する', () => {
  for (const count of [3, 4, 5, 6]) {
    const room = playingRoom(count);
    const hands = Object.fromEntries(room.seatOrder.map((seat) => [seat, [card('cat', `card-${seat}`), card('fox', `card2-${seat}`)]]));
    const before = JSON.parse(JSON.stringify(room));
    for (const seat of room.seatOrder) {
      const uid = room.playerUids[seat];
      // 実データは privateHands/{uid} なので、resumeはuidの手札だけを読む。
      assert.ok(handlerBody('resumeRoomHandler').includes('r.hand(uid)'), '自分の手札以外を読んでいる可能性がある');
      const result = presence.resumeResult({ roomId: room.roomId, room, seatId: seat, handCards: hands[seat], handStatus: 'ready' });
      assert.equal(result.seatId, seat, `${count}人 ${seat} のseatが変わった`);
      assert.equal(result.handStatus, 'ready');
      assert.deepEqual(result.cards, hands[seat], `${seat}の手札が本人分と違う`);
      const json = JSON.stringify(result);
      for (const other of room.seatOrder.filter((candidate) => candidate !== seat)) {
        assert.equal(json.includes(`card-${other}`), false, `${seat}の応答へ${other}の手札が漏れている`);
        assert.equal(json.includes(`card2-${other}`), false, `${seat}の応答へ${other}の手札が漏れている`);
      }
      assert.deepEqual(presence.resumeViolations(result), []);
      // 新しいseatは払い出さない。
      assert.deepEqual(result.seatOrder, room.seatOrder);
      assert.equal(result.seatOrder.length, count);
    }
    assert.equal(presence.gameStateChanged(before, room), false);
  }
});

test('resume(playing): 自分の手番だけisMyTurnで、他人の手番ではgame stateを動かさない', () => {
  const room = playingRoom(4, { currentTurnPlayerId: 'S3' });
  const before = JSON.parse(JSON.stringify(room));
  for (const seat of room.seatOrder) {
    const result = presence.resumeResult({ roomId: room.roomId, room, seatId: seat, handCards: [card('cat', `card-${seat}`)], handStatus: 'ready' });
    assert.equal(result.isMyTurn, seat === 'S3', `${seat}の手番判定が違う`);
    assert.equal(result.currentTurnPlayerId, 'S3', 'resumeが手番を動かしている');
    assert.equal(result.turnState, TURN_STATE.AWAITING_OFFER);
    assert.equal(result.mustJudge, false);
  }
  assert.equal(presence.gameStateChanged(before, room), false, 'resumeが手番を変更している');
});

test('resume(awaitingJudgment): 受取人だけmustJudge=true、実カードは返らない', () => {
  const room = playingRoom(4, {
    turnState: TURN_STATE.AWAITING_JUDGMENT,
    currentTurnPlayerId: 'S1',
    publicOffer: { status: 'pending', fromPlayerId: 'S1', toPlayerId: 'S2', claimAnimal: 'cat', actionId: 'action-1' },
  });
  const secretCard = card('cat', 'secret-lie-card');
  const before = JSON.parse(JSON.stringify(room));
  const recipient = presence.resumeResult({ roomId: room.roomId, room, seatId: 'S2', handCards: [card('bear', 'own-card')], handStatus: 'ready' });
  assert.equal(recipient.mustJudge, true, '受取人なのに判定が必要と分からない');
  assert.equal(recipient.isMyTurn, false);
  assert.equal(recipient.publicOffer.status, 'pending');
  assert.equal(recipient.publicOffer.toPlayerId, 'S2');
  assert.equal(recipient.publicOffer.claimAnimal, 'cat');
  assert.equal('actualAnimal' in recipient.publicOffer, false, '判定前に実animalTypeが見えている');
  assert.equal(JSON.stringify(recipient).includes(secretCard.cardId), false);
  assert.deepEqual(recipient.cards, [card('bear', 'own-card')]);
  assert.deepEqual(presence.resumeViolations(recipient), []);

  for (const seat of ['S1', 'S3', 'S4']) {
    const other = presence.resumeResult({ roomId: room.roomId, room, seatId: seat, handCards: [card('bear', `own-${seat}`)], handStatus: 'ready' });
    assert.equal(other.mustJudge, false, `${seat}が判定者と誤判定されている`);
  }
  // 第三者でも公開情報は同じで、game stateは動かない。
  assert.equal(presence.gameStateChanged(before, room), false);
  // 判定済みofferは実animalTypeを公開してよい。
  const completed = presence.publicOfferView({ status: 'completed', fromPlayerId: 'S1', toPlayerId: 'S2', claimAnimal: 'cat', actualAnimal: 'fox', success: false });
  assert.equal(completed.actualAnimal, 'fox');
  assert.deepEqual(presence.publicOfferViolations(room.publicOffer), []);
  assert.deepEqual(presence.publicOfferViolations({ status: 'pending', actualAnimal: 'fox' }), ['actualAnimal']);
});

test('resume(finished): finalResultを返し、ゲームを再開しない', () => {
  const room = finishedRoom(4);
  const before = JSON.parse(JSON.stringify(room));
  for (const seat of room.seatOrder) {
    const result = presence.resumeResult({ roomId: room.roomId, room, seatId: seat, handCards: null, handStatus: 'finished' });
    assert.equal(result.status, ROOM_STATUS.FINISHED);
    assert.equal(result.handStatus, 'finished');
    assert.deepEqual(result.cards, []);
    assert.equal(result.isMyTurn, false);
    assert.equal(result.mustJudge, false);
    assert.equal(result.turnState, TURN_STATE.FINISHED);
    assert.equal(result.currentTurnPlayerId, null);
    assert.deepEqual(result.finalResult, room.finalResult);
    assert.equal(result.finishReason, room.finishReason);
    assert.deepEqual(result.winnerPlayerIds, room.winnerPlayerIds);
    assert.equal(presence.resumeViolations(result).length, 0);
  }
  assert.equal(presence.gameStateChanged(before, room), false, 'finishedで盤面を動かしている');
});

test('resume(left fixture): Phase A契約と矛盾せず、leftを退出扱いとして扱うだけ', () => {
  const room = playingRoom(4, {
    playerStatus: { S1: PLAYER_STATUS.ACTIVE, S2: PLAYER_STATUS.ACTIVE, S3: PLAYER_STATUS.ACTIVE, S4: 'left' },
    leftPlayerIds: ['S4'],
  });
  const before = JSON.parse(JSON.stringify(room));
  const left = presence.resumeResult({ roomId: room.roomId, room, seatId: 'S4', handCards: [], handStatus: 'left' });
  assert.equal(left.handStatus, 'left');
  assert.deepEqual(left.cards, []);
  assert.equal(left.isMyTurn, false);
  assert.equal(left.mustJudge, false);
  assert.equal(left.status, ROOM_STATUS.PLAYING, 'leftで部屋を終了させている');
  // 他のactiveは通常どおり復帰でき、presenceはplayerStatusを書き換えない。
  const active = presence.resumeResult({ roomId: room.roomId, room, seatId: 'S2', handCards: [card('cat', 'own')], handStatus: 'ready' });
  assert.equal(active.handStatus, 'ready');
  assert.equal(active.playerStatus.S2, PLAYER_STATUS.ACTIVE);
  assert.equal(active.playerStatus.S4, 'left');
  assert.equal(presence.gameStateChanged(before, room), false);
});

/* ------------------------------------------------------------------ presence */

test('presence: 15秒heartbeat・120秒境界（119/120/121）・複数connection', () => {
  assert.equal(presence.HEARTBEAT_INTERVAL_MS, 15 * 1000);
  assert.equal(presence.PRESENCE_STALE_MS, 2 * 60 * 1000);
  assert.deepEqual(presence.heartbeatContract(), { intervalMs: 15000, staleMs: 120000, accessTtlMs: 300000 });
  assert.ok(presence.HEARTBEAT_INTERVAL_MS < presence.PRESENCE_STALE_MS, '1回の遅延で切断扱いになっている');

  const connection = (offset) => presence.heartbeatRecord({ uid: 'uid-S1', roomId: 'room-phase-d', seatId: 'S1', connectionId: presence.newConnectionId(), now: NOW - offset });
  // 既存2人＋こはる版と同じく、ちょうど120秒は「まだ接続中」。
  assert.equal(presence.connectionOnline(connection(119000), NOW), true);
  assert.equal(presence.connectionOnline(connection(120000), NOW), true);
  assert.equal(presence.connectionOnline(connection(120001), NOW), false);
  assert.equal(presence.connectionOnline({ ...connection(0), state: 'disconnected' }, NOW), false);
  assert.equal(presence.connectionOnline({ uid: 'uid-S1', state: 'online' }, NOW), false);

  // 複数connection: 1つでも生きていればconnected。
  const alive = { connections: { first: connection(1000), second: connection(121000) } };
  const state = presence.presenceState(alive, NOW);
  assert.equal(state.online, true);
  assert.equal(state.state, presence.CONNECTION_STATES.CONNECTED);
  assert.equal(state.connectionCount, 2);
  assert.equal(state.onlineConnectionCount, 1);
  // 全部staleなら再接続待ち（正式退出ではない）。
  const stale = presence.presenceState({ connections: { first: connection(200000), second: connection(121000) } }, NOW);
  assert.equal(stale.online, false);
  assert.equal(stale.state, presence.CONNECTION_STATES.RECONNECTING);
  assert.equal(stale.stale, true);
  assert.equal(presence.presenceState({}, NOW).stale, false);
  assert.equal(presence.presenceState({}, NOW).state, presence.CONNECTION_STATES.RECONNECTING);

  // connection記録の形式（Rulesと同じ許可fieldだけ）。
  const record = connection(0);
  assert.deepEqual(presence.connectionViolations(record), []);
  assert.equal(presence.connectionValid(record), true);
  assert.equal(presence.connectionValid({ ...record, seatId: 'S7' }), false);
  assert.equal(presence.connectionValid({ ...record, connectionId: 'not-a-uuid' }), false);
  assert.equal(presence.connectionValid({ ...record, state: 'idle' }), false);
  assert.equal(presence.connectionValid({ ...record, lastHeartbeatAt: 'soon' }), false);
  assert.equal(presence.connectionValid({ ...record, cards: [] }), false);
  assert.deepEqual(presence.connectionViolations({ ...record, cards: [] }), ['cards']);
  assert.deepEqual(presence.connectionViolations({ ...record, extra: 1 }), ['extra']);
  const disconnected = presence.disconnectRecord(record, NOW);
  assert.equal(disconnected.state, 'disconnected');
  assert.equal(disconnected.connectedAt, record.connectedAt);
});

test('presence: staleでもplayerStatus/turn/finalResultを変更しない（presenceは接続情報のみ）', () => {
  const room = playingRoom(3, { currentTurnPlayerId: 'S2' });
  const before = presence.gameStateSnapshot(room);
  const staleState = presence.presenceState({ connections: { only: presence.heartbeatRecord({
    uid: 'uid-S1', roomId: room.roomId, seatId: 'S1', connectionId: presence.newConnectionId(), now: NOW - 10 * 60 * 1000,
  }) } }, NOW);
  assert.equal(staleState.stale, true, '10分無通信は再接続待ち');
  const result = presence.resumeResult({ roomId: room.roomId, room, seatId: 'S1', handCards: [card('cat', 'own')], handStatus: 'ready' });
  // resume結果もstaleでも通常playerとして戻るだけ（観戦扱いでも退出扱いでもない）。
  assert.equal(result.playerStatus.S1, PLAYER_STATUS.ACTIVE);
  assert.equal(result.currentTurnPlayerId, 'S2');
  assert.equal(result.turnState, TURN_STATE.AWAITING_OFFER);
  assert.deepEqual(presence.gameStateSnapshot(room), before);
  assert.equal(presence.gameStateChanged(before, room), false);

  // authorizeはpresenceAccess（RTDB）だけを書き、resumeは何も書き換えない。
  const authorizeBody = handlerBody('authorizePresenceHandler');
  const resumeBody = handlerBody('resumeRoomHandler');
  for (const [name, body] of [['authorizePresenceHandler', authorizeBody], ['resumeRoomHandler', resumeBody]]) {
    assert.equal(/tx\.(update|set|create|delete)\(/.test(body), false, `${name} がtransaction書込みをしている`);
    assert.equal(/r\.room\.(update|set|delete)\(/.test(body), false, `${name} がroomを書き換えている`);
    assert.equal(body.includes('room.playerStatus ='), false, `${name} がplayerStatusを代入している`);
  }
  assert.equal(/\.(update|set|create|delete)\(/.test(resumeBody), false, 'resumeが何かを書き込んでいる');
  assert.ok(authorizeBody.includes('presenceDb()'), 'presenceはRTDBへ書く');
  assert.ok(authorizeBody.includes('presence.accessPath(roomId, uid)'), 'presenceの書込み先がaccessだけではない');
  assert.ok(authorizeBody.includes('presence.accessFields('), 'accessの形が契約と違う');
});

test('秘密: pending実カード・leftovers・他人hand・serverStateが応答へ混ざらない', () => {
  const room = playingRoom(3, {
    turnState: TURN_STATE.AWAITING_JUDGMENT,
    publicOffer: { status: 'pending', fromPlayerId: 'S1', toPlayerId: 'S2', claimAnimal: 'cat' },
  });
  const result = presence.resumeResult({ roomId: room.roomId, room, seatId: 'S2', handCards: [card('bear', 'own-card')], handStatus: 'ready' });
  assert.deepEqual(presence.resumeViolations(result), []);
  // 漏洩検出が実際に働くこと（陽性対照）。
  assert.deepEqual(presence.resumeViolations({ ...result, leftovers: [card('cat', 'x')] }), ['leftovers']);
  assert.deepEqual(presence.resumeViolations({ ...result, pendingOffer: { card: card('cat', 'x') } }), ['pendingOffer']);
  assert.deepEqual(presence.resumeViolations({ ...result, serverState: {} }), ['serverState']);
  assert.deepEqual(presence.resumeViolations({ ...result, hands: {} }), ['hands']);
  assert.deepEqual(presence.resumeViolations({ ...result, publicOffer: { ...result.publicOffer, actualAnimal: 'cat' } }), ['publicOffer.actualAnimal']);
  assert.deepEqual(presence.resumeViolations({ ...result, cards: 'own-card' }), ['cards']);
  assert.deepEqual(presence.resumeViolations(null), ['result']);
  // 実データのroomにも秘密が混ざっていない（公開roomの契約）。
  assert.equal(JSON.stringify(result).includes('leftovers'), false);
  assert.equal(JSON.stringify(result).includes('serverState'), false);
  assert.equal(JSON.stringify(result).includes('inviteDigest'), false);
});

/* --------------------------------------------------------------------- Rules */

test('RTDB Rules: 3〜6人版専用ルートを追加し、既存2人版ブロックは変更しない', () => {
  assert.equal(databaseRules.rules['.read'], false);
  assert.equal(databaseRules.rules['.write'], false);
  // 既存2人＋こはる版のブロックは1文字も変わっていない。
  assert.equal(shaJson(databaseRules.rules.mofumofuOnlinePresence), ONLINE_PRESENCE_HASH, '既存2人版presence Rulesが変更されている');
  assert.equal(shaJson(databaseRules.rules.mofumofuOnlinePresenceAccess), ONLINE_ACCESS_HASH, '既存2人版access Rulesが変更されている');
  assert.deepEqual(Object.keys(databaseRules.rules), [
    '.read', '.write', 'mofumofuOnlinePresenceAccess', 'mofumofuOnlinePresence',
    'mofumofuMultiPresenceAccess', 'mofumofuMultiPresence',
    'shadowCardRoomAccess', 'shadowCardPresence', 'moonScaleDuelRoomAccess', 'moonScaleDuelPresence',
  ]);

  // accessはclientから読み書きできない（server専用）。
  const accessRules = databaseRules.rules.mofumofuMultiPresenceAccess.$roomId.$uid;
  assert.equal(accessRules['.read'], false);
  assert.equal(accessRules['.write'], false);

  const multi = databaseRules.rules.mofumofuMultiPresence.$roomId;
  const roomRead = multi['.read'];
  for (const required of ['auth != null', "child(auth.uid).child('uid').val() === auth.uid", "child('roomId').val() === $roomId", "child('expiresAt').val() > now"]) {
    assert.ok(roomRead.includes(required), `room readに${required}が無い`);
  }
  const connection = multi.$uid.connections.$connectionId;
  const write = connection['.write'];
  assert.ok(write.includes('$uid === auth.uid'), '別uidへ書ける');
  assert.ok(write.includes('mofumofuMultiPresenceAccess'), 'accessを見ていない');
  assert.ok(write.includes("data.exists() && data.child('uid').val() === auth.uid && newData.child('state').val() === 'disconnected'"), 'disconnect書込みの条件が無い');
  assert.deepEqual(presence.connectionViolations({}), []);
  const connectionIdRegex = write.match(/\$connectionId\.matches\(\/(.+)\/\)/);
  assert.ok(connectionIdRegex, 'connectionId形式の検証が無い');
  assert.equal(connectionIdRegex[1], presence.CONNECTION_ID_PATTERN);
  assert.equal(presence.isConnectionId(presence.newConnectionId()), true);
  assert.equal(presence.isConnectionId('not-a-uuid'), false);
  assert.equal(presence.isConnectionId(presence.newConnectionId().toUpperCase()), false);

  const validate = connection['.validate'];
  for (const field of presence.CONNECTION_FIELDS) assert.ok(validate.includes(`'${field}'`), `許可field ${field} が無い`);
  assert.ok(validate.includes("newData.child('seatId').val() === root.child('mofumofuMultiPresenceAccess')"), '別seatを書ける');
  assert.ok(validate.includes("newData.child('state').val() === 'online'") && validate.includes("'disconnected'"));
  assert.equal((validate.match(/isNumber\(\)/g) || []).length, 2);
  // seatIdはS1〜S6だけ（S7やAを拒否）。
  const seatValidate = connection.seatId['.validate'];
  for (const seat of SEAT_IDS) assert.ok(seatValidate.includes(`'${seat}'`), `${seat}が許可されていない`);
  assert.equal(seatValidate.includes("'S7'"), false, 'S7が許可されている');
  assert.equal(seatValidate.includes("'A'"), false, '2人版のseat Aが許可されている');
  assert.deepEqual(SEAT_IDS.filter((seat) => presence.isSeatId(seat)), SEAT_IDS);
  assert.equal(presence.isSeatId('S7'), false);
  assert.equal(presence.isSeatId('A'), false);
  assert.equal(presence.SEAT_PATTERN, '^S[1-6]$');

  // 余計なfieldは接続nodeでも上位nodeでも拒否する。
  assert.equal(connection.$other['.validate'], false);
  assert.equal(multi.$uid.$other['.validate'], false);
  assert.equal(connection.uid['.validate'], true);
  assert.equal(connection.connectedAt['.validate'], "!data.exists() || newData.val() === data.val()");
});

test('Firestore Rules: 3〜6人版collectionの最小Rulesを追加し、既存2人版を緩めない', () => {
  const blockOf = (text, marker, tail) => {
    const start = text.indexOf(marker);
    assert.ok(start >= 0, `${marker} が見つからない`);
    const end = text.indexOf(tail);
    assert.ok(end > start, `${tail} が見つからない`);
    return text.slice(start, end + tail.length);
  };
  const onlineBlock = blockOf(firestoreRules, '    // もふもふ大集合！オンライン版。', 'match /mofumofuOnlineActionRequests/{docId} { allow read, write: if false; }');
  assert.equal(shaText(onlineBlock), FIRESTORE_ONLINE_BLOCK_HASH, '既存2人版Firestore Rulesが変更されている');

  assert.ok(firestoreRules.includes('function isMofumofuMultiMember(roomId)'));
  assert.ok(firestoreRules.includes('documents/mofumofuMultiRooms/$(roomId)/members/$(request.auth.uid)'));
  assert.ok(firestoreRules.includes('match /mofumofuMultiRooms/{roomId} {\n      allow read: if isMofumofuMultiMember(roomId);\n      allow write: if false;\n    }'), 'roomはmemberだけread可・client write不可であること');
  assert.ok(firestoreRules.includes('match /mofumofuMultiRooms/{roomId}/members/{uid} {\n      allow read: if isMofumofuMultiMember(roomId);\n      allow write: if false;\n    }'));
  assert.ok(firestoreRules.includes('match /mofumofuMultiRooms/{roomId}/privateHands/{uid} {\n      allow read: if request.auth != null && request.auth.uid == uid && isMofumofuMultiMember(roomId);\n      allow write: if false;\n    }'), 'privateHandsは本人だけread可であること');
  assert.ok(firestoreRules.includes('match /mofumofuMultiRooms/{roomId}/{document=**} { allow read, write: if false; }'), 'serverState等のclient read禁止が無い');
  for (const collection of ['mofumofuMultiRoomInvites', 'mofumofuMultiRoomSecrets', 'mofumofuMultiRateLimits', 'mofumofuMultiActionRequests']) {
    assert.ok(firestoreRules.includes(`match /${collection}/{docId} { allow read, write: if false; }`), `${collection}が閉じていない`);
  }
  // client書込みを許す文がmultiブロックに混ざっていない。
  const multiBlock = firestoreRules.slice(firestoreRules.indexOf('function isMofumofuMultiMember'), firestoreRules.indexOf('// ============================================================\n    // 1) 訪問カウンタ'));
  assert.equal(/allow (write|create|update|delete): if (?!false)/.test(multiBlock), false, 'multi側にclient書込み許可がある');
});

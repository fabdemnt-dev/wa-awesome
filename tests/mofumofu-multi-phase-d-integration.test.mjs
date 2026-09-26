import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Phase D の Emulator 統合テスト。Phase A〜Cの正本（rules.js / contract.js）をそのまま使い、
// create → join → start 済みの実roomに対して authorize / resume を実行して確認する。
// RTDB Emulator（FIREBASE_DATABASE_EMULATOR_HOST）がある場合はpresenceAccessの実書込みも検証し、
// 無い場合はその部分だけをskipして報告する（presenceの判断自体は純粋テストが担保する）。
const functionRequire = createRequire(new URL('../functions/package.json', import.meta.url));
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || '';
const rtdbEmulator = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '';
const projectId = process.env.GCLOUD_PROJECT || 'demo-mofumofu-multi';

if (!emulatorHost) {
  test('mofumofu-multi Phase D integration', { skip: 'FIRESTORE_EMULATOR_HOST 未設定（npm run test:mofumofu-multi:phase-d:integration）' }, () => {});
} else {
  process.env.GCLOUD_PROJECT = projectId;
  process.env.MOFUMOFU_DIRECT_HANDLERS = '1';
  process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, storageBucket: `${projectId}.appspot.com` });

  const { getFirestore, Timestamp } = functionRequire('firebase-admin/firestore');
  const multi = functionRequire('./mofumofu-multi/index.js');
  const contract = functionRequire('./mofumofu-multi/contract.js');
  const rules = functionRequire('./mofumofu-multi/rules.js');
  const presence = functionRequire('./mofumofu-multi/presence.js');

  const {
    createHandler, joinHandler, startHandler, makeOfferHandler, judgeOfferHandler,
    authorizePresenceHandler, resumeRoomHandler, cleanupMofumofuMultiDataNow,
  } = multi._handlers;
  const { COLLECTIONS } = contract;

  test('mofumofu-multi Phase D integration (emulator)', async (t) => {
    const store = getFirestore();
    const roomRef = (id) => store.collection(COLLECTIONS.rooms).doc(id);
    const readRoom = async (id) => (await roomRef(id).get()).data();
    const readHands = async (id) => {
      const snapshot = await roomRef(id).collection(COLLECTIONS.privateHands).get();
      return Object.fromEntries(snapshot.docs.map((doc) => [doc.id, doc.data().cards]));
    };
    let seq = 0;
    const actionId = () => `00000000-0000-4000-8000-${String((seq += 1)).padStart(12, '0')}`;
    const request = (uid, data, ip) => ({ data, auth: { uid, token: {} }, rawRequest: { ip, socket: { remoteAddress: ip } } });
    const expectError = async (run, code, reason) => {
      await assert.rejects(run, (error) => {
        assert.equal(error.code, code, `期待 code=${code} / 実際 ${error.code} (${error.message})`);
        if (reason) assert.equal(error.details?.reason, reason, `期待 reason=${reason} / 実際 ${error.details?.reason}`);
        return true;
      });
    };
    const make = (uid, roomId, cardId, claim, target, ip) => makeOfferHandler(
      request(uid, { roomId, actionId: actionId(), cardId, claimedAnimalType: claim, targetPlayerId: target }, ip),
    );
    const judge = (uid, roomId, judgment, ip) => judgeOfferHandler(
      request(uid, { roomId, actionId: actionId(), judgment }, ip),
    );
    const resume = (uid, roomId, ip) => resumeRoomHandler(request(uid, { roomId }, ip));
    const authorize = (uid, roomId, extra, ip) => authorizePresenceHandler(request(uid, { roomId, ...(extra || {}) }, ip));

    async function newGame(playerCount, prefix, ip) {
      const created = await createHandler(request(`${prefix}-s1`, { actionId: actionId() }, ip));
      const uidOf = { S1: `${prefix}-s1` };
      for (let index = 2; index <= playerCount; index += 1) {
        const uid = `${prefix}-s${index}`;
        const joined = await joinHandler(request(uid, { inviteCode: created.inviteCode, actionId: actionId() }, ip));
        uidOf[joined.seatId] = uid;
      }
      const started = await startHandler(request(uidOf.S1, { roomId: created.roomId, actionId: actionId() }, ip));
      return { roomId: created.roomId, uidOf, seats: [...started.seatOrder], ip };
    }
    async function routeTurn(game, { cardId, animalType, recipientSeat }) {
      const room = await readRoom(game.roomId);
      const offererSeat = room.currentTurnPlayerId;
      const selfReceive = recipientSeat === offererSeat;
      const targetSeat = selfReceive ? game.seats.find((seat) => seat !== offererSeat) : recipientSeat;
      await make(game.uidOf[offererSeat], game.roomId, cardId, animalType, targetSeat, game.ip);
      await judge(game.uidOf[targetSeat], game.roomId, selfReceive ? 'truth' : 'lie', game.ip);
      return { offererSeat, targetSeat };
    }
    // 集合終了まで打ち続ける（Phase C統合テストと同じ手順）。
    async function playToGathering(playerCount, prefix, ip) {
      const game = await newGame(playerCount, prefix, ip);
      const collector = game.seats[1];
      for (let turns = 0; turns < 200; turns += 1) {
        const room = await readRoom(game.roomId);
        if (room.status === 'finished') return { game, room, collector };
        const offererSeat = room.currentTurnPlayerId;
        const hands = await readHands(game.roomId);
        const cardPlayed = (hands[game.uidOf[offererSeat]] || [])[0];
        assert.ok(cardPlayed, `手番${offererSeat}の手札が空（room=${game.roomId}）`);
        await routeTurn(game, { cardId: cardPlayed.cardId, animalType: cardPlayed.animalType, recipientSeat: collector });
      }
      throw new Error('集合終了のシミュレーションが終わらない');
    }

    await cleanupMofumofuMultiDataNow(Date.now() + 25 * 60 * 60 * 1000, 1000);

    await t.test('resume(waiting): hostとparticipantが同じseatへ戻り、手札は未配布', async () => {
      const created = await createHandler(request('d-w-s1', { actionId: actionId() }, '198.51.100.11'));
      const joined = await joinHandler(request('d-w-s2', { inviteCode: created.inviteCode, actionId: actionId() }, '198.51.100.11'));
      const before = await readRoom(created.roomId);
      const host = await resume('d-w-s1', created.roomId, '198.51.100.11');
      const guest = await resume('d-w-s2', created.roomId, '198.51.100.11');
      assert.equal(host.status, 'waiting');
      assert.equal(host.seatId, 'S1');
      assert.equal(host.handStatus, 'pending');
      assert.equal(host.cards, null, 'waitingで手札を返している');
      assert.equal(host.isMyTurn, false);
      assert.equal(host.mustJudge, false);
      assert.equal(guest.seatId, joined.seatId);
      assert.equal(guest.seatId, 'S2');
      assert.deepEqual(guest.cards, null);
      assert.deepEqual(presence.resumeViolations(host), []);
      assert.deepEqual(presence.resumeViolations(guest), []);
      const after = await readRoom(created.roomId);
      assert.equal(presence.gameStateChanged(before, after), false, 'resumeがroomを書き換えている');
      assert.deepEqual(after.seatOrder, ['S1', 'S2'], 'resumeで新しいseatを払い出している');
    });

    await t.test('resume(playing): S1〜S6が同じseatへ戻り、自分の手札だけを返す', async () => {
      const game = await newGame(6, 'd-p6', '198.51.100.21');
      const before = await readRoom(game.roomId);
      const hands = await readHands(game.roomId);
      assert.equal(game.seats.length, 6);
      for (const seat of game.seats) {
        const uid = game.uidOf[seat];
        const result = await resume(uid, game.roomId, '198.51.100.21');
        assert.equal(result.seatId, seat, `${seat}のseatが変わった`);
        assert.equal(result.status, 'playing');
        assert.equal(result.handStatus, 'ready');
        assert.deepEqual(result.cards, hands[uid], `${seat}が本人の手札を受け取っていない`);
        const json = JSON.stringify(result);
        for (const other of game.seats.filter((candidate) => candidate !== seat)) {
          const otherCards = hands[game.uidOf[other]] || [];
          assert.equal(otherCards.some((candidate) => json.includes(candidate.cardId)), false, `${seat}の応答へ${other}の手札が漏れている`);
        }
        assert.equal(json.includes('leftovers'), false);
        assert.equal(json.includes('serverState'), false);
        assert.deepEqual(presence.resumeViolations(result), []);
        // 自分の手番だけが続行可能（勝手にnext turnへ進めない）。
        assert.equal(result.isMyTurn, seat === before.currentTurnPlayerId, `${seat}の手番判定が違う`);
        assert.equal(result.currentTurnPlayerId, before.currentTurnPlayerId, 'resumeが手番を動かしている');
        assert.equal(result.turnNumber, before.turnNumber);
      }
      const after = await readRoom(game.roomId);
      assert.equal(presence.gameStateChanged(before, after), false, 'resumeがgame stateを動かしている');
      assert.deepEqual(after.seatOrder, before.seatOrder, 'resumeで新seatが増えている');
      const members = await roomRef(game.roomId).collection(COLLECTIONS.members).get();
      assert.equal(members.size, 6, 'member documentが増減している');
    });

    await t.test('resume(awaitingJudgment): 受取人だけmustJudge=true、実カードは返らない', async () => {
      const game = await newGame(4, 'd-j4', '198.51.100.31');
      const hands = await readHands(game.roomId);
      const played = hands[game.uidOf.S1][0];
      await make(game.uidOf.S1, game.roomId, played.cardId, played.animalType, 'S2', '198.51.100.31');
      const before = await readRoom(game.roomId);
      assert.equal(before.turnState, 'awaitingJudgment');
      const recipient = await resume(game.uidOf.S2, game.roomId, '198.51.100.31');
      assert.equal(recipient.mustJudge, true, '受取人が判定者だと分からない');
      assert.equal(recipient.isMyTurn, false);
      assert.equal(recipient.publicOffer.status, 'pending');
      assert.equal(recipient.publicOffer.toPlayerId, 'S2');
      assert.equal('actualAnimal' in recipient.publicOffer, false, '判定前に実animalTypeが見えている');
      assert.equal(JSON.stringify(recipient).includes(played.cardId), false, '実カードIDが応答へ漏れている');
      assert.deepEqual(presence.resumeViolations(recipient), []);
      const secret = (await roomRef(game.roomId).collection(COLLECTIONS.serverState).doc('current').get()).data();
      assert.equal(secret.pendingOffer.card.cardId, played.cardId, '秘密領域に保留カードがある前提が崩れている');
      for (const seat of ['S1', 'S3', 'S4']) {
        const other = await resume(game.uidOf[seat], game.roomId, '198.51.100.31');
        assert.equal(other.mustJudge, false, `${seat}が判定者と誤判定されている`);
      }
      const after = await readRoom(game.roomId);
      assert.equal(presence.gameStateChanged(before, after), false, 'resumeが判定待ち状態を動かしている');
    });

    await t.test('resume(finished): finalResultを返し、ゲームを再開しない', async () => {
      const played = await playToGathering(3, 'd-f3', '198.51.100.41');
      const before = await readRoom(played.game.roomId);
      assert.equal(before.status, 'finished');
      for (const seat of played.game.seats) {
        const result = await resume(played.game.uidOf[seat], played.game.roomId, '198.51.100.41');
        assert.equal(result.status, 'finished');
        assert.equal(result.handStatus, 'finished');
        assert.deepEqual(result.cards, []);
        assert.equal(result.isMyTurn, false);
        assert.equal(result.mustJudge, false);
        assert.equal(result.currentTurnPlayerId, null);
        assert.equal(result.finalResult.finishReason, 'gathering');
        assert.deepEqual(result.finalResult.winnerPlayerIds, before.winnerPlayerIds);
        assert.deepEqual(presence.resumeViolations(result), []);
      }
      const after = await readRoom(played.game.roomId);
      assert.equal(presence.gameStateChanged(before, after), false, 'finished後に盤面が動いている');
    });

    await t.test('resume: Authなし・roomなし・非member・期限切れを区別して拒否する', async () => {
      const game = await newGame(3, 'd-e3', '198.51.100.51');
      const ip = '198.51.100.51';
      await expectError(() => resumeRoomHandler({ data: { roomId: game.roomId }, rawRequest: { ip, socket: { remoteAddress: ip } } }), 'unauthenticated');
      await expectError(() => resume('d-nobody', '00000000-0000-4000-8000-0000000009ff', ip), 'not-found', presence.SESSION_REASONS.ROOM_NOT_FOUND);
      await expectError(() => resume('d-stranger', game.roomId, ip), 'permission-denied', presence.SESSION_REASONS.NOT_MEMBER);
      // TTL切れは「roomが無い」と区別できる（Phase Eの入口復帰判定用）。
      await roomRef(game.roomId).update({ deleteAt: Timestamp.fromMillis(Date.now() - 1000) });
      await expectError(() => resume(game.uidOf.S1, game.roomId, ip), 'failed-precondition', presence.SESSION_REASONS.ROOM_EXPIRED);
      await roomRef(game.roomId).update({ deleteAt: Timestamp.fromMillis(Date.now() + 6 * 60 * 60 * 1000) });
      const restored = await resume(game.uidOf.S1, game.roomId, ip);
      assert.equal(restored.seatId, 'S1', '期限を戻しても同じseatへ復帰できない');
    });

    await t.test('authorize: server解決のseatだけをaccessへ書き、clientはseatを名乗れない', async (t2) => {
      const ip = '198.51.100.61';
      const game = await newGame(6, 'd-a6', ip);
      await expectError(() => authorize('d-a-nobody', game.roomId, {}, ip), 'permission-denied', presence.SESSION_REASONS.NOT_MEMBER);
      // client申告のseatId（余計なfield）は拒否する。
      await expectError(() => authorize(game.uidOf.S1, game.roomId, { seatId: 'S9' }, ip), 'invalid-argument');
      await expectError(() => authorize(game.uidOf.S1, game.roomId, { connectionId: 'x' }, ip), 'invalid-argument');
      if (!rtdbEmulator) {
        t2.diagnostic('RTDB Emulatorが無いためpresenceAccessの実書込みは未検証（Rules評価はphase-d:rules、判断は純粋テストが担保）');
        return;
      }
      for (const seat of game.seats) {
        const uid = game.uidOf[seat];
        const result = await authorize(uid, game.roomId, {}, ip);
        assert.equal(result.seatId, seat, `${seat}のseatが違う`);
        assert.equal(result.heartbeatIntervalMs, 15000);
        assert.equal(result.staleMs, 120000);
        assert.ok(result.expiresAt > Date.now() && result.expiresAt <= Date.now() + presence.PRESENCE_ACCESS_TTL_MS + 1000);
        const stored = (await multi._test.presenceDb().ref(presence.accessPath(game.roomId, uid)).get()).val();
        assert.ok(stored, 'presenceAccessが書かれていない');
        assert.deepEqual(Object.keys(stored).sort(), ['expiresAt', 'roomId', 'seatId', 'uid']);
        assert.equal(stored.uid, uid);
        assert.equal(stored.roomId, game.roomId);
        assert.equal(stored.seatId, seat, 'accessのseatがserver解決と違う');
        assert.equal(typeof stored.expiresAt, 'number');
      }
    });

    await t.test('cleanup: 期限切れデータを削除できる', async () => {
      const deleted = await cleanupMofumofuMultiDataNow(Date.now() + 25 * 60 * 60 * 1000, 1000);
      assert.ok(deleted.rooms >= 4, `削除したroom数が少ない: ${deleted.rooms}`);
      for (const name of [COLLECTIONS.rooms, COLLECTIONS.invites, COLLECTIONS.roomSecrets, COLLECTIONS.actionRequests, COLLECTIONS.rateLimits]) {
        assert.equal((await store.collection(name).get()).size, 0, `${name} が残っている`);
      }
    });
  });
}

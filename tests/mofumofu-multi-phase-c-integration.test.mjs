import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Phase C の Emulator 統合テスト。create → join → start → make → judge → turn進行 → 終了 までを
// 実際の Firestore transaction 経由で通し、冪等性・race・finished guard・秘密分離を確認する。
const functionRequire = createRequire(new URL('../functions/package.json', import.meta.url));
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || '';
const projectId = process.env.GCLOUD_PROJECT || 'demo-mofumofu-multi';

if (!emulatorHost) {
  test('mofumofu-multi Phase C integration', { skip: 'FIRESTORE_EMULATOR_HOST 未設定（npm run test:mofumofu-multi:phase-c:integration）' }, () => {});
} else {
  process.env.GCLOUD_PROJECT = projectId;
  process.env.MOFUMOFU_DIRECT_HANDLERS = '1';
  process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, storageBucket: `${projectId}.appspot.com` });

  const { getFirestore } = functionRequire('firebase-admin/firestore');
  const multi = functionRequire('./mofumofu-multi/index.js');
  const contract = functionRequire('./mofumofu-multi/contract.js');
  const rules = functionRequire('./mofumofu-multi/rules.js');

  const {
    createHandler, joinHandler, startHandler, makeOfferHandler, judgeOfferHandler, cleanupMofumofuMultiDataNow,
  } = multi._handlers;
  const { COLLECTIONS } = contract;

  test('mofumofu-multi Phase C integration (emulator)', async (t) => {
    const store = getFirestore();
    const roomRef = (id) => store.collection(COLLECTIONS.rooms).doc(id);
    const readRoom = async (id) => (await roomRef(id).get()).data();
    const readSecret = async (id) => (await roomRef(id).collection(COLLECTIONS.serverState).doc('current').get()).data();
    const readHands = async (id) => {
      const snapshot = await roomRef(id).collection(COLLECTIONS.privateHands).get();
      return Object.fromEntries(snapshot.docs.map((doc) => [doc.id, doc.data().cards]));
    };
    let seq = 0;
    const actionId = () => `00000000-0000-4000-8000-${String((seq += 1)).padStart(12, '0')}`;
    const request = (uid, data, ip) => ({ data, auth: { uid, token: {} }, rawRequest: { ip, socket: { remoteAddress: ip } } });
    const expectCode = async (run, code) => {
      await assert.rejects(run, (error) => {
        assert.equal(error.code, code, `期待 code=${code} / 実際 ${error.code} (${error.message})`);
        return true;
      });
    };
    const make = (uid, roomId, cardId, claim, target, ip = IP) => makeOfferHandler(
      request(uid, { roomId, actionId: actionId(), cardId, claimedAnimalType: claim, targetPlayerId: target }, ip),
    );
    const judge = (uid, roomId, judgment, ip = IP) => judgeOfferHandler(
      request(uid, { roomId, actionId: actionId(), judgment }, ip),
    );
    const IP = '198.51.100.10';

    // create → join → start までを実行して、seat→uid を返す。
    async function newGame(playerCount, prefix, ip = IP) {
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
    // 手番playerが出したカードを指定席へ届ける（claimは実カードと一致 → truth=本人 / lie=相手が受け取る）。
    async function routeTurn(game, { cardId, animalType, recipientSeat }) {
      const room = await readRoom(game.roomId);
      const offererSeat = room.currentTurnPlayerId;
      const selfReceive = recipientSeat === offererSeat;
      const targetSeat = selfReceive ? game.seats.find((seat) => seat !== offererSeat) : recipientSeat;
      await make(game.uidOf[offererSeat], game.roomId, cardId, animalType, targetSeat, game.ip);
      await judge(game.uidOf[targetSeat], game.roomId, selfReceive ? 'truth' : 'lie', game.ip);
      return { offererSeat, targetSeat };
    }
    const faceUpCount = (room, seat, animal) => (room.faceUpCards[seat] || []).filter((card) => card.animalType === animal).length;
    // 集合を成立させない受け取り手を選ぶ（同種が少ない席 → 枚数が少ない席 → seat順）。
    function safeRecipient(room, animal, seats) {
      const safe = seats.filter((seat) => !rules.gatheringState([
        ...(room.faceUpCards[seat] || []), { animalType: animal },
      ]).gathering);
      safe.sort((a, b) => faceUpCount(room, a, animal) - faceUpCount(room, b, animal)
        || (room.faceUpCards[a] || []).length - (room.faceUpCards[b] || []).length
        || a.localeCompare(b));
      return safe[0] || null;
    }
    // 誰か1人の手札が尽きるまで、集合を避けて打ち続ける。
    async function playToHandEmpty(playerCount, prefix, ip) {
      const game = await newGame(playerCount, prefix, ip);
      for (let turns = 0; turns < 200; turns += 1) {
        const room = await readRoom(game.roomId);
        if (room.status === 'finished') return { game, turns, room };
        const offererSeat = room.currentTurnPlayerId;
        const hands = await readHands(game.roomId);
        const card = (hands[game.uidOf[offererSeat]] || [])
          .map((candidate) => ({ card: candidate, recipient: safeRecipient(room, candidate.animalType, game.seats) }))
          .find((plan) => plan.recipient);
        assert.ok(card, `集合を避けられる受け取り手がいない（room=${game.roomId}）`);
        await routeTurn(game, { cardId: card.card.cardId, animalType: card.card.animalType, recipientSeat: card.recipient });
      }
      throw new Error('hand-empty シミュレーションが終わらない');
    }
    // collector に全ての表向きカードを集めて集合終了させる。
    async function playToGathering(playerCount, prefix, ip) {
      const game = await newGame(playerCount, prefix, ip);
      const collector = game.seats[1];
      for (let turns = 0; turns < 200; turns += 1) {
        const room = await readRoom(game.roomId);
        if (room.status === 'finished') return { game, turns, room, collector };
        const offererSeat = room.currentTurnPlayerId;
        const hands = await readHands(game.roomId);
        const card = (hands[game.uidOf[offererSeat]] || [])[0];
        assert.ok(card, `手番${offererSeat}の手札が空（room=${game.roomId}）`);
        await routeTurn(game, { cardId: card.cardId, animalType: card.animalType, recipientSeat: collector });
      }
      throw new Error('gathering シミュレーションが終わらない');
    }

    // 前回runの残骸を消す（全docにdeleteAtを設定しているため、遠い未来時刻で全消去できる）。
    await cleanupMofumofuMultiDataNow(Date.now() + 25 * 60 * 60 * 1000);

    let game;
    await t.test('make: 実カードは秘密領域だけに置き、公開roomへは公開情報だけを書く', async () => {
      game = await newGame(3, 'c3a');
      const room = await readRoom(game.roomId);
      assert.equal(room.status, 'playing');
      assert.equal(room.turnState, 'awaitingOffer');
      assert.equal(room.currentTurnPlayerId, 'S1');
      const hands = await readHands(game.roomId);
      const played = hands[game.uidOf.S1][0];
      // 入力検証は awaitingOffer の状態で確認する
      await expectCode(() => make('nobody', game.roomId, played.cardId, played.animalType, 'S2'), 'permission-denied');
      await expectCode(() => make(game.uidOf.S2, game.roomId, hands[game.uidOf.S2][0].cardId, played.animalType, 'S3'), 'failed-precondition');
      await expectCode(() => make(game.uidOf.S1, game.roomId, played.cardId, played.animalType, 'S1'), 'failed-precondition');
      await expectCode(() => make(game.uidOf.S1, game.roomId, played.cardId, 'dragon', 'S2'), 'invalid-argument');
      await expectCode(() => make(game.uidOf.S1, game.roomId, 'no-such-card', played.animalType, 'S2'), 'failed-precondition');
      await expectCode(() => make(game.uidOf.S1, game.roomId, hands[game.uidOf.S2][0].cardId, played.animalType, 'S2'), 'failed-precondition');
      await expectCode(() => make(game.uidOf.S1, game.roomId, played.cardId, played.animalType, 'S9'), 'invalid-argument');

      const result = await make(game.uidOf.S1, game.roomId, played.cardId, played.animalType, 'S2');
      assert.equal(result.turnState, 'awaitingJudgment');
      assert.equal(result.currentTurnPlayerId, 'S1');
      assert.equal(result.handCount, hands[game.uidOf.S1].length - 1);
      assert.deepEqual(contract.publicOfferViolations(result.publicOffer), []);
      assert.equal('actualAnimal' in result.publicOffer, false);

      const after = await readRoom(game.roomId);
      assert.equal(after.turnState, 'awaitingJudgment');
      assert.equal(after.handCounts.S1, hands[game.uidOf.S1].length - 1);
      assert.equal(after.publicOffer.status, 'pending');
      assert.equal(after.publicOffer.fromPlayerId, 'S1');
      assert.equal(after.publicOffer.toPlayerId, 'S2');
      assert.equal(after.publicOffer.claimAnimal, played.animalType);
      assert.equal('actualAnimal' in after.publicOffer, false, '判定前に実animalTypeが公開されている');
      const roomJson = JSON.stringify(after);
      assert.equal(roomJson.includes(played.cardId), false, '公開roomへ実カードIDが漏れている');
      assert.equal(roomJson.includes('leftovers'), false);
      assert.equal(roomJson.includes('inviteDigest'), false);
      assert.equal(roomJson.includes(contract.inviteCodeDigest('x').slice(0, 12)), false);
      assert.deepEqual(contract.publicRoomViolations(after), []);

      const secret = await readSecret(game.roomId);
      assert.equal(secret.pendingOffer.card.cardId, played.cardId);
      assert.equal(secret.pendingOffer.card.animalType, played.animalType);
      assert.equal(secret.pendingOffer.actionId.length > 0, true);
      // 他人の手札は本人のdocのまま変わっていない（内容は公開roomに無い）
      const afterHands = await readHands(game.roomId);
      assert.equal(JSON.stringify(afterHands[game.uidOf.S2]), JSON.stringify(hands[game.uidOf.S2]));
      assert.equal(JSON.stringify(after).includes(JSON.stringify(afterHands[game.uidOf.S2])), false);
    });

    await t.test('make: 判定待ち・手番外のmakeは拒否され、状態が動かない', async () => {
      const room = await readRoom(game.roomId);
      assert.equal(room.turnState, 'awaitingJudgment');
      const hands = await readHands(game.roomId);
      const s2Card = hands[game.uidOf.S2][0];
      await expectCode(() => make(game.uidOf.S1, game.roomId, s2Card.cardId, s2Card.animalType, 'S2'), 'failed-precondition');
      await expectCode(() => make(game.uidOf.S2, game.roomId, s2Card.cardId, s2Card.animalType, 'S1'), 'failed-precondition');
      const fresh = await readRoom(game.roomId);
      assert.deepEqual(fresh.handCounts, room.handCounts, '拒否時に手札が動いてはいけない');
      assert.deepEqual(fresh.faceUpCards, room.faceUpCards);
    });

    await t.test('judge: 受取人本人だけが判定でき、第三者は拒否される', async () => {
      await expectCode(() => judge(game.uidOf.S3, game.roomId, 'truth'), 'permission-denied');
      await expectCode(() => judge(game.uidOf.S1, game.roomId, 'truth'), 'permission-denied');
      await expectCode(() => judge(game.uidOf.S2, game.roomId, 'maybe'), 'invalid-argument');
      const before = await readRoom(game.roomId);
      assert.equal(before.turnState, 'awaitingJudgment');
      assert.equal((await readSecret(game.roomId)).pendingOffer.toPlayerId, 'S2');

      const result = await judge(game.uidOf.S2, game.roomId, 'lie');
      assert.equal(typeof result.success, 'boolean');
      assert.equal(result.judgment, 'lie');
      assert.ok(result.actualAnimal);
      const expectedRecipient = result.success ? 'S1' : 'S2';
      assert.equal(result.faceUpRecipientPlayerId, expectedRecipient);
      const after = await readRoom(game.roomId);
      assert.equal(after.publicOffer.status, 'completed');
      assert.equal(after.publicOffer.actualAnimal, result.actualAnimal);
      assert.equal(after.faceUpCards[expectedRecipient].length, 1);
      assert.equal(after.faceUpCards[expectedRecipient][0].animalType, result.actualAnimal);
      assert.equal(after.turnNumber, 1);
      assert.equal(after.currentTurnPlayerId, 'S2');
      assert.equal(after.turnState, 'awaitingOffer');
      assert.equal((await readSecret(game.roomId)).pendingOffer, null, '判定後に保留カードが残っている');
      assert.deepEqual(contract.publicRoomViolations(after), []);
    });

    await t.test('冪等: make/judge の再送は初回結果を返し、二重消費・二重進行しない', async () => {
      const hands = await readHands(game.roomId);
      const played = hands[game.uidOf.S2][0];
      const makeActionId = actionId();
      const made = await makeOfferHandler(request(game.uidOf.S2, {
        roomId: game.roomId, actionId: makeActionId, cardId: played.cardId, claimedAnimalType: played.animalType, targetPlayerId: 'S1',
      }, game.ip));
      const afterMake = await readRoom(game.roomId);
      const replayMake = await makeOfferHandler(request(game.uidOf.S2, {
        roomId: game.roomId, actionId: makeActionId, cardId: played.cardId, claimedAnimalType: played.animalType, targetPlayerId: 'S1',
      }, game.ip));
      assert.deepEqual(replayMake, made, 'makeの再送が初回結果と違う');
      const afterReplay = await readRoom(game.roomId);
      assert.deepEqual(afterReplay.handCounts, afterMake.handCounts, 'make再送で手札が二重に減った');
      // 同一actionId・異なるpayload
      await expectCode(() => makeOfferHandler(request(game.uidOf.S2, {
        roomId: game.roomId, actionId: makeActionId, cardId: played.cardId, claimedAnimalType: played.animalType, targetPlayerId: 'S3',
      }, game.ip)), 'already-exists');

      const judgeActionId = actionId();
      const judged = await judgeOfferHandler(request(game.uidOf.S1, { roomId: game.roomId, actionId: judgeActionId, judgment: 'truth' }, game.ip));
      const afterJudge = await readRoom(game.roomId);
      const replayJudge = await judgeOfferHandler(request(game.uidOf.S1, { roomId: game.roomId, actionId: judgeActionId, judgment: 'truth' }, game.ip));
      assert.deepEqual(replayJudge, judged, 'judgeの再送が初回結果と違う');
      const afterJudgeReplay = await readRoom(game.roomId);
      assert.deepEqual(afterJudgeReplay.faceUpCards, afterJudge.faceUpCards, 'judge再送で表向きカードが二重追加された');
      assert.equal(afterJudgeReplay.turnNumber, afterJudge.turnNumber, 'judge再送で手番が二重進行した');
      await expectCode(() => judgeOfferHandler(request(game.uidOf.S1, { roomId: game.roomId, actionId: judgeActionId, judgment: 'lie' }, game.ip)), 'already-exists');
    });

    await t.test('race: 同時makeは片方だけ成立し、同時judgeも片方だけ成立する', async () => {
      const hands = await readHands(game.roomId);
      const room = await readRoom(game.roomId);
      const offererSeat = room.currentTurnPlayerId;
      const offererUid = game.uidOf[offererSeat];
      const targets = game.seats.filter((seat) => seat !== offererSeat);
      const cards = hands[offererUid].slice(0, 2);
      const results = await Promise.allSettled([
        make(offererUid, game.roomId, cards[0].cardId, cards[0].animalType, targets[0], game.ip),
        make(offererUid, game.roomId, cards[1].cardId, cards[1].animalType, targets[1], game.ip),
      ]);
      assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 1, '同時makeが二重成立した');
      const afterRace = await readRoom(game.roomId);
      assert.equal(afterRace.turnState, 'awaitingJudgment');
      const judgeSeat = afterRace.publicOffer.toPlayerId;
      const judgeResults = await Promise.allSettled([
        judge(game.uidOf[judgeSeat], game.roomId, 'truth', game.ip),
        judge(game.uidOf[judgeSeat], game.roomId, 'lie', game.ip),
      ]);
      assert.equal(judgeResults.filter((entry) => entry.status === 'fulfilled').length, 1, '同時judgeが二重成立した');
      const afterJudge = await readRoom(game.roomId);
      assert.equal(afterJudge.turnState, 'awaitingOffer');
      const faceUpTotal = game.seats.reduce((sum, seat) => sum + (afterJudge.faceUpCards[seat] || []).length, 0);
      assert.ok(faceUpTotal >= 1, '同時judgeで表向きカードが1枚も増えていない');
      assert.equal(afterJudge.turnNumber, afterRace.turnNumber + 1, '同時judgeで手番が二重進行した');
    });

    await t.test('stale: 手番が過ぎたplayerのmake・判定待ちでないjudgeは拒否される', async () => {
      const room = await readRoom(game.roomId);
      const notCurrent = game.seats.find((seat) => seat !== room.currentTurnPlayerId);
      const hands = await readHands(game.roomId);
      const card = hands[game.uidOf[notCurrent]][0];
      await expectCode(() => make(game.uidOf[notCurrent], game.roomId, card.cardId, card.animalType, room.currentTurnPlayerId), 'failed-precondition');
      await expectCode(() => judge(game.uidOf[notCurrent], game.roomId, 'truth'), 'failed-precondition');
    });

    await t.test('完走(3人): 集合終了し、敗者以外のactive全員がwinnerになる', async () => {
      const played = await playToGathering(3, 'g3', '198.51.100.31');
      const { room, collector, turns } = played;
      assert.equal(room.status, 'finished');
      assert.equal(room.finishReason, 'gathering');
      assert.ok(['four-of-a-kind', 'all-eight-types', 'four-and-eight'].includes(room.gatheringReason), room.gatheringReason);
      assert.deepEqual(room.loserPlayerIds, [collector]);
      assert.deepEqual(room.winnerPlayerIds, played.game.seats.filter((seat) => seat !== collector));
      assert.equal(room.draw, false);
      assert.deepEqual(room.leftPlayerIds, []);
      // 集合成立時はhand-empty判定へ進まない（全員まだ手札が残っている）
      assert.equal(played.game.seats.every((seat) => room.handCounts[seat] > 0), true);
      assert.equal(room.turnState, 'finished');
      assert.equal(room.currentTurnPlayerId, null);
      assert.equal((await readSecret(played.game.roomId)).pendingOffer, null);
      assert.equal(room.finalResult.finishReason, 'gathering');
      assert.equal(room.finalResult.gatheringReason, room.gatheringReason);
      assert.equal(room.finalResult.players.length, 3);
      assert.equal(turns < 28, true, `集合終了まで${turns}手かかった`);
      assert.deepEqual(contract.publicRoomViolations(room), []);
    });

    await t.test('完走(4人): hand-empty終了し、0枚の本人は敗者にならない', async () => {
      const played = await playToHandEmpty(4, 'h4', '198.51.100.41');
      const { room } = played;
      assert.equal(room.status, 'finished');
      assert.equal(room.finishReason, 'hand-empty');
      assert.equal(room.gatheringReason, null);
      assert.deepEqual(room.loserPlayerIds, []);
      const emptySeats = played.game.seats.filter((seat) => room.handCounts[seat] === 0);
      assert.equal(emptySeats.length > 0, true);
      const active = played.game.seats.filter((seat) => room.playerStatus[seat] === 'active');
      const totals = active.map((seat) => ({ seat, total: rules.faceUpTotal(room.faceUpCards[seat]) }));
      const minimum = Math.min(...totals.map((item) => item.total));
      assert.deepEqual(room.winnerPlayerIds, totals.filter((item) => item.total === minimum).map((item) => item.seat));
      assert.equal(room.draw, room.winnerPlayerIds.length > 1);
      assert.equal(room.finalResult.finishReason, 'hand-empty');
      assert.equal(room.finalResult.gatheringReason, null);
      assert.equal(room.finalResult.players.length, 4);
      assert.equal(room.finalResult.players.some((player) => player.faceUpCardsTotal === minimum), true);
      assert.deepEqual(contract.publicRoomViolations(room), []);
      // 手札・余りは公開roomに無く、秘密領域にだけある
      const secret = await readSecret(played.game.roomId);
      assert.equal(Array.isArray(secret.leftovers), true);
      assert.equal(JSON.stringify(room).includes('leftovers'), false);
    });

    await t.test('完走(5人): hand-empty終了する', async () => {
      const played = await playToHandEmpty(5, 'h5', '198.51.100.51');
      assert.equal(played.room.status, 'finished');
      assert.equal(played.room.finishReason, 'hand-empty');
      assert.equal(played.room.finalResult.players.length, 5);
      assert.deepEqual(played.room.loserPlayerIds, []);
      assert.equal(played.room.turnState, 'finished');
    });

    await t.test('完走(6人): 32枚で最後まで成立し、hand-empty終了する', async () => {
      const played = await playToHandEmpty(6, 'h6', '198.51.100.61');
      const { room } = played;
      assert.equal(room.status, 'finished');
      assert.equal(room.finishReason, 'hand-empty');
      assert.equal(room.finalResult.players.length, 6);
      const faceUp = played.game.seats.reduce((sum, seat) => sum + (room.faceUpCards[seat] || []).length, 0);
      const hand = played.game.seats.reduce((sum, seat) => sum + room.handCounts[seat], 0);
      const secret = await readSecret(played.game.roomId);
      assert.equal(faceUp + hand + secret.leftovers.length + (secret.discard || []).length, 32, '32枚が保存されていない');
    });

    await t.test('finished guard: 終了後のmake/judgeは拒否し、成功済みactionIdの再送だけは初回結果を返す', async () => {
      const finished = await playToGathering(3, 'gf', '198.51.100.71');
      const room = await readRoom(finished.game.roomId);
      const hands = await readHands(finished.game.roomId);
      const seat = finished.game.seats.find((candidate) => hands[finished.game.uidOf[candidate]]?.length);
      const card = hands[finished.game.uidOf[seat]][0];
      await expectCode(() => make(finished.game.uidOf[seat], finished.game.roomId, card.cardId, card.animalType,
        finished.game.seats.find((candidate) => candidate !== seat)), 'failed-precondition');
      await expectCode(() => judge(finished.game.uidOf[seat], finished.game.roomId, 'truth'), 'failed-precondition');
      const after = await readRoom(finished.game.roomId);
      assert.deepEqual(after.faceUpCards, room.faceUpCards, '終了後に盤面が動いた');
      assert.equal(after.turnNumber, room.turnNumber);
      assert.equal(after.finalResult.finishReason, 'gathering');
    });

    await t.test('cleanup: 期限切れデータを削除できる', async () => {
      // cleanupは1回の実行で上限件数までしか消さないため、十分大きい上限を渡す。
      const deleted = await cleanupMofumofuMultiDataNow(Date.now() + 25 * 60 * 60 * 1000, 1000);
      assert.ok(deleted.rooms >= 4, `削除したroom数が少ない: ${deleted.rooms}`);
      for (const name of [COLLECTIONS.rooms, COLLECTIONS.invites, COLLECTIONS.roomSecrets, COLLECTIONS.actionRequests, COLLECTIONS.rateLimits]) {
        assert.equal((await store.collection(name).get()).size, 0, `${name} が残っている`);
      }
    });
  });
}

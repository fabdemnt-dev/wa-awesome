import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Phase E の Emulator 統合テスト。server正本（Phase A〜Dの handlers）と
// 3〜6人版クライアントの純粋核（multi-core.js）を突き合わせ、3/4/5/6人で
// 入口 → create → join → start → make → judge → resume → 終了 → 結果表示 までが一致することを確認する。
// 実ブラウザ（DOM）は使わない。表示はクライアント純粋核のview関数で検証する。
const functionRequire = createRequire(new URL('../functions/package.json', import.meta.url));
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || '';
const rtdbEmulator = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '';
const projectId = process.env.GCLOUD_PROJECT || 'demo-mofumofu-multi';

if (!emulatorHost) {
  test('mofumofu-multi Phase E integration', { skip: 'FIRESTORE_EMULATOR_HOST 未設定（npm run test:mofumofu-multi:phase-e:integration）' }, () => {});
} else {
  process.env.GCLOUD_PROJECT = projectId;
  process.env.MOFUMOFU_DIRECT_HANDLERS = '1';
  process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, storageBucket: `${projectId}.appspot.com` });

  const { getFirestore } = functionRequire('firebase-admin/firestore');
  const multi = functionRequire('./mofumofu-multi/index.js');
  const contract = functionRequire('./mofumofu-multi/contract.js');
  const rules = functionRequire('./mofumofu-multi/rules.js');
  const presence = functionRequire('./mofumofu-multi/presence.js');
  const core = await import('../toybox/mofumofu-gathering/online/multi/multi-core.js');

  const {
    createHandler, joinHandler, startHandler, makeOfferHandler, judgeOfferHandler,
    authorizePresenceHandler, resumeRoomHandler, cleanupMofumofuMultiDataNow,
  } = multi._handlers;
  const { COLLECTIONS } = contract;

  test('mofumofu-multi Phase E integration (emulator)', async (t) => {
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

    async function newRoom(playerCount, prefix, ip) {
      const created = await createHandler(request(`${prefix}-s1`, { actionId: actionId() }, ip));
      const uidOf = { S1: `${prefix}-s1` };
      for (let index = 2; index <= playerCount; index += 1) {
        const uid = `${prefix}-s${index}`;
        const joined = await joinHandler(request(uid, { inviteCode: created.inviteCode, actionId: actionId() }, ip));
        uidOf[joined.seatId] = uid;
      }
      return { roomId: created.roomId, uidOf, inviteCode: created.inviteCode, ip };
    }
    async function startGame(game, prefix) {
      const started = await startHandler(request(game.uidOf.S1, { roomId: game.roomId, actionId: actionId() }, game.ip));
      return { ...game, seats: [...started.seatOrder], prefix };
    }
    // hand-emptyを避けつつ終局まで打つ（受取人を回して集合の成立を遅らせる）。
    async function playOut(game, { collector = null, maxTurns = 240 } = {}) {
      let rotating = 0;
      for (let turns = 0; turns < maxTurns; turns += 1) {
        const room = await readRoom(game.roomId);
        if (room.status === 'finished') return room;
        const offererSeat = room.currentTurnPlayerId;
        const hands = await readHands(game.roomId);
        const hand = hands[game.uidOf[offererSeat]] || [];
        assert.ok(hand.length > 0, `手番${offererSeat}の手札が空（room=${game.roomId}）`);
        const others = game.seats.filter((seat) => seat !== offererSeat);
        const target = collector
          ? (collector === offererSeat ? others[0] : collector)
          : others[rotating++ % others.length];
        const played = hand[0];
        await make(game.uidOf[offererSeat], game.roomId, played.cardId, played.animalType, target, game.ip);
        await judge(game.uidOf[target], game.roomId, collector || collector === offererSeat ? 'lie' : (turns % 2 ? 'truth' : 'lie'), game.ip);
      }
      throw new Error('終局まで到達しなかった');
    }

    await cleanupMofumofuMultiDataNow(Date.now() + 25 * 60 * 60 * 1000, 1000);

    await t.test('入口(lobby): 3/4/5/6人の参加・開始条件がclient核の表示と一致する', async () => {
      for (const count of [3, 4, 5, 6]) {
        const prefix = `e-lobby-${count}`;
        const game = await newRoom(count, prefix, `198.51.100.${30 + count}`);
        const room = await readRoom(game.roomId);
        assert.deepEqual(room.seatOrder, rules.SEAT_IDS.slice(0, count), `${count}人のseat`);
        assert.deepEqual(core.SEAT_IDS.slice(0, count).map((seat) => room.playerUids[seat]), room.seatOrder.map((seat) => game.uidOf[seat]));

        // ホスト視点のロビー表示。
        const hostView = core.lobbyView(room, 'S1');
        assert.equal(hostView.playerCount, count);
        assert.equal(hostView.playerCountText, `${count}人 / 6人`);
        assert.equal(hostView.isHost, true);
        assert.equal(hostView.canStart, true);
        assert.equal(hostView.inviteVisible, true);
        assert.equal(hostView.full, count === 6);
        assert.equal(hostView.emptySeats, 6 - count);
        assert.equal(hostView.nextSeatId, count === 6 ? null : rules.SEAT_IDS[count]);
        assert.deepEqual(hostView.seats.map((seat) => seat.label), ['あなた', ...hostView.seats.slice(1).map((seat) => seat.label)]);
        assert.equal(hostView.seats.slice(1).every((seat) => /^あいて\d$/.test(seat.label)), true, '他席の表示名');
        // participant視点では開始ボタンも招待コードも出ない。
        const guestView = core.lobbyView(room, 'S2');
        assert.equal(guestView.isHost, false);
        assert.equal(guestView.startVisible, false);
        assert.equal(guestView.inviteVisible, false);

        // 開始後の手札枚数（10/8/6/5）と山札枚数（2/0/2/2）が契約どおり。
        await startGame(game, prefix);
        const playing = await readRoom(game.roomId);
        assert.equal(playing.status, 'playing');
        for (const seat of playing.seatOrder) {
          assert.equal(playing.handCounts[seat], rules.handSizeFor(count), `${count}人 ${seat}の手札枚数`);
        }
        const board = core.boardView(playing, 'S1');
        assert.equal(board.deckCount, rules.LEFTOVERS_BY_PLAYER_COUNT[count]);
        assert.equal(board.deckEmpty, count === 4);
      }
    });

    await t.test('make/judge: 手番と受取人だけが操作でき、判定前に実カードは見えない', async () => {
      const game = await startGame(await newRoom(5, 'e-turn', '198.51.100.41'), 'e-turn');
      const playing = await readRoom(game.roomId);
      const turnSeat = playing.currentTurnPlayerId;
      const hands = await readHands(game.roomId);
      const playCard = hands[game.uidOf[turnSeat]][0];
      const targetSeat = game.seats.find((seat) => seat !== turnSeat);

      // 手番でない人・存在しない手札・自分自身へのofferは拒否される。
      const notTurn = game.seats.find((seat) => seat !== turnSeat);
      await expectError(
        make(game.uidOf[notTurn], game.roomId, playCard.cardId, playCard.animalType, targetSeat, game.ip),
        'failed-precondition',
      );
      await expectError(
        make(game.uidOf[turnSeat], game.roomId, playCard.cardId, playCard.animalType, turnSeat, game.ip),
        'failed-precondition',
      );

      await make(game.uidOf[turnSeat], game.roomId, playCard.cardId, playCard.animalType, targetSeat, game.ip);
      const pending = await readRoom(game.roomId);
      assert.equal(pending.turnState, 'awaitingJudgment');
      assert.equal(pending.publicOffer.status, 'pending');
      assert.equal(pending.publicOffer.toPlayerId, targetSeat);
      assert.equal(Object.hasOwn(pending.publicOffer, 'actualAnimal'), false, '判定前に実animalTypeが公開roomへ出ている');
      assert.deepEqual(contract.publicRoomViolations(pending), []);

      // 表示: 手番でない人の画面では「待っています」、受取人だけ判定UIが出る。
      const watcher = game.seats.find((seat) => seat !== targetSeat && seat !== turnSeat);
      const watchView = core.gameView(pending, watcher, {}, { presenceReady: false });
      assert.equal(watchView.canJudge, false);
      assert.equal(watchView.canMakeOffer, false);
      assert.equal(watchView.targets.length, 0);
      const judgeView = core.gameView(pending, targetSeat, {}, { presenceReady: false });
      assert.equal(judgeView.canJudge, true, '受取人に判定UIが出ていない');
      assert.equal(judgeView.board.cardSub, `${core.seatDisplayName(pending, turnSeat, targetSeat)}の宣言`);
      assert.equal(JSON.stringify(judgeView).includes('actualAnimal'), false);

      // 受取人以外の判定は拒否。
      await expectError(
        judge(game.uidOf[watcher], game.roomId, 'lie', game.ip),
        'permission-denied',
      );
      const resolved = await judge(game.uidOf[targetSeat], game.roomId, 'lie', game.ip);
      assert.equal(typeof resolved.success, 'boolean');
      const after = await readRoom(game.roomId);
      assert.equal(after.publicOffer.status, 'completed');
      assert.equal(after.publicOffer.actualAnimal, playCard.animalType, '判定後の実カードが公開されていない');
      assert.equal(after.faceUpCards[resolved.faceUpRecipientPlayerId].length > 0, true, '表向きカードが移動していない');
      assert.deepEqual(contract.publicRoomViolations(after), []);
      const doneView = core.gameView(after, targetSeat, {}, { presenceReady: false });
      assert.ok(doneView.board.resultLine.includes('本当は'), '判定結果の表示が無い');
    });

    await t.test('秘密: resumeは本人の手札だけを返し、他人の手札・山札・serverStateを漏らさない', async () => {
      for (const count of [3, 4, 5, 6]) {
        const game = await startGame(await newRoom(count, `e-secret-${count}`, `198.51.100.${50 + count}`), `e-secret-${count}`);
        const hands = await readHands(game.roomId);
        const allCardIds = Object.values(hands).flat().map((entry) => entry.cardId);
        assert.equal(allCardIds.length, rules.handSizeFor(count) * count, `${count}人の配布枚数`);
        for (const seat of game.seats) {
          const uid = game.uidOf[seat];
          const view = await resume(uid, game.roomId, game.ip);
          assert.equal(view.seatId, seat, `${count}人 ${seat}で別seatが返っている`);
          assert.equal(view.handStatus, 'ready');
          assert.equal(view.cards.length, rules.handSizeFor(count), `${seat}の手札枚数`);
          assert.deepEqual(view.cards.map((entry) => entry.cardId), hands[uid].map((entry) => entry.cardId), '本人の手札と不一致');
          assert.deepEqual(presence.resumeViolations(view), []);
          const json = JSON.stringify(view);
          for (const otherSeat of game.seats.filter((seat2) => seat2 !== seat)) {
            for (const card of hands[game.uidOf[otherSeat]]) {
              assert.equal(json.includes(card.cardId), false, `${seat}の応答に${otherSeat}のカードが漏れている`);
            }
          }
        }
        // 表示: 山札は人数から決まる公開枚数だけで、中身は出さない。
        const room = await readRoom(game.roomId);
        const view = core.gameView(room, 'S1', {}, { presenceReady: false });
        assert.equal(view.others.length, count - 1);
        assert.equal(view.targets.length, count - 1);
        assert.equal(core.validTargets(room, 'S1').length, count - 1);
        assert.equal(JSON.stringify(view).includes('leftovers'), false);
      }
    });

    await t.test('resume: 復帰しても同じseat・同じ手番のままで、presenceAccessへseatが書かれる', async () => {
      const game = await startGame(await newRoom(4, 'e-resume', '198.51.100.61'), 'e-resume');
      const before = await readRoom(game.roomId);
      for (const seat of game.seats) {
        const admission = await authorizePresenceHandler(request(game.uidOf[seat], { roomId: game.roomId }, game.ip));
        assert.equal(admission.seatId, seat, 'serverが解決したseatが違う');
        assert.equal(admission.heartbeatIntervalMs, presence.HEARTBEAT_INTERVAL_MS);
        assert.equal(admission.staleMs, presence.PRESENCE_STALE_MS);
        assert.equal(admission.expiresAt > Date.now(), true);
        const view = await resume(game.uidOf[seat], game.roomId, game.ip);
        assert.equal(view.seatId, seat);
        assert.equal(view.currentTurnPlayerId, before.currentTurnPlayerId, 'resumeが手番を動かしている');
        assert.equal(view.turnState, before.turnState);
        assert.equal(view.isMyTurn, seat === before.currentTurnPlayerId);
        assert.equal(view.mustJudge, false);
      }
      const after = await readRoom(game.roomId);
      assert.equal(presence.gameStateChanged(before, after), false, 'authorize/resumeがroomを書き換えている');
      assert.deepEqual(after.seatOrder, before.seatOrder, 'resumeで新しいseatが増えている');

      // 非memberの保存room復帰は not-member として区別され、client核が入口復帰と判定する。
      await expectError(resume('e-resume-stranger', game.roomId, game.ip), 'permission-denied', core.SESSION_REASONS.NOT_MEMBER);
      assert.equal(
        core.sessionFailureReason({ code: 'functions/permission-denied', details: { reason: 'not-member' } }),
        core.SESSION_REASONS.NOT_MEMBER,
      );
    });

    await t.test('presence: authorizeはpresenceAccessへseatだけを書き、presence本体へ秘密を入れない', async (context) => {
      if (!rtdbEmulator) {
        context.diagnostic('RTDB Emulator未設定のため、presenceAccessの実書込み確認は未走行');
        return;
      }
      const { getDatabase } = functionRequire('firebase-admin/database');
      const projectIdForRtdb = process.env.GCLOUD_PROJECT;
      const appName = 'mofumofu-multi-phase-e-assert';
      const { initializeApp } = functionRequire('firebase-admin/app');
      const rtdb = getDatabase(initializeApp({ databaseURL: `http://${rtdbEmulator}?ns=${projectIdForRtdb}` }, appName));

      const game = await startGame(await newRoom(3, 'e-presence', '198.51.100.71'), 'e-presence');
      const seat = 'S3';
      const uid = game.uidOf[seat];
      const admission = await authorizePresenceHandler(request(uid, { roomId: game.roomId }, game.ip));
      const access = (await rtdb.ref(presence.accessPath(game.roomId, uid)).get()).val();
      assert.equal(access.uid, uid);
      assert.equal(access.roomId, game.roomId);
      assert.equal(access.seatId, seat);
      assert.equal(Number(access.expiresAt) > Date.now(), true);
      assert.deepEqual(Object.keys(access).sort(), ['expiresAt', 'roomId', 'seatId', 'uid']);
      assert.equal(admission.seatId, seat);

      // 自分のconnection nodeはクライアント（Phase E）が書く形と同じ7 fieldだけ。
      const record = presence.heartbeatRecord({
        uid, roomId: game.roomId, seatId: seat, connectionId: presence.newConnectionId(), now: Date.now(),
      });
      assert.deepEqual(presence.connectionViolations(record), []);
      await rtdb.ref(presence.connectionPath(game.roomId, uid, record.connectionId)).set(record);
      const stored = (await rtdb.ref(presence.connectionPath(game.roomId, uid, record.connectionId)).get()).val();
      assert.deepEqual(presence.connectionViolations(stored), []);
      // 表示: この接続で「接続中」、heartbeatが古い接続だけなら「再接続待ち」。
      const presenceValue = { [uid]: { connections: { [record.connectionId]: stored } } };
      const room = await readRoom(game.roomId);
      const online = core.gameView(room, 'S1', presenceValue, { presenceReady: true, now: Date.now() });
      assert.equal(online.others.find((entry) => entry.seatId === seat).presenceText, core.TEXT.chipOnline);
      const stale = core.gameView(room, 'S1', {
        [uid]: { connections: { [record.connectionId]: { ...stored, lastHeartbeatAt: Date.now() - 121_000 } } },
      }, { presenceReady: true, now: Date.now() });
      assert.equal(stale.others.find((entry) => entry.seatId === seat).presenceText, core.TEXT.chipReconnecting);
      assert.equal((await readRoom(game.roomId)).playerStatus[seat], rules.PLAYER_STATUS.ACTIVE, 'staleで退出扱いになっている');
    });

    await t.test('終了と結果: 3人・6人は集合で終わり、結果表示がroom正本と一致する', async () => {
      for (const count of [3, 6]) {
        const prefix = `e-finish-${count}`;
        const game = await startGame(await newRoom(count, prefix, `198.51.100.${80 + count}`), prefix);
        const room = await playOut(game, { collector: game.seats[1] });
        assert.equal(room.status, 'finished');
        assert.equal(room.finishReason, rules.FINISH_REASON.GATHERING, `${count}人が集合で終わっていない`);
        const result = core.resultView(room, 'S1');
        assert.equal(result.kind, 'gathering');
        assert.equal(core.isGatheringResult(room), true);
        assert.equal(result.showGatheringOverlay, true);
        assert.equal(result.players.length, count, `${count}人の結果表示の人数`);
        assert.equal(result.players.filter((player) => player.isLoser).length >= 1, true, '敗者が結果表示にいない');
        assert.equal(result.title.includes('もふもふ大集合！'), true);
        assert.equal(result.players.filter((player) => player.isLoser).every((player) => player.verdict === core.TEXT.loserVerdict), true);
        assert.equal(result.players.filter((player) => player.isWinner).every((player) => player.verdict === core.TEXT.winVerdict), true);
        assert.equal(result.reason.length > 0, true);
        assert.equal(result.logoPath.endsWith('mofumofu-logo.png'), true);
        // 終了後はmakeもjudgeもできない（結果だけを見る）。
        const view = core.gameView(room, 'S1', {}, { presenceReady: false });
        assert.equal(view.canMakeOffer, false);
        assert.equal(view.canJudge, false);
        assert.equal(view.turnText, core.TEXT.turnFinished);
        // 終了後のresumeは結果だけを返し、再開しない。
        const resumed = await resume(game.uidOf.S1, room.roomId, game.ip);
        assert.equal(resumed.status, 'finished');
        assert.equal(resumed.handStatus, 'finished');
        assert.equal(resumed.isMyTurn, false);
        assert.deepEqual(presence.resumeViolations(resumed), []);
      }
    });

    await t.test('終了と結果: 4人は集合以外の終わり方でも結果表示が分岐する', async () => {
      const prefix = 'e-finish-4';
      const game = await startGame(await newRoom(4, prefix, '198.51.100.90'), prefix);
      const room = await playOut(game, {});
      assert.equal(room.status, 'finished');
      const result = core.resultView(room, 'S1');
      const expectedKind = room.finishReason === rules.FINISH_REASON.GATHERING ? 'gathering'
        : room.finishReason === rules.FINISH_REASON.HAND_EMPTY ? 'hand-empty' : 'too-few-active';
      assert.equal(result.kind, expectedKind, `finishReason=${room.finishReason} と表示が不一致`);
      assert.equal(result.showGatheringOverlay, expectedKind === 'gathering');
      assert.equal(result.players.length, 4);
      assert.equal(result.players.every((player) => player.label !== 'S1'), true, '内部seat IDを表示している');
      assert.deepEqual(contract.publicRoomViolations(room), []);
      assert.equal(JSON.stringify(room.finalResult || {}).includes('leftovers'), false);
    });

    await t.test('4人: 山札0枚でも配布枚数と結果が一致する', async () => {
      const prefix = 'e-deck-4';
      const game = await startGame(await newRoom(4, prefix, '198.51.100.91'), prefix);
      const hands = await readHands(game.roomId);
      const dealt = Object.values(hands).flat().length;
      assert.equal(dealt, rules.handSizeFor(4) * 4);
      assert.equal(rules.LEFTOVERS_BY_PLAYER_COUNT[4], 0);
      assert.equal(rules.createDeck().length - dealt, 0, '4人戦の山札が0枚でない');
      const room = await readRoom(game.roomId);
      assert.equal(core.boardView(room, 'S1').deckText, '山札 0枚');
      assert.equal(core.boardView(room, 'S1').deckEmpty, true);
    });
  });
}

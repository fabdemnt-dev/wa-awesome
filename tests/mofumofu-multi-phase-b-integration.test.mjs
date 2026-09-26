import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// functions/ の依存（firebase-admin）を使い、Firestore Emulatorへ直接接続する統合テスト。
// 事前に emulator を起動し、FIRESTORE_EMULATOR_HOST / GCLOUD_PROJECT を渡して実行する。
const functionRequire = createRequire(new URL('../functions/package.json', import.meta.url));
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || '';
const projectId = process.env.GCLOUD_PROJECT || 'demo-mofumofu-multi';

if (!emulatorHost) {
  test('mofumofu-multi Phase B integration', { skip: 'FIRESTORE_EMULATOR_HOST 未設定（npm run test:mofumofu-multi:phase-b:integration）' }, () => {});
} else {
  // index.js のフォールバック（ipHmacKey未設定でも動く）と projectId 解決を先に整える。
  process.env.GCLOUD_PROJECT = projectId;
  process.env.MOFUMOFU_DIRECT_HANDLERS = '1';
  process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, storageBucket: `${projectId}.appspot.com` });

  const { getFirestore } = functionRequire('firebase-admin/firestore');
  const multi = functionRequire('./mofumofu-multi/index.js');
  const contract = functionRequire('./mofumofu-multi/contract.js');
  const rules = functionRequire('./mofumofu-multi/rules.js');

  const { createHandler, joinHandler, startHandler, cleanupMofumofuMultiDataNow } = multi._handlers;
  const { COLLECTIONS } = contract;
  const IP = '203.0.113.10';
  // 動物名プロパティをカード形から推定する（8種類が入っているキー）。
  const ANIMAL_KEY = (() => {
    const deck = rules.createDeck();
    for (const key of Object.keys(deck[0])) {
      if (new Set(deck.map((card) => card[key])).size === 8) return key;
    }
    return Object.keys(deck[0])[0];
  })();

  test('mofumofu-multi Phase B integration (emulator)', async (t) => {
    const store = getFirestore();
    const roomRef = (id) => store.collection(COLLECTIONS.rooms).doc(id);
    const inviteRef = (code) => store.collection(COLLECTIONS.invites).doc(contract.inviteCodeDigest(code));
    const readRoom = async (id) => (await roomRef(id).get()).data();
    const readInvite = async (code) => (await inviteRef(code).get()).data();
    const request = (uid, data, ip = IP) => {
      const value = { data, rawRequest: { ip, socket: { remoteAddress: ip } } };
      if (uid) value.auth = { uid, token: {} };
      return value;
    };
    const expectCode = async (run, code) => {
      await assert.rejects(run, (error) => {
        assert.equal(error.code, code, `期待 code=${code} / 実際 code=${error.code} (${error.message})`);
        return true;
      });
    };
    let seq = 0;
    const actionId = () => `00000000-0000-4000-8000-${String((seq += 1)).padStart(12, '0')}`;

    // 全てのdocにdeleteAtを設定しているので、遠い未来時刻で全消去してから始める。
    await cleanupMofumofuMultiDataNow(Date.now() + 25 * 60 * 60 * 1000);

    let roomA; let codeA; let roomB; let codeB; let codeC; let codeD; let startActionId;

    await t.test('create: 認証なしは unauthenticated', async () => {
      await expectCode(() => createHandler({ data: { actionId: actionId() }, rawRequest: { ip: IP } }), 'unauthenticated');
    });

    await t.test('create: room/member/secret/inviteを作り、平文コードを保存しない', async () => {
      const result = await createHandler(request('host-a', { actionId: actionId() }));
      roomA = result.roomId;
      codeA = result.inviteCode;
      assert.equal(result.seatId, 'S1');
      assert.equal(result.status, 'waiting');
      assert.match(codeA, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);

      const room = await readRoom(roomA);
      assert.equal(room.status, 'waiting');
      assert.equal(room.kind, 'multi');
      assert.equal(room.hostUid, 'host-a');
      assert.deepEqual(room.seatOrder, ['S1']);
      assert.deepEqual(room.playerUids, { S1: 'host-a' });
      assert.deepEqual(contract.publicRoomViolations(room), []);
      assert.equal(JSON.stringify(room).includes(codeA), false, '公開roomへ平文コードが入っている');
      assert.ok(Number(room.joinExpiresAt) > Date.now());

      const invite = await readInvite(codeA);
      assert.equal(invite.roomId, roomA);
      assert.equal(invite.status, 'active');
      assert.ok(Number(invite.expiresAt) > Date.now());
      assert.equal(JSON.stringify(invite).includes(codeA), false, 'inviteへ平文コードが入っている');

      const secret = await store.collection(COLLECTIONS.roomSecrets).doc(roomA).get();
      assert.equal(secret.exists, true);
      assert.equal(secret.data().inviteDigest, contract.inviteCodeDigest(codeA));
      assert.equal('inviteCode' in secret.data(), false);

      const member = await roomRef(roomA).collection(COLLECTIONS.members).doc('host-a').get();
      assert.equal(member.exists, true);
      assert.equal(member.data().seatId, 'S1');

      const serverState = await roomRef(roomA).collection(COLLECTIONS.serverState).doc('current').get();
      assert.equal(serverState.exists, false, 'start前はserverStateを作らない');

      const invites = await store.collection(COLLECTIONS.invites).get();
      for (const doc of invites.docs) {
        assert.equal(JSON.stringify(doc.data()).includes(codeA), false);
      }
    });

    await t.test('create: 同一actionIdの再送は同じroomを返し、部屋を増やさない', async () => {
      const before = (await store.collection(COLLECTIONS.rooms).get()).size;
      const replayActionId = actionId();
      const first = await createHandler(request('host-replay', { actionId: replayActionId }));
      const again = await createHandler(request('host-replay', { actionId: replayActionId }));
      assert.equal(again.roomId, first.roomId);
      assert.equal(again.seatId, 'S1');
      assert.equal(again.inviteCode, undefined, '再送で平文コードを返してはいけない');
      assert.equal((await store.collection(COLLECTIONS.rooms).get()).size, before + 1);
      await expectCode(() => createHandler(request('host-other', { actionId: replayActionId })), 'already-exists');
    });

    await t.test('create: actionId不正・余分なfieldは invalid-argument', async () => {
      await expectCode(() => createHandler(request('host-a', { actionId: 'not-a-uuid' })), 'invalid-argument');
      await expectCode(() => createHandler(request('host-a', { actionId: actionId(), extra: 1 })), 'invalid-argument');
    });

    await t.test('create: 2つ目の部屋（roomB, 3人用）', async () => {
      const result = await createHandler(request('host-b', { actionId: actionId() }));
      roomB = result.roomId;
      codeB = result.inviteCode;
      assert.notEqual(roomB, roomA);
      await joinHandler(request('guest-b2', { inviteCode: codeB, actionId: actionId() }));
      const third = await joinHandler(request('guest-b3', { inviteCode: codeB, actionId: actionId() }));
      assert.equal(third.seatId, 'S3');
      assert.equal(third.playerCount, 3);
      const room = await readRoom(roomB);
      assert.deepEqual(room.seatOrder, ['S1', 'S2', 'S3']);
    });

    let guest2Join;
    await t.test('join: S2〜S6が順に着席し、6人目で invite が full になる', async () => {
      guest2Join = await joinHandler(request('guest-2', { inviteCode: codeA, actionId: actionId() }));
      assert.equal(guest2Join.seatId, 'S2');
      assert.equal(guest2Join.playerCount, 2);
      assert.equal(guest2Join.roomId, roomA);
      for (const [index, uid] of ['guest-3', 'guest-4', 'guest-5'].entries()) {
        const result = await joinHandler(request(uid, { inviteCode: codeA, actionId: actionId() }));
        assert.equal(result.seatId, `S${index + 3}`);
        assert.equal(result.playerCount, index + 3);
        assert.equal(result.status, 'waiting');
      }
      assert.equal((await readInvite(codeA)).status, 'active', '5人では満員にしない');
      const sixth = await joinHandler(request('guest-6', { inviteCode: codeA, actionId: actionId() }));
      assert.equal(sixth.seatId, 'S6');
      assert.equal(sixth.playerCount, 6);
      assert.equal((await readInvite(codeA)).status, 'full');

      const room = await readRoom(roomA);
      assert.deepEqual(room.seatOrder, ['S1', 'S2', 'S3', 'S4', 'S5', 'S6']);
      assert.deepEqual(room.playerUids, {
        S1: 'host-a', S2: 'guest-2', S3: 'guest-3', S4: 'guest-4', S5: 'guest-5', S6: 'guest-6',
      });
      assert.deepEqual(room.handCounts, { S1: 0, S2: 0, S3: 0, S4: 0, S5: 0, S6: 0 });
      assert.deepEqual(Object.values(room.playerStatus), Array(6).fill('active'));
      assert.equal(room.status, 'waiting');
      assert.deepEqual(contract.publicRoomViolations(room), []);
      assert.equal(JSON.stringify(room).includes(codeA), false);
      const members = await roomRef(roomA).collection(COLLECTIONS.members).get();
      assert.equal(members.size, 6);
    });

    await t.test('join: 7人目は resource-exhausted で拒否する', async () => {
      await expectCode(() => joinHandler(request('guest-7', { inviteCode: codeA, actionId: actionId() })), 'resource-exhausted');
      const room = await readRoom(roomA);
      assert.equal(Object.keys(room.playerUids).length, 6);
      assert.equal(room.seatOrder.length, 6);
    });

    await t.test('join: 同一UIDの再参加は席を増やさず既存seatを返す', async () => {
      const result = await joinHandler(request('guest-3', { inviteCode: codeA, actionId: actionId() }));
      assert.equal(result.seatId, 'S3');
      assert.equal(result.rejoined, true);
      assert.equal(result.roomId, roomA);
      const room = await readRoom(roomA);
      assert.equal(Object.keys(room.playerUids).length, 6);
      assert.equal(room.playerUids.S3, 'guest-3');
    });

    await t.test('join: actionId再送は同一結果、payload違いは already-exists', async () => {
      // 実joinを作り、同じactionIdで再送する。
      const joinActionId = actionId();
      const created = await createHandler(request('host-replay-join', { actionId: actionId() }));
      const joined = await joinHandler(request('guest-replay-join', { inviteCode: created.inviteCode, actionId: joinActionId }));
      const replayed = await joinHandler(request('guest-replay-join', { inviteCode: created.inviteCode, actionId: joinActionId }));
      assert.deepEqual(replayed, joined);
      // 同一actionId・別payload（roomBの有効なコード）は already-exists
      await expectCode(() => joinHandler(request('guest-replay-join', { inviteCode: codeB, actionId: joinActionId })), 'already-exists');
    });

    await t.test('join: 存在しないコード・形式不正は failed-precondition', async () => {
      await expectCode(() => joinHandler(request('guest-8', { inviteCode: 'AAAA2222', actionId: actionId() })), 'failed-precondition');
      await expectCode(() => joinHandler(request('guest-8', { inviteCode: 'abcd', actionId: actionId() })), 'failed-precondition');
      await expectCode(() => joinHandler(request('guest-8', { inviteCode: 12345, actionId: actionId() })), 'invalid-argument');
    });

    await t.test('join: 同一uidで失敗を重ねると rate limit で resource-exhausted', async () => {
      const uid = 'guest-rate';
      for (let i = 0; i < contract.RATE_FAILURE_LIMIT; i += 1) {
        await expectCode(() => joinHandler(request(uid, { inviteCode: 'AAAA2222', actionId: actionId() })), 'failed-precondition');
      }
      await expectCode(() => joinHandler(request(uid, { inviteCode: 'AAAA2222', actionId: actionId() })), 'resource-exhausted');
      // 失敗記録はuid単位なので、別uidは通常の失敗（failed-precondition）のまま。
      await expectCode(() => joinHandler(request('guest-8', { inviteCode: 'AAAA2222', actionId: actionId() })), 'failed-precondition');
    });

    await t.test('start: ホスト以外は permission-denied、2人では failed-precondition、無い部屋は not-found', async () => {
      await expectCode(() => startHandler(request('guest-2', { roomId: roomB, actionId: actionId() })), 'permission-denied');
      const twoPlayer = await createHandler(request('host-x', { actionId: actionId() }));
      await joinHandler(request('guest-x2', { inviteCode: twoPlayer.inviteCode, actionId: actionId() }));
      await expectCode(() => startHandler(request('host-x', { roomId: twoPlayer.roomId, actionId: actionId() })), 'failed-precondition');
      await expectCode(
        () => startHandler(request('host-a', { roomId: '00000000-0000-4000-8000-999999999999', actionId: actionId() })),
        'not-found',
      );
    });

    await t.test('start: 3人roomで成功し、手札・余り・秘密分離が契約どおり', async () => {
      startActionId = actionId();
      const result = await startHandler(request('host-b', { roomId: roomB, actionId: startActionId }));
      assert.equal(result.status, 'playing');
      assert.equal(result.playerCount, 3);
      assert.equal(result.handSize, 10);
      assert.deepEqual(result.seatOrder, ['S1', 'S2', 'S3']);
      assert.equal(result.currentTurnPlayerId, 'S1');
      assert.equal(result.turnState, 'awaitingOffer');

      const room = await readRoom(roomB);
      assert.equal(room.status, 'playing');
      assert.equal(room.dealt, true);
      assert.equal(room.turnState, 'awaitingOffer');
      assert.equal(room.currentTurnPlayerId, 'S1');
      assert.equal(room.turnNumber, 0);
      assert.deepEqual(room.handCounts, { S1: 10, S2: 10, S3: 10 });
      assert.deepEqual(contract.publicRoomViolations(room), []);
      assert.equal(JSON.stringify(room).includes(codeB), false);
      assert.equal('hands' in room, false);
      assert.equal('leftovers' in room, false);

      const handDocs = await roomRef(roomB).collection(COLLECTIONS.privateHands).get();
      assert.equal(handDocs.size, 3, '手札は本人分だけ保存する');
      assert.deepEqual(handDocs.docs.map((doc) => doc.id).sort(), ['guest-b2', 'guest-b3', 'host-b']);
      const dealt = [];
      for (const doc of handDocs.docs) {
        assert.equal(doc.data().cards.length, 10);
        dealt.push(...doc.data().cards);
      }

      const server = (await roomRef(roomB).collection(COLLECTIONS.serverState).doc('current').get()).data();
      assert.equal(server.leftovers.length, rules.leftoversFor(3));
      assert.equal(server.pendingOffer, null);
      assert.deepEqual(server.seatOrder, ['S1', 'S2', 'S3']);

      const total = [...dealt, ...server.leftovers];
      assert.equal(total.length, 32);
      assert.equal(new Set(total.map((card) => JSON.stringify(card))).size, 32, 'カードが重複している');
      const byAnimal = {};
      for (const card of total) byAnimal[card[ANIMAL_KEY]] = (byAnimal[card[ANIMAL_KEY]] || 0) + 1;
      assert.deepEqual(Object.values(byAnimal).sort(), [4, 4, 4, 4, 4, 4, 4, 4]);

      const invite = await readInvite(codeB);
      assert.equal(invite.status, 'started');
      assert.ok(invite.revokedAt);
      const member = await roomRef(roomB).collection(COLLECTIONS.members).doc('host-b').get();
      assert.ok(Number(member.data().deleteAt.toMillis()) > Date.now(), 'memberのdeleteAtを延長していない');
    });

    await t.test('start: 二重開始は already-exists、同一actionIdの再送は同一結果', async () => {
      await expectCode(() => startHandler(request('host-b', { roomId: roomB, actionId: actionId() })), 'already-exists');
      const replay = await startHandler(request('host-b', { roomId: roomB, actionId: startActionId }));
      assert.equal(replay.playerCount, 3);
      assert.equal(replay.handSize, 10);
      assert.equal(replay.status, 'playing');
    });

    await t.test('start: 4人roomは手札8・余り0', async () => {
      const four = await createHandler(request('host-c', { actionId: actionId() }));
      codeC = four.inviteCode;
      for (const uid of ['guest-c2', 'guest-c3', 'guest-c4']) {
        await joinHandler(request(uid, { inviteCode: codeC, actionId: actionId() }));
      }
      const result = await startHandler(request('host-c', { roomId: four.roomId, actionId: actionId() }));
      assert.equal(result.playerCount, 4);
      assert.equal(result.handSize, rules.handSizeFor(4));
      const server = (await roomRef(four.roomId).collection(COLLECTIONS.serverState).doc('current').get()).data();
      assert.equal(server.leftovers.length, rules.leftoversFor(4));
      const handDocs = await roomRef(four.roomId).collection(COLLECTIONS.privateHands).get();
      assert.equal(handDocs.size, 4);
      let dealt = 0;
      for (const doc of handDocs.docs) dealt += doc.data().cards.length;
      assert.equal(dealt + server.leftovers.length, 32);
      const room = await readRoom(four.roomId);
      assert.deepEqual(room.handCounts, { S1: 8, S2: 8, S3: 8, S4: 8 });
    });

    await t.test('join: 開始済みroomへの参加は ALREADY_STARTED で拒否する', async () => {
      let error = null;
      try { await joinHandler(request('guest-9', { inviteCode: codeB, actionId: actionId() })); } catch (caught) { error = caught; }
      assert.equal(error?.code, 'failed-precondition');
      assert.equal(error?.message, contract.ALREADY_STARTED_ERROR);

      const room = await readRoom(roomB);
      assert.deepEqual(room.seatOrder, ['S1', 'S2', 'S3'], '開始済みroomへ席を追加している');
      assert.equal(Object.keys(room.playerUids).length, 3);
      const hands = await roomRef(roomB).collection(COLLECTIONS.privateHands).get();
      assert.equal(hands.size, 3);
    });

    await t.test('join/start: 参加期限切れは failed-precondition', async () => {
      const stale = await createHandler(request('host-d', { actionId: actionId() }));
      codeD = stale.inviteCode;
      await joinHandler(request('guest-d2', { inviteCode: codeD, actionId: actionId() }));
      await joinHandler(request('guest-d3', { inviteCode: codeD, actionId: actionId() }));
      await roomRef(stale.roomId).update({ joinExpiresAt: Date.now() - 1000 });

      let error = null;
      try { await joinHandler(request('guest-d4', { inviteCode: codeD, actionId: actionId() })); } catch (caught) { error = caught; }
      assert.equal(error?.message, contract.EXPIRED_ERROR);
      await expectCode(() => startHandler(request('host-d', { roomId: stale.roomId, actionId: actionId() })), 'failed-precondition');
    });

    await t.test('start: member情報が欠けているroomは開始できない', async () => {
      const broken = await createHandler(request('host-e', { actionId: actionId() }));
      for (const uid of ['guest-e2', 'guest-e3']) {
        await joinHandler(request(uid, { inviteCode: broken.inviteCode, actionId: actionId() }));
      }
      await roomRef(broken.roomId).collection(COLLECTIONS.members).doc('guest-e3').delete();
      await expectCode(() => startHandler(request('host-e', { roomId: broken.roomId, actionId: actionId() })), 'failed-precondition');
      const room = await readRoom(broken.roomId);
      assert.equal(room.status, 'waiting');
      assert.equal(room.dealt, false);
    });

    await t.test('join/start: 認証なしは unauthenticated', async () => {
      await expectCode(() => joinHandler({ data: { inviteCode: codeA, actionId: actionId() }, rawRequest: { ip: IP } }), 'unauthenticated');
      await expectCode(() => startHandler({ data: { roomId: roomB, actionId: actionId() }, rawRequest: { ip: IP } }), 'unauthenticated');
    });

    await t.test('cleanup: 期限切れデータを削除できる', async () => {
      const deleted = await cleanupMofumofuMultiDataNow(Date.now() + 25 * 60 * 60 * 1000);
      assert.ok(deleted.rooms >= 6, `削除したroom数が少ない: ${deleted.rooms}`);
      for (const name of [COLLECTIONS.rooms, COLLECTIONS.invites, COLLECTIONS.roomSecrets, COLLECTIONS.actionRequests, COLLECTIONS.rateLimits]) {
        assert.equal((await store.collection(name).get()).size, 0, `${name} が残っている`);
      }
      const hands = await roomRef(roomB).collection(COLLECTIONS.privateHands).get();
      assert.equal(hands.size, 0, 'subcollectionが残っている');
    });
  });
}

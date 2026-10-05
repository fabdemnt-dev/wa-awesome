import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInAnonymously, updateCurrentUser } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { getFirestore, connectFirestoreEmulator, doc, getDocFromServer, onSnapshot, terminate } from 'firebase/firestore';
import { legalActions, getDecision, rankMatch, applyMatchAction, assertMatchInvariants } from '../lab/floating-garden/match-engine.js';
import { emulatorConfig } from './helpers/floating-garden-emulators.mjs';

// Real Auth SDK -> Callable HTTP -> Admin transaction -> Firestore SDK listener.
// There is intentionally no direct-handler fallback and no missing-emulator skip.
const config = emulatorConfig({ authAndFunctions: true });
const functionRequire = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp: initializeAdminApp, deleteApp: deleteAdminApp } = functionRequire('firebase-admin/app');
const { getFirestore: getAdminFirestore } = functionRequire('firebase-admin/firestore');
const adminApp = initializeAdminApp({ projectId: config.projectId }, `floating-garden-test-${randomUUID()}`);
const adminDb = getAdminFirestore(adminApp);
const clients = new Set();
const requestId = () => randomUUID();
const roomRef = (roomId) => adminDb.doc(`floatingGardenRooms/${roomId}`);
const memberRef = (roomId, uid) => roomRef(roomId).collection('members').doc(uid);
const receiptRef = (uid, id) => adminDb.doc(`floatingGardenActionRequests/${createHash('sha256').update(uid).digest('hex')}_${id}`);

async function client(label, { user = null, anonymous = true } = {}) {
  const app = initializeApp({ projectId: config.projectId, apiKey: 'emulator-only-dummy-key', appId: `demo-${label}` }, `${label}-${randomUUID()}`);
  const auth = getAuth(app);
  connectAuthEmulator(auth, config.auth.origin, { disableWarnings: true });
  const firestore = getFirestore(app);
  connectFirestoreEmulator(firestore, config.firestore.host, config.firestore.port);
  const functions = getFunctions(app, 'asia-northeast1');
  connectFunctionsEmulator(functions, config.functions.host, config.functions.port);
  if (user) { await updateCurrentUser(auth, user); await auth.currentUser.getIdToken(true); }
  else if (anonymous) await signInAnonymously(auth);
  const value = { app, auth, firestore, call: (name, data) => httpsCallable(functions, `floatingGarden${name}`, { timeout: 30000 })(data).then((result) => result.data) };
  clients.add(value);
  return value;
}
async function close(value) { if (!clients.delete(value)) return; await terminate(value.firestore); await deleteApp(value.app); }
async function rejected(promise, code, reason) {
  await assert.rejects(promise, (error) => {
    assert.equal(String(error.code).replace(/^functions\//, ''), code, error.message);
    if (reason) assert.equal(error.details?.reason, reason);
    return true;
  });
}
function publicOnly(value, forbiddenValues = []) {
  const forbiddenKeys = new Set(['deck', 'deckCursor', 'seed', 'initialState', 'serverState', 'state', 'commands', 'uid', 'hostUid', 'playerUids', 'inviteCode', 'inviteMac', 'verifier', 'secret', 'payloadHash', 'fingerprint', 'receipt']);
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) { assert.ok(!forbiddenKeys.has(key), `private key leaked: ${key}`); visit(child); }
  }
  visit(value);
  const room = value.room || value;
  assert.deepEqual(Object.keys(room).sort(), ['id', 'status', 'hostSeat', 'playerCount', 'gameId', 'revision', 'rulesVersion', 'expiresAtMillis', 'players', 'match', 'scores', ...(room.playerCount > 2 ? ['npcCount'] : [])].sort(), 'public room is an explicit allowlist');
  const json = JSON.stringify(value);
  for (const secret of forbiddenValues) if (secret) assert.ok(!json.includes(secret), 'private value leaked into public response');
}
function wireAction(snapshot, legal, id = requestId()) {
  const { seat, revision, ...command } = legal;
  assert.equal(revision, snapshot.room.match.revision);
  return { roomId: snapshot.room.id, gameId: snapshot.room.gameId, rulesVersion: snapshot.room.rulesVersion, expectedRevision: revision, requestId: id, command };
}
function watchRoom(value, roomId) {
  let latest;
  let failure;
  const pending = new Set();
  const revisions = [];
  const stop = onSnapshot(doc(value.firestore, `floatingGardenRooms/${roomId}`), { includeMetadataChanges: true }, (snapshot) => {
    if (snapshot.metadata.fromCache) return;
    latest = snapshot.data();
    if (!latest) return;
    revisions.push(latest.revision);
    for (const item of pending) if (latest.revision >= item.revision) { clearTimeout(item.timer); pending.delete(item); item.resolve(latest); }
  }, (error) => { failure = error; for (const item of pending) { clearTimeout(item.timer); item.reject(error); } pending.clear(); });
  return {
    revisions,
    wait(revision) {
      if (failure) return Promise.reject(failure);
      if (latest?.revision >= revision) return Promise.resolve(latest);
      return new Promise((resolve, reject) => {
        const item = { revision, resolve, reject };
        item.timer = setTimeout(() => { pending.delete(item); reject(new Error(`listener never reached room revision ${revision}`)); }, 15000);
        pending.add(item);
      });
    },
    stop() { stop(); for (const item of pending) { clearTimeout(item.timer); item.reject(new Error('listener stopped')); } pending.clear(); },
  };
}

test.after(async () => {
  await Promise.allSettled([...clients].map(close));
  await adminDb.terminate();
  await deleteAdminApp(adminApp);
});

test('two independent authenticated clients create, recover, exercise all game branches and finish identically', { timeout: 240000 }, async (t) => {
  const seats = [await client('host'), await client('guest')];
  const outsider = await client('outsider');
  const unsigned = await client('unsigned', { anonymous: false });
  assert.notEqual(seats[0].auth.currentUser.uid, seats[1].auth.currentUser.uid);
  const secrets = seats.map((value) => value.auth.currentUser.uid);
  let created;
  let snapshot;
  let watchers = [];
  let savedCreate;
  let startPayload;
  let startResult;
  const history = [];
  const branches = new Set();

  await t.test('authentication, strict input validation and parallel create deduplication', async () => {
    await rejected(unsigned.call('CreateRoom', { displayName: 'Host', requestId: requestId() }), 'unauthenticated');
    await rejected(seats[0].call('CreateRoom', { displayName: 'Host', requestId: requestId(), playerCount: 4 }), 'invalid-argument');
    savedCreate = { displayName: 'Host', requestId: requestId() };
    const before = (await adminDb.collection('floatingGardenRooms').get()).size;
    const copies = await Promise.all(Array.from({ length: 3 }, () => seats[0].call('CreateRoom', savedCreate)));
    created = copies[0];
    copies.forEach((copy) => assert.deepEqual(copy, created));
    assert.equal((await adminDb.collection('floatingGardenRooms').get()).size, before + 1);
    assert.equal(created.seat, 0);
    assert.match(created.inviteCode, /^FG1-/);
    secrets.push(created.inviteCode);
    assert.deepEqual(await seats[0].call('CreateRoom', savedCreate), created, 'lost create response recovers the same usable invitation');
    await rejected(seats[0].call('CreateRoom', { ...savedCreate, displayName: 'Changed' }), 'already-exists');
    snapshot = await seats[0].call('GetSnapshot', { roomId: created.roomId });
    assert.equal(snapshot.room.match, null);
    assert.equal(snapshot.room.status, 'waiting');
    publicOnly(snapshot, secrets);
  });
  if (!created) return;

  await t.test('join/start authorization, duplicate joins, host-only start and listener convergence', async () => {
    await rejected(seats[0].call('StartMatch', { roomId: created.roomId, expectedRevision: snapshot.room.revision, requestId: requestId() }), 'failed-precondition');
    await rejected(outsider.call('GetSnapshot', { roomId: created.roomId }), 'permission-denied');
    await rejected(unsigned.call('GetSnapshot', { roomId: created.roomId }), 'unauthenticated');
    await rejected(seats[1].call('JoinRoom', { inviteCode: created.inviteCode.replace(/.$/, 'Z') + 'X', displayName: 'Guest', requestId: requestId() }), 'not-found');
    const joinPayload = { inviteCode: created.inviteCode, displayName: 'Guest', requestId: requestId() };
    const joins = await Promise.all([seats[1].call('JoinRoom', joinPayload), seats[1].call('JoinRoom', joinPayload)]);
    assert.deepEqual(joins[0], joins[1]);
    assert.equal(joins[0].seat, 1);
    assert.equal(joins[0].roomId, created.roomId);
    await rejected(seats[1].call('JoinRoom', { ...joinPayload, displayName: 'Changed' }), 'already-exists');
    snapshot = await seats[0].call('GetSnapshot', { roomId: created.roomId });
    assert.deepEqual(snapshot.room.players.map(({ seat }) => seat), [0, 1]);
    assert.equal((await roomRef(created.roomId).collection('members').get()).size, 2);
    await rejected(outsider.call('JoinRoom', { inviteCode: created.inviteCode, displayName: 'Third', requestId: requestId() }), 'failed-precondition');
    await rejected(seats[1].call('StartMatch', { roomId: created.roomId, expectedRevision: snapshot.room.revision, requestId: requestId() }), 'permission-denied');
    watchers = seats.map((value) => watchRoom(value, created.roomId));
    startPayload = { roomId: created.roomId, expectedRevision: snapshot.room.revision, requestId: requestId() };
    const starts = await Promise.all([seats[0].call('StartMatch', startPayload), seats[0].call('StartMatch', startPayload)]);
    assert.deepEqual(starts[0], starts[1]);
    startResult = starts[0]; snapshot = startResult;
    assert.equal(snapshot.room.status, 'playing');
    assert.equal(snapshot.room.match.revision, 0);
    assert.equal(snapshot.room.rulesVersion, 'floating-garden-match-1');
    const delivered = await Promise.all(watchers.map((watch) => watch.wait(snapshot.room.revision)));
    delivered.forEach((room) => assert.deepEqual(room, snapshot.room));
    await rejected(outsider.call('JoinRoom', { inviteCode: created.inviteCode, displayName: 'Late', requestId: requestId() }), 'failed-precondition');
    const sameUid = await seats[1].call('JoinRoom', { ...joinPayload, requestId: requestId() });
    assert.equal(sameUid.seat, 1);
    assert.equal((await roomRef(created.roomId).collection('members').get()).size, 2);
  });
  if (!snapshot?.room?.match) { watchers.forEach((watch) => watch.stop()); return; }

  async function reloadSeat(seat) {
    const previous = seats[seat];
    const user = previous.auth.currentUser;
    watchers[seat].stop();
    const restored = await client(`reload-seat-${seat}`, { user });
    await close(previous);
    seats[seat] = restored;
    watchers[seat] = watchRoom(restored, created.roomId);
    assert.equal(restored.auth.currentUser.uid, user.uid);
    const recovered = await restored.call('GetSnapshot', { roomId: created.roomId });
    assert.deepEqual(recovered.room, snapshot.room);
    assert.equal(recovered.self.seat, seat);
    await watchers[seat].wait(snapshot.room.revision);
  }
  async function act(type, fields = {}, { reload = false, duplicate = false, lostResponse = false } = {}) {
    const state = snapshot.room.match;
    const legal = legalActions(state).find((action) => action.type === type && Object.entries(fields).every(([key, value]) => action[key] === value));
    assert.ok(legal, `${type} is legal at ${state.round}/${state.activeSeat}/${state.step}`);
    const actor = legal.seat;
    const payload = wireAction(snapshot, legal);
    const previousRoomRevision = snapshot.room.revision;
    const before = structuredClone(snapshot.room.match);
    if (reload) await rejected(seats[1 - actor].call('SubmitAction', { ...payload, requestId: requestId() }), 'permission-denied');
    let result;
    if (duplicate) {
      const copies = await Promise.all([seats[actor].call('SubmitAction', payload), seats[actor].call('SubmitAction', payload), seats[actor].call('SubmitAction', payload)]);
      copies.forEach((copy) => assert.deepEqual(copy, copies[0]));
      result = copies[0];
    } else if (lostResponse) {
      // Let the server commit, then deliberately discard the successful response.
      await seats[actor].call('SubmitAction', payload);
      result = await seats[actor].call('SubmitAction', payload);
    } else result = await seats[actor].call('SubmitAction', payload);
    assert.equal(result.room.match.revision, before.revision + 1, 'an action advances exactly once');
    assert.equal(result.room.revision, previousRoomRevision + 1);
    assert.equal(result.self.seat, actor);
    publicOnly(result, secrets);
    history.push({ actor, payload, result });
    branches.add(type);
    if (type === 'store') branches.add(before.players[actor].storage ? 'store-swap' : 'store-empty');
    if (before.phase === 'final-stone') branches.add(`final-${type}`);
    snapshot = result;
    const delivered = await Promise.all(watchers.map((watch) => watch.wait(snapshot.room.revision)));
    delivered.forEach((room) => { assert.deepEqual(room, snapshot.room); publicOnly(room, secrets); });
    if (duplicate || lostResponse) assert.deepEqual(await seats[actor].call('SubmitAction', payload), result);
    if (reload) await reloadSeat(getDecision(snapshot.room.match)?.seat ?? actor);
    return result;
  }

  try {
    await t.test('callable and Firestore privacy, malicious fields, wrong seat, old game/version/revision are rejected', async () => {
      const roomId = created.roomId;
      const initial = structuredClone(snapshot.room);
      const payload = wireAction(snapshot, legalActions(snapshot.room.match)[0]);
      for (const [value, expected] of [[outsider, 'permission-denied'], [unsigned, 'unauthenticated'], [seats[1], 'permission-denied']]) await rejected(value.call('SubmitAction', { ...payload, requestId: requestId() }), expected);
      for (const changed of [{ seat: 1 }, { scores: [{ seat: 0, score: 999 }] }, { deck: [] }]) await rejected(seats[0].call('SubmitAction', { ...payload, requestId: requestId(), ...changed }), 'invalid-argument');
      for (const command of [{ type: 'draw', seat: 1 }, { type: 'draw', revision: 0 }, { type: 'draw', tile: { terrain: 'magic' } }, { type: 'stone', index: -1, stone: 'moon' }, { type: 'place', index: 0, rotation: 7 }]) await rejected(seats[0].call('SubmitAction', { ...payload, requestId: requestId(), command }), 'invalid-argument');
      await rejected(seats[0].call('SubmitAction', { ...payload, requestId: requestId(), expectedRevision: 1 }), 'failed-precondition', 'stale-revision');
      await rejected(seats[0].call('SubmitAction', { ...payload, requestId: requestId(), gameId: randomUUID() }), 'failed-precondition', 'wrong-game');
      await rejected(seats[0].call('SubmitAction', { ...payload, requestId: requestId(), rulesVersion: 'old-version' }), 'failed-precondition', 'rules-version');
      assert.deepEqual((await seats[0].call('GetSnapshot', { roomId })).room, initial);
      const own = await getDocFromServer(doc(seats[0].firestore, `floatingGardenRooms/${roomId}/members/${seats[0].auth.currentUser.uid}`));
      assert.equal(own.data().seat, 0); assert.equal(own.data().active, true);
      assert.equal(own.data().expiresAtMillis, snapshot.room.expiresAtMillis);
      const deniedPaths = [`floatingGardenRooms/${roomId}/members/${seats[1].auth.currentUser.uid}`, `floatingGardenRooms/${roomId}/serverGames/${snapshot.room.gameId}`, receiptRef(seats[0].auth.currentUser.uid, savedCreate.requestId).path, 'floatingGardenInvites/anything', 'floatingGardenRateLimits/anything'];
      for (const path of deniedPaths) await rejected(getDocFromServer(doc(seats[0].firestore, path)), 'permission-denied');
      await rejected(getDocFromServer(doc(outsider.firestore, `floatingGardenRooms/${roomId}`)), 'permission-denied');
    });

    await t.test('draw, accepted gift, both placements, invitations, yield and welcome survive duplicate sends and SDK recreation', async () => {
      await act('draw', {}, { duplicate: true, reload: true });
      const first = history[0];
      await rejected(seats[0].call('SubmitAction', { ...first.payload, requestId: requestId() }), 'failed-precondition', 'stale-revision');
      await rejected(seats[0].call('SubmitAction', { ...first.payload, command: { type: 'self' } }), 'already-exists');
      await act('offer', { target: 1 }, { reload: true });
      await act('accept', {}, { lostResponse: true, reload: true });
      await act('place', { rotation: 3 }, { reload: true });
      await act('place'); await act('meditate');
      await act('draw'); await act('self');
      await act('request-invite', {}, { lostResponse: true, reload: true });
      await act('yield', {}, { duplicate: true, reload: true });
      await act('place'); await act('place'); await act('meditate');
      await act('draw'); await act('self'); await act('request-invite');
      await act('welcome', {}, { reload: true }); await act('place'); await act('meditate');
    });

    await t.test('declined gift, empty storage, full storage exchange and stored source are covered', async () => {
      await act('draw'); await act('offer', { target: 0 }); await act('decline');
      await act('store', {}, { lostResponse: true, reload: true }); await act('place'); await act('meditate');
      await act('draw'); await act('store'); await act('place'); await act('meditate');
      await act('draw'); await act('store', {}, { duplicate: true, reload: true });
      while (snapshot.room.match.step === 'invite-response') await act('pass-invite');
      await act('place'); await act('meditate');
      await act('use-storage', {}, { reload: true }); await act('self');
      while (snapshot.room.match.step === 'invite-response') await act('pass-invite');
      await act('place'); await act('stone', { stone: 'moon' });
    });

    await t.test('normal turns, finishing and final stones converge on identical scoring with balanced care', async () => {
      let remaining = 400;
      while (snapshot.room.match.phase !== 'finished') {
        assert.ok(remaining-- > 0, 'legal online match terminates');
        const state = snapshot.room.match;
        const legal = legalActions(state);
        let choice;
        if (state.phase === 'final-stone') choice = legal.find(({ type }) => type === (getDecision(state).seat === 0 ? 'stone' : 'pass-final'));
        else choice = legal.find(({ type }) => ({ source: 'draw', choose: 'self', 'invite-response': 'pass-invite', place: 'place', care: 'meditate' })[state.step] === type);
        choice ||= legal[0];
        const { type, seat, revision, ...fields } = choice;
        await act(type, fields, { reload: state.phase === 'final-stone', lostResponse: state.phase === 'final-stone' });
      }
      assert.equal(snapshot.room.status, 'finished');
      assert.ok(snapshot.room.match.players.every(({ garden }) => garden.filter(Boolean).length === 16));
      assert.equal(new Set(snapshot.room.match.players.map(({ careCount }) => careCount)).size, 1);
      assert.ok(snapshot.room.match.round <= 16);
      assert.deepEqual(snapshot.room.scores, rankMatch(snapshot.room.match));
      const serverGame = (await roomRef(created.roomId).collection('serverGames').doc(snapshot.room.gameId).get()).data();
      assert.equal(serverGame.commands.length, history.length);
      assert.equal(serverGame.state.deck.length, 40);
      const replayed = serverGame.commands.reduce((state, command) => applyMatchAction(state, command), serverGame.initialState);
      assertMatchInvariants(replayed);
      assert.deepEqual(replayed, serverGame.state, 'canonical CPU rules replay the accepted server commands exactly');
      assert.deepEqual(rankMatch(replayed), snapshot.room.scores);
      const recovered = await Promise.all(seats.map((value) => value.call('GetSnapshot', { roomId: created.roomId })));
      recovered.forEach((value, seat) => { assert.deepEqual(value.room, snapshot.room); assert.equal(value.self.seat, seat); publicOnly(value, secrets); });
      const required = ['draw', 'offer', 'accept', 'decline', 'place', 'self', 'store-empty', 'store-swap', 'use-storage', 'request-invite', 'pass-invite', 'yield', 'welcome', 'meditate', 'stone', 'final-stone', 'final-pass-final'];
      required.forEach((type) => assert.ok(branches.has(type), `end-to-end branch not exercised: ${type}`));
      for (const watch of watchers) assert.deepEqual(watch.revisions, [...watch.revisions].sort((a, b) => a - b), 'listener never rolls a room backwards');
      // Receipt replay remains exact even after later progress and completion.
      assert.deepEqual(await seats[0].call('StartMatch', startPayload), startResult);
      for (const old of [history[0], history[2], history.at(-1)]) assert.deepEqual(await seats[old.actor].call('SubmitAction', old.payload), old.result);
      await rejected(seats[0].call('SubmitAction', { ...history[0].payload, requestId: requestId(), expectedRevision: snapshot.room.match.revision }), 'failed-precondition');
    });
  } finally { watchers.forEach((watch) => watch.stop()); }
});

test('parallel joins/start and same-UID tabs preserve two seats and one revision', { timeout: 60000 }, async () => {
  const host = await client('race-host');
  const candidates = [await client('candidate-a'), await client('candidate-b')];
  const created = await host.call('CreateRoom', { displayName: 'Host', requestId: requestId() });
  const joins = await Promise.allSettled(candidates.map((value, i) => value.call('JoinRoom', { inviteCode: created.inviteCode, displayName: `Guest${i}`, requestId: requestId() })));
  assert.equal(joins.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal((await roomRef(created.roomId).collection('members').get()).size, 2);
  const guest = candidates[joins.findIndex(({ status }) => status === 'fulfilled')];
  let snapshot = await host.call('GetSnapshot', { roomId: created.roomId });
  const race = await Promise.allSettled([
    host.call('StartMatch', { roomId: created.roomId, expectedRevision: snapshot.room.revision, requestId: requestId() }),
    guest.call('JoinRoom', { inviteCode: created.inviteCode, displayName: 'Guest again', requestId: requestId() }),
  ]);
  assert.equal(race[0].status, 'fulfilled');
  assert.equal(race[1].status, 'fulfilled');
  snapshot = await host.call('GetSnapshot', { roomId: created.roomId });
  assert.equal(snapshot.room.players.length, 2);
  assert.equal(snapshot.room.status, 'playing');
  const secondTab = await client('same-uid-tab', { user: host.auth.currentUser });
  const payload = wireAction(snapshot, legalActions(snapshot.room.match)[0]);
  const outcomes = await Promise.allSettled([host.call('SubmitAction', payload), secondTab.call('SubmitAction', { ...payload, requestId: requestId() })]);
  assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1);
  const failure = outcomes.find(({ status }) => status === 'rejected').reason;
  assert.equal(failure.code, 'functions/failed-precondition');
  assert.equal(failure.details?.reason, 'stale-revision');
  const recovered = await secondTab.call('GetSnapshot', { roomId: created.roomId });
  assert.equal(recovered.self.seat, 0);
  assert.equal(recovered.room.match.revision, 1);
  assert.equal(recovered.room.match.deckRemaining, 39);
});

test('expiry and membership revocation reject live reads and new actions without changing the game', { timeout: 60000 }, async () => {
  const host = await client('expiry-host'); const guest = await client('expiry-guest');
  const created = await host.call('CreateRoom', { displayName: 'Host', requestId: requestId() });
  await guest.call('JoinRoom', { inviteCode: created.inviteCode, displayName: 'Guest', requestId: requestId() });
  let snapshot = await host.call('GetSnapshot', { roomId: created.roomId });
  snapshot = await host.call('StartMatch', { roomId: created.roomId, expectedRevision: snapshot.room.revision, requestId: requestId() });
  const payload = wireAction(snapshot, legalActions(snapshot.room.match)[0]);
  const originalRoom = (await roomRef(created.roomId).get()).data();
  await memberRef(created.roomId, host.auth.currentUser.uid).update({ active: false });
  await rejected(host.call('GetSnapshot', { roomId: created.roomId }), 'permission-denied');
  await rejected(host.call('SubmitAction', payload), 'permission-denied');
  await rejected(getDocFromServer(doc(host.firestore, roomRef(created.roomId).path)), 'permission-denied');
  assert.deepEqual((await roomRef(created.roomId).get()).data(), originalRoom);
  await memberRef(created.roomId, host.auth.currentUser.uid).update({ active: true, expiresAtMillis: 1 });
  await rejected(host.call('GetSnapshot', { roomId: created.roomId }), 'failed-precondition');
  await memberRef(created.roomId, host.auth.currentUser.uid).update({ expiresAtMillis: originalRoom.expiresAtMillis });
  await roomRef(created.roomId).update({ expiresAtMillis: 1 });
  for (const value of [host, guest]) {
    await rejected(value.call('GetSnapshot', { roomId: created.roomId }), 'failed-precondition');
    await rejected(getDocFromServer(doc(value.firestore, roomRef(created.roomId).path)), 'permission-denied');
  }
  await rejected(host.call('SubmitAction', { ...payload, requestId: requestId() }), 'failed-precondition');
  assert.equal((await roomRef(created.roomId).get()).data().match.revision, 0);
});


for (const npcCount of [1, 2]) test(`real Auth/Callable/Firestore: two humans + ${npcCount} NPC finish and recover atomic batches`, { timeout: 240000 }, async () => {
  const seats = [await client(`npc-${npcCount}-host`), await client(`npc-${npcCount}-guest`)];
  const outsider = await client(`npc-${npcCount}-outsider`);
  const created = await seats[0].call('CreateRoom', { displayName: 'Host', npcCount, requestId: requestId() });
  await seats[1].call('JoinRoom', { displayName: 'Guest', inviteCode: created.inviteCode, requestId: requestId() });
  await rejected(outsider.call('JoinRoom', { displayName: 'Third human', inviteCode: created.inviteCode, requestId: requestId() }), 'failed-precondition');
  let snapshot = await seats[0].call('GetSnapshot', { roomId: created.roomId });
  const watchers = seats.map((value) => watchRoom(value, created.roomId));
  try {
    snapshot = await seats[0].call('StartMatch', { roomId: created.roomId, expectedRevision: snapshot.room.revision, requestId: requestId() });
    assert.equal(snapshot.room.rulesVersion, 'floating-garden-online-npc-1');
    assert.equal(snapshot.room.playerCount, 2 + npcCount);
    assert.equal((await roomRef(created.roomId).collection('members').get()).size, 2);
    let count = 0, batches = 0;
    while (snapshot.room.status !== 'finished') {
      assert.ok(++count < 400);
      const match = snapshot.room.match, legal = legalActions(match);
      assert.ok(getDecision(match).seat < 2);
      const action = ['self', 'pass-invite', 'meditate', 'pass-final'].map((type) => legal.find((candidate) => candidate.type === type)).find(Boolean) || legal[0];
      const payload = wireAction(snapshot, action), before = snapshot.room;
      if (count % 19 === 0) {
        const copies = await Promise.all([seats[action.seat].call('SubmitAction', payload), seats[action.seat].call('SubmitAction', payload)]);
        assert.deepEqual(copies[0], copies[1]); snapshot = copies[0];
      } else snapshot = await seats[action.seat].call('SubmitAction', payload);
      assert.equal(snapshot.room.revision, before.revision + 1);
      if (snapshot.room.match.revision > before.match.revision + 1) {
        batches += 1;
        assert.deepEqual(await seats[action.seat].call('SubmitAction', payload), snapshot, 'accepted human + NPC batch replays once');
      }
      publicOnly(snapshot, seats.map((value) => value.auth.currentUser.uid));
      const received = await Promise.all(watchers.map((watcher) => watcher.wait(snapshot.room.revision)));
      received.forEach((room) => assert.deepEqual(room, snapshot.room));
      if (count % 23 === 0) {
        await rejected(seats[action.seat].call('SubmitAction', { ...payload, requestId: requestId() }), 'failed-precondition', 'stale-revision');
        assert.deepEqual((await seats[1].call('GetSnapshot', { roomId: created.roomId })).room, snapshot.room);
      }
    }
    assert.ok(batches > 0); assert.equal(snapshot.room.scores.length, 2 + npcCount);
    assert.ok(snapshot.room.match.players.every((player) => player.garden.filter(Boolean).length === 16));
    const game = (await roomRef(created.roomId).collection('serverGames').doc(snapshot.room.gameId).get()).data();
    let replay = game.initialState;
    for (const command of game.commands) replay = applyMatchAction(replay, command);
    assert.deepEqual(replay, game.state); assert.equal(assertMatchInvariants(replay), true);
    assert.deepEqual(rankMatch(replay), snapshot.room.scores);
    assert.equal((await roomRef(created.roomId).collection('members').get()).size, 2);
    await rejected(outsider.call('GetSnapshot', { roomId: created.roomId }), 'permission-denied');
  } finally { watchers.forEach((watcher) => watcher.stop()); await Promise.all([...seats, outsider].map(close)); }
});

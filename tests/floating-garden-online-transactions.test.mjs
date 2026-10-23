import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { legalActions, getDecision, rankMatch, applyMatchAction, assertMatchInvariants } from '../lab/floating-garden/match-engine.js';
import { emulatorConfig } from './helpers/floating-garden-emulators.mjs';

// PARTIAL integration: production handlers and real Firestore transactions only.
// Caller contexts are synthetic; this does NOT test Auth, callable HTTP or browser SDKs.
// Keep the full Auth+Functions+Firestore suite separate, including when it is blocked.
const { projectId } = emulatorConfig();
const functionRequire = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = functionRequire('firebase-admin/app');
const { getFirestore, Timestamp } = functionRequire('firebase-admin/firestore');
const { createHandlers } = functionRequire('./floating-garden-online/handlers.js');
const { toPublicSnapshot } = functionRequire('./floating-garden-online/contract.js');
const app = initializeApp({ projectId }, `garden-transactions-${randomUUID()}`);
const db = getFirestore(app);
const handlers = createHandlers({ db, timestampFromMillis: Timestamp.fromMillis,
  inviteSecret: () => 'floating-garden-transaction-test-dummy-key-only' });
const id = () => randomUUID();
const call = (uid, name, data) => handlers[`floatingGarden${name}`]({ auth: uid ? { uid, token: {} } : null, data, rawRequest: { ip: '127.0.0.1' } });
const roomRef = (roomId) => db.doc(`floatingGardenRooms/${roomId}`);
const rejected = (promise, code) => assert.rejects(promise, (error) => { assert.equal(error.code, code, error.message); return true; });
const mutation = (snapshot, command, requestId = id()) => {
  const { seat, revision, ...publicCommand } = command;
  return { roomId: snapshot.room.id, gameId: snapshot.room.gameId, rulesVersion: snapshot.room.rulesVersion,
    expectedRevision: snapshot.room.match.revision, requestId, command: publicCommand };
};
test.after(async () => { await db.terminate(); await deleteApp(app); });

test('real Firestore transaction contention: duplicate create/join/start return one canonical result', { timeout: 60000 }, async () => {
  const host = `host-${id()}`; const guest = `guest-${id()}`;
  await rejected(call(null, 'CreateRoom', { displayName: 'Host', requestId: id() }), 'unauthenticated');
  const payload = { displayName: 'Host', requestId: id() };
  const before = (await db.collection('floatingGardenRooms').get()).size;
  const copies = await Promise.all(Array.from({ length: 3 }, () => call(host, 'CreateRoom', payload)));
  copies.forEach((copy) => assert.deepEqual(copy, copies[0]));
  const created = copies[0];
  assert.equal((await db.collection('floatingGardenRooms').get()).size, before + 1);
  assert.deepEqual(await call(host, 'CreateRoom', payload), created, 'lost successful response returns the same invitation');
  await rejected(call(host, 'CreateRoom', { ...payload, displayName: 'Different' }), 'already-exists');
  const join = { inviteCode: created.inviteCode, displayName: 'Guest', requestId: id() };
  const joined = await Promise.all([call(guest, 'JoinRoom', join), call(guest, 'JoinRoom', join)]);
  assert.deepEqual(joined[0], joined[1]);
  assert.equal(joined[0].seat, 1);
  assert.equal((await roomRef(created.roomId).collection('members').get()).size, 2);
  const snapshot = await call(host, 'GetSnapshot', { roomId: created.roomId });
  const start = { roomId: created.roomId, expectedRevision: snapshot.room.revision, requestId: id() };
  const started = await Promise.all([call(host, 'StartMatch', start), call(host, 'StartMatch', start)]);
  assert.deepEqual(started[0], started[1]);
  assert.equal((await roomRef(created.roomId).collection('serverGames').get()).size, 1);
  assert.equal(started[0].room.match.revision, 0);
});

test('real Firestore transactions reject a third seat and stale concurrent commands', { timeout: 60000 }, async () => {
  const host = `host-${id()}`; const guests = [`guest-${id()}`, `guest-${id()}`];
  const created = await call(host, 'CreateRoom', { displayName: 'Host', requestId: id() });
  const joins = await Promise.allSettled(guests.map((uid, i) => call(uid, 'JoinRoom', { inviteCode: created.inviteCode, displayName: `Guest${i}`, requestId: id() })));
  assert.equal(joins.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(joins.find(({ status }) => status === 'rejected').reason.code, 'failed-precondition');
  const guest = guests[joins.findIndex(({ status }) => status === 'fulfilled')];
  let snapshot = await call(host, 'GetSnapshot', { roomId: created.roomId });
  const startAndRejoin = await Promise.all([
    call(host, 'StartMatch', { roomId: created.roomId, expectedRevision: snapshot.room.revision, requestId: id() }),
    call(guest, 'JoinRoom', { inviteCode: created.inviteCode, displayName: 'Guest again', requestId: id() }),
  ]);
  snapshot = startAndRejoin[0];
  const payload = mutation(snapshot, legalActions(snapshot.room.match)[0]);
  const concurrent = await Promise.allSettled([call(host, 'SubmitAction', payload), call(host, 'SubmitAction', { ...payload, requestId: id() })]);
  assert.equal(concurrent.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(concurrent.find(({ status }) => status === 'rejected').reason.details.reason, 'stale-revision');
  const after = await call(host, 'GetSnapshot', { roomId: created.roomId });
  assert.equal(after.room.match.revision, 1);
  assert.equal(after.room.match.deckRemaining, 39);
  assert.equal((await roomRef(created.roomId).collection('members').get()).size, 2);
});

test('real Firestore transaction match covers 135 actions, retries, gift/invitation/storage and exact final scoring', { timeout: 180000 }, async () => {
  const seats = [`host-${id()}`, `guest-${id()}`];
  const created = await call(seats[0], 'CreateRoom', { displayName: 'Host', requestId: id() });
  await call(seats[1], 'JoinRoom', { inviteCode: created.inviteCode, displayName: 'Guest', requestId: id() });
  let snapshot = await call(seats[0], 'GetSnapshot', { roomId: created.roomId });
  const startPayload = { roomId: created.roomId, expectedRevision: snapshot.room.revision, requestId: id() };
  snapshot = await call(seats[0], 'StartMatch', startPayload);
  const initialResponse = structuredClone(snapshot);
  const history = []; const branches = new Set();
  async function act(type, fields = {}, retry = false) {
    const before = snapshot.room;
    const legal = legalActions(before.match).find((action) => action.type === type && Object.entries(fields).every(([key, value]) => action[key] === value));
    assert.ok(legal, `${type} must be legal at ${before.match.round}/${before.match.step}`);
    const payload = mutation(snapshot, legal);
    if (retry) await rejected(call(seats[1 - legal.seat], 'SubmitAction', { ...payload, requestId: id() }), 'permission-denied');
    const results = retry
      ? await Promise.all([call(seats[legal.seat], 'SubmitAction', payload), call(seats[legal.seat], 'SubmitAction', payload)])
      : [await call(seats[legal.seat], 'SubmitAction', payload)];
    if (retry) assert.deepEqual(results[0], results[1]);
    snapshot = results[0];
    assert.equal(snapshot.room.revision, before.revision + 1);
    assert.equal(snapshot.room.match.revision, before.match.revision + 1);
    assert.deepEqual((await roomRef(created.roomId).get()).data(), snapshot.room, 'the public room is committed atomically');
    if (retry) assert.deepEqual(await call(seats[legal.seat], 'SubmitAction', payload), snapshot, 'lost-response retry is exact');
    branches.add(type);
    if (type === 'store') branches.add(before.match.players[legal.seat].storage ? 'store-swap' : 'store-empty');
    if (before.match.phase === 'final-stone') branches.add(`final-${type}`);
    history.push({ uid: seats[legal.seat], payload, response: structuredClone(snapshot) });
  }
  for (const type of ['draw', 'offer', 'accept', 'place', 'place', 'meditate', 'draw', 'self', 'request-invite', 'yield', 'place', 'place', 'meditate', 'draw', 'self', 'request-invite', 'welcome', 'place', 'meditate']) await act(type, type === 'offer' ? { target: 1 } : {}, ['draw', 'accept', 'request-invite', 'yield', 'welcome'].includes(type));
  for (const type of ['draw', 'offer', 'decline', 'store', 'place', 'meditate', 'draw', 'store', 'place', 'meditate', 'draw', 'store']) await act(type, type === 'offer' ? { target: 0 } : {}, type === 'store');
  while (snapshot.room.match.step === 'invite-response') await act('pass-invite');
  await act('place'); await act('meditate'); await act('use-storage', {}, true); await act('self');
  while (snapshot.room.match.step === 'invite-response') await act('pass-invite');
  await act('place'); await act('stone', { stone: 'moon' });
  let remaining = 400;
  while (snapshot.room.match.phase !== 'finished') {
    assert.ok(remaining-- > 0);
    const state = snapshot.room.match; const legal = legalActions(state);
    let choice = state.phase === 'final-stone'
      ? legal.find(({ type }) => type === (getDecision(state).seat === 0 ? 'stone' : 'pass-final'))
      : legal.find(({ type }) => ({ source: 'draw', choose: 'self', 'invite-response': 'pass-invite', place: 'place', care: 'meditate' })[state.step] === type);
    choice ||= legal[0];
    const { type, seat, revision, ...fields } = choice;
    await act(type, fields, state.phase === 'final-stone');
  }
  assert.equal(history.length, 135);
  assert.equal(snapshot.room.status, 'finished');
  assert.ok(snapshot.room.match.players.every(({ garden }) => garden.filter(Boolean).length === 16));
  assert.equal(new Set(snapshot.room.match.players.map(({ careCount }) => careCount)).size, 1);
  assert.deepEqual(snapshot.room.scores, rankMatch(snapshot.room.match));
  const server = (await roomRef(created.roomId).collection('serverGames').doc(snapshot.room.gameId).get()).data();
  const replayed = server.commands.reduce((state, command) => applyMatchAction(state, command), server.initialState);
  assertMatchInvariants(replayed);
  assert.deepEqual(replayed, server.state);
  assert.deepEqual(toPublicSnapshot(replayed), snapshot.room.match);
  const both = await Promise.all(seats.map((uid) => call(uid, 'GetSnapshot', { roomId: created.roomId })));
  both.forEach((value, seat) => { assert.deepEqual(value.room, snapshot.room); assert.equal(value.self.seat, seat); });
  ['draw', 'offer', 'accept', 'decline', 'self', 'store-empty', 'store-swap', 'use-storage', 'request-invite', 'pass-invite', 'welcome', 'yield', 'place', 'meditate', 'stone', 'final-stone', 'final-pass-final'].forEach((type) => assert.ok(branches.has(type), type));
  assert.deepEqual(await call(seats[0], 'StartMatch', startPayload), initialResponse);
  for (const prior of [history[0], history[2], history.at(-1)]) assert.deepEqual(await call(prior.uid, 'SubmitAction', prior.payload), prior.response);
  await rejected(call(seats[0], 'SubmitAction', { ...history[0].payload, command: { type: 'self' } }), 'already-exists');
  await rejected(call(seats[0], 'SubmitAction', { ...history[0].payload, requestId: id() }), 'failed-precondition');
});

test('real Firestore revocation, expiry and rejected input preserve room and server state', { timeout: 60000 }, async () => {
  const host = `host-${id()}`; const guest = `guest-${id()}`;
  const created = await call(host, 'CreateRoom', { displayName: 'Host', requestId: id() });
  await call(guest, 'JoinRoom', { inviteCode: created.inviteCode, displayName: 'Guest', requestId: id() });
  let snapshot = await call(host, 'GetSnapshot', { roomId: created.roomId });
  snapshot = await call(host, 'StartMatch', { roomId: created.roomId, expectedRevision: snapshot.room.revision, requestId: id() });
  const original = (await roomRef(created.roomId).get()).data();
  const payload = mutation(snapshot, legalActions(snapshot.room.match)[0]);
  await rejected(call(`outsider-${id()}`, 'SubmitAction', payload), 'permission-denied');
  const stalePayload = { ...payload, requestId: id(), expectedRevision: 9 };
  await rejected(call(host, 'SubmitAction', stalePayload), 'failed-precondition');
  // Even a rejected attempt binds its rate-admission identity.
  await rejected(call(host, 'SubmitAction', { ...stalePayload, gameId: id() }), 'already-exists');
  await rejected(call(host, 'SubmitAction', { ...payload, requestId: id(), gameId: id() }), 'failed-precondition');
  await rejected(call(host, 'SubmitAction', { ...payload, requestId: id(), rulesVersion: 'wrong' }), 'failed-precondition');
  await rejected(call(host, 'SubmitAction', { ...payload, requestId: id(), command: { type: 'draw', seat: 1 } }), 'invalid-argument');
  await rejected(call(host, 'SubmitAction', { ...payload, requestId: id(), score: 999 }), 'invalid-argument');
  const membership = roomRef(created.roomId).collection('members').doc(host);
  await membership.update({ active: false });
  await rejected(call(host, 'GetSnapshot', { roomId: created.roomId }), 'permission-denied');
  await rejected(call(host, 'SubmitAction', payload), 'permission-denied');
  assert.deepEqual((await roomRef(created.roomId).get()).data(), original);
  await membership.update({ active: true, expiresAtMillis: 1 });
  await rejected(call(host, 'GetSnapshot', { roomId: created.roomId }), 'failed-precondition');
  await membership.update({ expiresAtMillis: original.expiresAtMillis });
  await roomRef(created.roomId).update({ expiresAtMillis: 1 });
  await rejected(call(host, 'SubmitAction', payload), 'failed-precondition');
  const server = (await roomRef(created.roomId).collection('serverGames').doc(snapshot.room.gameId).get()).data();
  assert.equal(server.state.revision, 0); assert.deepEqual(server.commands, []);
});

for (const npcCount of [1, 2]) test(`real Firestore ${2 + npcCount}-seat NPC match commits atomic batches, idempotent retries and a complete replay`, { timeout: 240000 }, async () => {
  const seats = [`npc-host-${id()}`, `npc-guest-${id()}`];
  const created = await call(seats[0], 'CreateRoom', { displayName: 'Host', npcCount, requestId: id() });
  await call(seats[1], 'JoinRoom', { inviteCode: created.inviteCode, displayName: 'Guest', requestId: id() });
  let snapshot = await call(seats[0], 'GetSnapshot', { roomId: created.roomId });
  assert.equal(snapshot.room.players.length, 2, 'NPC seats do not fill the human lobby');
  assert.equal(snapshot.room.rulesVersion, 'floating-garden-online-npc-1');
  assert.equal(snapshot.room.playerCount, 2 + npcCount);
  snapshot = await call(seats[0], 'StartMatch', { roomId: created.roomId, expectedRevision: snapshot.room.revision, requestId: id() });
  assert.equal(snapshot.room.players.length, 2 + npcCount);
  assert.deepEqual(snapshot.room.match.players.map((player) => player.isHuman), [true, true, ...Array(npcCount).fill(false)]);
  assert.equal((await roomRef(created.roomId).collection('members').get()).size, 2);
  let humanOperations = 0; let npcOperations = 0; let duplicateVerified = false; let concurrentVerified = false;
  const acceptedRetries = [];
  const publicOnly = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!['deck', 'deckCursor', 'seed', 'uid', 'private', 'secret', 'commands', 'initialState'].includes(key), `private field ${key}`);
      publicOnly(child);
    }
  };
  while (snapshot.room.status !== 'finished') {
    const before = snapshot.room; const decision = getDecision(before.match);
    assert.ok(decision.seat === 0 || decision.seat === 1, 'every committed snapshot waits for a human');
    const legal = legalActions(before.match);
    // Force two early gifts to actual NPC seats to exercise real batch contention.
    let action = (!duplicateVerified || !concurrentVerified) && legal.find((candidate) => candidate.type === 'offer' && candidate.target === 1 + npcCount);
    action ||= legal.find((candidate) => ({ source: 'draw', choose: 'self', 'invite-response': 'pass-invite',
      'offer-response': 'accept', welcome: 'welcome', place: 'place', care: 'meditate', 'final-stone': 'pass-final' })[before.match.step] === candidate.type) || legal[0];
    const uid = seats[action.seat]; const payload = mutation(snapshot, action);
    const npcGift = action.type === 'offer' && action.target >= 2;
    if (npcGift && !duplicateVerified) {
      const results = await Promise.all(Array.from({ length: 3 }, () => call(uid, 'SubmitAction', payload)));
      results.forEach((result) => assert.deepEqual(result, results[0]));
      snapshot = results[0]; duplicateVerified = true;
      assert.equal(snapshot.room.match.revision, before.match.revision + 3, 'offer, NPC accept and NPC placement commit exactly once');
      assert.deepEqual(await call(uid, 'SubmitAction', payload), snapshot);
      acceptedRetries.push({ uid, payload, response: structuredClone(snapshot) });
    } else if (npcGift && !concurrentVerified) {
      const candidates = [payload, { ...payload, requestId: id() }];
      const outcomes = await Promise.allSettled(candidates.map((data) => call(uid, 'SubmitAction', data)));
      assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
      assert.equal(outcomes.find((outcome) => outcome.status === 'rejected').reason.details.reason, 'stale-revision');
      const acceptedIndex = outcomes.findIndex((outcome) => outcome.status === 'fulfilled');
      snapshot = outcomes[acceptedIndex].value; concurrentVerified = true;
      assert.equal(snapshot.room.match.revision, before.match.revision + 3);
      acceptedRetries.push({ uid, payload: candidates[acceptedIndex], response: structuredClone(snapshot) });
    } else snapshot = await call(uid, 'SubmitAction', payload);
    humanOperations += 1;
    const advanced = snapshot.room.match.revision - before.match.revision - 1;
    assert.ok(advanced >= 0 && advanced <= 32); npcOperations += advanced;
    assert.equal(snapshot.room.revision, before.revision + 1);
    assert.equal(snapshot.room.rulesVersion, 'floating-garden-online-npc-1');
    assert.equal(snapshot.room.playerCount, 2 + npcCount);
    publicOnly(snapshot);
    assert.deepEqual((await roomRef(created.roomId).get()).data(), snapshot.room, 'human and NPC results share the committed public revision');
    if (humanOperations % 20 === 0) assert.deepEqual((await call(seats[1], 'GetSnapshot', { roomId: created.roomId })).room, snapshot.room);
    assert.ok(humanOperations < 500);
  }
  assert.equal(duplicateVerified, true); assert.equal(concurrentVerified, true); assert.ok(npcOperations > 0);
  const gameRef = roomRef(created.roomId).collection('serverGames').doc(snapshot.room.gameId);
  const server = (await gameRef.get()).data();
  const replayed = server.commands.reduce((state, command) => applyMatchAction(state, command), server.initialState);
  assert.equal(assertMatchInvariants(replayed), true);
  assert.deepEqual(replayed, server.state);
  assert.deepEqual(toPublicSnapshot(replayed), snapshot.room.match);
  assert.deepEqual(snapshot.room.scores, rankMatch(replayed));
  assert.equal(server.commands.length, snapshot.room.match.revision);
  assert.equal(server.commands.filter((command) => command.seat < 2).length, humanOperations);
  assert.equal(server.commands.filter((command) => command.seat >= 2).length, npcOperations);
  assert.ok(replayed.players.every((player) => player.garden.filter(Boolean).length === 16));
  assert.equal(new Set(replayed.players.map((player) => player.careCount)).size, 1);
  const memberships = await roomRef(created.roomId).collection('members').get();
  assert.deepEqual(memberships.docs.map((doc) => doc.id).sort(), seats.slice().sort());
  assert.deepEqual(memberships.docs.map((doc) => doc.data().seat).sort(), [0, 1]);
  const both = await Promise.all(seats.map((uid) => call(uid, 'GetSnapshot', { roomId: created.roomId })));
  both.forEach((result, seat) => { assert.deepEqual(result.room, snapshot.room); assert.equal(result.self.seat, seat); });
  for (const prior of acceptedRetries) assert.deepEqual(await call(prior.uid, 'SubmitAction', prior.payload), prior.response);
  assert.deepEqual((await gameRef.get()).data(), server, 'replaying old NPC batches never advances the finished game');
});

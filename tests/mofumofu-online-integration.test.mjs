import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInAnonymously } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, terminate } from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';

const direct = process.env.MOFUMOFU_DIRECT_HANDLERS === '1';
const projectId = 'demo-mofumofu-online';
const functionRequire = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp: initializeAdminApp, getApps: getAdminApps, deleteApp: deleteAdminApp } = functionRequire('firebase-admin/app');
const { getFirestore: getAdminFirestore } = functionRequire('firebase-admin/firestore');
let ownedAdminApp = null;
if (!getAdminApps().length) ownedAdminApp = initializeAdminApp({ projectId });
const adminDb = getAdminFirestore();
const module = functionRequire('./mofumofu-online');
const clients = [];
const config = { projectId, apiKey: 'demo', appId: 'demo' };

function client(name, authenticate = true) {
  const app = initializeApp(config, `${name}-${randomUUID()}`);
  const auth = getAuth(app);
  const fs = getFirestore(app);
  const fn = getFunctions(app, 'asia-northeast1');
  connectAuthEmulator(auth, 'http://127.0.0.1:9199', { disableWarnings: true });
  connectFirestoreEmulator(fs, '127.0.0.1', 8180);
  connectFunctionsEmulator(fn, '127.0.0.1', 5101);
  const value = { app, auth, fs, fn, ready: authenticate ? signInAnonymously(auth) : Promise.resolve() };
  value.call = async (name, data) => {
    await value.ready;
    if (!direct) return httpsCallable(fn, name)(data).then((response) => response.data);
    const handlerName = ({ createMofumofuRoom: 'createHandler', joinMofumofuRoom: 'joinHandler', startMofumofuGame: 'startHandler', resumeMofumofuRoom: 'resumeHandler', makeMofumofuOffer: 'makeHandler', judgeMofumofuOffer: 'judgeHandler', runMofumofuNpcTurn: 'npcHandler' })[name];
    return module._handlers[handlerName]({ data, auth: auth.currentUser ? { uid: auth.currentUser.uid } : null });
  };
  clients.push(value);
  return value;
}
function codeOf(error) { return String(error?.code || '').replace(/^functions\//, ''); }
async function rejects(promise, code) { await assert.rejects(promise, (error) => !code || codeOf(error) === code); }
async function startedRoom(prefix = 'room') {
  const a = client(`${prefix}-a`); const b = client(`${prefix}-b`); await Promise.all([a.ready, b.ready]);
  const created = await a.call('createMofumofuRoom', {});
  await b.call('joinMofumofuRoom', { inviteCode: created.inviteCode });
  await a.call('startMofumofuGame', { roomId: created.roomId });
  const [ra, rb] = await Promise.all([a.call('resumeMofumofuRoom', { roomId: created.roomId }), b.call('resumeMofumofuRoom', { roomId: created.roomId })]);
  return { a, b, roomId: created.roomId, created, ra, rb };
}
async function setTurn(roomId, playerId, state = 'awaitingOffer') {
  await adminDb.doc(`mofumofuOnlineRooms/${roomId}`).update({ currentTurnPlayerId: playerId, turnState: state, publicOffer: null });
  await adminDb.doc(`mofumofuOnlineRooms/${roomId}/serverState/current`).update({ pendingOffer: null });
}
function digest(code) { return createHash('sha256').update(code).digest('hex'); }
function testCard(animalType, suffix = randomUUID()) { return { cardId: `${animalType}-${suffix}`, animalType }; }
async function roomDocs(roomId) {
  const room = (await adminDb.doc(`mofumofuOnlineRooms/${roomId}`).get()).data();
  const server = (await adminDb.doc(`mofumofuOnlineRooms/${roomId}/serverState/current`).get()).data();
  const handA = (await adminDb.doc(`mofumofuOnlineRooms/${roomId}/privateHands/${room.playerUids.A}`).get()).data();
  const handB = (await adminDb.doc(`mofumofuOnlineRooms/${roomId}/privateHands/${room.playerUids.B}`).get()).data();
  return { room, server, handA, handB };
}
async function injectPending(roomId, { from, to, animal = 'cat', claim = animal, faceUpCards = {}, handA, handB, npcHand, statuses }) {
  const docs = await roomDocs(roomId); const actionId = randomUUID(); const card = testCard(animal, `pending-${actionId}`);
  const roomPatch = {
    status: 'playing', currentTurnPlayerId: from, turnState: to === 'koharu' ? 'awaitingNpcPhase' : 'awaitingJudgment',
    publicOffer: { actionId, fromPlayerId: from, toPlayerId: to, claimAnimal: claim, status: 'pending' },
    faceUpCards: { A: [], B: [], koharu: [], ...faceUpCards },
    playerStatus: { A: 'active', B: 'active', koharu: 'active', ...(statuses || {}) },
    eliminationSnapshots: {}, finalResult: null, winnerPlayerId: null, draw: false, finishReason: null,
  };
  const pendingOffer = { actionId, fromPlayerId: from, toPlayerId: to, claimAnimal: claim, card };
  await Promise.all([
    adminDb.doc(`mofumofuOnlineRooms/${roomId}`).update(roomPatch),
    adminDb.doc(`mofumofuOnlineRooms/${roomId}/serverState/current`).update({ pendingOffer, npcHand: npcHand ?? docs.server.npcHand, discard: [] }),
    adminDb.doc(`mofumofuOnlineRooms/${roomId}/privateHands/${docs.room.playerUids.A}`).update({ cards: handA ?? docs.handA.cards }),
    adminDb.doc(`mofumofuOnlineRooms/${roomId}/privateHands/${docs.room.playerUids.B}`).update({ cards: handB ?? docs.handB.cards }),
  ]);
  return { actionId, card, docs };
}

test.after(async () => {
  await Promise.allSettled(clients.map(({ fs }) => terminate(fs)));
  await Promise.allSettled(clients.map(({ app }) => deleteApp(app)));
  if (ownedAdminApp) await deleteAdminApp(ownedAdminApp);
});

test('1 authentication, room creation, invite secrecy, and normal join', async () => {
  const unauth = client('unauth', false);
  await rejects(unauth.call('createMofumofuRoom', {}), 'unauthenticated');
  const a = client('base-a'); const b = client('base-b'); await Promise.all([a.ready, b.ready]);
  const created = await a.call('createMofumofuRoom', {});
  assert.match(created.roomId, /^[0-9a-f-]{36}$/); assert.match(created.inviteCode, /^[A-HJ-NP-Z2-9]{8}$/);
  const joined = await b.call('joinMofumofuRoom', { inviteCode: created.inviteCode });
  assert.equal(joined.roomId, created.roomId); assert.equal(joined.seatId, 'B');
  const room = (await adminDb.doc(`mofumofuOnlineRooms/${created.roomId}`).get()).data();
  assert.equal(JSON.stringify(room).includes(created.inviteCode), false);
  assert.equal(JSON.stringify(room).match(/npcHand|leftovers|actualAnimal|randomSeed/), null);
});

test('2 join rate limiting is UID isolated, unlocks, and external errors are uniform', async () => {
  const one = client('rate-one'); const two = client('rate-two'); await Promise.all([one.ready, two.ready]);
  for (let i = 0; i < 8; i += 1) await rejects(one.call('joinMofumofuRoom', { inviteCode: 'AAAAAAAA' }), 'failed-precondition');
  await rejects(one.call('joinMofumofuRoom', { inviteCode: 'AAAAAAAA' }), 'resource-exhausted');
  await rejects(two.call('joinMofumofuRoom', { inviteCode: 'AAAAAAAA' }), 'failed-precondition');
  await adminDb.doc(`mofumofuOnlineRateLimits/${one.auth.currentUser.uid}`).update({ windowStartedAt: Date.now() - 11 * 60 * 1000 });
  await rejects(one.call('joinMofumofuRoom', { inviteCode: 'AAAAAAAA' }), 'failed-precondition');
  const a = client('rate-host'); await a.ready; const created = await a.call('createMofumofuRoom', {});
  await adminDb.doc(`mofumofuOnlineRoomInvites/${digest(created.inviteCode)}`).update({ status: 'expired', expiresAt: Date.now() - 1 });
  await rejects(two.call('joinMofumofuRoom', { inviteCode: created.inviteCode }), 'failed-precondition');
});

test('3 join concurrency, self rejoin, third-person rejection, and waiting expiry', async () => {
  const host = client('join-host'); const b = client('join-b'); const c = client('join-c'); await Promise.all([host.ready, b.ready, c.ready]);
  const created = await host.call('createMofumofuRoom', {});
  const outcomes = await Promise.allSettled([b.call('joinMofumofuRoom', { inviteCode: created.inviteCode }), c.call('joinMofumofuRoom', { inviteCode: created.inviteCode })]);
  assert.equal(outcomes.filter((x) => x.status === 'fulfilled').length, 1);
  const winner = outcomes[0].status === 'fulfilled' ? b : c;
  assert.equal((await winner.call('joinMofumofuRoom', { inviteCode: created.inviteCode })).seatId, 'B');
  const third = winner === b ? c : b; await rejects(third.call('joinMofumofuRoom', { inviteCode: created.inviteCode }), 'failed-precondition');
  const expHost = client('expire-host'); const expB = client('expire-b'); await Promise.all([expHost.ready, expB.ready]);
  const exp = await expHost.call('createMofumofuRoom', {});
  await adminDb.doc(`mofumofuOnlineRooms/${exp.roomId}`).update({ joinExpiresAt: Date.now() - 1 });
  await rejects(expB.call('joinMofumofuRoom', { inviteCode: exp.inviteCode }), 'failed-precondition');
});

test('4 start guards, double start, unique deck, and distribution stay unchanged', async () => {
  const host = client('start-host'); const b = client('start-b'); await Promise.all([host.ready, b.ready]);
  const created = await host.call('createMofumofuRoom', {});
  await rejects(host.call('startMofumofuGame', { roomId: created.roomId }), 'failed-precondition');
  await b.call('joinMofumofuRoom', { inviteCode: created.inviteCode });
  await rejects(b.call('startMofumofuGame', { roomId: created.roomId }), 'permission-denied');
  await host.call('startMofumofuGame', { roomId: created.roomId });
  const paths = [`mofumofuOnlineRooms/${created.roomId}/privateHands/${host.auth.currentUser.uid}`, `mofumofuOnlineRooms/${created.roomId}/privateHands/${b.auth.currentUser.uid}`, `mofumofuOnlineRooms/${created.roomId}/serverState/current`];
  const before = await Promise.all(paths.map((path) => adminDb.doc(path).get().then((s) => s.data())));
  await rejects(host.call('startMofumofuGame', { roomId: created.roomId }), 'already-exists');
  const after = await Promise.all(paths.map((path) => adminDb.doc(path).get().then((s) => s.data())));
  assert.deepEqual(after, before);
  const all = [...before[0].cards, ...before[1].cards, ...before[2].npcHand, ...before[2].leftovers];
  assert.equal(all.length, 32); assert.equal(new Set(all.map((c) => c.cardId)).size, 32);
  const expHost = client('start-exp-host'); const expB = client('start-exp-b'); await Promise.all([expHost.ready, expB.ready]);
  const exp = await expHost.call('createMofumofuRoom', {}); await expB.call('joinMofumofuRoom', { inviteCode: exp.inviteCode });
  await adminDb.doc(`mofumofuOnlineRooms/${exp.roomId}`).update({ joinExpiresAt: Date.now() - 1 });
  await rejects(expHost.call('startMofumofuGame', { roomId: exp.roomId }), 'failed-precondition');
  const raceHost = client('start-race-host'); const raceB = client('start-race-b'); await Promise.all([raceHost.ready, raceB.ready]);
  const race = await raceHost.call('createMofumofuRoom', {}); await raceB.call('joinMofumofuRoom', { inviteCode: race.inviteCode });
  const startRace = await Promise.allSettled([raceHost.call('startMofumofuGame', { roomId: race.roomId }), raceHost.call('startMofumofuGame', { roomId: race.roomId })]);
  assert.equal(startRace.filter((x) => x.status === 'fulfilled').length, 1);
  const resumedDuringStart = await Promise.allSettled([raceHost.call('resumeMofumofuRoom', { roomId: race.roomId }), raceB.call('resumeMofumofuRoom', { roomId: race.roomId })]);
  for (const value of resumedDuringStart) if (value.status === 'fulfilled') assert.ok(['ready', 'retry'].includes(value.value.handStatus));
});

test('5 Firestore Rules isolate hands and deny every server namespace and direct writes', async () => {
  const room = await startedRoom('rules'); const outsider = client('rules-outsider'); await outsider.ready;
  assert.equal((await getDoc(doc(room.a.fs, `mofumofuOnlineRooms/${room.roomId}/privateHands/${room.a.auth.currentUser.uid}`))).data().cards.length, 10);
  assert.equal((await getDoc(doc(room.b.fs, `mofumofuOnlineRooms/${room.roomId}/privateHands/${room.b.auth.currentUser.uid}`))).data().cards.length, 10);
  await rejects(getDoc(doc(room.a.fs, `mofumofuOnlineRooms/${room.roomId}/privateHands/${room.b.auth.currentUser.uid}`)), 'permission-denied');
  await rejects(getDoc(doc(room.b.fs, `mofumofuOnlineRooms/${room.roomId}/privateHands/${room.a.auth.currentUser.uid}`)), 'permission-denied');
  for (const who of [room.a, room.b]) {
    for (const path of [`mofumofuOnlineRooms/${room.roomId}/serverState/current`, 'mofumofuOnlineRoomInvites/test', 'mofumofuOnlineRoomSecrets/test', `mofumofuOnlineRateLimits/${who.auth.currentUser.uid}`, `mofumofuOnlineActionRequests/${randomUUID()}`, `mofumofuOnlineRooms/${room.roomId}/unknown/secret`]) await rejects(getDoc(doc(who.fs, path)), 'permission-denied');
    await rejects(setDoc(doc(who.fs, `mofumofuOnlineRooms/${room.roomId}`), { status: 'finished' }, { merge: true }), 'permission-denied');
    for (const path of ['mofumofuOnlineRoomInvites/client-write', 'mofumofuOnlineRoomSecrets/client-write', `mofumofuOnlineRateLimits/${who.auth.currentUser.uid}`, `mofumofuOnlineActionRequests/${randomUUID()}`, `mofumofuOnlineRooms/${room.roomId}/serverState/current`]) {
      await rejects(setDoc(doc(who.fs, path), { reset: true }, { merge: true }), 'permission-denied');
    }
  }
  await rejects(getDoc(doc(outsider.fs, `mofumofuOnlineRooms/${room.roomId}`)), 'permission-denied');
});

test('6 resume exposes only own settled hand and pending offer remains secret', async () => {
  const room = await startedRoom('resume');
  assert.equal(room.ra.cards.length, 10); assert.equal(room.rb.cards.length, 10);
  const card = room.ra.cards[0]; const id = randomUUID();
  const made = await room.a.call('makeMofumofuOffer', { roomId: room.roomId, cardId: card.cardId, claimAnimal: 'fox', targetPlayerId: 'B', actionId: id });
  assert.equal(JSON.stringify(made).includes(card.animalType), card.animalType === 'fox');
  const [a, b] = await Promise.all([room.a.call('resumeMofumofuRoom', { roomId: room.roomId }), room.b.call('resumeMofumofuRoom', { roomId: room.roomId })]);
  for (const value of [a, b]) { assert.equal(value.room.publicOffer.actionId, id); assert.equal('actualAnimal' in value.room.publicOffer, false); }
  assert.equal(a.cards.length, 9); assert.equal(b.cards.length, 10);
});

test('7 make validates turn, ownership, claims, target, extras, and is idempotent under concurrency', async () => {
  const room = await startedRoom('make'); const aCard = room.ra.cards[0]; const bCard = room.rb.cards[0]; const id = randomUUID();
  await rejects(room.b.call('makeMofumofuOffer', { roomId: room.roomId, cardId: bCard.cardId, claimAnimal: 'cat', targetPlayerId: 'A', actionId: randomUUID() }), 'failed-precondition');
  await rejects(room.a.call('makeMofumofuOffer', { roomId: room.roomId, cardId: bCard.cardId, claimAnimal: 'cat', targetPlayerId: 'B', actionId: randomUUID() }), 'permission-denied');
  await rejects(room.a.call('makeMofumofuOffer', { roomId: room.roomId, cardId: aCard.cardId, claimAnimal: 'wolf', targetPlayerId: 'B', actionId: randomUUID() }), 'invalid-argument');
  await rejects(room.a.call('makeMofumofuOffer', { roomId: room.roomId, cardId: aCard.cardId, claimAnimal: 'cat', targetPlayerId: 'X', actionId: randomUUID() }), 'invalid-argument');
  await rejects(room.a.call('makeMofumofuOffer', { roomId: room.roomId, cardId: aCard.cardId, claimAnimal: 'cat', targetPlayerId: 'B', actionId: randomUUID(), actualAnimal: 'cat' }), 'invalid-argument');
  const payload = { roomId: room.roomId, cardId: aCard.cardId, claimAnimal: 'cat', targetPlayerId: 'B', actionId: id };
  const results = await Promise.all([room.a.call('makeMofumofuOffer', payload), room.a.call('makeMofumofuOffer', payload)]); assert.deepEqual(results[0], results[1]);
  assert.equal((await room.a.call('resumeMofumofuRoom', { roomId: room.roomId })).cards.length, 9);
  await rejects(room.a.call('makeMofumofuOffer', { ...payload, claimAnimal: 'bear' }), 'already-exists');
});

test('8 judge authorization, validation, success rule, reveal timing, and idempotency', async () => {
  const room = await startedRoom('judge'); const card = room.ra.cards[0]; const id = randomUUID();
  await room.a.call('makeMofumofuOffer', { roomId: room.roomId, cardId: card.cardId, claimAnimal: card.animalType, targetPlayerId: 'B', actionId: id });
  await rejects(room.a.call('judgeMofumofuOffer', { roomId: room.roomId, actionId: id, judgment: 'truth' }), 'permission-denied');
  await rejects(room.b.call('judgeMofumofuOffer', { roomId: room.roomId, actionId: id, judgment: 'maybe' }), 'invalid-argument');
  const payload = { roomId: room.roomId, actionId: id, judgment: 'truth' };
  const [one, two] = await Promise.all([room.b.call('judgeMofumofuOffer', payload), room.b.call('judgeMofumofuOffer', payload)]);
  assert.deepEqual(one, two); assert.equal(one.offer.success, true); assert.equal(one.offer.actualAnimal, card.animalType); assert.equal(one.offer.faceUpRecipientPlayerId, 'A'); assert.equal(one.currentTurnPlayerId, 'B');
  const publicRoom = (await adminDb.doc(`mofumofuOnlineRooms/${room.roomId}`).get()).data(); assert.equal(publicRoom.faceUpCards.A.length, 1);
  await rejects(room.b.call('judgeMofumofuOffer', { ...payload, judgment: 'lie' }), 'already-exists');
});

test('9 failed judgment gives face-up card to receiver and stale/cross-room actions fail', async () => {
  const one = await startedRoom('failure'); const card = one.ra.cards[0]; const id = randomUUID();
  await one.a.call('makeMofumofuOffer', { roomId: one.roomId, cardId: card.cardId, claimAnimal: card.animalType, targetPlayerId: 'B', actionId: id });
  const result = await one.b.call('judgeMofumofuOffer', { roomId: one.roomId, actionId: id, judgment: 'lie' }); assert.equal(result.offer.faceUpRecipientPlayerId, 'B');
  const two = await startedRoom('cross');
  await rejects(two.a.call('makeMofumofuOffer', { roomId: two.roomId, cardId: two.ra.cards[0].cardId, claimAnimal: 'cat', targetPlayerId: 'B', actionId: id }), 'already-exists');
});

test('10 fixed rotation is A-B-koharu-A and clients cannot choose next player', async () => {
  const room = await startedRoom('rotation'); const aCard = room.ra.cards[0];
  await rejects(room.a.call('makeMofumofuOffer', { roomId: room.roomId, cardId: aCard.cardId, claimAnimal: 'cat', targetPlayerId: 'B', actionId: randomUUID(), nextPlayerId: 'A' }), 'invalid-argument');
  let id = randomUUID(); await room.a.call('makeMofumofuOffer', { roomId: room.roomId, cardId: aCard.cardId, claimAnimal: 'cat', targetPlayerId: 'B', actionId: id }); await room.b.call('judgeMofumofuOffer', { roomId: room.roomId, actionId: id, judgment: 'truth' });
  let rb = await room.b.call('resumeMofumofuRoom', { roomId: room.roomId }); assert.equal(rb.room.currentTurnPlayerId, 'B');
  id = randomUUID(); await room.b.call('makeMofumofuOffer', { roomId: room.roomId, cardId: rb.cards[0].cardId, claimAnimal: 'bear', targetPlayerId: 'A', actionId: id }); await room.a.call('judgeMofumofuOffer', { roomId: room.roomId, actionId: id, judgment: 'lie' });
  assert.equal((await room.a.call('resumeMofumofuRoom', { roomId: room.roomId })).room.currentTurnPlayerId, 'koharu');
  const npc = await room.a.call('runMofumofuNpcTurn', { roomId: room.roomId, actionId: randomUUID() }); const judge = npc.offer.toPlayerId === 'A' ? room.a : room.b;
  const completed = await judge.call('judgeMofumofuOffer', { roomId: room.roomId, actionId: npc.offer.actionId, judgment: 'truth' }); assert.equal(completed.currentTurnPlayerId, 'A');
});

test('11 NPC callable rejects outsiders, extra decisions, unnecessary calls, and human make during NPC turn', async () => {
  const room = await startedRoom('npc-guards'); const outsider = client('npc-outsider'); await outsider.ready;
  await rejects(room.a.call('runMofumofuNpcTurn', { roomId: room.roomId, actionId: randomUUID() }), 'failed-precondition');
  await setTurn(room.roomId, 'koharu', 'awaitingNpcPhase');
  await rejects(outsider.call('runMofumofuNpcTurn', { roomId: room.roomId, actionId: randomUUID() }), 'permission-denied');
  for (const extra of [{ cardId: 'x' }, { claimAnimal: 'cat' }, { targetPlayerId: 'A' }, { judgment: 'truth' }, { nextPlayerId: 'A' }]) await rejects(room.a.call('runMofumofuNpcTurn', { roomId: room.roomId, actionId: randomUUID(), ...extra }), 'invalid-argument');
  await rejects(room.a.call('makeMofumofuOffer', { roomId: room.roomId, cardId: room.ra.cards[0].cardId, claimAnimal: 'cat', targetPlayerId: 'B', actionId: randomUUID() }), 'failed-precondition');
});

test('12 NPC own turn removes one real card, keeps actual secret, and only target judges', async () => {
  const room = await startedRoom('npc-offer'); await setTurn(room.roomId, 'koharu', 'awaitingNpcPhase');
  const before = (await adminDb.doc(`mofumofuOnlineRooms/${room.roomId}/serverState/current`).get()).data().npcHand;
  const result = await room.a.call('runMofumofuNpcTurn', { roomId: room.roomId, actionId: randomUUID() });
  const after = (await adminDb.doc(`mofumofuOnlineRooms/${room.roomId}/serverState/current`).get()).data();
  assert.equal(after.npcHand.length, before.length - 1); assert.equal(JSON.stringify(result).includes('actualAnimal'), false); assert.equal('cardId' in result.offer, false);
  const target = result.offer.toPlayerId === 'A' ? room.a : room.b; const other = target === room.a ? room.b : room.a;
  await rejects(other.call('judgeMofumofuOffer', { roomId: room.roomId, actionId: result.offer.actionId, judgment: 'truth' }), 'permission-denied');
  await target.call('judgeMofumofuOffer', { roomId: room.roomId, actionId: result.offer.actionId, judgment: 'truth' });
});

test('13 NPC declaration has truthful and lying branches and judgment cannot receive actualAnimal', () => {
  assert.equal(module._test.chooseNpcClaim('cat', 0.1, 0), 'cat');
  const lie = module._test.chooseNpcClaim('cat', 0.9, 0); assert.notEqual(lie, 'cat'); assert.ok(module._test.ANIMALS.includes(lie));
  assert.equal(module._test.chooseNpcJudgment.length, 0, 'default parameters keep JS length zero');
  assert.equal(module._test.chooseNpcJudgment.toString().includes('actualAnimal'), false);
  assert.equal(module._test.chooseNpcJudgment({ truth: 10, total: 10 }, 0.7), 'truth');
  assert.equal(module._test.chooseNpcJudgment({ truth: 0, total: 10 }, 0.3), 'lie');
});

test('14 human-to-NPC is resolved only by NPC callable without cheating and advances from origin', async () => {
  const room = await startedRoom('human-npc'); const card = room.ra.cards[0]; const makeId = randomUUID();
  await room.a.call('makeMofumofuOffer', { roomId: room.roomId, cardId: card.cardId, claimAnimal: card.animalType, targetPlayerId: 'koharu', actionId: makeId });
  await rejects(room.a.call('judgeMofumofuOffer', { roomId: room.roomId, actionId: makeId, judgment: 'truth' }), 'failed-precondition');
  await rejects(room.b.call('judgeMofumofuOffer', { roomId: room.roomId, actionId: makeId, judgment: 'truth' }), 'failed-precondition');
  const npcId = randomUUID(); const [one, two] = await Promise.all([room.a.call('runMofumofuNpcTurn', { roomId: room.roomId, actionId: npcId }), room.a.call('runMofumofuNpcTurn', { roomId: room.roomId, actionId: npcId })]);
  assert.deepEqual(one, two); assert.equal(one.mode, 'npcJudgment'); assert.equal(one.currentTurnPlayerId, 'B');
  const publicRoom = (await adminDb.doc(`mofumofuOnlineRooms/${room.roomId}`).get()).data(); assert.equal(publicRoom.faceUpCards.A.length + publicRoom.faceUpCards.koharu.length, 1);
});

test('15 concurrent NPC callers cause one state transition and action records contain no secrets', async () => {
  const room = await startedRoom('npc-race'); await setTurn(room.roomId, 'koharu', 'awaitingNpcPhase');
  const before = (await adminDb.doc(`mofumofuOnlineRooms/${room.roomId}/serverState/current`).get()).data().npcHand.length;
  const idA = randomUUID(); const idB = randomUUID();
  const results = await Promise.allSettled([room.a.call('runMofumofuNpcTurn', { roomId: room.roomId, actionId: idA }), room.b.call('runMofumofuNpcTurn', { roomId: room.roomId, actionId: idB })]);
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
  const after = (await adminDb.doc(`mofumofuOnlineRooms/${room.roomId}/serverState/current`).get()).data().npcHand.length; assert.equal(after, before - 1);
  const actionId = results[0].status === 'fulfilled' ? idA : idB; const action = (await adminDb.doc(`mofumofuOnlineActionRequests/${actionId}`).get()).data();
  assert.equal(JSON.stringify(action).match(/npcHand|actualAnimal|leftovers/), null);
  const originalCaller = results[0].status === 'fulfilled' ? room.a : room.b;
  const otherCaller = originalCaller === room.a ? room.b : room.a;
  assert.deepEqual(await originalCaller.call('runMofumofuNpcTurn', { roomId: room.roomId, actionId }), results.find((x) => x.status === 'fulfilled').value);
  await rejects(otherCaller.call('runMofumofuNpcTurn', { roomId: room.roomId, actionId }), 'already-exists');
  const otherRoom = await startedRoom('npc-cross-room'); await setTurn(otherRoom.roomId, 'koharu', 'awaitingNpcPhase');
  await rejects(otherRoom.a.call('runMofumofuNpcTurn', { roomId: otherRoom.roomId, actionId }), 'already-exists');
});

test('16 client code stores only room/seat and never handles pre-judgment actualAnimal or NPC decisions', async () => {
  const source = await readFile(new URL('../toybox/mofumofu-gathering/online/script.js', import.meta.url), 'utf8');
  assert.match(source, /localStorage\.setItem\('mofumofuRoomId'/); assert.match(source, /localStorage\.setItem\('mofumofuSeatId'/);
  assert.equal(/localStorage\.setItem\([^)]*(actualAnimal|cards|publicOffer)/.test(source), false);
  assert.match(source, /runMofumofuNpcTurn', state\.npcRequest/);
  assert.equal(/npcRequest\s*\|\|=\s*\{[^}]+(cardId|claimAnimal|targetPlayerId|judgment|nextPlayerId)/s.test(source), false);
  assert.equal(source.includes('console.'), false); assert.equal(source.includes('dataset.actualAnimal'), false);
});

test('17-25 Phase 4 A elimination is atomic, secret-safe, idempotent, and blocks future actions', async () => {
  const game = await startedRoom('phase4-a'); const prior = [testCard('cat', 'up-1'), testCard('cat', 'up-2'), testCard('cat', 'up-3')];
  const injected = await injectPending(game.roomId, { from: 'A', to: 'B', animal: 'cat', faceUpCards: { A: prior } });
  const payload = { roomId: game.roomId, actionId: injected.actionId, judgment: 'truth' };
  const [first, replay] = await Promise.all([game.b.call('judgeMofumofuOffer', payload), game.b.call('judgeMofumofuOffer', payload)]);
  assert.deepEqual(first, replay); assert.equal(first.eliminatedPlayerId, 'A');
  const after = await roomDocs(game.roomId); const snapshot = after.room.eliminationSnapshots.A;
  assert.equal(after.room.playerStatus.A, 'eliminated'); assert.equal(after.handA.cards.length, 0); assert.equal(after.room.faceUpCards.A.length, 0);
  assert.equal(snapshot.eliminationAnimal, 'cat'); assert.equal(snapshot.faceUpCardsByAnimal.cat, 4); assert.equal(snapshot.faceUpCardsTotal, 4);
  assert.equal(after.server.discard.length, injected.docs.handA.cards.length + 4); assert.equal(new Set(after.server.discard.map((card) => card.cardId)).size, after.server.discard.length);
  assert.equal(JSON.stringify(after.room).includes('privateHands'), false); assert.equal(JSON.stringify(first).includes('discard'), false);
  const resumed = await game.a.call('resumeMofumofuRoom', { roomId: game.roomId }); assert.equal(resumed.handStatus, 'eliminated'); assert.deepEqual(resumed.cards, []);
  await rejects(game.a.call('makeMofumofuOffer', { roomId: game.roomId, cardId: 'cat-x', claimAnimal: 'cat', targetPlayerId: 'B', actionId: randomUUID() }), 'failed-precondition');
  const beforeReplay = JSON.stringify(after.server.discard); await game.b.call('judgeMofumofuOffer', payload); assert.equal(JSON.stringify((await roomDocs(game.roomId)).server.discard), beforeReplay);
});

test('26-32 B elimination skips B and rotation starts from original offer maker', async () => {
  const game = await startedRoom('phase4-b'); const prior = [testCard('rabbit', 'up-1'), testCard('rabbit', 'up-2'), testCard('rabbit', 'up-3')];
  const injected = await injectPending(game.roomId, { from: 'A', to: 'B', animal: 'rabbit', faceUpCards: { B: prior } });
  const result = await game.b.call('judgeMofumofuOffer', { roomId: game.roomId, actionId: injected.actionId, judgment: 'lie' });
  assert.equal(result.eliminatedPlayerId, 'B'); assert.equal(result.currentTurnPlayerId, 'koharu');
  const after = await roomDocs(game.roomId); assert.equal(after.room.playerStatus.B, 'eliminated'); assert.equal(after.room.currentTurnPlayerId, 'koharu');
  await setTurn(game.roomId, 'A'); await rejects(game.a.call('makeMofumofuOffer', { roomId: game.roomId, cardId: after.handA.cards[0].cardId, claimAnimal: 'cat', targetPlayerId: 'B', actionId: randomUUID() }), 'failed-precondition');
});

test('33-37 koharu elimination clears NPC hand and rotation skips koharu', async () => {
  const game = await startedRoom('phase4-koharu'); const prior = [testCard('bear', 'up-1'), testCard('bear', 'up-2'), testCard('bear', 'up-3')];
  const injected = await injectPending(game.roomId, { from: 'koharu', to: 'A', animal: 'bear', faceUpCards: { koharu: prior } });
  const result = await game.a.call('judgeMofumofuOffer', { roomId: game.roomId, actionId: injected.actionId, judgment: 'truth' });
  assert.equal(result.eliminatedPlayerId, 'koharu'); assert.equal(result.currentTurnPlayerId, 'A');
  const after = await roomDocs(game.roomId); assert.deepEqual(after.server.npcHand, []); assert.equal(after.room.faceUpCards.koharu.length, 0);
  await adminDb.doc(`mofumofuOnlineRooms/${game.roomId}`).update({ currentTurnPlayerId: 'koharu', turnState: 'awaitingNpcPhase' });
  await rejects(game.a.call('runMofumofuNpcTurn', { roomId: game.roomId, actionId: randomUUID() }), 'failed-precondition');
});

test('38-46 three active players: any empty server-side hand ends game and compares every active face-up total', async () => {
  // Offline beginTurn checks alive.some(hand.length === 0), so three survivors also finish immediately.
  const game = await startedRoom('phase4-empty');
  const injected = await injectPending(game.roomId, { from: 'A', to: 'B', animal: 'fox', faceUpCards: { A: [testCard('cat')], B: [testCard('cat'), testCard('bear')], koharu: [testCard('rabbit')] }, handA: [testCard('fox', 'last')] });
  // Use the actual injected pending card as A's sole offered card state: make has already removed it, hence empty.
  await adminDb.doc(`mofumofuOnlineRooms/${game.roomId}/privateHands/${injected.docs.room.playerUids.A}`).update({ cards: [] });
  const result = await game.b.call('judgeMofumofuOffer', { roomId: game.roomId, actionId: injected.actionId, judgment: 'truth' });
  assert.equal(result.finish.finishReason, 'hand-empty'); assert.equal(result.finish.winnerPlayerId, 'koharu'); assert.equal(result.finish.draw, false);
  const after = await roomDocs(game.roomId); assert.equal(after.room.status, 'finished'); assert.equal(after.room.finalResult.players.length, 3);
});

test('47-56 hand-empty ties are draws and final result contains public collections but no hands', () => {
  const room = { playerStatus: { A: 'active', B: 'active', koharu: 'active' }, faceUpCards: { A: [testCard('cat')], B: [], koharu: [testCard('fox'), testCard('fox')] }, eliminationSnapshots: {}, turnNumber: 4 };
  const pending = { actionId: randomUUID(), fromPlayerId: 'A', toPlayerId: 'B', claimAnimal: 'rabbit', card: testCard('rabbit') };
  const resolved = module._test.resolveFaceUp(room, { npcHand: [testCard('cat')], discard: [], pendingOffer: pending }, { A: [], B: [testCard('bear')] }, pending, 'lie', Date.now());
  assert.equal(resolved.finish.finishReason, 'hand-empty'); assert.equal(resolved.finish.winnerPlayerId, null); assert.equal(resolved.finish.draw, true);
  assert.equal(resolved.room.finalResult.players.length, 3); assert.equal(JSON.stringify(resolved.room.finalResult).includes('cardId'), false); assert.equal(JSON.stringify(resolved.room.finalResult).includes('npcHand'), false);
});

test('57-66 last player standing finishes, invite ends, finished operations reject, replay and resume are stable', async () => {
  const game = await startedRoom('phase4-last'); const secret = (await adminDb.doc(`mofumofuOnlineRoomSecrets/${game.roomId}`).get()).data();
  const prior = [testCard('panda', 'up-1'), testCard('panda', 'up-2'), testCard('panda', 'up-3')];
  const injected = await injectPending(game.roomId, { from: 'A', to: 'B', animal: 'panda', faceUpCards: { B: prior }, statuses: { koharu: 'eliminated' } });
  const payload = { roomId: game.roomId, actionId: injected.actionId, judgment: 'lie' }; const result = await game.b.call('judgeMofumofuOffer', payload);
  assert.equal(result.finish.finishReason, 'last-player-standing'); assert.equal(result.finish.winnerPlayerId, 'A'); assert.equal(result.finish.draw, false);
  const after = await roomDocs(game.roomId); assert.equal(after.room.status, 'finished'); assert.equal(after.room.finalResult.winnerPlayerId, 'A');
  assert.equal((await adminDb.doc(`mofumofuOnlineRoomInvites/${secret.inviteDigest}`).get()).data().status, 'ended');
  await rejects(game.a.call('makeMofumofuOffer', { roomId: game.roomId, cardId: after.handA.cards[0].cardId, claimAnimal: 'cat', targetPlayerId: 'B', actionId: randomUUID() }), 'failed-precondition');
  await rejects(game.b.call('judgeMofumofuOffer', { roomId: game.roomId, actionId: randomUUID(), judgment: 'truth' }), 'failed-precondition');
  await rejects(game.a.call('runMofumofuNpcTurn', { roomId: game.roomId, actionId: randomUUID() }), 'failed-precondition');
  assert.deepEqual(await game.b.call('judgeMofumofuOffer', payload), result);
  const resumed = await game.a.call('resumeMofumofuRoom', { roomId: game.roomId }); assert.equal(resumed.room.status, 'finished'); assert.ok(resumed.room.finalResult); assert.deepEqual(resumed.cards, []);
});

test('67-75 Phase 4 rules and static client secrecy/controls remain closed', async () => {
  const game = await startedRoom('phase4-rules');
  for (const who of [game.a, game.b]) {
    await rejects(getDoc(doc(who.fs, `mofumofuOnlineRooms/${game.roomId}/serverState/current`)), 'permission-denied');
    await rejects(getDoc(doc(who.fs, `mofumofuOnlineRooms/${game.roomId}/serverState/discard`)), 'permission-denied');
    await rejects(setDoc(doc(who.fs, `mofumofuOnlineRooms/${game.roomId}`), { playerStatus: { A: 'eliminated' } }, { merge: true }), 'permission-denied');
    await rejects(setDoc(doc(who.fs, `mofumofuOnlineRooms/${game.roomId}`), { finalResult: { winnerPlayerId: 'A' } }, { merge: true }), 'permission-denied');
  }
  const source = await readFile(new URL('../toybox/mofumofu-gathering/online/script.js', import.meta.url), 'utf8');
  assert.equal(source.includes('console.'), false); assert.equal(/localStorage\.setItem\([^)]*(cards|actualAnimal|finalResult)/.test(source), false);
  assert.match(source, /ownStatus === 'active'/); assert.match(source, /renderFinalResult/); assert.match(source, /room\.status === 'finished'/);
  assert.match(source, /room\.status === 'finished' \|\| room\.playerStatus\?\.\[state\.seatId\] === 'eliminated'[\s\S]*?state\.cards = \[\]/);
});

test('Phase 4 boundary: three matching or four mixed face-up cards do not eliminate', () => {
  for (const faceUp of [
    [testCard('cat'), testCard('cat')],
    [testCard('cat'), testCard('rabbit'), testCard('bear')],
  ]) {
    const room = { playerStatus: { A: 'active', B: 'active', koharu: 'active' }, faceUpCards: { A: faceUp, B: [], koharu: [] }, eliminationSnapshots: {}, turnNumber: 1 };
    const pending = { actionId: randomUUID(), fromPlayerId: 'A', toPlayerId: 'B', claimAnimal: 'cat', card: testCard('cat') };
    const resolved = module._test.resolveFaceUp(room, { npcHand: [testCard('fox')], discard: [], pendingOffer: pending }, { A: [testCard('bear')], B: [testCard('rabbit')] }, pending, 'truth', Date.now());
    assert.equal(resolved.eliminatedPlayerId, null); assert.equal(resolved.room.playerStatus.A, 'active');
  }
});

test('Phase 4 NPC judgment elimination is atomic and same actionId replay has no duplicate discard', async () => {
  const game = await startedRoom('phase4-npc-elim'); const priorA = [testCard('polar'), testCard('polar'), testCard('polar')]; const priorK = [testCard('polar'), testCard('polar'), testCard('polar')];
  const injected = await injectPending(game.roomId, { from: 'A', to: 'koharu', animal: 'polar', claim: 'polar', faceUpCards: { A: priorA, koharu: priorK } });
  const npcActionId = randomUUID(); const payload = { roomId: game.roomId, actionId: npcActionId };
  const [one, two] = await Promise.all([game.a.call('runMofumofuNpcTurn', payload), game.a.call('runMofumofuNpcTurn', payload)]);
  assert.deepEqual(one, two); assert.ok(['A', 'koharu'].includes(one.eliminatedPlayerId));
  const before = await roomDocs(game.roomId); const discardIds = before.server.discard.map((card) => card.cardId);
  assert.equal(new Set(discardIds).size, discardIds.length); assert.equal(Object.keys(before.room.eliminationSnapshots).length, 1);
  assert.deepEqual(await game.a.call('runMofumofuNpcTurn', payload), one);
  const after = await roomDocs(game.roomId); assert.deepEqual(after.server.discard, before.server.discard); assert.deepEqual(after.room.eliminationSnapshots, before.room.eliminationSnapshots);
  assert.equal(JSON.stringify(one).includes('discard'), false); assert.equal(JSON.stringify(one).includes('npcHand'), false);
});

test('Phase 4 NPC offer targets only active humans', async () => {
  const game = await startedRoom('phase4-npc-target'); await setTurn(game.roomId, 'koharu', 'awaitingNpcPhase');
  await adminDb.doc(`mofumofuOnlineRooms/${game.roomId}`).update({ 'playerStatus.B': 'eliminated' });
  const result = await game.a.call('runMofumofuNpcTurn', { roomId: game.roomId, actionId: randomUUID() });
  assert.equal(result.mode, 'npcOffer'); assert.equal(result.offer.toPlayerId, 'A');
});

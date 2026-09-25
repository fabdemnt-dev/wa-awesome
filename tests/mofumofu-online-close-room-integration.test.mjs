// closeHandler の実挙動を、既存harnessと同じ「direct handler + Firestore emulator」で検証する。
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const projectId = 'demo-mofumofu-online';
const functionRequire = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp, getApps, deleteApp } = functionRequire('firebase-admin/app');
const { getFirestore } = functionRequire('firebase-admin/firestore');
if (!getApps().length) initializeApp({ projectId, databaseURL: `https://${projectId}.firebaseio.com` });
const db = getFirestore();
const module = functionRequire('./mofumofu-online');
const handlers = module._handlers;

const freshUid = () => `close-${randomUUID()}`;
const request = (uid, data) => ({ data, auth: { uid }, rawRequest: { ip: '127.0.0.1' } });
const codeOf = (error) => String(error?.code || '').replace(/^functions\//, '');
const digestOf = (code) => createHash('sha256').update(code).digest('hex');
async function rejects(promise, code) { await assert.rejects(promise, (error) => codeOf(error) === code); }
async function createRoom(uid) { return handlers.createHandler(request(uid, {})); }
async function closeRoom(uid, data) { return handlers.closeHandler(request(uid, data)); }

test.after(async () => { await deleteApp(getApps()[0]); });

test('close: the host closes a waiting room with B joined, and everything is cleaned up', async () => {
  const uidA = freshUid(); const uidB = freshUid();
  const created = await createRoom(uidA);
  await handlers.joinHandler(request(uidB, { inviteCode: created.inviteCode }));
  const actionId = randomUUID();
  const result = await closeRoom(uidA, { roomId: created.roomId, actionId });
  assert.deepEqual(result, { roomId: created.roomId, actionId, status: 'closed' });
  assert.equal((await db.doc(`mofumofuOnlineRooms/${created.roomId}`).get()).exists, false, 'room must be gone');
  assert.equal((await db.doc(`mofumofuOnlineRoomSecrets/${created.roomId}`).get()).exists, false, 'secret must be gone');
  assert.equal((await db.collection(`mofumofuOnlineRooms/${created.roomId}/members`).get()).size, 0, 'members must be gone');
  const invite = (await db.doc(`mofumofuOnlineRoomInvites/${digestOf(created.inviteCode)}`).get()).data();
  assert.equal(invite.status, 'closed', 'invite must be closed, not active');
  await rejects(handlers.joinHandler(request(freshUid(), { inviteCode: created.inviteCode })), 'failed-precondition');
});

test('close: the same actionId + payload replays the original success even after the room is gone', async () => {
  const uidA = freshUid();
  const created = await createRoom(uidA);
  const actionId = randomUUID();
  const first = await closeRoom(uidA, { roomId: created.roomId, actionId });
  for (let i = 0; i < 8; i += 1) assert.deepEqual(await closeRoom(uidA, { roomId: created.roomId, actionId }), first);
  await rejects(closeRoom(uidA, { roomId: randomUUID(), actionId }), 'already-exists');
  await rejects(closeRoom(uidA, { roomId: created.roomId, actionId: randomUUID() }), 'not-found');
});

test('close: only the host can close, and the room survives a rejected attempt', async () => {
  const uidA = freshUid(); const uidB = freshUid();
  const created = await createRoom(uidA);
  await handlers.joinHandler(request(uidB, { inviteCode: created.inviteCode }));
  await rejects(closeRoom(uidB, { roomId: created.roomId, actionId: randomUUID() }), 'permission-denied');
  assert.equal((await db.doc(`mofumofuOnlineRooms/${created.roomId}`).get()).exists, true);
  await rejects(closeRoom(freshUid(), { roomId: created.roomId, actionId: randomUUID() }), 'permission-denied');
});

test('close: a started game cannot be closed, and an unauthenticated call is rejected', async () => {
  const uidA = freshUid(); const uidB = freshUid();
  const created = await createRoom(uidA);
  await handlers.joinHandler(request(uidB, { inviteCode: created.inviteCode }));
  await handlers.startHandler(request(uidA, { roomId: created.roomId }));
  await rejects(closeRoom(uidA, { roomId: created.roomId, actionId: randomUUID() }), 'failed-precondition');
  await rejects(handlers.closeHandler({ data: { roomId: created.roomId, actionId: randomUUID() }, auth: null, rawRequest: { ip: '127.0.0.1' } }), 'unauthenticated');
  await rejects(closeRoom(uidA, { roomId: created.roomId }), 'invalid-argument');
});

test('close: a cleanup-removed room is not-found, while its own replay still succeeds', async () => {
  const uidA = freshUid();
  const created = await createRoom(uidA);
  const actionId = randomUUID();
  const first = await closeRoom(uidA, { roomId: created.roomId, actionId });
  const cleanupRoom = await createRoom(uidA);
  await db.doc(`mofumofuOnlineRooms/${cleanupRoom.roomId}`).delete();
  await db.doc(`mofumofuOnlineRoomSecrets/${cleanupRoom.roomId}`).delete();
  await rejects(closeRoom(uidA, { roomId: cleanupRoom.roomId, actionId: randomUUID() }), 'not-found');
  assert.deepEqual(await closeRoom(uidA, { roomId: created.roomId, actionId }), first);
});

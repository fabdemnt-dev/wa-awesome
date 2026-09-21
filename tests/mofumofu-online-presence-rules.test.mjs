import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { ref, get, set, update } from 'firebase/database';

const projectId = 'demo-mofumofu-presence-three';
const roomId = randomUUID();
const otherRoomId = randomUUID();
const aId = 'presence-a';
const bId = 'presence-b';
const aConnection = randomUUID();
const bConnection = randomUUID();
let env;

function record(uid, seatId, connectionId, overrides = {}) {
  const now = Date.now();
  return { uid, roomId, seatId, connectionId, state: 'online', lastHeartbeatAt: now, connectedAt: now, ...overrides };
}

test.before(async () => {
  env = await initializeTestEnvironment({
    projectId,
    database: { host: '127.0.0.1', port: 9103, rules: fs.readFileSync('database.rules.json', 'utf8') },
  });
  await env.withSecurityRulesDisabled(async (context) => {
    const database = context.database();
    const expiresAt = Date.now() + 60_000;
    await set(ref(database, `mofumofuOnlinePresenceAccess/${roomId}/${aId}`), { uid: aId, roomId, seatId: 'A', expiresAt });
    await set(ref(database, `mofumofuOnlinePresenceAccess/${roomId}/${bId}`), { uid: bId, roomId, seatId: 'B', expiresAt });
  });
});
test.after(async () => { await env?.cleanup(); });

test('presence Rules: admitted users write only their own valid connections', async () => {
  const a = env.authenticatedContext(aId).database();
  const b = env.authenticatedContext(bId).database();
  const unauthenticated = env.unauthenticatedContext().database();
  await assertSucceeds(set(ref(a, `mofumofuOnlinePresence/${roomId}/${aId}/connections/${aConnection}`), record(aId, 'A', aConnection)));
  await assertSucceeds(set(ref(b, `mofumofuOnlinePresence/${roomId}/${bId}/connections/${bConnection}`), record(bId, 'B', bConnection)));
  await assertSucceeds(update(ref(a, `mofumofuOnlinePresence/${roomId}/${aId}/connections/${aConnection}`), { lastHeartbeatAt: Date.now() }));
  const unauthConnection = randomUUID(); const forgedConnection = randomUUID();
  await assertFails(set(ref(unauthenticated, `mofumofuOnlinePresence/${roomId}/x/connections/${unauthConnection}`), record('x', 'A', unauthConnection)));
  await assertFails(set(ref(a, `mofumofuOnlinePresence/${roomId}/${bId}/connections/${forgedConnection}`), record(bId, 'B', forgedConnection)));
  await assertFails(update(ref(b, `mofumofuOnlinePresence/${roomId}/${aId}/connections/${aConnection}`), { state: 'disconnected' }));
});

test('presence Rules: room, seat, connection format and fields are closed', async () => {
  const a = env.authenticatedContext(aId).database();
  await assertFails(set(ref(a, `mofumofuOnlinePresence/${otherRoomId}/${aId}/connections/${aConnection}`), { ...record(aId, 'A', aConnection), roomId: otherRoomId }));
  const wrongSeatConnection = randomUUID();
  await assertFails(set(ref(a, `mofumofuOnlinePresence/${roomId}/${aId}/connections/${wrongSeatConnection}`), record(aId, 'B', wrongSeatConnection)));
  await assertFails(set(ref(a, `mofumofuOnlinePresence/${roomId}/${aId}/connections/not-a-uuid`), record(aId, 'A', 'not-a-uuid')));
  for (const forbidden of ['cards', 'cardId', 'animalType', 'actualAnimal', 'pendingOffer', 'npcHand', 'discard', 'inviteCode']) {
    const connectionId = randomUUID();
    await assertFails(set(ref(a, `mofumofuOnlinePresence/${roomId}/${aId}/connections/${connectionId}`), { ...record(aId, 'A', connectionId), [forbidden]: 'secret' }));
  }
  const stored = await assertSucceeds(get(ref(a, `mofumofuOnlinePresence/${roomId}`)));
  assert.equal(stored.exists(), true);
});

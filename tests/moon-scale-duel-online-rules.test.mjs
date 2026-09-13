import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initializeTestEnvironment, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';

let env;
test.before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-moon-scale-duel',
    firestore: { host: '127.0.0.1', port: 8080, rules: fs.readFileSync('firestore.rules', 'utf8') },
  });
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'moonScaleDuelRooms/room-a'), { status: 'playing' });
    await setDoc(doc(db, 'moonScaleDuelRooms/room-a/privatePlayers/u1'), { seatId: 'seat1' });
    await setDoc(doc(db, 'moonScaleDuelRooms/room-a/privatePlayers/u2'), { seatId: 'seat2' });
    await setDoc(doc(db, 'moonScaleDuelRooms/room-a/serverGames/game-a'), { secret: true });
    await setDoc(doc(db, 'moonScaleDuelRoomSecrets/room-a'), { inviteMac: 'secret' });
  });
});
test.after(async () => { if (env) await env.cleanup(); });

test('Firestore denies every direct moon-scale game read and write', async () => {
  const member = env.authenticatedContext('u1').firestore();
  for (const target of [
    'moonScaleDuelRooms/room-a',
    'moonScaleDuelRooms/room-a/privatePlayers/u1',
    'moonScaleDuelRooms/room-a/privatePlayers/u2',
    'moonScaleDuelRooms/room-a/serverGames/game-a',
    'moonScaleDuelRoomSecrets/room-a',
  ]) {
    await assertFails(getDoc(doc(member, target)));
  }
  await assertFails(setDoc(doc(member, 'moonScaleDuelRooms/room-a/games/forged'), { moonShadow: 999 }));
});

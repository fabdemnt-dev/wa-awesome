import test from 'node:test';
import fs from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';
let env;
test.before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-shadow-card', firestore: { host: '127.0.0.1', port: 8080, rules: fs.readFileSync('firestore.rules', 'utf8') } });
  await env.withSecurityRulesDisabled(async c => {
    const db = c.firestore();
    await setDoc(doc(db, 'shadowCardRooms/r1'), { status: 'playing' });
    await setDoc(doc(db, 'shadowCardRooms/r1/members/u1'), { leftAt: null });
    await setDoc(doc(db, 'shadowCardRooms/r1/members/u2'), { leftAt: null });
    await setDoc(doc(db, 'shadowCardRooms/r1/privatePlayers/u1/rounds/1'), { hand: ['assist'] });
    await setDoc(doc(db, 'shadowCardRooms/r1/serverRounds/1'), { hands: { secret: true } });
  });
});
test.after(async () => { if (env) await env.cleanup(); });
test('member reads own hand only', async () => {
  const db = env.authenticatedContext('u1').firestore();
  await assertSucceeds(getDoc(doc(db, 'shadowCardRooms/r1/privatePlayers/u1/rounds/1')));
  await assertFails(getDoc(doc(db, 'shadowCardRooms/r1/privatePlayers/u2/rounds/1')));
  await assertFails(getDoc(doc(db, 'shadowCardRooms/r1/serverRounds/1')));
});
test('matching uid must also be a current room member', async () => {
  const db = env.authenticatedContext('outsider').firestore();
  await assertFails(getDoc(doc(db, 'shadowCardRooms/r1/privatePlayers/outsider/rounds/1')));
});
test('clients cannot write game data', async () => {
  const db = env.authenticatedContext('u1').firestore();
  await assertFails(setDoc(doc(db, 'shadowCardRooms/r1/results/1'), { forged: true }));
});

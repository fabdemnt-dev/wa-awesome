import test from 'node:test';
import fs from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { ref, get, set } from 'firebase/database';

let env;
test.before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-moon-scale-duel',
    database: { host: '127.0.0.1', port: 9000, rules: fs.readFileSync('database.rules.json', 'utf8') },
  });
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.database();
    await set(ref(db, 'moonScaleDuelRoomAccess/room-a/u1'), true);
    await set(ref(db, 'moonScaleDuelRoomAccess/room-a/u2'), true);
    await set(ref(db, 'moonScaleDuelPresence/room-a/u2'), { state: 'online', lastChanged: 1 });
  });
});
test.after(async () => { if (env) await env.cleanup(); });

test('RTDB allows only an admitted uid to write its own valid presence', async () => {
  const member = env.authenticatedContext('u1').database();
  await assertSucceeds(set(ref(member, 'moonScaleDuelPresence/room-a/u1'), { state: 'online', lastChanged: 2 }));
  await assertSucceeds(get(ref(member, 'moonScaleDuelPresence/room-a/u2')));
  await assertFails(set(ref(member, 'moonScaleDuelPresence/room-a/u2'), { state: 'offline', lastChanged: 3 }));
  await assertFails(set(ref(member, 'moonScaleDuelPresence/room-a/u1'), { state: 'away', lastChanged: 4 }));
  const outsider = env.authenticatedContext('outsider').database();
  await assertFails(set(ref(outsider, 'moonScaleDuelPresence/room-a/outsider'), { state: 'online', lastChanged: 5 }));
});

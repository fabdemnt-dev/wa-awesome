import test from 'node:test';
import fs from 'node:fs';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import {
  get,
  ref,
  remove,
  set,
  update,
} from 'firebase/database';

let env;

function anonymousDatabase(uid) {
  return env.authenticatedContext(uid, {
    firebase: {
      sign_in_provider: 'anonymous',
    },
  }).database();
}

test.before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-shadow-card',
    database: {
      host: '127.0.0.1',
      port: 9000,
      rules: fs.readFileSync('database.rules.json', 'utf8'),
    },
  });

  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.database();
    await set(ref(db, 'shadowCardRoomAccess/room-a/u1'), true);
    await set(ref(db, 'shadowCardRoomAccess/room-a/u2'), true);
    await set(ref(db, 'shadowCardPresence/room-a/u2'), {
      state: 'online',
      lastChanged: 1,
    });
  });
});

test.after(async () => {
  if (env) await env.cleanup();
});

test('participant writes valid presence to own uid only', async () => {
  const db = anonymousDatabase('u1');
  const ownPresence = ref(db, 'shadowCardPresence/room-a/u1');

  await assertSucceeds(set(ownPresence, {
    state: 'online',
    lastChanged: 2,
  }));
  await assertSucceeds(set(ownPresence, {
    state: 'offline',
    lastChanged: 3,
  }));
});

test('invalid or incomplete presence is rejected', async () => {
  const db = anonymousDatabase('u1');
  const ownPresence = ref(db, 'shadowCardPresence/room-a/u1');

  await assertFails(set(ownPresence, { state: 'online' }));
  await assertFails(set(ownPresence, { lastChanged: 4 }));
  await assertFails(set(ownPresence, {
    state: 'away',
    lastChanged: 5,
  }));
  await assertFails(set(ownPresence, {
    state: 'online',
    lastChanged: 'not-a-number',
  }));
  await assertFails(set(ownPresence, {
    state: 'online',
    lastChanged: 6,
    extra: true,
  }));
});

test('participant cannot delete own presence', async () => {
  const db = anonymousDatabase('u1');
  const ownPresence = ref(db, 'shadowCardPresence/room-a/u1');

  await assertFails(set(ownPresence, null));
  await assertFails(remove(ownPresence));
});

test('participant reads uid presence but not the room collection', async () => {
  const db = anonymousDatabase('u1');

  await assertSucceeds(get(ref(db, 'shadowCardPresence/room-a/u2')));
  await assertFails(get(ref(db, 'shadowCardPresence/room-a')));
});

test('participant cannot create update or delete another uid presence', async () => {
  const db = anonymousDatabase('u1');
  const newForeignPresence = ref(db, 'shadowCardPresence/room-a/foreign-uid');
  const otherPresence = ref(db, 'shadowCardPresence/room-a/u2');

  await assertFails(set(newForeignPresence, {
    state: 'online',
    lastChanged: 7,
  }));
  await assertFails(update(otherPresence, {
    state: 'offline',
    lastChanged: 8,
  }));
  await assertFails(set(otherPresence, null));
  await assertFails(remove(otherPresence));
});

test('clients cannot write room access markers', async () => {
  const participant = anonymousDatabase('u1');
  const outsider = anonymousDatabase('outsider');

  await assertFails(set(
    ref(participant, 'shadowCardRoomAccess/room-a/u1'),
    false,
  ));
  await assertFails(set(
    ref(outsider, 'shadowCardRoomAccess/room-a/outsider'),
    true,
  ));
});

test('unauthenticated client cannot access presence', async () => {
  const db = env.unauthenticatedContext().database();
  const presence = ref(db, 'shadowCardPresence/room-a/u1');

  await assertFails(get(presence));
  await assertFails(set(presence, {
    state: 'online',
    lastChanged: 9,
  }));
});

test('anonymous non-member cannot access presence', async () => {
  const db = anonymousDatabase('outsider');

  await assertFails(get(ref(db, 'shadowCardPresence/room-a/u1')));
  await assertFails(set(
    ref(db, 'shadowCardPresence/room-a/outsider'),
    {
      state: 'online',
      lastChanged: 10,
    },
  ));
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../functions/index.js', import.meta.url), 'utf8');
function setup(overrides = {}) {
  let room = {
    schemaVersion: 2, status: 'lobby', currentHost: '親', currentHostUid: 'host',
    players: ['親', '参加者'], spectators: ['見学者'],
    participantUids: { host: '親', player: '参加者', spectator: '見学者' },
    settings: { handCount: 2 }, words: [1, 2, 3, 4].map(id => ({ id: String(id), text: String(id) })),
    ...overrides,
  };
  const db = {
    collection: () => ({ doc: () => ({}) }),
    runTransaction: async callback => callback({
      get: async () => ({ exists: true, data: () => structuredClone(room) }),
      update: (_ref, data) => { room = { ...room, ...data }; },
    }),
  };
  class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const context = {
    exports: {}, console,
    require(name) {
      if (name === 'firebase-admin/app') return { initializeApp() {} };
      if (name === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: {} };
      if (name === 'firebase-functions/v2/https') return { onCall: (_options, fn) => fn, HttpsError };
      if (name === 'firebase-functions/params') return { defineSecret: () => ({}) };
      if (name === 'bcryptjs') return {};
      if (name === './manus-config') return {};
      throw new Error(name);
    },
  };
  vm.runInNewContext(source, context);
  return {
    start: uid => context.exports.dealPoemHands({ auth: uid ? { uid } : null, data: { roomId: 'test' } }),
    room: () => room,
  };
}
for (const uid of ['host', 'player']) {
  for (const hostFields of [{}, { currentHost: null, currentHostUid: null }]) {
    test(`ポエム開始: ${uid}, 親情報 ${JSON.stringify(hostFields)}`, async () => {
      const app = setup(hostFields);
      await app.start(uid);
      const room = app.room();
      assert.equal(room.status, 'playing');
      assert.equal(room.hands.host.length, 2);
      assert.equal(room.hands.player.length, 2);
      assert.equal(new Set(Object.values(room.hands).flat().map(x => x.id)).size, 4);
      assert.equal(room.currentHostUid, 'host');
      const before = JSON.stringify(room);
      await assert.rejects(app.start(uid), { code: 'failed-precondition' });
      assert.equal(JSON.stringify(app.room()), before);
    });
  }
}
for (const [uid, code] of [[null, 'unauthenticated'], ['spectator', 'permission-denied'], ['outsider', 'permission-denied']]) {
  test(`開始拒否: ${uid}`, async () => {
    const app = setup();
    const before = JSON.stringify(app.room());
    await assert.rejects(app.start(uid), { code });
    assert.equal(JSON.stringify(app.room()), before);
  });
}
for (const overrides of [{ words: [] }, { schemaVersion: 1 }, { status: 'playing' }]) {
  test(`条件不足で開始しない: ${JSON.stringify(overrides)}`, async () => {
    const app = setup(overrides);
    const before = JSON.stringify(app.room());
    await assert.rejects(app.start('player'), { code: 'failed-precondition' });
    assert.equal(JSON.stringify(app.room()), before);
  });
}

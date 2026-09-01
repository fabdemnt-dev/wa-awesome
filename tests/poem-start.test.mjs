import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../functions/index.js', import.meta.url), 'utf8');
function setup(overrides = {}) {
  const deleted = Symbol("delete");
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
      update: (_ref, data) => {
        for (const [key, value] of Object.entries(data)) {
          const path = key.split('.'); let target = room;
          for (const part of path.slice(0, -1)) target = target[part] ||= {};
          if (value === deleted) delete target[path.at(-1)];
          else target[path.at(-1)] = value;
        }
      },
    }),
  };
  class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const context = {
    exports: {}, console,
    require(name) {
      if (name === 'firebase-admin/app') return { initializeApp() {} };
      if (name === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: { delete: () => deleted } };
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
    call: (name, uid, data = {}) => context.exports[name]({ auth: uid ? { uid } : null, data: { roomId: 'test', ...data } }),
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
      assert.equal(room.currentHostUid, undefined);
      assert.equal(room.currentHost, undefined);
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

for (const fields of [{}, { currentHost: null, currentHostUid: null }, { currentHost: '見学者', currentHostUid: 'spectator' }]) {
  test(`ポエム設定は親情報に関係なくプレイヤーが変更できる: ${JSON.stringify(fields)}`, async () => {
    const app = setup(fields);
    await app.call('updatePoemSettings', 'player', { handCount: 3 });
    assert.equal(app.room().settings.handCount, 3);
    assert.equal(app.room().currentHost, undefined);
  });
}
test('元の親も作成中に見学へ移れ、親情報を新しく作らない', async () => {
  const app = setup({ status: 'playing' });
  await app.call('changePoemRole', 'host', { role: 'spectator' });
  assert.ok(app.room().spectators.includes('親'));
  assert.ok(!app.room().players.includes('親'));
  assert.equal(app.room().currentHostUid, undefined);
});
test('親情報なしのロビーでプレイヤーへ変更しても親は作らない', async () => {
  const app = setup({ currentHost: null, currentHostUid: null });
  await app.call('changePoemRole', 'spectator', { role: 'player' });
  assert.ok(app.room().players.includes('見学者'));
  assert.equal(app.room().currentHost, undefined);
});
test('プレイヤーが他人の作品を披露できる', async () => {
  const app = setup({ status: 'playing', poems: { host: { text: '作品', revealed: false } } });
  await app.call('revealPoemSecure', 'player', { targetUid: 'host' });
  assert.equal(app.room().poems.host.revealed, true);
  assert.equal(app.room().currentHostUid, undefined);
});
for (const uid of ['spectator', 'outsider', null]) {
  test(`設定・披露はプレイヤー以外を拒否する: ${uid}`, async () => {
    const expected = uid ? 'permission-denied' : 'unauthenticated';
    await assert.rejects(setup().call('updatePoemSettings', uid, { handCount: 3 }), { code: expected });
    await assert.rejects(setup({ status: 'playing', poems: { host: { text: '作品' } } }).call('revealPoemSecure', uid, { targetUid: 'host' }), { code: expected });
  });
}
test('ポエムの親引き継ぎを拒否し、情報を再作成しない', async () => {
  const app = setup({ status: 'playing' });
  await assert.rejects(app.call('claimHost', 'player', { game: 'poem' }), { code: 'failed-precondition' });
});
test('開始後の手札設定変更は引き続き拒否する', async () => {
  await assert.rejects(setup({ status: 'playing' }).call('updatePoemSettings', 'player', { handCount: 3 }), { code: 'failed-precondition' });
});
test('俳句の設定は引き続き親だけに許可する', async () => {
  const app = setup();
  await assert.rejects(app.call('updateHaikuSettings', 'player', { hand5: 3, hand7: 2 }), { code: 'permission-denied' });
  await app.call('updateHaikuSettings', 'host', { hand5: 3, hand7: 2 });
  assert.equal(app.room().currentHostUid, 'host');
});

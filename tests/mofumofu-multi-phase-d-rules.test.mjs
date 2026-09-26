import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

// Phase D: 3〜6人版RTDB Rulesの実評価テスト（Firebase Database Emulator）。
// 起動: npm run test:mofumofu-multi:phase-d:rules
// （firebase emulators:exec --only database。Emulatorが無い環境ではskipする）
let rulesUnit = null;
try {
  rulesUnit = await import('@firebase/rules-unit-testing');
  await import('firebase/database');
} catch {
  rulesUnit = null;
}

if (!rulesUnit) {
  test('mofumofu-multi Phase D RTDB Rules', { skip: '@firebase/rules-unit-testing / Emulator が無い（npm run test:mofumofu-multi:phase-d:rules）' }, () => {});
} else {
  const { initializeTestEnvironment, assertFails, assertSucceeds } = rulesUnit;
  const { ref, get, set, update } = await import('firebase/database');
  const projectId = 'demo-mofumofu-multi';
  const host = (process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000').split(':')[0];
  const port = Number((process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000').split(':')[1] || 9000);

  const roomId = randomUUID();
  const otherRoomId = randomUUID();
  const aId = 'rules-a';
  const bId = 'rules-b';
  const expiredId = 'rules-expired';
  const noAccessId = 'rules-no-access';
  const aConnection = randomUUID();
  const bConnection = randomUUID();
  const expiredConnection = randomUUID();
  let env;

  const accessPathOf = (targetRoom, uid) => `mofumofuMultiPresenceAccess/${targetRoom}/${uid}`;
  const presencePathOf = (targetRoom, uid, connectionId) => `mofumofuMultiPresence/${targetRoom}/${uid}/connections/${connectionId}`;
  const record = (uid, seatId, connectionId, overrides = {}) => {
    const now = Date.now();
    return { uid, roomId, seatId, connectionId, state: 'online', lastHeartbeatAt: now, connectedAt: now, ...overrides };
  };

  test.before(async () => {
    env = await initializeTestEnvironment({
      projectId,
      database: { host, port, rules: fs.readFileSync(new URL('../database.rules.json', import.meta.url), 'utf8') },
    });
    await env.withSecurityRulesDisabled(async (context) => {
      const database = context.database();
      const now = Date.now();
      await set(ref(database, accessPathOf(roomId, aId)), { uid: aId, roomId, seatId: 'S1', expiresAt: now + 60_000 });
      await set(ref(database, accessPathOf(roomId, bId)), { uid: bId, roomId, seatId: 'S4', expiresAt: now + 60_000 });
      await set(ref(database, accessPathOf(roomId, expiredId)), { uid: expiredId, roomId, seatId: 'S3', expiresAt: now - 1000 });
    });
  });
  test.after(async () => { await env?.cleanup(); });

  test('presence Rules: 本人のconnection書込みとheartbeat更新だけを許可する', async () => {
    const a = env.authenticatedContext(aId).database();
    const b = env.authenticatedContext(bId).database();
    await assertSucceeds(set(ref(a, presencePathOf(roomId, aId, aConnection)), record(aId, 'S1', aConnection)));
    await assertSucceeds(set(ref(b, presencePathOf(roomId, bId, bConnection)), record(bId, 'S4', bConnection)));
    await assertSucceeds(update(ref(a, presencePathOf(roomId, aId, aConnection)), { lastHeartbeatAt: Date.now() }));
    // 本人であれば複数connectionを同時に持てる。
    const secondConnection = randomUUID();
    await assertSucceeds(set(ref(a, presencePathOf(roomId, aId, secondConnection)), record(aId, 'S1', secondConnection)));
    // 切断の記録はaccess期限後でも本人なら書ける（既存版と同じ意味）。
    await assertSucceeds(update(ref(a, presencePathOf(roomId, aId, aConnection)), { state: 'disconnected', lastHeartbeatAt: Date.now() }));
    await assertSucceeds(get(ref(a, `mofumofuMultiPresence/${roomId}`)));
  });

  test('presence Rules: 別uid・別room・別seat・S7・不正connectionId・余計なfieldを拒否する', async () => {
    const a = env.authenticatedContext(aId).database();
    const unauthenticated = env.unauthenticatedContext().database();
    // 別uid
    await assertFails(set(ref(a, presencePathOf(roomId, bId, randomUUID())), record(bId, 'S4', randomUUID())));
    // 未認証
    await assertFails(set(ref(unauthenticated, presencePathOf(roomId, noAccessId, randomUUID())), record(noAccessId, 'S1', randomUUID())));
    // 別room（accessが無いroom）
    const otherConnection = randomUUID();
    await assertFails(set(ref(a, presencePathOf(otherRoomId, aId, otherConnection)), { ...record(aId, 'S1', otherConnection), roomId: otherRoomId }));
    // 別seat（accessはS1なのにS2を名乗る）
    const wrongSeatConnection = randomUUID();
    await assertFails(set(ref(a, presencePathOf(roomId, aId, wrongSeatConnection)), record(aId, 'S2', wrongSeatConnection)));
    // S7（形式外のseat）
    const s7Connection = randomUUID();
    await assertFails(set(ref(a, presencePathOf(roomId, aId, s7Connection)), record(aId, 'S7', s7Connection)));
    // 不正connectionId（path形式）
    await assertFails(set(ref(a, presencePathOf(roomId, aId, 'not-a-uuid')), record(aId, 'S1', 'not-a-uuid')));
    // connectionId fieldとpathの不一致
    const mismatchConnection = randomUUID();
    await assertFails(set(ref(a, presencePathOf(roomId, aId, mismatchConnection)), record(aId, 'S1', randomUUID())));
    // 余計なfield（秘密の混入）
    for (const forbidden of ['cards', 'cardId', 'animalType', 'hand', 'pendingOffer', 'leftovers', 'inviteCode', 'serverState']) {
      const connectionId = randomUUID();
      await assertFails(set(ref(a, presencePathOf(roomId, aId, connectionId)), { ...record(aId, 'S1', connectionId), [forbidden]: 'secret' }));
    }
    // 型不正（lastHeartbeatAtが文字列 / stateが許可外）
    const typeConnection = randomUUID();
    await assertFails(set(ref(a, presencePathOf(roomId, aId, typeConnection)), { ...record(aId, 'S1', typeConnection), lastHeartbeatAt: 'soon' }));
    const stateConnection = randomUUID();
    await assertFails(set(ref(a, presencePathOf(roomId, aId, stateConnection)), { ...record(aId, 'S1', stateConnection), state: 'idle' }));
    // 未認証のread
    await assertFails(get(ref(unauthenticated, `mofumofuMultiPresence/${roomId}`)));
  });

  test('presence Rules: accessなし・access期限切れは拒否し、accessはclientから読み書きできない', async () => {
    const noAccess = env.authenticatedContext(noAccessId).database();
    const expired = env.authenticatedContext(expiredId).database();
    const a = env.authenticatedContext(aId).database();
    const connection = randomUUID();
    await assertFails(set(ref(noAccess, presencePathOf(roomId, noAccessId, connection)), record(noAccessId, 'S1', connection)));
    const expiredConnectionId = randomUUID();
    await assertFails(set(ref(expired, presencePathOf(roomId, expiredId, expiredConnectionId)), record(expiredId, 'S3', expiredConnectionId)));
    await assertFails(get(ref(expired, `mofumofuMultiPresence/${roomId}`)));
    // accessそのものはclientから読み書きできない（server専用）。
    await assertFails(get(ref(a, accessPathOf(roomId, aId))));
    await assertFails(set(ref(a, accessPathOf(roomId, aId)), { uid: aId, roomId, seatId: 'S6', expiresAt: Date.now() + 600000 }));
    // 既存2人版ルートは独立したまま（3〜6人版のaccessでは2人版presenceへ書けない）。
    await assertFails(set(ref(a, `mofumofuOnlinePresence/${roomId}/${aId}/connections/${randomUUID()}`), record(aId, 'A', randomUUID())));
  });
}

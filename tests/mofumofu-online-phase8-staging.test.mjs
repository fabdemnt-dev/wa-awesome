import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { presenceAllowsNpcProxy } from '../toybox/mofumofu-gathering/online/connection-control.js';

const require = createRequire(import.meta.url);
const backend = require('../functions/mofumofu-online');
const functionRequire = createRequire(new URL('../functions/mofumofu-online/package.json', import.meta.url));
const { Timestamp } = functionRequire('firebase-admin/firestore');
const configUrl = pathToFileURL(new URL('../toybox/mofumofu-gathering/online/firebase-config.js', import.meta.url).pathname);
const html = await readFile(new URL('../toybox/mofumofu-gathering/online/index.html', import.meta.url), 'utf8');
const firebaseJson = JSON.parse(await readFile(new URL('../firebase.json', import.meta.url), 'utf8'));

test('client proxy stale判定はserverの全connection・最新heartbeat判定と一致する', () => {
  const now = 1_000_000;
  const staleMs = backend._test.PRESENCE_STALE_MS;
  assert.equal(staleMs, 120_000);
  const values = [
    null,
    {},
    { connections: { live: { state: 'online', lastHeartbeatAt: now - 15_000 } } },
    { connections: { gone: { state: 'disconnected', lastHeartbeatAt: now - 15_000 } } },
    { connections: { gone: { state: 'disconnected', lastHeartbeatAt: now - 119_999 } } },
    { connections: { gone: { state: 'disconnected', lastHeartbeatAt: now - 120_000 } } },
    { connections: { gone: { state: 'disconnected', lastHeartbeatAt: now - 120_001 } } },
    { connections: { old: { state: 'disconnected', lastHeartbeatAt: now - 500_000 }, live: { state: 'online', lastHeartbeatAt: now - 1_000 } } },
    { connections: { old: { state: 'disconnected', lastHeartbeatAt: now - 500_000 }, recent: { state: 'disconnected', lastHeartbeatAt: now - 30_000 } } },
    { connections: { only: { state: 'disconnected', connectedAt: now - 500_000 } } },
    { connections: { bad: { state: 'disconnected', lastHeartbeatAt: 'invalid' } } },
    { connections: { malformed: { state: 'online', lastHeartbeatAt: Infinity } } },
  ];
  for (const value of values) {
    const server = backend._test.uidPresenceState(value, now);
    const serverAllows = !server.online && !!server.lastHeartbeatAt && now - server.lastHeartbeatAt >= staleMs;
    assert.equal(presenceAllowsNpcProxy(value, now, staleMs), serverAllows);
  }
});

test('未初期化プロセスでAdmin Appを一度だけ初期化してFunctionsをexportする', () => {
  const functionsDirectory = fileURLToPath(new URL('../functions/mofumofu-online/', import.meta.url));
  const modulePath = fileURLToPath(new URL('../functions/mofumofu-online/index.js', import.meta.url));
  const expectedExports = [
    'createMofumofuRoom',
    'joinMofumofuRoom',
    'startMofumofuGame',
    'resumeMofumofuRoom',
    'authorizeMofumofuPresence',
    'makeMofumofuOffer',
    'judgeMofumofuOffer',
    'runMofumofuNpcTurn',
    'startMofumofuNpcProxy',
    'runMofumofuNpcProxyAction',
    'cleanupMofumofuOnline',
  ];
  const script = `
    const { getApps } = require('firebase-admin/app');
    if (getApps().length !== 0) throw new Error('Admin App was initialized before module load');
    const first = require(${JSON.stringify(modulePath)});
    if (getApps().length !== 1) throw new Error('default Admin App was not initialized exactly once');
    const app = getApps()[0];
    const second = require(${JSON.stringify(modulePath)});
    if (getApps().length !== 1 || getApps()[0] !== app) throw new Error('Admin App was initialized twice');
    for (const name of ${JSON.stringify(expectedExports)}) {
      if (typeof first[name] !== 'function' || second[name] !== first[name]) throw new Error('missing export: ' + name);
    }
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: functionsDirectory,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('resolveFaceUp後もroomとserverStateのdeleteAtは同じFirestore Timestamp', () => {
  const roomDeleteAt = Timestamp.fromMillis(2_000_000_000_000);
  const serverDeleteAt = Timestamp.fromMillis(2_000_000_000_123);
  const card = { cardId: 'cat-pending', animalType: 'cat' };
  const pending = { actionId: 'timestamp-action', fromPlayerId: 'A', toPlayerId: 'B', claimAnimal: 'cat', card };
  const room = {
    status: 'playing', playerStatus: { A: 'active', B: 'active', koharu: 'active' },
    faceUpCards: { A: [], B: [], koharu: [] }, eliminationSnapshots: {}, turnNumber: 1,
    deleteAt: roomDeleteAt,
  };
  const server = { npcHand: [{ cardId: 'fox-npc', animalType: 'fox' }], discard: [], pendingOffer: pending, deleteAt: serverDeleteAt };
  const hands = { A: [{ cardId: 'bear-a', animalType: 'bear' }], B: [{ cardId: 'rabbit-b', animalType: 'rabbit' }] };
  const resolved = backend._test.resolveFaceUp(room, server, hands, pending, 'truth', 1_900_000_000_000);

  assert.ok(resolved.room.deleteAt instanceof Timestamp);
  assert.ok(resolved.server.deleteAt instanceof Timestamp);
  assert.ok(resolved.room.deleteAt.isEqual(roomDeleteAt));
  assert.ok(resolved.server.deleteAt.isEqual(serverDeleteAt));
  assert.equal(resolved.finish, null);
});

test('NPC終了roomのdeleteAtは正規Firestore Timestampのまま期限値も維持する', () => {
  const deleteAt = Timestamp.fromMillis(2_000_000_000_000);
  const now = 1_900_000_000_000;
  const room = {
    status: 'playing', playerStatus: { A: 'active', B: 'active', koharu: 'active' },
    faceUpCards: { A: [], B: [], koharu: [] }, eliminationSnapshots: {}, turnNumber: 4,
    deleteAt,
  };
  const advance = { currentTurnPlayerId: null, turnState: 'finished', turnNumber: 5 };
  const finish = { finishReason: 'hand-empty', winnerPlayerId: 'A', draw: false };
  const finished = backend._test.finishedNpcRoom(room, advance, finish, now);

  assert.ok(finished.deleteAt instanceof Timestamp);
  assert.ok(finished.deleteAt.isEqual(deleteAt));
  assert.equal(finished.status, 'finished');
  assert.equal(finished.finalResult.finishReason, 'hand-empty');
});

const productionOrigin = 'https://fabdemnt-dev.github.io';
const stagingOrigin = 'https://wa-awesome-mofumofu-stg.web.app';
const stagingConfig = {
  environment: 'staging',
  hostname: 'wa-awesome-mofumofu-stg.web.app',
  firebase: {
    apiKey: 'AIzaSyB1oIhZWMryuWZV9r2-nO9X4W6LuqXVvlo',
    authDomain: 'wa-awesome-mofumofu-stg.firebaseapp.com',
    projectId: 'wa-awesome-mofumofu-stg',
    storageBucket: 'wa-awesome-mofumofu-stg.firebasestorage.app',
    messagingSenderId: '481875415725',
    appId: '1:481875415725:web:e16ec434ac7cddd117ec24',
    databaseURL: 'https://wa-awesome-mofumofu-stg-default-rtdb.asia-southeast1.firebasedatabase.app',
  },
  appCheckSiteKey: '6LfWOsgtAAAAAIuboWvU-f8EEAh2olIFiGDk_f1X',
};

async function resolve(hostname, injected = {}) {
  globalThis.location = { hostname };
  globalThis.MOFUMOFU_ONLINE_CONFIG = injected;
  const module = await import(`${configUrl.href}?case=${encodeURIComponent(hostname)}-${Math.random()}`);
  return module.resolveEnvironment();
}

test('CORSはprojectごとの単一origin allowlistでfail-closed', () => {
  const { corsOriginsForProject } = backend._test;
  assert.deepEqual(corsOriginsForProject('wa-awesome'), [productionOrigin]);
  assert.ok(!corsOriginsForProject('wa-awesome').includes(stagingOrigin));
  assert.deepEqual(corsOriginsForProject('wa-awesome-mofumofu-stg'), [stagingOrigin]);
  assert.ok(!corsOriginsForProject('wa-awesome-mofumofu-stg').includes(productionOrigin));
  assert.deepEqual(corsOriginsForProject('unknown-project'), []);
  assert.ok(!corsOriginsForProject('wa-awesome').includes('*'));
  assert.ok(!corsOriginsForProject('wa-awesome-mofumofu-stg').includes('*'));
});

test('production hostnameはproduction configだけを選ぶ', async () => {
  const environment = await resolve('fabdemnt-dev.github.io', {
    environment: 'production',
    hostname: 'fabdemnt-dev.github.io',
    databaseURL: 'https://wa-awesome-default-rtdb.asia-southeast1.firebasedatabase.app',
    appCheckSiteKey: '6LeU8sstAAAAAOEyP56nWLD633TiAWaLmvcskE6e',
  });
  assert.equal(environment.name, 'production');
  assert.equal(environment.firebase.projectId, 'wa-awesome');
  assert.notEqual(environment.firebase.projectId, stagingConfig.firebase.projectId);
});

test('staging hostnameは検証済みstaging configだけを選ぶ', async () => {
  const environment = await resolve('wa-awesome-mofumofu-stg.web.app', stagingConfig);
  assert.equal(environment.name, 'staging');
  assert.equal(environment.firebase.appId, '1:481875415725:web:e16ec434ac7cddd117ec24');
  assert.equal(environment.firebase.projectId, 'wa-awesome-mofumofu-stg');
  assert.equal(environment.firebase.authDomain, 'wa-awesome-mofumofu-stg.firebaseapp.com');
  assert.equal(environment.firebase.databaseURL, 'https://wa-awesome-mofumofu-stg-default-rtdb.asia-southeast1.firebasedatabase.app');
  assert.equal(environment.appCheck.siteKey, '6LfWOsgtAAAAAIuboWvU-f8EEAh2olIFiGDk_f1X');
  assert.notEqual(environment.firebase.projectId, 'wa-awesome');
});

test('未知hostnameはstagingを自動選択しない', async () => {
  await assert.rejects(() => resolve('unknown.example', stagingConfig), /このホストではオンライン版を起動できません/);
});

test('staging runtime configの不足・不一致を拒否する', async () => {
  await assert.rejects(() => resolve('wa-awesome-mofumofu-stg.web.app', {}), /staging runtime configが正しくありません/);
  const wrong = structuredClone(stagingConfig);
  wrong.firebase.projectId = 'wa-awesome';
  await assert.rejects(() => resolve('wa-awesome-mofumofu-stg.web.app', wrong), /staging project IDが正しくありません/);
});

test('HTMLは正確なstaging hostnameでmodule前にconfigを注入する', () => {
  assert.match(html, /location\.hostname === 'wa-awesome-mofumofu-stg\.web\.app'/);
  assert.ok(html.indexOf('MOFUMOFU_ONLINE_CONFIG') < html.indexOf('type="module"'));
});

test('Hostingはstaging siteとオンライン版ディレクトリだけを対象にする', () => {
  assert.equal(firebaseJson.hosting.site, 'wa-awesome-mofumofu-stg');
  assert.equal(firebaseJson.hosting.public, 'toybox/mofumofu-gathering/online');
});

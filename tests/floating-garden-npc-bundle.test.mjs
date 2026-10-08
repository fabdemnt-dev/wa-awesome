/** Exercise the actual deployable package, not repository handler substitutions.
 * Only Firestore, verified request contexts, time and shuffle entropy are fixtures.
 * Auth/App Check token verification and network transports still require emulator/device QA.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareTrialBundle } from '../scripts/prepare-floating-garden-trial.mjs';
import { createMemoryStore } from './helpers/floating-garden-store.mjs';

const require = createRequire(import.meta.url);
const START = Date.parse('2026-10-02T00:00:00Z');
const DAY = 86400000;
const TESTERS = ['bundle-host', 'bundle-guest'];
const KEY = 'generated-bundle-fixture-hmac-key-never-used-by-a-live-service';
const configuration = () => ({
  schemaVersion: 1, enabled: true, projectId: 'garden-trial-bundle',
  previewOrigin: 'https://garden-trial-bundle--garden-7day-a1b2c3.web.app',
  startsAtMillis: START, endsAtMillis: START + 7 * DAY,
  region: 'asia-northeast1', maxTesters: 2, maxRooms: 20,
  firebase: { apiKey: 'AIza' + 'a'.repeat(35), authDomain: 'garden-trial-bundle.firebaseapp.com', projectId: 'garden-trial-bundle', appId: '1:123456789:web:abcdef0123456789' },
  appCheck: { provider: 'recaptcha-enterprise', siteKey: '6L' + 'a'.repeat(38), verified: true },
});
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const rejects = (promise, reason, code) => assert.rejects(promise, (error) => error.details?.reason === reason && (!code || error.code === code));
const random = (seed) => { let value = seed; return (max) => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value % max; }; };
let temporary;
let bundle;
test.before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'garden-npc-generated-bundle-'));
  const output = join(temporary, 'bundle');
  // Default repositoryRoot deliberately uses the real checkout, never a source fixture.
  await prepareTrialBundle({ config: configuration(), output, now: START });
  const functions = join(output, 'functions');
  const configModule = require(join(functions, 'config.js'));
  const config = configModule.validateTrialConfig(await json(join(functions, 'trial-config.json')));
  const trial = require(join(functions, 'trial-handlers.js'));
  const online = require(join(functions, 'online/handlers.js'));
  const contract = require(join(functions, 'online/contract.js'));
  const core = await online.loadCore();
  const cpu = await online.loadCpu();
  bundle = { output, functions, configModule, config, trial, online, contract, core, cpu,
    records: await json(join(output, 'ADMIN-RECORDS-REVIEW.json')) };
});
test.after(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });

function fixture({ initialTime = START + 1000, seed = 13, env, database } = {}) {
  const { config, trial, online, records } = bundle;
  const db = database || createMemoryStore(); let timestamp = initialTime; let serial = 0;
  const callerUids = new Set(); let expireOnGameWrite = false;
  // Enable only these in-memory fixture records; generated review files stay stopped.
  db.set(trial.GATE_PATH, { ...records[trial.GATE_PATH], enabled: true, testerUids: TESTERS.slice() });
  db.set(trial.USAGE_PATH, records[trial.USAGE_PATH]);
  for (const uid of TESTERS) db.set(`floatingGardenTrialTesters/${uid}`, { ...records.testerDocumentTemplate, active: true });
  const simulatedDb = { doc: db.doc, runTransaction: (body) => db.runTransaction((tx) => body({
    ...tx,
    update(ref, value) {
      tx.update(ref, value);
      if (expireOnGameWrite && ref.path.includes('/serverGames/')) timestamp = config.endsAtMillis;
    },
  })) };
  const rateLimits = Object.fromEntries(Object.entries(online.RATE_LIMITS).map(([name, value]) => [name, {
    ...value, limit: 10000, ...(value.ipLimit ? { ipLimit: 10000 } : {}),
  }]));
  const handlers = trial.createTrialHandlers({
    db: simulatedDb, config, env: env || { GCLOUD_PROJECT: config.projectId }, now: () => timestamp,
    trustedHandlersFactory: online.createHandlers, inviteSecret: () => KEY, randomInt: random(seed), rateLimits,
    // No coreLoader/cpuLoader replacement: both must resolve inside the generated package.
  });
  const id = () => `bundle-request-${++serial}`;
  const request = (uid, data) => {
    callerUids.add(uid);
    return { auth: { uid }, app: { appId: configuration().firebase.appId }, rawRequest: { headers: { origin: config.previewOrigin }, ip: '127.0.0.1' }, data };
  };
  const roomPath = (room) => `floatingGardenRooms/${room.roomId}`;
  const gamePath = (room) => `${roomPath(room)}/serverGames/${db.peek(roomPath(room)).gameId}`;
  const createData = (npcCount, requestId = id()) => ({ displayName: '星の庭', requestId, ...(npcCount === undefined ? {} : { npcCount }) });
  const create = (npcCount, requestId) => handlers.floatingGardenCreateRoom(request(TESTERS[0], createData(npcCount, requestId)));
  const joinRoom = (room, requestId = id()) => handlers.floatingGardenJoinRoom(request(TESTERS[1], { displayName: '月の庭', inviteCode: room.inviteCode, requestId }));
  const snapshot = (room, seat = 0) => handlers.floatingGardenGetSnapshot(request(TESTERS[seat], { roomId: room.roomId }));
  async function ready(npcCount) {
    const room = await create(npcCount); await joinRoom(room);
    const result = await handlers.floatingGardenStartMatch(request(TESTERS[0], { roomId: room.roomId, expectedRevision: 2, requestId: id() }));
    return { ...room, snapshot: result };
  }
  function actionRequest(room, action, requestId = id()) {
    const current = db.peek(roomPath(room)); const { seat, revision, ...command } = action;
    assert.ok(seat === 0 || seat === 1, 'only the two real human seats may submit');
    return request(TESTERS[seat], { roomId: room.roomId, gameId: current.gameId, rulesVersion: current.rulesVersion,
      expectedRevision: current.match.revision, requestId, command });
  }
  const act = (room, action, requestId) => handlers.floatingGardenSubmitAction(actionRequest(room, action, requestId));
  return { db, handlers, id, request, callerUids, createData, create, joinRoom, snapshot, ready, roomPath, gamePath, actionRequest, act,
    setTime: (value) => { timestamp = value; }, expireOnGameWrite: () => { expireOnGameWrite = true; } };
}
function assertPublic(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!['deck', 'deckCursor', 'seed', 'uid', 'private', 'secret', 'commands', 'initialState'].includes(key), `private field ${key}`);
    assertPublic(child);
  }
}
function assertReplay(game) {
  let replay = game.initialState;
  for (const command of game.commands) replay = bundle.core.applyMatchAction(replay, command);
  assert.deepEqual(game.state, replay);
  assert.equal(game.commands.length, replay.revision);
}

test('generated runtime imports, CPU and configuration all come from the real standalone bundle', async () => {
  assert.equal(require.resolve(join(bundle.functions, 'online/handlers.js')), join(bundle.functions, 'online/handlers.js'));
  assert.equal(require.resolve(join(bundle.functions, 'trial-handlers.js')), join(bundle.functions, 'trial-handlers.js'));
  assert.equal(bundle.core.MATCH_VERSION, bundle.contract.RULES_VERSION);
  assert.equal(typeof bundle.cpu.chooseCpuAction, 'function');
  assert.equal(bundle.config.maxRooms, 20);
  assert.equal(configuration().maxTesters, 2);
  assert.equal(bundle.config.endsAtMillis - bundle.config.startsAtMillis, 7 * DAY);
  assert.equal(bundle.records[bundle.trial.GATE_PATH].enabled, false);
  assert.deepEqual(bundle.records[bundle.trial.GATE_PATH].testerUids, []);
  assert.equal(bundle.records.testerDocumentTemplate.active, false);
  const manifest = await json(join(bundle.output, 'SOURCE-SHA256.json'));
  for (const name of ['handlers.js', 'contract.js', 'invite-code.js', 'core/engine.js', 'core/match-engine.js', 'core/cpu.js']) {
    const actual = await readFile(join(bundle.functions, 'online', name));
    assert.equal(createHash('sha256').update(actual).digest('hex'), manifest[`functions/floating-garden-online/${name}`]);
  }
  const noInstall = await readFile(join(bundle.functions, 'package.json'), 'utf8');
  assert.equal(JSON.parse(noInstall).scripts, undefined);
});

for (const npcCount of [1, 2]) test(`generated trial wrapper completes a ${2 + npcCount}-seat game with only two authenticated humans`, async () => {
  const f = fixture({ seed: npcCount * 19 }); const room = await f.ready(npcCount);
  let snapshot = room.snapshot; let humanOperations = 0; let npcOperations = 0; const choose = random(npcCount * 83);
  const receiptSamples = [];
  while (snapshot.room.status !== 'finished') {
    const decision = bundle.core.getDecision(snapshot.room.match);
    assert.ok(decision.seat < 2);
    const legal = bundle.core.legalActions(snapshot.room.match);
    const action = legal[choose(legal.length)];
    const request = f.actionRequest(room, action); const beforeRevision = snapshot.room.match.revision;
    if (humanOperations % 31 === 0) {
      f.db.forceConflicts(2);
      const results = await Promise.all(Array.from({ length: 3 }, () => f.handlers.floatingGardenSubmitAction(request)));
      results.forEach((result) => assert.deepEqual(result, results[0])); snapshot = results[0];
      receiptSamples.push({ request, result: snapshot });
    } else snapshot = await f.handlers.floatingGardenSubmitAction(request);
    humanOperations += 1;
    npcOperations += snapshot.room.match.revision - beforeRevision - 1;
    assertPublic(snapshot);
    assert.equal(snapshot.room.playerCount, 2 + npcCount);
    assert.equal(snapshot.room.npcCount, npcCount);
    assert.equal(snapshot.room.rulesVersion, bundle.contract.NPC_RULES_VERSION);
    assert.equal(snapshot.room.match.version, bundle.core.MATCH_VERSION);
    assert.deepEqual((await f.snapshot(room, 0)).room, snapshot.room);
    assert.deepEqual((await f.snapshot(room, 1)).room, snapshot.room);
    assert.ok(humanOperations < 500);
  }
  assert.deepEqual([...f.callerUids].sort(), TESTERS.slice().sort());
  assert.equal(f.db.paths().filter((path) => path.includes('/members/')).length, 2);
  assert.equal(f.db.paths().filter((path) => path.startsWith('floatingGardenTrialTesters/')).length, 2);
  const game = f.db.peek(f.gamePath(room)); assertReplay(game);
  assert.equal(game.rulesVersion, bundle.contract.NPC_RULES_VERSION);
  assert.equal(game.state.version, bundle.contract.RULES_VERSION);
  assert.ok(npcOperations > 0);
  assert.equal(game.commands.filter((command) => command.seat >= 2).length, npcOperations);
  assert.equal(game.commands.filter((command) => command.seat < 2).length, humanOperations);
  assert.equal(game.state.players.length, 2 + npcCount);
  assert.equal(game.state.players.every((player) => player.garden.filter(Boolean).length === 16), true);
  assert.equal(new Set(game.state.players.map((player) => player.careCount)).size, 1);
  assert.deepEqual(snapshot.room.scores, bundle.core.rankMatch(game.state));
  assert.equal(f.db.peek(bundle.trial.USAGE_PATH).createdRoomCount, 1);
  assert.equal(f.db.paths().filter((path) => path.startsWith('floatingGardenActionRequests/')).length, humanOperations + 3);
  const beforeReplay = f.db.peek(f.gamePath(room));
  for (const { request, result } of receiptSamples) assert.deepEqual(await f.handlers.floatingGardenSubmitAction(request), result);
  assert.deepEqual(f.db.peek(f.gamePath(room)), beforeReplay);
  assert.equal(f.db.peek(bundle.trial.USAGE_PATH).createdRoomCount, 1);
});

test('generated two-human legacy creation still omits NPC fields and uses one transition per operation', async () => {
  const f = fixture(); const room = await f.ready();
  assert.equal(Object.hasOwn(room.snapshot.room, 'npcCount'), false);
  assert.equal(room.snapshot.room.playerCount, 2);
  const result = await f.act(room, bundle.core.legalActions(room.snapshot.room.match)[0]);
  assert.equal(result.room.match.revision, 1);
  assert.equal(f.db.peek(f.gamePath(room)).commands.length, 1);
  assert.equal(f.db.peek(bundle.trial.USAGE_PATH).createdRoomCount, 1);
});

test('generated trial admits exactly twenty mixed-mode rooms without charging retries or NPC seats', async () => {
  const f = fixture(); const accepted = [];
  for (let index = 0; index < 20; index += 1) {
    const requestId = `bundle-twenty-${index}`; const npcCount = index % 3;
    accepted.push({ result: await f.create(npcCount, requestId), requestId, npcCount });
  }
  assert.equal(f.db.peek(bundle.trial.USAGE_PATH).createdRoomCount, 20);
  assert.equal(new Set(accepted.map((item) => item.result.roomId)).size, 20);
  await rejects(f.create(2), 'trial-room-limit', 'resource-exhausted');
  for (const { result, requestId, npcCount } of accepted) assert.deepEqual(await f.create(npcCount, requestId), result);
  assert.equal(f.db.peek(bundle.trial.USAGE_PATH).createdRoomCount, 20);
  assert.equal(f.db.paths().filter((path) => /^floatingGardenRooms\/[^/]+$/.test(path)).length, 20);
});

for (const name of ['floatingGardenCreateRoom', 'floatingGardenJoinRoom', 'floatingGardenStartMatch', 'floatingGardenGetSnapshot', 'floatingGardenSubmitAction']) {
  test(`generated ${name} rejects a third tester even if its tester document exists`, async () => {
    const f = fixture(); const room = await f.ready(2);
    f.db.set('floatingGardenTrialTesters/third-user', { active: true, expiresAtMillis: bundle.config.endsAtMillis });
    const before = f.db.entries();
    await rejects(f.handlers[name](f.request('third-user', { roomId: room.roomId, npcCount: 2 })), 'trial-tester-not-enrolled', 'permission-denied');
    assert.deepEqual(f.db.entries(), before);
    f.db.set(bundle.trial.GATE_PATH, { ...f.db.peek(bundle.trial.GATE_PATH), testerUids: [...TESTERS, 'third-user'] });
    const malformed = f.db.entries();
    await rejects(f.handlers[name](f.request(TESTERS[0], {})), 'trial-tester-not-enrolled');
    assert.deepEqual(f.db.entries(), malformed);
  });
}

test('generated wrapper denies wrong runtime, origin and unverified request contexts before state writes', async () => {
  const wrongProject = fixture({ env: { GCLOUD_PROJECT: 'wa-awesome' } }); const untouched = wrongProject.db.entries();
  await rejects(wrongProject.create(2), 'trial-project-mismatch');
  assert.deepEqual(wrongProject.db.entries(), untouched);
  const f = fixture();
  for (const [reason, modify] of [
    ['trial-auth-required', (request) => { delete request.auth; }],
    ['trial-app-check-required', (request) => { delete request.app; }],
    ['trial-origin-mismatch', (request) => { request.rawRequest.headers.origin = 'https://other.example'; }],
  ]) {
    const request = f.request(TESTERS[0], f.createData(2)); modify(request); const before = f.db.entries();
    await rejects(f.handlers.floatingGardenCreateRoom(request), reason);
    assert.deepEqual(f.db.entries(), before);
  }
});

test('generated wrapper clamps NPC room, membership, game and receipt expiry to trial end', async () => {
  const f = fixture({ initialTime: bundle.config.endsAtMillis - 60000 }); const room = await f.ready(2);
  for (const [path, data] of f.db.entries()) {
    if (/^(floatingGardenRooms|floatingGardenActionRequests|floatingGardenInvites)\//.test(path)) assert.equal(data.expiresAtMillis, bundle.config.endsAtMillis, path);
  }
  const draw = await f.act(room, bundle.core.legalActions(room.snapshot.room.match)[0]);
  const request = f.actionRequest(room, bundle.core.legalActions(draw.room.match).find((action) => action.type === 'offer' && action.target === 2));
  await f.handlers.floatingGardenSubmitAction(request);
  const before = f.db.entries();
  f.setTime(bundle.config.endsAtMillis);
  await rejects(f.snapshot(room), 'trial-outside-window');
  await rejects(f.handlers.floatingGardenSubmitAction(request), 'trial-outside-window');
  await rejects(f.joinRoom(room), 'trial-outside-window');
  assert.deepEqual(f.db.entries(), before);
});

test('generated wrapper rolls back a completed NPC chain if trial time expires before transaction commit', async () => {
  const f = fixture(); const room = await f.ready(2);
  const draw = await f.act(room, bundle.core.legalActions(room.snapshot.room.match)[0]);
  const action = bundle.core.legalActions(draw.room.match).find((candidate) => candidate.type === 'offer' && candidate.target === 2);
  const request = f.actionRequest(room, action);
  const beforeRoom = f.db.peek(f.roomPath(room)); const beforeGame = f.db.peek(f.gamePath(room));
  f.expireOnGameWrite();
  await rejects(f.handlers.floatingGardenSubmitAction(request), 'trial-outside-window');
  assert.deepEqual(f.db.peek(f.roomPath(room)), beforeRoom); assert.deepEqual(f.db.peek(f.gamePath(room)), beforeGame);
  assert.equal(f.db.peek(`floatingGardenActionRequests/${bundle.contract.uidKey(TESTERS[0])}_${request.data.requestId}`), undefined);
  assert.equal(f.db.peek(bundle.trial.USAGE_PATH).createdRoomCount, 1);
});

test('generated wrapper rechecks tester and gate authorization before replaying accepted NPC receipts', async () => {
  const f = fixture(); const room = await f.ready(1);
  const draw = await f.act(room, bundle.core.legalActions(room.snapshot.room.match)[0]);
  const request = f.actionRequest(room, bundle.core.legalActions(draw.room.match).find((action) => action.type === 'offer' && action.target === 2));
  const accepted = await f.handlers.floatingGardenSubmitAction(request); const game = f.db.peek(f.gamePath(room));
  const testerPath = `floatingGardenTrialTesters/${TESTERS[0]}`; const tester = f.db.peek(testerPath);
  f.db.set(testerPath, { ...tester, active: false });
  await rejects(f.handlers.floatingGardenSubmitAction(request), 'trial-tester-not-enrolled');
  f.db.set(testerPath, tester);
  f.db.set(bundle.trial.GATE_PATH, { ...f.db.peek(bundle.trial.GATE_PATH), enabled: false });
  await rejects(f.handlers.floatingGardenSubmitAction(request), 'trial-disabled');
  f.db.set(bundle.trial.GATE_PATH, { ...f.db.peek(bundle.trial.GATE_PATH), enabled: true });
  assert.deepEqual(await f.handlers.floatingGardenSubmitAction(request), accepted);
  assert.deepEqual(f.db.peek(f.gamePath(room)), game);
});

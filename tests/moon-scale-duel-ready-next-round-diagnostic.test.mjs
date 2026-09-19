import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInAnonymously } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { getFirestore, connectFirestoreEmulator, terminate } from 'firebase/firestore';
import { getDatabase, connectDatabaseEmulator, goOffline } from 'firebase/database';

const diagnosticRunId = process.env.MOON_SCALE_DUEL_DIAGNOSTIC_RUN_ID || 'local';
const caseId = process.env.MOON_SCALE_DUEL_DIAGNOSTIC_CASE || '1';
const clients = [];
const config = { projectId: 'demo-moon-scale-duel', apiKey: 'demo', appId: 'demo', databaseURL: 'http://127.0.0.1:9000?ns=demo-moon-scale-duel' };

function emit(event, details = {}) {
  console.log(JSON.stringify({ diagnostic: 'ready-next-round-client', diagnosticRunId, caseId, event, timestamp: new Date().toISOString(), ...details }));
}

function client(name) {
  const app = initializeApp(config, `${diagnosticRunId}-${caseId}-${name}`);
  const auth = getAuth(app);
  const fs = getFirestore(app);
  const fn = getFunctions(app, 'asia-northeast1');
  const rt = getDatabase(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(fs, '127.0.0.1', 8080);
  connectFunctionsEmulator(fn, '127.0.0.1', 5001);
  connectDatabaseEmulator(rt, '127.0.0.1', 9000);
  const value = { app, auth, fs, rt, call: (name, data) => httpsCallable(fn, name)(data).then((response) => response.data) };
  clients.push(value);
  return value;
}

async function startedRoom(prefix) {
  const host = client(`${prefix}-host`);
  const guest = client(`${prefix}-guest`);
  await Promise.all([signInAnonymously(host.auth), signInAnonymously(guest.auth)]);
  const created = await host.call('moonScaleDuelCreateRoom', { displayName: '月詠', requestId: `${prefix}-create` });
  await guest.call('moonScaleDuelJoinRoom', { displayName: '星読', inviteCode: created.inviteCode, requestId: `${prefix}-join` });
  const waiting = await host.call('moonScaleDuelGetSnapshot', { roomId: created.roomId });
  const started = await host.call('moonScaleDuelStartGame', { roomId: created.roomId, stateVersion: waiting.room.stateVersion, requestId: `${prefix}-start` });
  return { host, guest, roomId: created.roomId, gameId: started.gameId };
}

async function playRound(room, prefix) {
  const before = await room.host.call('moonScaleDuelGetSnapshot', { roomId: room.roomId });
  const payload = (requestId) => ({ roomId: room.roomId, gameId: room.gameId, round: before.game.round, stateVersion: before.game.stateVersion, cardId: 'waxing', requestId });
  await Promise.all([
    room.host.call('moonScaleDuelSubmitCard', payload(`${prefix}-card-h`)),
    room.guest.call('moonScaleDuelSubmitCard', payload(`${prefix}-card-g`)),
  ]);
  return room.host.call('moonScaleDuelGetSnapshot', { roomId: room.roomId });
}

function readyPayload(room, snapshot, requestId) {
  return { roomId: room.roomId, gameId: room.gameId, round: snapshot.game.round, stateVersion: snapshot.game.stateVersion, requestId };
}

test.after(async () => {
  clients.forEach(({ rt }) => goOffline(rt));
  await Promise.allSettled(clients.map(({ fs }) => terminate(fs)));
  await Promise.allSettled(clients.map(({ app }) => deleteApp(app)));
});

test('diagnoses one-ready and simultaneous readyNextRound transaction lifecycle', { timeout: 120000 }, async () => {
  const sequential = await startedRoom(`diag-${caseId}-seq`);
  const sequentialResult = await playRound(sequential, `diag-${caseId}-seq`);
  const first = await sequential.host.call('moonScaleDuelReadyNextRound', readyPayload(sequential, sequentialResult, `diag-${caseId}-seq-ready-h`));
  assert.equal(first.advanced, false);
  const oneReady = await sequential.host.call('moonScaleDuelGetSnapshot', { roomId: sequential.roomId });
  assert.deepEqual(oneReady.game.nextRoundReady, { seat1: true, seat2: false });
  const second = await sequential.guest.call('moonScaleDuelReadyNextRound', readyPayload(sequential, oneReady, `diag-${caseId}-seq-ready-g`));
  assert.equal(second.advanced, true);
  emit('sequential-control-complete', { roomId: sequential.roomId, gameId: sequential.gameId, round: sequentialResult.game.round });

  const race = await startedRoom(`diag-${caseId}-race`);
  const raceResult = await playRound(race, `diag-${caseId}-race`);
  const calls = [
    { seatId: 'seat1', requestId: `diag-${caseId}-race-ready-h`, client: race.host },
    { seatId: 'seat2', requestId: `diag-${caseId}-race-ready-g`, client: race.guest },
  ];
  emit('simultaneous-call-start', { roomId: race.roomId, gameId: race.gameId, round: raceResult.game.round, stateVersion: raceResult.game.stateVersion });
  const startedAt = Date.now();
  const outcomes = await Promise.all(calls.map(async ({ seatId, requestId, client: caller }) => {
    try {
      const value = await caller.call('moonScaleDuelReadyNextRound', readyPayload(race, raceResult, requestId));
      return { seatId, requestId, status: 'fulfilled', advanced: value.advanced };
    } catch (error) {
      return { seatId, requestId, status: 'rejected', code: error.code || null, message: error.message || null, stack: error.stack || null };
    }
  }));
  emit('simultaneous-call-complete', { roomId: race.roomId, gameId: race.gameId, round: raceResult.game.round, elapsedMillis: Date.now() - startedAt, outcomes });
  assert.equal(outcomes.every((outcome) => outcome.status === 'fulfilled'), true, JSON.stringify(outcomes));
  assert.deepEqual(outcomes.map((outcome) => outcome.advanced).sort(), [false, true]);
  const advanced = await race.host.call('moonScaleDuelGetSnapshot', { roomId: race.roomId });
  assert.equal(advanced.game.round, 2);
  assert.equal(advanced.game.phase, 'selecting-card');
  assert.deepEqual(advanced.game.nextRoundReady, { seat1: false, seat2: false });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInAnonymously } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { getFirestore, connectFirestoreEmulator, terminate } from 'firebase/firestore';
import { getDatabase, connectDatabaseEmulator, goOffline } from 'firebase/database';

const functionRequire = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp: initializeAdminApp, getApps: getAdminApps, deleteApp: deleteAdminApp } = functionRequire('firebase-admin/app');
const { getFirestore: getAdminFirestore } = functionRequire('firebase-admin/firestore');

const PROJECT_ID = 'demo-moon-scale-duel';
const SUBMIT_TRIALS = 10;
const TRANSACTION_TRIALS = 10;
const config = {
  projectId: PROJECT_ID,
  apiKey: 'demo',
  appId: 'demo',
  databaseURL: `http://127.0.0.1:9000?ns=${PROJECT_ID}`,
};

let ownedAdminApp = null;
if (!getAdminApps().length) {
  ownedAdminApp = initializeAdminApp({ projectId: PROJECT_ID, databaseURL: config.databaseURL });
}
const adminDb = getAdminFirestore();
const clients = [];

function diagnosticLog(event) {
  process.stdout.write(`DIAGNOSTIC ${JSON.stringify(event)}\n`);
}

function safeError(error) {
  return {
    code: typeof error?.code === 'string' || typeof error?.code === 'number' ? error.code : 'unknown',
    message: typeof error?.message === 'string' ? error.message : String(error),
  };
}

function createClient(name) {
  const app = initializeApp(config, name);
  const auth = getAuth(app);
  const firestore = getFirestore(app);
  const functions = getFunctions(app, 'asia-northeast1');
  const database = getDatabase(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(firestore, '127.0.0.1', 8080);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  connectDatabaseEmulator(database, '127.0.0.1', 9000);
  const client = {
    app,
    auth,
    firestore,
    database,
    call: (name, data) => httpsCallable(functions, name)(data).then((response) => response.data),
  };
  clients.push(client);
  return client;
}

async function createStartedRoom(trial) {
  const host = createClient(`diagnostic-submit-${trial}-host`);
  const guest = createClient(`diagnostic-submit-${trial}-guest`);
  await Promise.all([signInAnonymously(host.auth), signInAnonymously(guest.auth)]);
  const created = await host.call('moonScaleDuelCreateRoom', {
    displayName: '診断ホスト',
    requestId: `diagnostic-${trial}-create`,
  });
  await guest.call('moonScaleDuelJoinRoom', {
    displayName: '診断ゲスト',
    inviteCode: created.inviteCode,
    requestId: `diagnostic-${trial}-join`,
  });
  const waiting = await host.call('moonScaleDuelGetSnapshot', { roomId: created.roomId });
  const started = await host.call('moonScaleDuelStartGame', {
    roomId: created.roomId,
    stateVersion: waiting.room.stateVersion,
    requestId: `diagnostic-${trial}-start`,
  });
  return { host, guest, roomId: created.roomId, started };
}

async function timedSubmit(label, operation) {
  const startedAt = performance.now();
  try {
    const value = await operation();
    return { label, status: 'success', elapsedMs: Math.round(performance.now() - startedAt), value };
  } catch (error) {
    return { label, status: 'failure', elapsedMs: Math.round(performance.now() - startedAt), error: safeError(error) };
  }
}

test.after(async () => {
  clients.forEach(({ database }) => goOffline(database));
  await Promise.allSettled(clients.map(({ firestore }) => terminate(firestore)));
  await Promise.allSettled(clients.map(({ app }) => deleteApp(app)));
  if (ownedAdminApp) await deleteAdminApp(ownedAdminApp);
});

test('diagnostic: repeat minimal simultaneous moonScaleDuelSubmitCard', { timeout: 600_000 }, async () => {
  const failures = [];
  for (let trial = 1; trial <= SUBMIT_TRIALS; trial += 1) {
    const room = await createStartedRoom(trial);
    const payload = (cardId, requestId) => ({
      roomId: room.roomId,
      gameId: room.started.gameId,
      round: 1,
      stateVersion: room.started.stateVersion,
      cardId,
      requestId,
    });
    const [host, guest] = await Promise.all([
      timedSubmit('host', () => room.host.call('moonScaleDuelSubmitCard', payload('reflection', `diagnostic-${trial}-host`))),
      timedSubmit('guest', () => room.guest.call('moonScaleDuelSubmitCard', payload('stillness', `diagnostic-${trial}-guest`))),
    ]);
    const first = host.elapsedMs <= guest.elapsedMs ? 'host' : 'guest';
    const event = {
      diagnostic: 'simultaneous-submit',
      trial,
      result: host.status === 'success' && guest.status === 'success' ? 'success' : 'failure',
      first,
      host: { status: host.status, elapsedMs: host.elapsedMs, ...(host.error ? { error: host.error } : {}) },
      guest: { status: guest.status, elapsedMs: guest.elapsedMs, ...(guest.error ? { error: guest.error } : {}) },
      expectedRound: 1,
      expectedStateVersion: room.started.stateVersion,
    };
    diagnosticLog(event);
    if (event.result === 'failure') {
      failures.push(event);
      break;
    }
    assert.equal([host.value, guest.value].filter((result) => result.revealed).length, 1);
    const snapshot = await room.host.call('moonScaleDuelGetSnapshot', { roomId: room.roomId });
    assert.equal(snapshot.game.phase, 'round-result');
    assert.equal(snapshot.game.round, 1);
    assert.equal(snapshot.game.stateVersion, room.started.stateVersion + 1);
    assert.deepEqual(snapshot.game.publicCards, { seat1: 'reflection', seat2: 'stillness' });
    assert.equal(JSON.stringify(snapshot).includes('privateSelections'), false);
  }
  diagnosticLog({
    diagnostic: 'simultaneous-submit-summary',
    trialsPlanned: SUBMIT_TRIALS,
    trialsCompleted: failures.length ? failures[0].trial : SUBMIT_TRIALS,
    failures: failures.length,
  });
  assert.equal(failures.length, 0, 'simultaneous submit diagnostic reproduced a failure');
});

function createBarrier() {
  let arrivals = 0;
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return async () => {
    arrivals += 1;
    if (arrivals === 2) release();
    await promise;
  };
}

async function readDocuments(transaction, refs, method) {
  if (method === 'parallel') return Promise.all(refs.map((ref) => transaction.get(ref)));
  if (method === 'sequential') {
    const snapshots = [];
    for (const ref of refs) snapshots.push(await transaction.get(ref));
    return snapshots;
  }
  return transaction.getAll(...refs);
}

async function runContendingTransaction({ trial, side, method, refs, barrier }) {
  let attempts = 0;
  let phase = 'before-callback';
  const startedAt = performance.now();
  try {
    await adminDb.runTransaction(async (transaction) => {
      attempts += 1;
      const attempt = attempts;
      phase = 'callback-started';
      if (attempt === 1) diagnosticLog({ diagnostic: 'firestore-transaction-stage', method, trial, side, attempt, stage: phase });
      if (attempt === 1) await barrier();
      phase = 'reads-started';
      const snapshots = await readDocuments(transaction, refs, method);
      phase = 'reads-completed';
      if (attempt === 1) diagnosticLog({ diagnostic: 'firestore-transaction-stage', method, trial, side, attempt, stage: phase });
      phase = 'writes-started';
      const current = snapshots[0].data().value;
      transaction.update(refs[0], { value: current + 1 });
      phase = 'callback-completed';
    });
    phase = 'run-transaction-completed';
    return { side, status: 'success', attempts, phase, elapsedMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    return {
      side,
      status: 'failure',
      attempts,
      phase,
      elapsedMs: Math.round(performance.now() - startedAt),
      error: safeError(error),
    };
  }
}

for (const method of ['parallel', 'sequential', 'getAll']) {
  test(`diagnostic: compare contending Firestore transactions using ${method}`, { timeout: 300_000 }, async () => {
    const failures = [];
    const attemptCounts = [];
    const elapsed = [];
    for (let trial = 1; trial <= TRANSACTION_TRIALS; trial += 1) {
      const collection = adminDb.collection(`moonScaleDuelTransactionDiagnostic_${method}_${trial}`);
      const refs = Array.from({ length: 6 }, (_, index) => collection.doc(`document-${index + 1}`));
      const batch = adminDb.batch();
      refs.forEach((ref) => batch.set(ref, { value: 0 }));
      await batch.commit();
      const barrier = createBarrier();
      const [first, second] = await Promise.all([
        runContendingTransaction({ trial, side: 'first', method, refs, barrier }),
        runContendingTransaction({ trial, side: 'second', method, refs, barrier }),
      ]);
      const event = {
        diagnostic: 'firestore-transaction-comparison',
        method,
        trial,
        result: first.status === 'success' && second.status === 'success' ? 'success' : 'failure',
        first,
        second,
      };
      diagnosticLog(event);
      attemptCounts.push(first.attempts, second.attempts);
      elapsed.push(first.elapsedMs, second.elapsedMs);
      if (event.result === 'failure') failures.push(event);
      if (event.result === 'failure') break;
      assert.equal((await refs[0].get()).data().value, 2);
    }
    diagnosticLog({
      diagnostic: 'firestore-transaction-comparison-summary',
      method,
      trialsPlanned: TRANSACTION_TRIALS,
      trialsCompleted: failures.length ? failures[0].trial : TRANSACTION_TRIALS,
      failures: failures.length,
      minAttempts: Math.min(...attemptCounts),
      maxAttempts: Math.max(...attemptCounts),
      minElapsedMs: Math.min(...elapsed),
      maxElapsedMs: Math.max(...elapsed),
    });
    assert.equal(failures.length, 0, `${method} transaction diagnostic reproduced a failure`);
  });
}

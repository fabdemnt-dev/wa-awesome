import test from 'node:test';
import assert from 'node:assert/strict';
import { runMofumofuFullResume } from '../toybox/mofumofu-gathering/online/full-resume.js';
import { createResumeCoordinator } from '../toybox/mofumofu-gathering/online/connection-control.js';

function harness(overrides = {}) {
  const calls = [];
  const auth = { currentUser: { uid: 'anonymous-b' }, authStateReady: async () => calls.push('auth-ready') };
  const storage = new Map([['mofumofuRoomId', 'room-1'], ['mofumofuSeatId', 'B']]);
  const screen = { shown: false, cards: [] };
  const options = {
    auth,
    signInAnonymously: async () => { calls.push('sign-in'); auth.currentUser = { uid: 'new-anonymous' }; },
    isCurrent: () => true,
    retirePresence: async () => calls.push('retire'),
    createConnectionId: () => { calls.push('connection-id'); return 'connection-1'; },
    authorizePresence: async (connectionId) => { calls.push(`authorize:${connectionId}`); return { seatId: 'B' }; },
    beginPresence: async (seatId, connectionId) => calls.push(`presence:${seatId}:${connectionId}`),
    resumeRoom: async () => { calls.push('resume'); return { seatId: 'B', cards: Array(10).fill('card'), room: { status: 'playing' } }; },
    applyResume: async (value) => { calls.push('apply'); screen.shown = true; screen.cards = value.cards; },
    ...overrides,
  };
  return { auth, storage, screen, calls, options };
}

test('App Check throttling相当の外部状態があっても明示preflightなしでpresence・resume・画面復元へ進む', async () => {
  const h = harness();
  let obsoleteExplicitGetTokenCalls = 0;
  const obsoleteExplicitGetToken = async () => { obsoleteExplicitGetTokenCalls += 1; throw Object.assign(new Error('throttled'), { code: 'appCheck/throttled' }); };

  assert.equal(await runMofumofuFullResume({ ...h.options, getToken: obsoleteExplicitGetToken }), true);
  assert.equal(obsoleteExplicitGetTokenCalls, 0);
  assert.deepEqual(h.calls, ['auth-ready', 'retire', 'connection-id', 'authorize:connection-1', 'presence:B:connection-1', 'resume', 'apply']);
  assert.equal(h.screen.shown, true);
  assert.equal(h.screen.cards.length, 10);
  assert.equal(h.auth.currentUser.uid, 'anonymous-b');
  assert.equal(h.storage.get('mofumofuRoomId'), 'room-1');
  assert.equal(h.storage.get('mofumofuSeatId'), 'B');
});

test('Anonymous Authが保存済みならsign-inせず同じUIDを維持する', async () => {
  const h = harness();
  await runMofumofuFullResume(h.options);
  assert.equal(h.auth.currentUser.uid, 'anonymous-b');
  assert.equal(h.calls.includes('sign-in'), false);
});

test('Anonymous Authがなければsign-in完了後にpresence認可へ進む', async () => {
  const h = harness();
  h.auth.currentUser = null;
  await runMofumofuFullResume(h.options);
  assert.equal(h.auth.currentUser.uid, 'new-anonymous');
  assert.ok(h.calls.indexOf('sign-in') < h.calls.indexOf('authorize:connection-1'));
});

test('backendのApp Check拒否は握り潰さず接続側へ伝播する', async () => {
  const rejection = Object.assign(new Error('App Check rejected'), { code: 'functions/unauthenticated' });
  const h = harness({ authorizePresence: async () => { throw rejection; } });
  await assert.rejects(runMofumofuFullResume(h.options), (error) => error === rejection);
  assert.equal(h.calls.includes('resume'), false);
  assert.equal(h.screen.shown, false);
});

test('backendのApp Check拒否はresume coordinatorの接続エラー経路へ到達する', async () => {
  const rejection = Object.assign(new Error('App Check rejected'), { code: 'functions/unauthenticated' });
  const h = harness({ authorizePresence: async () => { throw rejection; } });
  const state = { resumeFlight: null, connectionState: 'syncing' };
  let reported = null;
  const requestResume = createResumeCoordinator({
    state,
    getRoomId: () => 'room-1',
    runResume: () => runMofumofuFullResume(h.options),
    onError: (error, reason) => { reported = { error, reason }; state.connectionState = 'error'; },
  });

  await requestResume('visibilitychange');
  assert.deepEqual(reported, { error: rejection, reason: 'visibilitychange' });
  assert.equal(state.connectionState, 'error');
  assert.equal(state.resumeFlight, null);
});

test('resume Callableの拒否も握り潰さず画面適用しない', async () => {
  const rejection = Object.assign(new Error('App Check rejected'), { code: 'functions/permission-denied' });
  const h = harness({ resumeRoom: async () => { throw rejection; } });
  await assert.rejects(runMofumofuFullResume(h.options), (error) => error === rejection);
  assert.equal(h.screen.shown, false);
});

test('古いgenerationは次の副作用へ進まない', async () => {
  let current = true;
  const h = harness({
    retirePresence: async () => { h.calls.push('retire'); current = false; },
    isCurrent: () => current,
  });
  assert.equal(await runMofumofuFullResume(h.options), false);
  assert.deepEqual(h.calls, ['auth-ready', 'retire']);
});

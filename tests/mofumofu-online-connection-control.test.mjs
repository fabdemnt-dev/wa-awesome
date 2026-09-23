import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionIsOnline, createResumeCoordinator, playerPresenceState, presenceAllowsNpcProxy, proxyEvaluationReady, runStartGame, shouldStartNpcProxy } from '../toybox/mofumofu-gathering/online/connection-control.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function startHarness() {
  const state = { startBusy: false };
  const button = { disabled: false };
  const gate = deferred();
  let starts = 0;
  let refreshes = 0;
  const run = () => runStartGame({
    state,
    button,
    roomId: 'room-1',
    startGame: async ({ roomId }) => { starts += 1; assert.equal(roomId, 'room-1'); await gate.promise; },
    refresh: async () => { refreshes += 1; },
  });
  return { state, button, gate, run, counts: () => ({ starts, refreshes }) };
}

test('start 1 click sends one Callable and disables immediately', async () => {
  const value = startHarness();
  const flight = value.run();
  assert.equal(value.state.startBusy, true);
  assert.equal(value.button.disabled, true);
  await Promise.resolve();
  assert.deepEqual(value.counts(), { starts: 1, refreshes: 0 });
  value.gate.resolve();
  assert.equal(await flight, true);
  assert.deepEqual(value.counts(), { starts: 1, refreshes: 1 });
  assert.equal(value.button.disabled, true);
});

test('start pending ignores repeated clicks', async () => {
  const value = startHarness();
  const first = value.run();
  const second = value.run();
  assert.equal(await second, false);
  await Promise.resolve();
  assert.equal(value.counts().starts, 1);
  value.gate.resolve();
  await first;
});

test('start failure unlocks and permits retry', async () => {
  const state = { startBusy: false };
  const button = { disabled: false };
  let attempts = 0;
  const run = () => runStartGame({
    state, button, roomId: 'room-1',
    startGame: async () => { attempts += 1; if (attempts === 1) throw new Error('failed'); },
    refresh: async () => {},
  });
  await assert.rejects(run(), /failed/);
  assert.equal(state.startBusy, false);
  assert.equal(button.disabled, false);
  assert.equal(await run(), true);
  assert.equal(attempts, 2);
});

function resumeHarness({ clock = 10_000 } = {}) {
  const state = {
    resumeFlight: null,
    connectionState: 'connected',
    lifecycleDisconnected: false,
    lastSuccessfulResumeRoomId: null,
    lastSuccessfulResumeAt: 0,
  };
  let roomId = 'room-1';
  let now = clock;
  let runs = 0;
  let connections = 0;
  let proxyAttempts = 0;
  let activeHeartbeat = 0;
  let maxHeartbeat = 0;
  let activeAccess = 0;
  let maxAccess = 0;
  let activeFirestore = 0;
  let maxFirestore = 0;
  let activeRtdb = 0;
  let maxRtdb = 0;
  let activePolling = 0;
  let maxPolling = 0;
  let gate = null;
  const stop = () => {
    activeHeartbeat = activeAccess = activeFirestore = activeRtdb = activePolling = 0;
  };
  const start = () => {
    activeHeartbeat += 1; maxHeartbeat = Math.max(maxHeartbeat, activeHeartbeat);
    activeAccess += 1; maxAccess = Math.max(maxAccess, activeAccess);
    activeFirestore += 1; maxFirestore = Math.max(maxFirestore, activeFirestore);
    activeRtdb += 1; maxRtdb = Math.max(maxRtdb, activeRtdb);
    activePolling += 1; maxPolling = Math.max(maxPolling, activePolling);
  };
  const runResume = async () => {
    runs += 1;
    stop();
    connections += 1;
    if (gate) await gate.promise;
    start();
    state.connectionState = 'connected';
  };
  const errors = [];
  const request = createResumeCoordinator({
    state,
    getRoomId: () => roomId,
    runResume,
    onError: (error, reason) => { errors.push([error.message, reason]); state.connectionState = 'error'; },
    now: () => now,
  });
  return {
    state, request, errors,
    setGate(value) { gate = value; },
    setNow(value) { now = value; },
    setRoom(value) { roomId = value; },
    counts() { return { runs, connections, proxyAttempts, maxHeartbeat, maxAccess, maxFirestore, maxRtdb, maxPolling }; },
    simulateProxyCheck() { if (activeHeartbeat === 0) proxyAttempts += 1; },
  };
}

for (const [first, second] of [
  ['pageshow', 'visibilitychange'],
  ['visibilitychange', 'pageshow'],
  ['visibilitychange', 'online'],
  ['online', 'visibilitychange'],
  ['pageshow', 'online'],
  ['online', 'pageshow'],
]) {
  test(`pending ${first} + ${second} uses one connection`, async () => {
    const value = resumeHarness();
    const gate = deferred();
    value.setGate(gate);
    const firstFlight = value.request(first);
    const secondFlight = value.request(second);
    assert.equal(firstFlight, secondFlight);
    await Promise.resolve();
    assert.equal(value.counts().connections, 1);
    gate.resolve();
    await firstFlight;
    assert.equal(value.counts().runs, 1);
  });
}

test('lifecycle event immediately after successful resume is coalesced', async () => {
  const value = resumeHarness();
  await value.request('pageshow');
  await value.request('visibilitychange');
  await value.request('online');
  assert.deepEqual(value.counts(), { runs: 1, connections: 1, proxyAttempts: 0, maxHeartbeat: 1, maxAccess: 1, maxFirestore: 1, maxRtdb: 1, maxPolling: 1 });
});

test('lifecycle event after cooldown starts a new full resume', async () => {
  const value = resumeHarness();
  await value.request('pageshow');
  value.setNow(11_501);
  await value.request('visibilitychange');
  assert.equal(value.counts().connections, 2);
});

for (const reason of [
  'firestore-listener:waiting-playing',
  'firestore-listener-error:unavailable',
  'heartbeat-error',
  'presence-access-error',
  'manual-retry',
  'create-room',
  'join-room',
  'initial',
]) {
  test(`${reason} bypasses lifecycle coalescing`, async () => {
    const value = resumeHarness();
    await value.request('pageshow');
    await value.request(reason);
    assert.equal(value.counts().connections, 2);
  });
}

test('offline observation makes immediate online perform a real resume', async () => {
  const value = resumeHarness();
  await value.request('pageshow');
  value.state.lifecycleDisconnected = true;
  await value.request('online');
  assert.equal(value.counts().connections, 2);
});

test('same cooldown record does not suppress a different room', async () => {
  const value = resumeHarness();
  await value.request('pageshow');
  value.setRoom('room-2');
  await value.request('visibilitychange');
  assert.equal(value.counts().connections, 2);
});

test('failed resume is not recorded as successful and next lifecycle event retries', async () => {
  const state = { resumeFlight: null, connectionState: 'connected', lifecycleDisconnected: false, lastSuccessfulResumeRoomId: null, lastSuccessfulResumeAt: 0 };
  let runs = 0;
  const request = createResumeCoordinator({
    state,
    getRoomId: () => 'room-1',
    runResume: async () => { runs += 1; if (runs === 1) throw new Error('failed'); state.connectionState = 'connected'; },
    onError: () => { state.connectionState = 'error'; },
    now: () => 10_000,
  });
  await request('pageshow');
  await request('visibilitychange');
  assert.equal(runs, 2);
});

test('coalesced lifecycle burst does not create a transient proxy attempt', async () => {
  const value = resumeHarness();
  await value.request('pageshow');
  await value.request('visibilitychange');
  value.simulateProxyCheck();
  assert.equal(value.counts().proxyAttempts, 0);
  assert.equal(value.counts().connections, 1);
});

test('old flight finally cannot clear a newer flight reference', async () => {
  const value = resumeHarness();
  const gate = deferred();
  value.setGate(gate);
  const oldFlight = value.request('pageshow');
  await Promise.resolve();
  const replacement = Promise.resolve();
  value.state.resumeFlight = replacement;
  gate.resolve();
  await oldFlight;
  assert.equal(value.state.resumeFlight, replacement);
});

function proxyState(overrides = {}) {
  return {
    resumeFlight: null,
    connectionState: 'connected',
    resumeGeneration: 4,
    presenceReadyGeneration: 4,
    ...overrides,
  };
}

test('full resume中の旧presence切断から新presence確認までproxyを要求しない', () => {
  let requests = 0;
  const requestProxy = (state) => {
    if (shouldStartNpcProxy({ state, mode: 'human', presence: { connections: { old: { state: 'disconnected', lastHeartbeatAt: 1 } } }, now: 1_000_000 })) requests += 1;
  };
  requestProxy(proxyState({ resumeFlight: Promise.resolve(), connectionState: 'syncing', presenceReadyGeneration: 0 }));
  requestProxy(proxyState({ resumeFlight: Promise.resolve(), connectionState: 'syncing', presenceReadyGeneration: 4 }));
  requestProxy(proxyState({ resumeFlight: null, connectionState: 'connected', presenceReadyGeneration: 3 }));
  assert.equal(requests, 0);
});

test('現generationの新presence snapshot確認後はhuman onlineを維持する', () => {
  const state = proxyState();
  assert.equal(proxyEvaluationReady(state), true);
  assert.equal(shouldStartNpcProxy({ state, mode: 'human', presence: { connections: { live: { state: 'online', lastHeartbeatAt: 999_999 } } }, now: 1_000_000 }), false);
});

test('online connectionがあればproxyを開始しない', () => {
  const now = 1_000_000;
  const presence = { connections: { live: { state: 'online', lastHeartbeatAt: now - 15_000 } } };
  assert.equal(playerPresenceState(presence, now).online, true);
  assert.equal(shouldStartNpcProxy({ state: proxyState(), mode: 'human', presence, now }), false);
});

test('disconnectedでも最新heartbeatが15秒前または119秒前ならproxyを開始しない', () => {
  const now = 1_000_000;
  for (const age of [15_000, 119_000, 119_999]) {
    const presence = { connections: { gone: { state: 'disconnected', lastHeartbeatAt: now - age } } };
    assert.equal(presenceAllowsNpcProxy(presence, now), false);
    assert.equal(shouldStartNpcProxy({ state: proxyState(), mode: 'human', presence, now }), false);
  }
});

test('disconnectedの2分境界と2分超ではserver仕様どおりproxy開始可能', () => {
  const now = 1_000_000;
  for (const age of [120_000, 120_001]) {
    const presence = { connections: { gone: { state: 'disconnected', lastHeartbeatAt: now - age } } };
    assert.equal(presenceAllowsNpcProxy(presence, now), true);
    assert.equal(shouldStartNpcProxy({ state: proxyState(), mode: 'human', presence, now }), true);
  }
});

test('複数connectionのうち1つでもonlineならproxyを開始しない', () => {
  const now = 1_000_000;
  const presence = { connections: {
    old: { state: 'disconnected', lastHeartbeatAt: now - 500_000 },
    live: { state: 'online', lastHeartbeatAt: now - 1_000 },
  } };
  assert.deepEqual(playerPresenceState(presence, now), { online: true, lastHeartbeatAt: now - 1_000 });
  assert.equal(shouldStartNpcProxy({ state: proxyState(), mode: 'human', presence, now }), false);
});

test('複数disconnectedでは最新heartbeatから2分を判定する', () => {
  const now = 1_000_000;
  const recent = { connections: {
    old: { state: 'disconnected', lastHeartbeatAt: now - 500_000 },
    recent: { state: 'disconnected', lastHeartbeatAt: now - 30_000 },
  } };
  assert.equal(presenceAllowsNpcProxy(recent, now), false);
  const stale = { connections: {
    old: { state: 'disconnected', lastHeartbeatAt: now - 500_000 },
    latest: { state: 'disconnected', lastHeartbeatAt: now - 120_001 },
  } };
  assert.equal(presenceAllowsNpcProxy(stale, now), true);
});

test('connectedAtだけ・欠損presence・malformed timestampは安全側でproxyを開始しない', () => {
  const now = 1_000_000;
  const values = [
    null,
    {},
    { connections: { only: { state: 'disconnected', connectedAt: now - 500_000 } } },
    { connections: { bad: { state: 'disconnected', lastHeartbeatAt: 'invalid' } } },
    { connections: { bad: null } },
  ];
  for (const presence of values) {
    assert.deepEqual(playerPresenceState(presence, now), { online: false, lastHeartbeatAt: 0 });
    assert.equal(shouldStartNpcProxy({ state: proxyState(), mode: 'human', presence, now }), false);
  }
});

test('非有限timestampは安全側でproxyを開始しない', () => {
  const now = 1_000_000;
  const presence = { connections: { bad: { state: 'online', lastHeartbeatAt: Infinity } } };
  assert.equal(playerPresenceState(presence, now).online, false);
  assert.equal(presenceAllowsNpcProxy(presence, now), false);
});

test('文字列timestampはmalformedとして安全側でproxyを開始しない', () => {
  const now = 1_000_000;
  const presence = { connections: { malformed: { state: 'online', lastHeartbeatAt: String(now - 120_000) } } };
  assert.deepEqual(playerPresenceState(presence, now), { online: false, lastHeartbeatAt: 0 });
  assert.equal(presenceAllowsNpcProxy(presence, now), false);
});

test('5秒polling再評価は2分未満0回、2分到達後に開始可能', () => {
  const heartbeat = 1_000_000;
  const presence = { connections: { gone: { state: 'disconnected', lastHeartbeatAt: heartbeat } } };
  let requests = 0;
  for (let elapsed = 5_000; elapsed < 120_000; elapsed += 5_000) {
    if (shouldStartNpcProxy({ state: proxyState(), mode: 'human', presence, now: heartbeat + elapsed })) requests += 1;
  }
  assert.equal(requests, 0);
  assert.equal(shouldStartNpcProxy({ state: proxyState(), mode: 'human', presence, now: heartbeat + 120_000 }), true);
});

test('NPC代理開始済みのactionは安定接続後に引き続き許可される', () => {
  assert.equal(proxyEvaluationReady(proxyState()), true);
  assert.equal(shouldStartNpcProxy({ state: proxyState(), mode: 'npc-controlled', presence: null }), false);
});

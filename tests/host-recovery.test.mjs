import test from 'node:test';
import assert from 'node:assert/strict';
import { HOST_TIMEOUT_MS, isHostHeartbeatStale } from '../host-recovery-utils.js';

test('直近のHeartbeatがある親は不在扱いにならない', () => {
  const now = 1_000_000;
  assert.equal(isHostHeartbeatStale({ hostHeartbeatAt: now - HOST_TIMEOUT_MS + 1 }, now), false);
});

test('期限を超えたHeartbeatの親は不在扱いになる', () => {
  const now = 1_000_000;
  assert.equal(isHostHeartbeatStale({ hostHeartbeatAt: now - HOST_TIMEOUT_MS - 1 }, now), true);
});

test('Heartbeatがない状態は猶予時間を超えるまで不在扱いにしない', () => {
  const now = 1_000_000;
  assert.equal(isHostHeartbeatStale({}, now, now - HOST_TIMEOUT_MS + 1), false);
  assert.equal(isHostHeartbeatStale({}, now, now - HOST_TIMEOUT_MS - 1), true);
});

test('Firestore Timestamp形式のHeartbeatを扱える', () => {
  const now = 1_000_000;
  assert.equal(isHostHeartbeatStale({ hostHeartbeatAt: { toMillis: () => now - HOST_TIMEOUT_MS - 1 } }, now), true);
});

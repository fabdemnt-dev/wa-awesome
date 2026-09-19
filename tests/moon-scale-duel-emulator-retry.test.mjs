import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  callReadyNextRoundWithEmulatorRetry,
  isRetryableReadyNextRoundEmulatorError,
} from './helpers/moon-scale-duel-emulator-retry.mjs';

const require = createRequire(import.meta.url);
const {
  emulatorRetryDetails,
  isInvalidClosedTransactionError,
} = require('../functions/moon-scale-duel-online/emulator-transaction-error.js');

function callableError(code, message, details) {
  return Object.assign(new Error(message), { code, details });
}

const knownCallableError = () => callableError(
  'functions/internal',
  'INTERNAL',
  emulatorRetryDetails(),
);

test('server classification requires INVALID_ARGUMENT and the exact known message', () => {
  assert.equal(isInvalidClosedTransactionError(Object.assign(new Error('3 INVALID_ARGUMENT: Transaction is invalid or closed.'), { code: 3 })), true);
  assert.equal(isInvalidClosedTransactionError(Object.assign(new Error('Transaction is invalid or closed.'), { code: 'INVALID_ARGUMENT' })), true);
  assert.equal(isInvalidClosedTransactionError(Object.assign(new Error('Another invalid argument'), { code: 3 })), false);
  assert.equal(isInvalidClosedTransactionError(Object.assign(new Error('Transaction is invalid or closed.'), { code: 13 })), false);
});

test('known emulator failure is retried once with the identical payload', async () => {
  const payload = { requestId: 'same-request-id', stateVersion: 7 };
  const seen = [];
  const result = await callReadyNextRoundWithEmulatorRetry(async (received) => {
    seen.push(received);
    if (seen.length === 1) throw knownCallableError();
    return { advanced: true };
  }, payload);
  assert.deepEqual(result, { advanced: true });
  assert.equal(seen.length, 2);
  assert.equal(seen[0], payload);
  assert.equal(seen[1], payload);
  assert.equal(seen[0].requestId, seen[1].requestId);
});

for (const [name, error] of [
  ['different INVALID_ARGUMENT message', callableError('functions/internal', 'INTERNAL', { ...emulatorRetryDetails(), firestoreMessage: 'Another invalid argument' })],
  ['different INTERNAL', callableError('functions/internal', 'Different internal failure')],
  ['FAILED_PRECONDITION', callableError('functions/failed-precondition', 'FAILED_PRECONDITION')],
  ['PERMISSION_DENIED', callableError('functions/permission-denied', 'PERMISSION_DENIED')],
  ['assertion failure', new assert.AssertionError({ message: 'game assertion failed' })],
]) {
  test(`${name} is not retried`, async () => {
    let calls = 0;
    await assert.rejects(callReadyNextRoundWithEmulatorRetry(async () => {
      calls += 1;
      throw error;
    }, { requestId: 'not-retried' }), (received) => received === error);
    assert.equal(calls, 1);
  });
}

test('two consecutive known failures stop after the single retry', async () => {
  let calls = 0;
  await assert.rejects(callReadyNextRoundWithEmulatorRetry(async () => {
    calls += 1;
    throw knownCallableError();
  }, { requestId: 'retry-once' }), isRetryableReadyNextRoundEmulatorError);
  assert.equal(calls, 2);
});

test('success is returned without an extra call', async () => {
  let calls = 0;
  const result = await callReadyNextRoundWithEmulatorRetry(async () => {
    calls += 1;
    return { advanced: false };
  }, { requestId: 'success-once' });
  assert.deepEqual(result, { advanced: false });
  assert.equal(calls, 1);
});

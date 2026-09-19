'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { requireInviteHmacKey } = require('../deep-mining-agreement-online/secret');

test('requires an explicit sufficiently long invite HMAC key', () => {
  const value = 'local-test-only-deep-mining-key-not-production';
  assert.equal(requireInviteHmacKey(() => value), value);
});

test('fails closed when the invite HMAC key is unavailable', () => {
  assert.throws(() => requireInviteHmacKey(() => undefined), /at least 32 characters/);
  assert.throws(() => requireInviteHmacKey(() => { throw new Error('missing'); }), /unavailable/);
});

test('rejects the former predictable emulator fallback key', () => {
  assert.throws(() => requireInviteHmacKey(() => 'emulator-dma-key'), /at least 32 characters/);
});

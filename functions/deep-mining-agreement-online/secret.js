'use strict';

function requireInviteHmacKey(readSecret) {
  let value;
  try {
    value = readSecret();
  } catch {
    throw new Error('DEEP_MINING_AGREEMENT_INVITE_HMAC_KEY is unavailable');
  }
  if (typeof value !== 'string' || value.length < 32) {
    throw new Error('DEEP_MINING_AGREEMENT_INVITE_HMAC_KEY must contain at least 32 characters');
  }
  return value;
}

module.exports = { requireInviteHmacKey };

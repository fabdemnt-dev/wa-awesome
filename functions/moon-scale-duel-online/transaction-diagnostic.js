'use strict';

const crypto = require('node:crypto');

const ENABLED = process.env.MOON_SCALE_DUEL_TRANSACTION_DIAGNOSTIC === '1';
const PREFIX = 'MOON_SCALE_DUEL_TRANSACTION_DIAGNOSTIC ';

function safeError(error) {
  const code = typeof error?.code === 'string' || typeof error?.code === 'number' ? error.code : 'unknown';
  const message = typeof error?.message === 'string' ? error.message.slice(0, 240) : 'unknown error';
  return { code, message };
}

function createTransactionDiagnostic(callable) {
  if (!ENABLED) {
    return {
      event() {},
      nextAttempt() { return 0; },
      errorFields(error) { return safeError(error); },
      snapshot() { return { attempt: 0, lastStage: null }; },
    };
  }

  const diagnosticId = crypto.randomUUID();
  const startedAt = Date.now();
  let attempt = 0;
  let lastStage = null;

  function event(stage, fields = {}) {
    lastStage = stage;
    console.log(`${PREFIX}${JSON.stringify({
      callable,
      diagnosticId,
      attempt,
      stage,
      elapsed_ms: Date.now() - startedAt,
      ...fields,
    })}`);
  }

  return {
    event,
    nextAttempt() { attempt += 1; return attempt; },
    errorFields(error) { return safeError(error); },
    snapshot() { return { attempt, lastStage }; },
  };
}

module.exports = { createTransactionDiagnostic };

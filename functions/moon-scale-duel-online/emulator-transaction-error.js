'use strict';

const FIRESTORE_INVALID_TRANSACTION_MESSAGE = 'Transaction is invalid or closed.';
const EMULATOR_RETRY_KIND = 'moon-scale-duel/firestore-emulator-invalid-transaction';

function isInvalidClosedTransactionError(error) {
  const code = error?.code;
  const message = error?.message;
  const invalidArgument = code === 3 || code === '3' || code === 'INVALID_ARGUMENT';
  return invalidArgument && (
    message === FIRESTORE_INVALID_TRANSACTION_MESSAGE
    || message === `3 INVALID_ARGUMENT: ${FIRESTORE_INVALID_TRANSACTION_MESSAGE}`
  );
}

function emulatorRetryDetails() {
  return {
    kind: EMULATOR_RETRY_KIND,
    firestoreCode: 'INVALID_ARGUMENT',
    firestoreMessage: FIRESTORE_INVALID_TRANSACTION_MESSAGE,
  };
}

module.exports = {
  EMULATOR_RETRY_KIND,
  FIRESTORE_INVALID_TRANSACTION_MESSAGE,
  emulatorRetryDetails,
  isInvalidClosedTransactionError,
};

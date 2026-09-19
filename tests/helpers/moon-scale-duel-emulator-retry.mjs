const RETRY_KIND = 'moon-scale-duel/firestore-emulator-invalid-transaction';
const FIRESTORE_CODE = 'INVALID_ARGUMENT';
const FIRESTORE_MESSAGE = 'Transaction is invalid or closed.';

export function isRetryableReadyNextRoundEmulatorError(error) {
  return error?.code === 'functions/internal'
    && error?.details?.kind === RETRY_KIND
    && error?.details?.firestoreCode === FIRESTORE_CODE
    && error?.details?.firestoreMessage === FIRESTORE_MESSAGE;
}

export async function callReadyNextRoundWithEmulatorRetry(invoke, payload) {
  try {
    return await invoke(payload);
  } catch (error) {
    if (!isRetryableReadyNextRoundEmulatorError(error)) throw error;
    return invoke(payload);
  }
}

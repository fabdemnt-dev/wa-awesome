export const AUTH_TIMEOUT_MS = 20_000;

export class AuthTimeoutError extends Error {
  constructor(stage) {
    super('ログイン処理が一定時間内に完了しませんでした。');
    this.name = 'AuthTimeoutError';
    this.code = 'auth/operation-timeout';
    this.stage = stage;
  }
}

export function withAuthTimeout(operation, { stage, timeoutMs = AUTH_TIMEOUT_MS } = {}) {
  let timeoutId;
  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => reject(new AuthTimeoutError(stage)), timeoutMs);
  });
  return Promise.race([Promise.resolve(operation), timeout])
    .finally(() => clearTimeout(timeoutId));
}

export async function runAnonymousAuth({
  authStateReady,
  getCurrentUser,
  signIn,
  timeoutMs = AUTH_TIMEOUT_MS,
}) {
  await withAuthTimeout(authStateReady(), { stage: 'auth-state-ready', timeoutMs });
  const currentUser = getCurrentUser();
  if (currentUser) return currentUser;
  const credential = await withAuthTimeout(signIn(), { stage: 'sign-in-anonymously', timeoutMs });
  return credential.user;
}

export function createAuthAttemptCoordinator({ attempt, onStart, onSuccess, onFailure, onSettled }) {
  let generation = 0;
  let inFlight = null;

  function run() {
    if (inFlight) return inFlight;
    const currentGeneration = ++generation;
    onStart?.();
    inFlight = (async () => {
      try {
        const result = await attempt();
        if (currentGeneration === generation) await onSuccess?.(result);
      } catch (error) {
        if (currentGeneration === generation) await onFailure?.(error);
      } finally {
        if (currentGeneration === generation) {
          inFlight = null;
          onSettled?.();
        }
      }
    })();
    return inFlight;
  }

  return { run };
}

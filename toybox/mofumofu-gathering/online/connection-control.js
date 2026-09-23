export const LIFECYCLE_RESUME_REASONS = new Set(['visibilitychange', 'pageshow', 'online']);

export function connectionIsOnline(connection, now = Date.now(), staleMs = 120_000) {
  return connection?.state === 'online' && Number(connection.lastHeartbeatAt) >= now - staleMs;
}

export function proxyEvaluationReady(state) {
  return !state.resumeFlight
    && state.connectionState === 'connected'
    && state.presenceReadyGeneration === state.resumeGeneration;
}

export function shouldStartNpcProxy({ state, mode, online }) {
  return proxyEvaluationReady(state) && mode === 'human' && !online;
}

export async function runStartGame({ state, button, roomId, startGame, refresh }) {
  if (state.startBusy) return false;
  state.startBusy = true;
  button.disabled = true;
  let started = false;
  try {
    await startGame({ roomId });
    started = true;
    await refresh();
    return true;
  } catch (error) {
    if (!started) {
      state.startBusy = false;
      button.disabled = false;
    }
    throw error;
  }
}

export function createResumeCoordinator({
  state,
  getRoomId,
  runResume,
  onError,
  now = Date.now,
  cooldownMs = 1_500,
}) {
  return function requestResume(reason) {
    const roomId = getRoomId();
    if (!roomId) return Promise.resolve();
    if (state.resumeFlight) return state.resumeFlight;

    const lifecycleBurst = LIFECYCLE_RESUME_REASONS.has(reason)
      && state.connectionState === 'connected'
      && !state.lifecycleDisconnected
      && state.lastSuccessfulResumeRoomId === roomId
      && now() - state.lastSuccessfulResumeAt < cooldownMs;
    if (lifecycleBurst) return Promise.resolve();

    const work = Promise.resolve().then(() => runResume(reason));
    const flight = work.then(() => {
      if (getRoomId() !== roomId || state.connectionState !== 'connected') return;
      state.lastSuccessfulResumeRoomId = roomId;
      state.lastSuccessfulResumeAt = now();
      state.lifecycleDisconnected = false;
    }).catch((error) => onError(error, reason)).finally(() => {
      if (state.resumeFlight === flight) state.resumeFlight = null;
    });
    state.resumeFlight = flight;
    return flight;
  };
}

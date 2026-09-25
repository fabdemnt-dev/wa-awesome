export const LIFECYCLE_RESUME_REASONS = new Set(['visibilitychange', 'pageshow', 'online']);

export function connectionIsOnline(connection, now = Date.now(), staleMs = 120_000) {
  return connection?.state === 'online'
    && Number.isFinite(connection.lastHeartbeatAt)
    && connection.lastHeartbeatAt >= now - staleMs;
}

export function playerPresenceState(value, now = Date.now(), staleMs = 120_000) {
  const connections = Object.values(value?.connections || {}).filter((connection) => connection && typeof connection === 'object' && !Array.isArray(connection));
  const lastHeartbeatAt = connections.reduce((latest, connection) => (
    Number.isFinite(connection.lastHeartbeatAt) ? Math.max(latest, connection.lastHeartbeatAt) : latest
  ), 0);
  return {
    online: connections.some((connection) => connectionIsOnline(connection, now, staleMs)),
    lastHeartbeatAt,
  };
}

export function presenceAllowsNpcProxy(value, now = Date.now(), staleMs = 120_000) {
  const presence = playerPresenceState(value, now, staleMs);
  return !presence.online
    && !!presence.lastHeartbeatAt
    && now - presence.lastHeartbeatAt >= staleMs;
}

export function proxyEvaluationReady(state) {
  return !state.resumeFlight
    && state.connectionState === 'connected'
    && state.presenceReadyGeneration === state.resumeGeneration;
}

export function shouldStartNpcProxy({ state, mode, presence, now = Date.now(), staleMs = 120_000 }) {
  return proxyEvaluationReady(state)
    && mode === 'human'
    && presenceAllowsNpcProxy(presence, now, staleMs);
}

// ダイアログのスクロール位置を、初期表示で全文が読める位置へ合わせる純粋計算。
// 収まるとき／高さ未確定（viewH=0）は0（先頭）。収まらないときは先頭→末尾の順で返し、末尾が実際の初期位置になる。
export function dialogScrollTargets({ contentH, viewH, wasAtBottom, pad = 24 }) {
  if (!(viewH > 0) || !(contentH > 0)) return [0];
  if (contentH <= viewH + pad) return [0];
  const bottom = contentH - viewH;
  return wasAtBottom ? [bottom] : [0, bottom];
}

// 入口（部屋をつくる／参加）の二重送信防止。disabled状態はDOMではなくstate.entryBusyだけを正本にし、
// room消失で入口へ戻る経路でも同じstateを解放できるようにする。
export function beginEntrySubmit(state) {
  if (state.entryBusy) return false;
  state.entryBusy = true;
  return true;
}

export function endEntrySubmit(state) {
  state.entryBusy = false;
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

// 公開roomはmakeのactionIdを載せるがjudgeのactionIdは載せない。
// 不明な結果は元のpayloadを保ったまま同じactionIdで一度だけ確認する。
export function multiActionBlocked(state) {
  return Boolean(state.makeBusy || state.judgeBusy || state.makeRequest || state.judgeRequest || state.actionRecoveryFlight);
}

export function multiJudgeButtonsDisabled(view, state) {
  return !view.canJudge || multiActionBlocked(state);
}

export function definitiveMultiActionRejection(error) {
  const code = String(error?.code || '').replace(/^functions\//, '');
  return ['invalid-argument', 'failed-precondition', 'already-exists', 'not-found'].includes(code);
}

async function boundedResult(work, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('action-result-timeout')), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

export function createMultiPendingActionRecovery({
  state, replay, refresh, onChecking = () => {}, onResolved = () => {},
  onUncertain, onRejected, onSettled = () => {}, timeoutMs = 10_000,
}) {
  // Timeout後も進行中のCallableを記憶し、近接する復帰で重ねて送らない。
  const replayFlights = new WeakMap();
  return function recoverPendingActions() {
    if (state.actionRecoveryFlight) return state.actionRecoveryFlight;
    if (!state.makeRequest && !state.judgeRequest) return Promise.resolve();
    const roomId = state.roomId;
    const flight = (async () => {
      let resolved = false;
      for (const kind of ['make', 'judge']) {
        const key = `${kind}Request`;
        const request = state[key];
        if (!request || request.roomId !== roomId) continue;
        onChecking();
        try {
          if (!(kind === 'make' && state.room?.publicOffer?.actionId === request.actionId)) {
            let entry = replayFlights.get(request);
            if (!entry) { entry = { attempts: 0, flight: null, settled: false }; replayFlights.set(request, entry); }
            if (!entry.flight) {
              if (entry.attempts >= 2) { onUncertain(kind, new Error('action-replay-limit')); continue; }
              entry.attempts += 1;
              entry.settled = false;
              entry.flight = Promise.resolve().then(() => replay(kind, request));
              entry.flight.then(() => { entry.settled = true; }, () => { entry.settled = true; });
            }
            await boundedResult(entry.flight, timeoutMs);
          }
          if (state.roomId !== roomId || state[key] !== request) continue;
          state[key] = null;
          state[`${kind}Busy`] = false;
          onResolved(kind, request);
          resolved = true;
        } catch (error) {
          if (state.roomId !== roomId || state[key] !== request) continue;
          const entry = replayFlights.get(request);
          if (entry?.settled) entry.flight = null;
          state[`${kind}Busy`] = false;
          if (definitiveMultiActionRejection(error)) {
            state[key] = null;
            onRejected(kind, error);
          } else onUncertain(kind, error);
        }
      }
      if (resolved && state.roomId === roomId) {
        try { await refresh(); }
        catch (error) { onUncertain('refresh', error); }
      }
    })();
    const managed = flight.finally(() => {
      if (state.actionRecoveryFlight === managed) {
        state.actionRecoveryFlight = null;
        onSettled();
      }
    });
    state.actionRecoveryFlight = managed;
    return managed;
  };
}

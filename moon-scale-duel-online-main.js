import { ensureAnonymousUser } from './moon-scale-duel-online-firebase.js';
import { api } from './moon-scale-duel-online-api.js';
import { beginPresence } from './moon-scale-duel-online-presence.js';
import { state, requestIdFor, finishRequest } from './moon-scale-duel-online-state.js';
import { el, show, status, lobby, started } from './moon-scale-duel-online-ui.js';

const STORAGE_KEY = 'moonScaleDuelOnlineRoomId';
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let rematchRequestInFlight = null;
function message(error) { return error?.message?.replace(/^FirebaseError:\s*/, '') || '処理に失敗しました。'; }

async function refresh() {
  if (!state.roomId) return;
  const snapshot = await api.snapshot({ roomId: state.roomId });
  state.snapshot = snapshot;
  if (!snapshot.private?.availableCards?.includes(state.selectedCardId)) state.selectedCardId = null;
  if (!snapshot.private?.legalCopyTargets?.includes(state.selectedCopyTarget)) state.selectedCopyTarget = null;
  if (snapshot.room.status === 'waiting') lobby(snapshot);
  else started(snapshot, state.selectedCardId, state.selectedCopyTarget);
  status('オンライン対戦の準備ができました。');
}

async function enterRoom(result) {
  state.roomId = result.roomId;
  localStorage.setItem(STORAGE_KEY, state.roomId);
  await beginPresence(state.roomId, state.uid);
  await refresh();
}

async function mutate(action, callback) {
  try {
    status('処理中…');
    const result = await callback(requestIdFor(action));
    finishRequest(action);
    return result;
  } catch (error) {
    status(message(error));
    throw error;
  }
}

el('create-room').onclick = async () => {
  try {
    const result = await mutate('create', (requestId) => api.createRoom({ displayName: el('display-name').value, requestId }));
    await enterRoom(result);
  } catch { /* status is already shown */ }
};
el('join-room').onclick = async () => {
  try {
    const result = await mutate('join', (requestId) => api.joinRoom({ displayName: el('display-name').value, inviteCode: el('invite-code').value, requestId }));
    await enterRoom(result);
  } catch { /* status is already shown */ }
};
el('start-match').onclick = async () => {
  try {
    await mutate('start', (requestId) => api.startGame({ roomId: state.roomId, stateVersion: state.snapshot.room.stateVersion, requestId }));
    await refresh();
  } catch { /* status is already shown */ }
};
el('online-hand').onclick = (event) => {
  const button = event.target.closest('[data-card-id]');
  if (!button || button.disabled || state.snapshot?.private?.submitted) return;
  state.selectedCardId = button.dataset.cardId;
  started(state.snapshot, state.selectedCardId, state.selectedCopyTarget);
};
el('copy-choices').onclick = (event) => {
  const button = event.target.closest('[data-card-id]');
  if (!button || button.disabled || state.snapshot?.private?.copySubmitted) return;
  state.selectedCopyTarget = button.dataset.cardId;
  started(state.snapshot, state.selectedCardId, state.selectedCopyTarget);
};
el('submit-copy').onclick = async () => {
  const snapshot = state.snapshot;
  if (!snapshot?.game || !state.selectedCopyTarget) return;
  const action = `submit-copy-${snapshot.game.gameId}-${snapshot.game.round}`;
  try {
    await mutate(action, (requestId) => api.submitCopyTarget({
      roomId: state.roomId,
      gameId: snapshot.game.gameId,
      round: snapshot.game.round,
      stateVersion: snapshot.game.stateVersion,
      copyTargetId: state.selectedCopyTarget,
      requestId,
    }));
    state.selectedCopyTarget = null;
    await refresh();
  } catch { /* status is already shown */ }
};
el('submit-card').onclick = async () => {
  const snapshot = state.snapshot;
  if (!snapshot?.game || !state.selectedCardId) return;
  const action = `submit-card-${snapshot.game.gameId}-${snapshot.game.round}`;
  try {
    await mutate(action, (requestId) => api.submitCard({
      roomId: state.roomId,
      gameId: snapshot.game.gameId,
      round: snapshot.game.round,
      stateVersion: snapshot.game.stateVersion,
      cardId: state.selectedCardId,
      requestId,
    }));
    state.selectedCardId = null;
    await refresh();
  } catch { /* status is already shown */ }
};
function currentRoundAction(actionName, apiMethod) {
  const snapshot = state.snapshot;
  if (!snapshot?.game) return Promise.resolve();
  const action = `${actionName}-${snapshot.game.gameId}-${snapshot.game.round}-${snapshot.game.stateVersion}`;
  return mutate(action, (requestId) => apiMethod({
    roomId: state.roomId,
    gameId: snapshot.game.gameId,
    round: snapshot.game.round,
    stateVersion: snapshot.game.stateVersion,
    requestId,
  })).then(refresh);
}
el('ready-next-round').onclick = async () => {
  try { await currentRoundAction('ready-next-round', api.readyNextRound); } catch { /* status is already shown */ }
};
el('extend-next-round-wait').onclick = async () => {
  try { await currentRoundAction('extend-next-round-wait', api.extendNextRoundWait); } catch { /* status is already shown */ }
};
el('abort-after-wait').onclick = async () => {
  try { await currentRoundAction('abort-after-wait', api.abortAfterWait); } catch { /* status is already shown */ }
};
el('request-rematch').onclick = async () => {
  if (rematchRequestInFlight) return rematchRequestInFlight;
  const snapshot = state.snapshot;
  if (!snapshot?.game || snapshot.game.phase !== 'ended') return;
  el('request-rematch').disabled = true;
  const action = `request-rematch-${snapshot.game.gameId}-${snapshot.game.stateVersion}`;
  rematchRequestInFlight = (async () => {
    try {
      await mutate(action, (requestId) => api.requestRematch({
        roomId: state.roomId,
        gameId: snapshot.game.gameId,
        stateVersion: snapshot.game.stateVersion,
        requestId,
      }));
      state.selectedCardId = null;
      state.selectedCopyTarget = null;
      await refresh();
    } catch { el('request-rematch').disabled = false; }
    finally { rematchRequestInFlight = null; }
  })();
  return rematchRequestInFlight;
};
async function returnToToybox(event) {
  const destination = event.currentTarget.href;
  if (rematchRequestInFlight) {
    event.preventDefault();
    await rematchRequestInFlight;
  }
  const snapshot = state.snapshot;
  const yourSeat = snapshot?.you?.seatId;
  if (!snapshot?.game || snapshot.game.phase !== 'ended' || snapshot.game.rematchReady?.[yourSeat] !== true) {
    if (event.defaultPrevented) window.location.assign(destination);
    return;
  }
  event.preventDefault();
  const action = `cancel-rematch-${snapshot.game.gameId}-${snapshot.game.stateVersion}`;
  try {
    await mutate(action, (requestId) => api.cancelRematch({
      roomId: state.roomId,
      gameId: snapshot.game.gameId,
      stateVersion: snapshot.game.stateVersion,
      requestId,
    }));
    window.location.assign(destination);
  } catch { /* cancellation must succeed before navigation */ }
}
el('top-return').addEventListener('click', returnToToybox);
el('result-return').addEventListener('click', returnToToybox);
el('copy-code').onclick = async () => {
  try {
    await navigator.clipboard.writeText(el('shown-code').textContent);
    status('招待コードをコピーしました。');
  } catch { status('招待コードをコピーできませんでした。長押ししてコピーしてください。'); }
};

(async () => {
  try {
    state.uid = (await ensureAnonymousUser()).uid;
    const savedRoomId = localStorage.getItem(STORAGE_KEY);
    if (savedRoomId) {
      state.roomId = savedRoomId;
      try {
        await beginPresence(state.roomId, state.uid);
        await refresh();
      } catch {
        state.roomId = null;
        localStorage.removeItem(STORAGE_KEY);
        show('entry');
        status('オンライン対戦を開始できます。');
      }
    } else {
      show('entry');
      status('オンライン対戦を開始できます。');
    }
    for (;;) {
      await wait(2000);
      if (state.roomId) {
        try { await refresh(); } catch (error) { status(message(error)); }
      }
    }
  } catch (error) {
    status(message(error));
  }
})();

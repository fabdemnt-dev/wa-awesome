import { ROOM_STATUS } from './multi-core.js';

export const CLOSE_REQUEST_KEY = 'mofumofuMultiCloseRequest';

export function loadCloseRequest(storage, roomId) {
  try {
    const value = JSON.parse(storage.getItem(CLOSE_REQUEST_KEY) || 'null');
    return value?.roomId === roomId && typeof value.actionId === 'string' ? value : null;
  } catch { return null; }
}
export function saveCloseRequest(storage, request) {
  storage.setItem(CLOSE_REQUEST_KEY, JSON.stringify(request));
}
export function clearCloseRequest(storage) { storage.removeItem(CLOSE_REQUEST_KEY); }

export function hostCloseView(state, uid) {
  const room = state.room;
  const host = Boolean(uid && room?.hostUid === uid && room?.playerUids?.S1 === uid);
  const waiting = room?.status === ROOM_STATUS.WAITING && !room.dealt && !room.startedAt;
  return {
    visible: host && waiting,
    label: state.closeRequest ? '閉室結果を確認' : '待機室を閉じる',
    disabled: Boolean(state.closeBusy || state.startBusy || state.connectionState !== 'connected'),
  };
}

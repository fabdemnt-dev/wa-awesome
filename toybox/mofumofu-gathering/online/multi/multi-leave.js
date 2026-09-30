import { ROOM_STATUS, PLAYER_STATUS } from './multi-core.js';

export const LEAVE_REQUEST_KEY = 'mofumofuMultiLeaveRequest';

export function loadLeaveRequest(storage, roomId) {
  try {
    const value = JSON.parse(storage.getItem(LEAVE_REQUEST_KEY) || 'null');
    return value?.roomId === roomId && typeof value.actionId === 'string' ? value : null;
  } catch { return null; }
}
export function saveLeaveRequest(storage, request) {
  storage.setItem(LEAVE_REQUEST_KEY, JSON.stringify(request));
}
export function clearLeaveRequest(storage) {
  storage.removeItem(LEAVE_REQUEST_KEY);
}

export function leaveView(state) {
  if (state.leaveRequest?.roomId === state.roomId && state.roomId) {
    return { visible: true, label: '退出結果を確認', disabled: state.leaveBusy || state.connectionState !== 'connected',
      note: '通信結果を確認できていません。同じ操作を確認できます。' };
  }
  const room = state.room;
  if (room?.status !== ROOM_STATUS.PLAYING || room.playerStatus?.[state.seatId] !== PLAYER_STATUS.ACTIVE
    || !state.roomId || !state.seatId) return { visible: false };
  const offer = room.publicOffer;
  const involved = offer?.status === 'pending'
    && (offer.fromPlayerId === state.seatId || offer.toPlayerId === state.seatId);
  return { visible: true, label: 'ゲームから退出',
    disabled: Boolean(involved || state.leaveBusy || state.connectionState !== 'connected'),
    note: involved ? 'この判定が終わるまで退出できません。' : '' };
}

export async function boundedLeaveResult(work, timeoutMs = 10_000) {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('leave-result-timeout')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

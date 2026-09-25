// 保存済みroomがTTL cleanup等で既に存在しない場合の、復帰経路のnot-foundだけを扱う。
// 別原因のエラーは握り潰さず、従来どおりエラー表示へ流す。
const ROOM_MISSING_MESSAGE = '部屋が見つかりません';

export function isSavedRoomGoneError(error) {
  if (String(error?.code || '') !== 'functions/not-found') return false;
  return String(error?.message || '').includes(ROOM_MISSING_MESSAGE);
}

export function clearSavedRoom(storage) {
  storage.removeItem('mofumofuRoomId');
  storage.removeItem('mofumofuSeatId');
}

export function createRoomGoneRecovery({ state, storage, message, resetEntryView }) {
  return function recoverFromRoomGone() {
    clearSavedRoom(storage);
    state.roomId = null;
    state.seatId = null;
    state.room = null;
    state.cards = [];
    state.presence = {};
    state.connectionId = null;
    state.playingResumeKey = null;
    state.lastSuccessfulResumeRoomId = null;
    state.lastSuccessfulResumeAt = 0;
    state.makeRequest = null;
    state.judgeRequest = null;
    state.npcRequest = null;
    state.proxyStartRequest = null;
    state.proxyActionRequest = null;
    resetEntryView();
    state.connectionState = 'connected';
    message('保存していた部屋は終了しました。接続しました。');
  };
}

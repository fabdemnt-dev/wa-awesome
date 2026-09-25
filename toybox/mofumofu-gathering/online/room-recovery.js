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

// roomが消えた理由を、保存していたroomの招待期限がまだ先かどうかで見分ける。
// hostが閉じた場合は期限前に消えるため「部屋が閉じられました。」、TTL cleanup後は従来の文言を使う。
export function roomGoneNotice(lastRoom, now = Date.now()) {
  const expiresAt = lastRoom?.joinExpiresAt;
  const millis = typeof expiresAt?.toMillis === 'function' ? expiresAt.toMillis() : Number(expiresAt) || 0;
  return millis > now ? '部屋が閉じられました。' : '保存していた部屋は終了しました。接続しました。';
}

export function createRoomGoneRecovery({ state, storage, message, resetEntryView }) {
  return function recoverFromRoomGone(notice = null) {
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
    state.closeRequest = null;
    state.closeBusy = false;
    resetEntryView();
    state.connectionState = 'connected';
    message(notice || '保存していた部屋は終了しました。接続しました。');
  };
}

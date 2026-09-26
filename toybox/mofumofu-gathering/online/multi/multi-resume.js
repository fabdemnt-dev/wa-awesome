// もふもふ大集合！ 人間3〜6人オンライン版 Phase E: 復帰（resume）の手順と、保存roomの解除。
//
// 既存2人＋こはる版の full-resume.js / connection-control.js と同じ考え方を持つが、
// 3〜6人版専用の別系統として自前で持つ（既存モジュールをimportして共有しない）。
//
// 依存は注入で受け取る純粋な手順にする（node --test から直接検証できる）。
import { clearSavedRoom, sessionFailureReason, sessionRecoveryNotice } from './multi-core.js';

// 既存版と同じ順序: 認証 → 旧connectionのretire → connectionId発行 → presence認可 → presence開始 → resume → 反映。
// 各段の間で isCurrent() を確認し、古い世代の処理結果を反映しない（連打・再接続の競合対策）。
export async function runMofumofuMultiFullResume({
  auth,
  signInAnonymously,
  isCurrent,
  retirePresence,
  createConnectionId,
  authorizePresence,
  beginPresence,
  resumeRoom,
  applyResume,
}) {
  await auth.authStateReady();
  if (!auth.currentUser) await signInAnonymously(auth);
  if (!isCurrent()) return false;

  await retirePresence();
  if (!isCurrent()) return false;

  const connectionId = createConnectionId();
  const admission = await authorizePresence(connectionId);
  if (!isCurrent()) return false;

  await beginPresence(admission.seatId, connectionId);
  if (!isCurrent()) return false;

  const value = await resumeRoom();
  if (!isCurrent()) return false;

  await applyResume(value, connectionId);
  return true;
}

// 保存room解除の対象になるsession失敗（room-not-found / not-member / room-expired / room-status）だけを扱う。
// それ以外のエラーは握り潰さず、呼び出し側の通常エラー表示へ流す。
export function multiSessionFailureReason(error) {
  return sessionFailureReason(error);
}

export function handleMultiSessionFailure({ error, storage, forgetInvite, resetEntryView, message }) {
  const reason = multiSessionFailureReason(error);
  if (!reason) return null;
  clearSavedRoom(storage);
  forgetInvite();
  resetEntryView();
  message(sessionRecoveryNotice(reason));
  return reason;
}

// 同時実行を1本にまとめる（resumeFlight）。lifecycle理由の連続発火はcooldownで吸収する。
export function createMultiResumeCoordinator({
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
    const burst = reason === 'lifecycle'
      && state.connectionState === 'connected'
      && state.lastSuccessfulResumeRoomId === roomId
      && now() - state.lastSuccessfulResumeAt < cooldownMs;
    if (burst) return Promise.resolve();

    const work = Promise.resolve().then(() => runResume(reason));
    const flight = work.then(() => {
      if (getRoomId() !== roomId) return;
      state.lastSuccessfulResumeRoomId = roomId;
      state.lastSuccessfulResumeAt = now();
    }).catch((error) => onError(error, reason)).finally(() => {
      if (state.resumeFlight === flight) state.resumeFlight = null;
    });
    state.resumeFlight = flight;
    return flight;
  };
}

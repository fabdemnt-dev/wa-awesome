import runtime from './connection-runtime.js';
import { createConnectionCheck } from './connection.js';

// Local assets only on load. The first SDK request is inside the Start handler.
const start = document.getElementById('connection-start');
const status = document.getElementById('connection-status');
const uid = document.getElementById('connection-uid');
const expiry = document.getElementById('connection-expiry');
const diagnostic = document.getElementById('connection-diagnostic');
function render(state) {
  status.textContent = state.label;
  const http = state.diagnosticHttpStatus === null ? '不明' : state.diagnosticHttpStatus;
  const seconds = state.diagnosticWaitSeconds;
  const wait = seconds === null ? '不明' : seconds >= 3600 && seconds % 3600 === 0 ? `約${seconds / 3600}時間` :
    seconds >= 60 && seconds % 60 === 0 ? `約${seconds / 60}分` : `約${seconds}秒`;
  diagnostic.textContent = state.diagnosticStage === null ? 'なし' :
    `${state.diagnosticStage} / ${state.diagnosticCode} / HTTP ${http} / SDK待機目安 ${wait}（自動再試行なし）`;
  uid.textContent = state.uid ?? '未確認';
  expiry.textContent = state.expiresAtMillis === null ? '開始時に確認します' :
    new Intl.DateTimeFormat('ja-JP', { dateStyle: 'long', timeStyle: 'long', timeZone: 'Asia/Tokyo' }).format(state.expiresAtMillis);
  start.disabled = !state.canStart;
}
const connection = createConnectionCheck(runtime, { onState: render });
render(connection.getState());
start.addEventListener('click', () => { start.disabled = true; void connection.start(); });
window.addEventListener('pagehide', () => connection.stop());
// A BFCache return remains terminal. Resuming never silently starts another check.
window.addEventListener('pageshow', () => connection.checkAccess());
document.addEventListener('visibilitychange', () => connection.checkAccess());

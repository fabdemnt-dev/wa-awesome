// 開発用一時診断ログ。URLに ?diag=1 を付けたときだけ画面へ表示する。
// UID・ルームIDはそのまま表示せず、識別に必要な末尾だけを残す。
const enabled = new URLSearchParams(location.search).get('diag') === '1';
const entries = [];

function mask(value, visible = 6) {
  const text = String(value ?? '');
  if (!text) return '';
  if (text.length <= visible) return text;
  return `…${text.slice(-visible)}`;
}

function safeDetails(details) {
  if (!details || typeof details !== 'object') return details;
  return Object.fromEntries(Object.entries(details).map(([key, value]) => {
    if (/uid|roomid|roomId|token|auth/i.test(key)) return [key, mask(value)];
    if (Array.isArray(value)) return [key, value.length > 20 ? `[${value.length} items]` : value];
    return [key, value];
  }));
}

function render() {
  if (!enabled) return;
  const panel = document.getElementById('diagnostic-log-panel');
  const body = document.getElementById('diagnostic-log-body');
  if (!panel || !body) return;
  panel.hidden = false;
  body.textContent = entries.map((entry) => `${entry.time} ${entry.event} ${JSON.stringify(entry.details ?? {})}`).join('\n');
  body.scrollTop = body.scrollHeight;
}

export function diagLog(event, details = {}) {
  const entry = { time: new Date().toLocaleTimeString('ja-JP', { hour12: false }), event, details: safeDetails(details) };
  if (!enabled) return;
  console.debug(`[diag] ${event}`, entry.details);
  entries.push(entry);
  if (entries.length > 120) entries.shift();
  render();
}

export function diagState(state, source = 'state') {
  if (!state) return;
  diagLog(source, {
    roomId: state.roomId,
    myUid: state.myUid,
    myName: state.myName,
    isSpectator: state.isSpectator,
    status: state.currentData?.status,
    schemaVersion: state.currentData?.schemaVersion,
    currentHost: state.currentData?.currentHost,
    currentHostUid: state.currentData?.currentHostUid,
    players: state.currentData?.players,
    spectators: state.currentData?.spectators,
    participantUidCount: Object.keys(state.currentData?.participantUids || {}).length,
    words5Count: Array.isArray(state.currentData?.words5) ? state.currentData.words5.length : 0,
    words7Count: Array.isArray(state.currentData?.words7) ? state.currentData.words7.length : 0,
  });
}

if (enabled) {
  window.addEventListener('DOMContentLoaded', () => {
    const panel = document.createElement('details');
    panel.id = 'diagnostic-log-panel';
    panel.hidden = false;
    panel.style.cssText = 'position:fixed;z-index:9999;left:8px;right:8px;bottom:8px;background:#111827;color:#e5e7eb;border:2px solid #f59e0b;border-radius:10px;padding:8px;font:11px/1.4 monospace;box-shadow:0 4px 20px #0008;';
    panel.innerHTML = '<summary style="cursor:pointer;font:700 13px sans-serif;">診断ログ（UIDは末尾のみ）</summary><pre id="diagnostic-log-body" style="max-height:190px;overflow:auto;white-space:pre-wrap;margin:8px 0 0;"></pre><button type="button" id="diagnostic-log-copy" style="font:12px sans-serif;padding:5px 8px;">ログをコピー</button>';
    document.body.appendChild(panel);
    document.getElementById('diagnostic-log-copy')?.addEventListener('click', async () => {
      const text = entries.map((entry) => `${entry.time} ${entry.event} ${JSON.stringify(entry.details ?? {})}`).join('\n');
      await navigator.clipboard?.writeText(text);
      document.getElementById('diagnostic-log-copy').textContent = 'コピーしました';
    });
    render();
    diagLog('diagnostic-enabled', { path: location.pathname });
  });
}

window.diagLog = diagLog;
window.diagState = diagState;

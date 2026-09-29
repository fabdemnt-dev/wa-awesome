// Stagingだけの表示用。観測値は固定ラベル・試行番号・時間に限定する。
const labels = Object.freeze({
  auth: 'Auth', retire: '旧接続解除', cancel: 'onDisconnect.cancel',
  oldUpdate: '旧presence update', authorize: 'presence認可',
  presence: '新presence登録', disconnectSet: '新onDisconnect.set',
  onlineSet: '新presence online set', room: 'room resume Callable',
  apply: 'applyResume', listeners: 'listener / safety sync',
  connected: 'connected', recovery: '保留操作の結果確認',
});

export function createMultiResumeDiagnostic({ enabled, document, now = Date.now,
  schedule = setInterval, cancel = clearInterval }) {
  if (!enabled) return { start() {}, observe() {}, fail() {}, snapshot: () => null };

  const panel = document.createElement('aside');
  panel.id = 'resume-diagnostic';
  panel.setAttribute('aria-label', '復帰診断');
  panel.style.cssText = 'position:fixed;right:8px;bottom:calc(8px + env(safe-area-inset-bottom));z-index:30;max-width:min(88vw,300px);padding:7px 9px;border-radius:9px;background:rgba(25,35,50,.90);color:#fff;font:12px/1.45 system-ui,sans-serif;white-space:pre-line;pointer-events:none;box-shadow:0 2px 8px #0005;';
  document.body.append(panel);

  let attempt = 0;
  let startedAt = 0;
  let waitingAt = 0;
  let completed = null;
  let completedKind = null;
  let waiting = null;
  let failed = null;
  let connectedReached = false;
  let timer = null;
  const elapsed = (time) => Math.max(0, Math.floor((now() - time) / 1000));
  const snapshot = () => ({ attempt, completed, completedKind, waiting, failed, connectedReached,
    elapsedSeconds: attempt ? elapsed(startedAt) : 0,
    waitingSeconds: waiting ? elapsed(waitingAt) : 0 });
  function render() {
    if (!attempt) { panel.textContent = '復帰診断：試行待ち'; return; }
    const lines = [`復帰診断 R${attempt}・開始から${elapsed(startedAt)}秒`];
    if (completed) lines.push(completedKind === 'skip'
      ? `－ ${labels[completed]}（対象なし）` : `✓ ${labels[completed]}`);
    if (connectedReached && completed !== 'connected') lines.push('✓ connected');
    if (waiting) lines.push(`… ${labels[waiting]}（待機中 ${elapsed(waitingAt)}秒）`);
    if (failed) lines.push(`× ${labels[failed]}（失敗）`);
    panel.textContent = lines.join('\n');
  }
  function stopTimer() { if (timer !== null) cancel(timer); timer = null; }
  function start() {
    stopTimer();
    attempt += 1;
    startedAt = now();
    waitingAt = startedAt;
    completed = failed = null;
    completedKind = null;
    connectedReached = false;
    waiting = 'auth';
    timer = schedule(render, 1000);
    render();
  }
  function observe(kind, stage) {
    if (!attempt || !Object.hasOwn(labels, stage)) return;
    if (kind === 'wait') { waiting = stage; waitingAt = now(); if (timer === null) timer = schedule(render, 1000); }
    else if (kind === 'done' || kind === 'skip') {
      completed = stage; completedKind = kind; waiting = null;
      if (stage === 'connected') connectedReached = true;
      if (stage === 'connected' || stage === 'recovery') stopTimer();
    }
    else if (kind === 'error') { failed = stage; waiting = null; }
    else return;
    render();
  }
  function fail() {
    if (!attempt) return;
    failed = waiting || failed || 'room';
    waiting = null;
    stopTimer();
    render();
  }
  render();
  return { start, observe, fail, snapshot };
}

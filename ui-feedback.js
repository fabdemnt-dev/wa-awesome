let toastTimer = null;

function ensureToast() {
  let toast = document.getElementById('game-toast');
  if (toast) return toast;
  toast = document.createElement('div');
  toast.id = 'game-toast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.style.cssText = [
    'position:fixed', 'left:50%', 'bottom:24px', 'transform:translate(-50%, 12px)',
    'z-index:100000', 'max-width:min(92vw, 520px)', 'padding:12px 16px',
    'border-radius:12px', 'box-shadow:0 10px 30px rgba(15,23,42,.22)',
    'font-size:14px', 'font-weight:700', 'line-height:1.45', 'opacity:0',
    'pointer-events:none', 'transition:opacity 160ms ease, transform 160ms ease',
    'text-align:center'
  ].join(';');
  document.body.appendChild(toast);
  return toast;
}

export function showGameNotice(message, type = 'success') {
  const toast = ensureToast();
  toast.textContent = message;
  toast.style.background = type === 'error' ? '#991b1b' : '#166534';
  toast.style.color = '#fff';
  toast.style.opacity = '1';
  toast.style.transform = 'translate(-50%, 0)';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translate(-50%, 12px)';
  }, 3200);
}

export function setButtonBusy(button, busy, busyText = '処理中…') {
  if (!button) return;
  if (busy) {
    if (!button.dataset.originalText) button.dataset.originalText = button.innerText;
    button.disabled = true;
    button.innerText = busyText;
    button.setAttribute('aria-busy', 'true');
    button.style.opacity = '0.65';
  } else {
    button.disabled = false;
    if (button.dataset.originalText) button.innerText = button.dataset.originalText;
    button.removeAttribute('aria-busy');
    button.style.opacity = '';
  }
}

export async function withButtonBusy(button, task, busyText = '処理中…') {
  setButtonBusy(button, true, busyText);
  try {
    return await task();
  } finally {
    setButtonBusy(button, false);
  }
}

export function installButtonFeedback() {
  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('button');
    if (!button || button.disabled || button.dataset.noBusyFeedback === 'true') return;
    if (button.dataset.busyFeedbackTimer) clearTimeout(Number(button.dataset.busyFeedbackTimer));
    setButtonBusy(button, true);
    const timer = setTimeout(() => {
      setButtonBusy(button, false);
      delete button.dataset.busyFeedbackTimer;
    }, 1400);
    button.dataset.busyFeedbackTimer = String(timer);
  }, true);
}

installButtonFeedback();

// 既存のalert呼び出しを画面内通知へ移行し、ゲーム中の操作を遮らないようにする。
window.alert = (message) => {
  const text = String(message ?? '');
  const isError = /失敗|エラー|できません|不足|権限がありません/.test(text);
  showGameNotice(text, isError ? 'error' : 'success');
};

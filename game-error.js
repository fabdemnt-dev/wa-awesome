import { showGameNotice } from './ui-feedback.js';

function messageForError(error, action) {
  const code = error?.code || '';
  if (code.includes('permission-denied')) {
    return `${action}に失敗しました。権限がありません。ページを再読み込みして、もう一度お試しください。`;
  }
  if (code.includes('unavailable') || code.includes('deadline-exceeded')) {
    return `${action}に失敗しました。通信が一時的に不安定です。接続を確認して、もう一度お試しください。`;
  }
  return `${action}に失敗しました。通信状態を確認して、もう一度お試しください。`;
}

export function showGameError(error, action = '操作') {
  console.error(`[${action}]`, error);
  showGameNotice(messageForError(error, action), 'error');
}

// DOMのonclickから呼ばれるasync関数など、個別にcatchできない失敗も画面に通知する。
let installed = false;
export function installGameErrorHandling() {
  if (installed) return;
  installed = true;
  window.addEventListener('unhandledrejection', (event) => {
    event.preventDefault();
    showGameError(event.reason, 'ゲーム操作');
  });
}

export { messageForError };

installGameErrorHandling();

// Phase 10で本番確認が完了した後にだけtrueへ変更する公開フラグ。
const ONLINE_PUBLIC_ENABLED = false;
const entry = document.getElementById('onlineEntry');
if (ONLINE_PUBLIC_ENABLED && entry) entry.hidden = false;

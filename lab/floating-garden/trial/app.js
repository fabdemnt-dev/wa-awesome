import runtime from './trialruntime.js';
import { bootstrapTrial } from './bootstrap.js';
import { escape } from '../online/view.js?v=20261002-online-1';

const root = document.querySelector('#online-app');
if (root) {
  try { await bootstrapTrial(root, document.querySelector('#trial-status'), runtime); }
  catch (error) {
    root.innerHTML = `<section class="panel"><h2>試験用の接続を開始できません</h2><p>${escape(error.message)}</p><p>専用環境の承認済み設定と、指定されたプレビューURL・試験期間を確認してください。このソースの初期設定では接続は無効です。</p></section>`;
  }
}

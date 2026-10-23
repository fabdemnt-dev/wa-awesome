import { parseEntryMode } from '../online/entry-mode.js';
import { modeLabel } from '../online/modes.js?v=20261023-shared-objectives-1';
import runtime from './trialruntime.js';
import { bootstrapTrial } from './bootstrap.js?v=20261023-shared-objectives-1';
import { escape } from '../online/view.js?v=20261023-shared-objectives-1';

const root = document.querySelector('#online-app');
if (root) {
  try {
    const mode = parseEntryMode(globalThis.location.hash);
    const selection = document.querySelector('#entry-selection');
    if (selection) selection.textContent = mode ? `選択した構成：${modeLabel(mode.humanSeatCount, mode.npcCount)}。招待参加では相手の部屋の人数が使われます。` : '入口の人数指定はありません。接続が有効な場合に部屋作成画面で選択します。';
    await bootstrapTrial(root, document.querySelector('#trial-status'), runtime); }
  catch (error) {
    root.innerHTML = `<section class="panel"><h2>庭園への接続を開始できません</h2><p>${escape(error.message)}</p><p>この限定試験の接続設定または配信元を確認できません。URLの追加設定は使えません。保存情報を消さず、試験担当者の確認を待ってください。</p></section>`;
  }
}

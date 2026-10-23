import { parseEntryMode } from '../online/entry-mode.js';
import { modeLabel } from '../online/modes.js?v=20261022-human4-1';
import runtime from './trialruntime.js';
import { bootstrapTrial } from './bootstrap.js';
import { escape } from '../online/view.js?v=20261022-human4-1';

const root = document.querySelector('#online-app');
if (root) {
  try {
    const mode = parseEntryMode(globalThis.location.hash);
    const selection = document.querySelector('#entry-selection');
    if (selection) selection.textContent = mode ? `選択した構成：${modeLabel(mode.humanSeatCount, mode.npcCount)}。招待参加では相手の部屋の人数が使われます。` : '入口の人数指定はありません。接続が有効な場合に部屋作成画面で選択します。';
    await bootstrapTrial(root, document.querySelector('#trial-status'), runtime); }
  catch (error) {
    root.innerHTML = `<section class="panel"><h2>庭園への接続を開始できません</h2><p>${escape(error.message)}</p><p>現在は接続を停止しています。このGitHub Pages版はオンライン接続の準備中です。接続設定の確認が終わるまでは、上のリンクから現在のオンライン版をご利用ください。</p></section>`;
  }
}

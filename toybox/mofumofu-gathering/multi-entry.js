// もふもふ大集合！ 3〜6人オンライン版 Phase E: ゲームページの「モード選択」入口。
//
// 既存のオンライン導線は変えない:
//   - ゲームページの `#onlineEntry`（href="./online/"）と `online-entry.js` の ONLINE_PUBLIC_ENABLED=true はそのまま。
//   - JS無効時・修飾クリック・中クリックは href="./online/" へ素通しする（従来どおり2人＋こはる版へ入れる）。
// このスクリプトは、通常クリックのときだけモード選択ダイアログを開く追加レイヤー。
import { onlineModeOptions } from './online/multi/multi-core.js?v=20260926-1';

const entry = document.getElementById('onlineEntry');
const dialog = document.getElementById('onlineModeDialog');
const options = document.getElementById('onlineModeOptions');

if (entry && dialog && options) {
  // ゲームページのCSSへ手を入れずに、既存デザインの変数だけを使ってモード選択を描く。
  const style = document.createElement('style');
  style.textContent = `
.mode-options{display:grid;gap:10px;margin:12px 0}
.mode-option{display:flex;flex-direction:column;gap:2px;padding:12px 14px;border-radius:18px;background:#fff;border:2px solid #eadbd2;text-decoration:none;color:inherit;box-shadow:0 4px 10px rgba(80,55,40,.1)}
.mode-option strong{font-weight:900}
.mode-option .mode-desc{font-size:12.5px;font-weight:800;color:#796963}
.mode-option.disabled{opacity:.5;filter:grayscale(.4)}
`;
  document.head.append(style);

  const render = () => {
    options.replaceChildren(...onlineModeOptions().map((mode) => {
      const node = document.createElement(mode.enabled ? 'a' : 'span');
      node.className = `mode-option${mode.enabled ? '' : ' disabled'}`;
      if (mode.enabled) node.href = mode.href;
      else node.setAttribute('aria-disabled', 'true');
      const label = document.createElement('strong');
      label.textContent = mode.label;
      const description = document.createElement('span');
      description.className = 'mode-desc';
      description.textContent = mode.description;
      node.append(label, description);
      if (mode.enabled) node.addEventListener('click', () => dialog.close());
      return node;
    }));
  };

  entry.addEventListener('click', (event) => {
    // 新しいタブ・別ウィンドウで開く操作は邪魔しない。
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    render();
    dialog.showModal();
  });
  document.getElementById('closeModeDialog')?.addEventListener('click', () => dialog.close());
}

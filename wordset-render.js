import state from './wordset-state.js';
import { escapeHTML, splitWords, iconForId, getIconById, bgForId } from './wordset-utils.js';

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.innerText = text;
}
function setInputValue(id, val) {
  const el = document.getElementById(id);
  if (el && el.value !== val) el.value = val;
}
function previewLine(words, limit = 6) {
  if (!words || words.length === 0) return '（ことば未設定）';
  const shown = words.slice(0, limit).join(' / ');
  return words.length > limit ? shown + ' …' : shown;
}
// 保存されているアイコンを表示用に解決する。
// s.iconが絵文字そのものならそれを使い、過去のボタン選択式のID（'heart'等）ならそちらと互換をとる。
function resolveIcon(s) {
  if (s.icon) {
    const legacy = getIconById(s.icon); // 昔のボタン選択式で保存されたIDだった場合
    if (legacy) return legacy;
    return { emoji: s.icon, bg: bgForId(s.id) };
  }
  return iconForId(s.id);
}

function renderTabs() {
  const poemTab = document.getElementById('tab-poem');
  const haikuTab = document.getElementById('tab-haiku');
  if (poemTab) poemTab.classList.toggle('active', state.mode === 'poem');
  if (haikuTab) haikuTab.classList.toggle('active', state.mode === 'haiku');

  const poemPanel = document.getElementById('panel-poem');
  const haikuPanel = document.getElementById('panel-haiku');
  if (poemPanel) poemPanel.style.display = state.mode === 'poem' ? 'block' : 'none';
  if (haikuPanel) haikuPanel.style.display = state.mode === 'haiku' ? 'block' : 'none';
}

function renderPoemForm() {
  const f = state.forms.poem;
  setInputValue('poem-set-name', f.name);
  setInputValue('poem-words-input', f.words);
  setInputValue('poem-creator-name', f.creatorName);
  setInputValue('poem-password', f.password);
  const cb = document.getElementById('poem-has-password');
  if (cb && cb.checked !== !!f.hasPassword) cb.checked = !!f.hasPassword;
  const pwBox = document.getElementById('poem-password-box');
  if (pwBox) pwBox.style.display = f.hasPassword ? 'block' : 'none';
  setInputValue('poem-icon-input', f.icon);

  setText('poem-name-counter', `${f.name.length}/20`);
  setText('poem-words-counter', `${f.words.length}/1000`);

  const words = splitWords(f.words);
  setText('poem-preview-count', words.length);
  const chipEl = document.getElementById('poem-preview-chips');
  if (chipEl) {
    chipEl.innerHTML = words.length
      ? words.map((w, i) => `<span class="chip">${escapeHTML(w)}<button type="button" class="chip-remove" onclick="removeWordSetWord('words', ${i})" title="このことばを消す">×</button></span>`).join('')
      : '<span class="chip-empty">まだことばがありません</span>';
  }
  setText('poem-save-label', state.editingId.poem ? '✨ 更新を保存する' : '✨ このセットを保存する');
}

function renderHaikuForm() {
  const f = state.forms.haiku;
  setInputValue('haiku-set-name', f.name);
  setInputValue('haiku-words5-input', f.words5);
  setInputValue('haiku-words7-input', f.words7);
  setInputValue('haiku-creator-name', f.creatorName);
  setInputValue('haiku-password', f.password);
  const cb = document.getElementById('haiku-has-password');
  if (cb && cb.checked !== !!f.hasPassword) cb.checked = !!f.hasPassword;
  const pwBox = document.getElementById('haiku-password-box');
  if (pwBox) pwBox.style.display = f.hasPassword ? 'block' : 'none';
  setInputValue('haiku-icon-input', f.icon);

  setText('haiku-name-counter', `${f.name.length}/20`);
  setText('haiku-words5-counter', `${f.words5.length}/1000`);
  setText('haiku-words7-counter', `${f.words7.length}/1000`);

  const w5 = splitWords(f.words5);
  const w7 = splitWords(f.words7);
  setText('haiku-words5-pill', `${w5.length}こ のことば`);
  setText('haiku-words7-pill', `${w7.length}こ のことば`);
  setText('haiku5-preview-count', w5.length);
  setText('haiku7-preview-count', w7.length);

  const c5 = document.getElementById('haiku5-preview-chips');
  if (c5) {
    c5.innerHTML = w5.length
      ? w5.map((w, i) => `<span class="chip chip-5">${escapeHTML(w)}<button type="button" class="chip-remove" onclick="removeWordSetWord('words5', ${i})" title="このことばを消す">×</button></span>`).join('')
      : '<span class="chip-empty">まだことばがありません</span>';
  }
  const c7 = document.getElementById('haiku7-preview-chips');
  if (c7) {
    c7.innerHTML = w7.length
      ? w7.map((w, i) => `<span class="chip chip-7">${escapeHTML(w)}<button type="button" class="chip-remove" onclick="removeWordSetWord('words7', ${i})" title="このことばを消す">×</button></span>`).join('')
      : '<span class="chip-empty">まだことばがありません</span>';
  }
  setText('haiku-save-label', state.editingId.haiku ? '✨ 更新を保存する' : '✨ このセットを保存する');
}

function sortByNewest(list) {
  return [...list].sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
}

function creatorsLabel(s) {
  const creators = (s.creators && s.creators.length) ? s.creators : (s.creatorName ? [s.creatorName] : []);
  return creators.length ? creators.join('、') : '不明';
}

function renderPoemList() {
  const el = document.getElementById('poem-set-list');
  if (!el) return;
  const list = sortByNewest(state.sets.poem);
  el.innerHTML = list.length ? list.map(s => {
    const icon = resolveIcon(s);
    const words = s.words || [];
    const isOpen = state.expandedId.poem === s.id;
    return `
      <div class="set-item-wrap">
        <div class="set-item" style="${isOpen ? 'border-radius:10px 10px 0 0;' : ''}">
          <div class="set-icon" style="background:${icon.bg};">${icon.emoji}</div>
          <div class="set-info">
            <div class="set-name-row">
              <span class="set-name">${s.hasPassword ? '🔒 ' : ''}${escapeHTML(s.name)}</span>
              <span class="count-badge">${words.length}こ</span>
            </div>
            <div class="set-creator">作: ${escapeHTML(creatorsLabel(s))}</div>
            <div class="set-preview">${escapeHTML(previewLine(words))}</div>
          </div>
          <div class="set-actions">
            <button class="btn-view" onclick="toggleWordSetDetail('${s.id}')">${isOpen ? '📖 閉じる' : '📖 のぞく'}</button>
            <button class="btn-edit" onclick="editWordSet('${s.id}')">✏️ 編集</button>
            <button class="btn-delete" onclick="deleteWordSet('${s.id}')">🗑 削除</button>
          </div>
        </div>
        ${isOpen ? `
          <div class="set-detail">
            <div class="chip-list">
              ${words.length ? words.map(w => `<span class="chip">${escapeHTML(w)}</span>`).join('') : '<span class="chip-empty">ことばがありません</span>'}
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }).join('') : '<p class="empty-hint">まだワードセットがありません</p>';
}

function renderHaikuList() {
  const el = document.getElementById('haiku-set-list');
  if (!el) return;
  const list = sortByNewest(state.sets.haiku);
  el.innerHTML = list.length ? list.map(s => {
    const icon = resolveIcon(s);
    const words5 = s.words5 || [], words7 = s.words7 || [];
    const isOpen = state.expandedId.haiku === s.id;
    return `
      <div class="set-item-wrap">
        <div class="set-item" style="${isOpen ? 'border-radius:10px 10px 0 0;' : ''}">
          <div class="set-icon" style="background:${icon.bg};">${icon.emoji}</div>
          <div class="set-info">
            <div class="set-name-row">
              <span class="set-name">${s.hasPassword ? '🔒 ' : ''}${escapeHTML(s.name)}</span>
              <span class="count-badge count-badge-5">五音 ${words5.length}こ</span>
              <span class="count-badge count-badge-7">七音 ${words7.length}こ</span>
            </div>
            <div class="set-creator">作: ${escapeHTML(creatorsLabel(s))}</div>
            <div class="set-preview">${escapeHTML(previewLine([...words5, ...words7]))}</div>
          </div>
          <div class="set-actions">
            <button class="btn-view" onclick="toggleWordSetDetail('${s.id}')">${isOpen ? '📖 閉じる' : '📖 のぞく'}</button>
            <button class="btn-edit" onclick="editWordSet('${s.id}')">✏️ 編集</button>
            <button class="btn-delete" onclick="deleteWordSet('${s.id}')">🗑 削除</button>
          </div>
        </div>
        ${isOpen ? `
          <div class="set-detail">
            <div class="preview-box-title">五音のことば（${words5.length}こ）</div>
            <div class="chip-list">
              ${words5.length ? words5.map(w => `<span class="chip chip-5">${escapeHTML(w)}</span>`).join('') : '<span class="chip-empty">ことばがありません</span>'}
            </div>
            <div class="preview-box-title" style="margin-top:10px;">七音のことば（${words7.length}こ）</div>
            <div class="chip-list">
              ${words7.length ? words7.map(w => `<span class="chip chip-7">${escapeHTML(w)}</span>`).join('') : '<span class="chip-empty">ことばがありません</span>'}
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }).join('') : '<p class="empty-hint">まだワードセットがありません</p>';
}

export function renderAll() {
  renderTabs();
  renderPoemForm();
  renderHaikuForm();
  renderPoemList();
  renderHaikuList();
}

import state from './poem-state.js';
import { speakPoem } from './poem-audio.js';
import { getParticipantStorageKey, getParticipantNameByUid } from './participant-utils.js';

export function escapeHTML(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[&'`"<>]/g, function(match) {
    return { '&': '&amp;', "'": '&#x27;', '`': '&#x60;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[match];
  });
}

export function escapeJS(str) {
  if (typeof str !== 'string') return '';
  const jsEscaped = str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
  return escapeHTML(jsEscaped);
}

export function renderInputFields(count, SAMPLE_PHRASES) {
  const container = document.getElementById('word-inputs');
  if (!container) return;

  if (state.isSpectator) {
    container.innerHTML = '<div style="font-size:13px; color:#94a3b8; padding:8px 0;">※見学モードのため素材入力はありません</div>';
    return;
  }

  if (container.children.length !== count) {
    const previousValues = [...container.querySelectorAll('input')].map(input => input.value);
    container.innerHTML = '';
    const shuffledSamples = [...SAMPLE_PHRASES].sort(() => Math.random() - 0.5);

    for (let i = 1; i <= count; i++) {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'poem-input';
      inp.placeholder = `例: ${shuffledSamples[(i - 1) % shuffledSamples.length]}`;
      inp.style.marginBottom = '6px';
      inp.style.display = 'block';
      inp.style.width = '100%';
      inp.style.padding = '8px';
      inp.value = previousValues[i - 1] || '';
      inp.style.boxSizing = 'border-box';
      container.appendChild(inp);
    }
  }
}

export function renderHand() {
  const handList = document.getElementById('hand-list');
  const textarea = document.getElementById('poem-input-area');
  if (!handList || !state.currentData) return;

  const composer = document.getElementById('poem-composer');
  const notice = document.getElementById('poem-spectator-notice');
  if (composer) composer.hidden = state.isSpectator;
  if (notice) notice.hidden = !state.isSpectator;
  const storageKey = getParticipantStorageKey(state.currentData, state.myUid, state.myName);
  const submitted = state.currentData.poems?.[storageKey] !== undefined;
  if (textarea) {
    textarea.disabled = state.isSpectator || submitted;
    textarea.placeholder = submitted ? 'この回のポエムは投稿済みです' : '手札を元に自由にポエムを入力してね♪';
  }
  for (const id of ['poem-clear-btn', 'poem-submit-btn']) {
    const button = document.getElementById(id);
    if (button) button.disabled = state.isSpectator || submitted;
  }

  if (state.isSpectator) {
    handList.innerHTML = '<div style="font-size:13px; color:#94a3b8;">※見学モード中</div>';
    return;
  }

  const myHands = state.currentData.hands?.[storageKey] || [];
  
  if (myHands.length === 0) {
    handList.innerHTML = '<div style="font-size:13px; color:#94a3b8;">手札がありません</div>';
    return;
  }

  handList.innerHTML = myHands.map((item, idx) => {
    const isSelected = state.selectedHandIndices.has(idx);
    const selectedClass = isSelected ? 'selected' : '';

    return `
      <div class="card ${selectedClass}" onclick="onCardClick(${idx})">
        ${escapeHTML(item.text)} ${isSelected ? '✓' : ''}
      </div>
    `;
  }).join('');
}

export function renderBoards() {
  const boardList = document.getElementById('board-list');
  if (!boardList || !state.currentData) return;

  const poems = state.currentData.poems || {};
  if (Object.keys(poems).length === 0) {
    boardList.innerHTML = '<div style="font-size:13px; color:#64748b;">まだ投稿された作品はありません。</div>';
    return;
  }

  function getColorFromName(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    const colors = ['#4f46e5', '#e11d48', '#059669', '#d97706', '#7c3aed', '#0284c7', '#db2777', '#ca8a04'];
    return colors[Math.abs(hash) % colors.length];
  }

  boardList.innerHTML = Object.keys(poems).sort().map(poemKey => {
    const poemData = poems[poemKey];
    const pName = getParticipantNameByUid(state.currentData, poemKey) || poemKey;
    const safePName = escapeHTML(pName);
    const jsPName = escapeJS(poemKey);

    if (typeof poemData === 'string') {
      return `
        <div class="player-board" style="margin-bottom: 20px; padding: 16px; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff;">
          <div class="poem-board-header" style="display: flex; justify-content: space-between; align-items: center;">
            <strong>${safePName} の作品</strong>
            <button class="btn-audio" onclick="speakPoem('${escapeJS(poemData)}')" style="width: auto; margin-top: 0; padding: 4px 10px; font-size: 12px;">🔊 読み上げ</button>
          </div>
          <div style="margin-top: 8px; padding: 12px; background: #f8fafc; border-left: 4px solid #4f46e5; border-radius: 4px;">
            <p style="font-size: 15px; line-height: 1.5; white-space: pre-wrap; margin: 0;">${escapeHTML(poemData)}</p>
          </div>
        </div>
      `;
    }

    const isRevealed = poemData.revealed;
    const hands = poemData.hands || [];
    const likes = Number(poemData.likes) || 0;
    const emos = Number(poemData.emos) || 0;
    const userColor = getColorFromName(pName);

    const handsHtml = hands.map(h => {
      const authorColor = getColorFromName(h.author);
      return `
        <div style="display: inline-block; background-color: ${authorColor}22; border: 1px solid ${authorColor}66; color: #1e293b; padding: 4px 8px; margin: 2px; border-radius: 4px; font-size: 13px;">
          ${escapeHTML(h.text)} <span style="font-size: 10px; color: #64748b; font-weight: bold;">(${escapeHTML(h.author)})</span>
        </div>
      `;
    }).join('');

    return `
      <div class="player-board" style="margin-bottom: 20px; padding: 16px; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff;">
        <div class="poem-board-header" style="display: flex; justify-content: space-between; align-items: center;">
          <strong>${safePName} の作品</strong>
          ${isRevealed ? `<button class="btn-audio" onclick="speakPoem('${escapeJS(poemData.text)}')" style="width: auto; margin-top: 0; padding: 4px 10px; font-size: 12px;">🔊 読み上げ</button>` : ''}
        </div>
        
        <div style="margin-top: 8px;">
          <div style="font-size: 12px; color: #64748b; margin-bottom: 4px;">📌 使用した手札（元素材の作者）:</div>
          <div>${handsHtml.length > 0 ? handsHtml : '<span style="font-size: 12px; color: #94a3b8;">なし</span>'}</div>
        </div>

        <div style="margin-top: 12px;">
          ${!isRevealed ? (state.isSpectator ? '<p>作品の披露をお待ちください</p>' : `
            <button class="btn-primary" onclick="revealPoem('${jsPName}')" style="width: 100%; padding: 12px; font-size: 15px;">
              🎁 タップして作品を開く
            </button>
          `) : `
            <div style="margin-top: 8px; padding: 12px; background: #f8fafc; border-left: 4px solid ${userColor}; border-radius: 4px;">
              <p style="font-size: 15px; line-height: 1.5; white-space: pre-wrap; margin: 0;">${escapeHTML(poemData.text)}</p>
            </div>
          `}
        </div>

        ${isRevealed ? `
          <div class="reaction-actions" style="display: flex; gap: 16px; margin-top: 12px; align-items: center;">
            <button data-no-busy-feedback="true" onclick="addReaction('${jsPName}', 'like', this)" aria-label="いいねを送る" style="background: none; border: none; color: #334155; width: auto; padding: 6px 8px; font-size: 14px; cursor: pointer;">
              👍 いいね (${likes})
            </button>
            <button data-no-busy-feedback="true" onclick="addReaction('${jsPName}', 'emo', this)" aria-label="エモいを送る" style="background: none; border: none; color: #334155; width: auto; padding: 6px 8px; font-size: 14px; cursor: pointer;">
              💖 エモい (${emos})
            </button>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

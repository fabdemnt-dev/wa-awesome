import state from './haiku-state.js';
import { escapeHTML, escapeJS, evalOptionsMaster, hostOptionKeys, childOptionKeys, spectatorOptionKeys, colorPalette } from './haiku-utils.js';

export function getAuthorStyle(authorName) {
  if (!state.currentData || !state.currentData.players) return colorPalette[0];
  const idx = state.currentData.players.indexOf(authorName);
  return idx === -1 ? colorPalette[0] : colorPalette[idx % colorPalette.length];
}

window.toggleSettings = function() {
  const c = document.getElementById('setting-content');
  const i = document.getElementById('setting-toggle-icon');
  if (c) {
    c.style.display = c.style.display === 'none' ? 'block' : 'none';
    if (i) i.innerText = c.style.display === 'none' ? '▼' : '▲';
  }
};

window.toggleEvalGuide = function() {
  const c = document.getElementById('eval-guide-content');
  const i = document.getElementById('eval-guide-toggle-icon');
  if (c) {
    c.style.display = c.style.display === 'none' ? 'block' : 'none';
    if (i) i.innerText = c.style.display === 'none' ? '▼' : '▲';
  }
};

let previousIsSpectator = null; // 見学⇔プレイヤーの切り替わりを検知して、そのときは問答無用で入力欄を作り直すため

export function renderInputFields(c5, c7) {
  const spectatorChanged = previousIsSpectator !== null && previousIsSpectator !== state.isSpectator;
  previousIsSpectator = state.isSpectator;

  ['5', '7'].forEach(type => {
    const container = document.getElementById(`inputs-${type}-container`);
    if (!container) return;
    if (state.isSpectator) {
      container.innerHTML = '<div style="font-size:13px; color:#94a3b8; padding:8px 0;">※見学モードのため素材入力はありません</div>';
      return;
    }
    const count = type === '5' ? c5 : c7;
    if (spectatorChanged || container.children.length !== count) {
      container.innerHTML = '';
      for (let i = 1; i <= count; i++) {
        const inp = document.createElement('input');
        inp.type = 'text'; inp.id = `word-${type}-input-${i}`;
        inp.placeholder = `${type === '5' ? '五' : '七'}音の素材 ${i}`;
        container.appendChild(inp);
      }
    }
  });
}

export function renderHand() {
  const h5List = document.getElementById('hand-5-list');
  if (h5List) {
    if (state.isSpectator) {
      h5List.innerHTML = '<div style="font-size:13px; color:#94a3b8;">※見学モード中</div>';
    } else {
      h5List.innerHTML = state.myHand5.map((item, idx) => `
        <div class="card card-5 ${state.selectedHand.includes(item) ? 'selected' : ''}" onclick="selectCard(5, ${idx})">${escapeHTML(item.text)}</div>
      `).join('');
    }
  }

  const h7List = document.getElementById('hand-7-list');
  if (h7List) {
    if (state.isSpectator) {
      h7List.innerHTML = '<div style="font-size:13px; color:#94a3b8;">※見学モード中</div>';
    } else {
      h7List.innerHTML = state.myHand7.map((item, idx) => `
        <div class="card card-7 ${state.selectedHand[1] === item ? 'selected' : ''}" onclick="selectCard(7, ${idx})">${escapeHTML(item.text)}</div>
      `).join('');
    }
  }

  if (document.getElementById('phrase-1')) document.getElementById('phrase-1').innerText = state.selectedHand[0]?.text || '（選択してください）';
  if (document.getElementById('phrase-2')) document.getElementById('phrase-2').innerText = state.selectedHand[1]?.text || '（選択してください）';
  if (document.getElementById('phrase-3')) document.getElementById('phrase-3').innerText = state.selectedHand[2]?.text || '（選択してください）';

  // 画面を更新するついでに、今の選択状態をブラウザに一時保存する
  sessionStorage.setItem('haikuSelectedHand', JSON.stringify(state.selectedHand));
}

export function renderBoards() {
  const boardList = document.getElementById('board-list');
  if (!boardList || !state.currentData) return;

  const phrases = state.currentData.phrases || {};
  const phraseDetails = state.currentData.phraseDetails || {};
  const votes = state.currentData.votes || {};
  const revealedPhrases = state.currentData.revealedPhrases || {};
  const selfPraiseData = state.currentData.selfPraise || {};
  const players = state.currentData.players || [];
  const currentHost = players.includes(state.currentData.currentHost) ? state.currentData.currentHost : (players[0] || '');
  const isHost = (state.myName === currentHost);
  const availableKeys = state.isSpectator ? spectatorOptionKeys : (isHost ? hostOptionKeys : childOptionKeys);

  // 子方は1節につき1つしか御印を贈れないため、誰かに投票済みなら他の句のボードでも
  // 「投票済み」の表示にする（未投票の句にだけボタンが残るのを防ぐ）
  const myVotes = votes[state.myName] || {};
  const hasVotedAnywhereAsChild = !isHost && Object.values(myVotes).some(v => v != null);

  boardList.innerHTML = players.filter(pName => phrases[pName] !== undefined).map(pName => {
    const isRevealed = revealedPhrases[pName];
    const pDet = phraseDetails[pName] || [];
    
    const safePName = escapeHTML(pName);
    const jsPName = escapeJS(pName);

    if (!isRevealed) {
      return `
        <div class="player-board" style="text-align: center; padding: 20px;">
          <button onclick="revealPhrase('${jsPName}')" style="font-size: 16px; padding: 10px 20px; background-color: #3bab46; color: white; border: none; border-radius: 8px; cursor: pointer; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
            📜 ${safePName} の句を披露する（タップ）
          </button>
        </div>
      `;
    }

    const phraseHtml = pDet.length === 3 ? pDet.map(d => {
      const s = getAuthorStyle(d.author);
      return `<span class="word-tag" style="background:${s.bg}; color:${s.text}; border-color:${s.border};">${escapeHTML(d.text)}<span class="author-label">(${escapeHTML(d.author)})</span></span>`;
    }).join(' ') : `<strong>${escapeHTML(phrases[pName])}</strong>`;

    let evalBadgesHtml = '';
    const allVoters = [...players, ...(state.currentData.spectators || [])];
    allVoters.forEach(voter => {
      const vData = votes[voter]?.[pName];
      if (vData) {
        const keys = Array.isArray(vData) ? vData : [vData];
        keys.forEach(k => {
          if (evalOptionsMaster[k]) {
            evalBadgesHtml += `<span style="font-size:12px;">${evalOptionsMaster[k].icon}</span>`;
          }
        });
      }
    });

    const hasAlreadyVotedAsChild = !isHost && (votes[state.myName]?.[pName] != null || hasVotedAnywhereAsChild);

    const isSelfPraised = selfPraiseData[pName];
    let selfPraiseHtml = '';
    if (pName === state.myName) {
      if (isSelfPraised) {
        selfPraiseHtml = `<span style="font-size:13px; background:#fef3c7; color:#d97706; padding:2px 8px; border-radius:12px; border:1px solid #f59e0b; font-weight:bold;">🪞 自画自賛 🪞</span>`;
      } else {
        selfPraiseHtml = `<button onclick="doSelfPraise()" style="font-size:11px; padding:3px 8px; background:#f59e0b; color:white; border:none; border-radius:10px; cursor:pointer;">自画自賛する</button>`;
      }
    } else if (isSelfPraised) {
      selfPraiseHtml = `<span style="font-size:13px; background:#fef3c7; color:#d97706; padding:2px 8px; border-radius:12px; border:1px solid #f59e0b; font-weight:bold;">🪞 自画自賛 🪞</span>`;
    }

    return `
      <div class="player-board">
        <div class="board-header" style="display: flex; justify-content: space-between; align-items: center;">
          <strong>${safePName} の句</strong>
          <div style="display: flex; align-items: center; gap: 6px;">
            <button onclick="speakPhrase('${escapeJS(phrases[pName])}')" style="font-size:11px; padding:3px 8px; background:#0284c7; color:white; border:none; border-radius:10px; cursor:pointer; width:auto; margin-top:0;">🔊 読み上げ</button>
            ${selfPraiseHtml}
          </div>
        </div>
        <div style="margin-top: 6px;">${phraseHtml}</div>
        <div style="margin-top:6px;">${evalBadgesHtml}</div>
        ${pName !== state.myName ? `
          <div class="vote-select-group" style="margin-top:8px;">
            ${hasAlreadyVotedAsChild ? `
              <span style="font-size:13px; color:#10b981; font-weight:bold;">✅ ${votes[state.myName]?.[pName] != null ? `御印送信済み (${evalOptionsMaster[votes[state.myName][pName]]?.label || ''})` : '御印は1節につき1つだけ（他の句に贈りました）'}</span>
            ` : state.isSpectator ? `
              <button class="vote-submit-btn" onclick="submitVote('${jsPName}', '${spectatorOptionKeys[0]}')">${evalOptionsMaster[spectatorOptionKeys[0]].label}</button>
            ` : `
              <select class="vote-select" id="vote-select-${jsPName}">
                <option value="">-- 御印を選択 --</option>
                ${availableKeys.map(k => `<option value="${k}">${evalOptionsMaster[k].label}</option>`).join('')}
              </select>
              <button class="vote-submit-btn" onclick="submitVote('${jsPName}')">御印を贈る</button>
            `}
            ${state.isSpectator ? '<div style="font-size:11px; color:#94a3b8; margin-top:4px;">👀 見学者の御印はお楽しみ用（得点には反映されません）</div>' : ''}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  // 「次の節に進む」は選者（親）だけが押せるようにする
  const nextBtn = document.getElementById('next-round-btn');
  const nextHint = document.getElementById('next-round-hint');
  if (nextBtn) {
    if (isHost) {
      nextBtn.disabled = false;
      nextBtn.style.opacity = '1';
      nextBtn.style.cursor = 'pointer';
      if (nextHint) nextHint.style.display = 'none';
    } else {
      nextBtn.disabled = true;
      nextBtn.style.opacity = '0.5';
      nextBtn.style.cursor = 'not-allowed';
      if (nextHint) nextHint.style.display = 'block';
    }
  }
}

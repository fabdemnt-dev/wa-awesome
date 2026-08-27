import state from './haiku-state.js';
import { getParticipantStorageKey, getParticipantUidByName, getCurrentHostName } from './participant-utils.js';
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
      const previousValues = [...container.querySelectorAll('input')].map(input => input.value);
      container.innerHTML = '';
      for (let i = 1; i <= count; i++) {
        const inp = document.createElement('input');
        inp.type = 'text'; inp.id = `word-${type}-input-${i}`;
        inp.placeholder = `${type === '5' ? '五' : '七'}音の素材 ${i}`;
        inp.value = previousValues[i - 1] || '';
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
      const storageKey = getParticipantStorageKey(state.currentData, state.myUid, state.myName);
      const hasRedrawn = state.currentData?.schemaVersion === 2
        ? state.redrawUsed === true
        : !!(state.currentData?.redraws || {})[storageKey];
      h5List.innerHTML = state.myHand5.map((item, idx) => `
        <div class="card card-5 ${state.selectedHand.includes(item) ? 'selected' : ''}" onclick="selectCard(5, ${idx})">
          ${escapeHTML(item.text)}
          ${hasRedrawn ? '' : `<button type="button" class="redraw-toggle-btn ${state.redrawSelected5.includes(item.id) ? 'redraw-marked' : ''}" onclick="event.stopPropagation(); toggleRedrawCard(5, ${idx})" title="引き直し対象にする">🔄</button>`}
        </div>
      `).join('');
    }
  }

  const h7List = document.getElementById('hand-7-list');
  if (h7List) {
    if (state.isSpectator) {
      h7List.innerHTML = '<div style="font-size:13px; color:#94a3b8;">※見学モード中</div>';
    } else {
      const storageKey = getParticipantStorageKey(state.currentData, state.myUid, state.myName);
      const hasRedrawn = state.currentData?.schemaVersion === 2
        ? state.redrawUsed === true
        : !!(state.currentData?.redraws || {})[storageKey];
      h7List.innerHTML = state.myHand7.map((item, idx) => `
        <div class="card card-7 ${state.selectedHand[1] === item ? 'selected' : ''}" onclick="selectCard(7, ${idx})">
          ${escapeHTML(item.text)}
          ${hasRedrawn ? '' : `<button type="button" class="redraw-toggle-btn ${state.redrawSelected7.includes(item.id) ? 'redraw-marked' : ''}" onclick="event.stopPropagation(); toggleRedrawCard(7, ${idx})" title="引き直し対象にする">🔄</button>`}
        </div>
      `).join('');
    }
  }

  if (document.getElementById('phrase-1')) document.getElementById('phrase-1').innerText = state.selectedHand[0]?.text || '（選択してください）';
  if (document.getElementById('phrase-2')) document.getElementById('phrase-2').innerText = state.selectedHand[1]?.text || '（選択してください）';
  if (document.getElementById('phrase-3')) document.getElementById('phrase-3').innerText = state.selectedHand[2]?.text || '（選択してください）';

  // 画面を更新するついでに、今の選択状態をブラウザに一時保存する
  sessionStorage.setItem('haikuSelectedHand', JSON.stringify(state.selectedHand));

  updateDeckAndRedrawUI();
}

// 山札（引き直し用に残っている素材）の残り枚数表示と、引き直しボタンの状態を更新する。
// カードの🔄をタップした直後にも即座に反映されるよう、renderHandの中から毎回呼ぶ。
function updateDeckAndRedrawUI() {
  if (!state.currentData) return;

  const deck5Count = (state.currentData.deck5 || []).length;
  const deck7Count = (state.currentData.deck7 || []).length;
  if (document.getElementById('deck-5-count')) document.getElementById('deck-5-count').innerText = deck5Count;
  if (document.getElementById('deck-7-count')) document.getElementById('deck-7-count').innerText = deck7Count;

  const redrawBtn = document.getElementById('redraw-hand-btn');
  if (!redrawBtn) return;

  const storageKey = getParticipantStorageKey(state.currentData, state.myUid, state.myName);
  const myStorageKey = getParticipantStorageKey(state.currentData, state.myUid, state.myName);
  const hasSubmitted = !!(state.currentData.phrases || {})[myStorageKey];
  const hasRedrawn = state.currentData.schemaVersion === 2
    ? state.redrawUsed === true
    : !!(state.currentData.redraws || {})[storageKey];
  const selectedCount = (state.redrawSelected5?.length || 0) + (state.redrawSelected7?.length || 0);
  const canRedraw = !state.isSpectator && !hasSubmitted && !hasRedrawn && selectedCount > 0;

  redrawBtn.disabled = !canRedraw;
  redrawBtn.style.opacity = canRedraw ? '1' : '0.5';
  redrawBtn.style.cursor = canRedraw ? 'pointer' : 'not-allowed';

  if (hasRedrawn) {
    redrawBtn.innerText = '🔄 引き直し済み';
  } else if (hasSubmitted) {
    redrawBtn.innerText = '🔄 披露後は引き直せません';
  } else if (selectedCount === 0) {
    redrawBtn.innerText = '🔄 札を選んで引き直す（1節1回まで）';
  } else {
    redrawBtn.innerText = `🔄 選んだ${selectedCount}枚を引き直す（1節1回まで）`;
  }
}

export function renderBoards() {
  const boardList = document.getElementById('board-list');
  if (!boardList || !state.currentData) return;

  // ルーム更新や5秒ごとの再同期でboardList全体を描画し直すため、
  // 入力途中の御印が消えないよう、再描画前のselect値を一時退避する。
  const selectedVoteValues = new Map(
    [...boardList.querySelectorAll('select.vote-select')].map(select => [select.id, select.value])
  );

  const phrases = state.currentData.phrases || {};
  const phraseDetails = state.currentData.phraseDetails || {};
  const votes = state.currentData.votes || {};
  const revealedPhrases = state.currentData.revealedPhrases || {};
  const selfPraiseData = state.currentData.selfPraise || {};
  const players = state.currentData.players || [];
  const currentHost = getCurrentHostName(state.currentData);
  const hostUid = String(state.currentData.currentHostUid ?? '');
  const hostNameUid = getParticipantUidByName(state.currentData, currentHost);
  const isHost = state.currentData.schemaVersion === 2
    ? Boolean(state.myUid && ((hostUid && state.myUid === hostUid) || (!hostUid && hostNameUid && state.myUid === hostNameUid)))
    : state.myName === currentHost;
  const availableKeys = state.isSpectator ? spectatorOptionKeys : (isHost ? hostOptionKeys : childOptionKeys);

  // 子方は1節につき1つしか御印を贈れないため、誰かに投票済みなら他の句のボードでも
  // 「投票済み」の表示にする（未投票の句にだけボタンが残るのを防ぐ）
  const myVoteKey = getParticipantStorageKey(state.currentData, state.myUid, state.myName);
  const myVotes = votes[myVoteKey] || {};
  const hasVotedAnywhereAsChild = !isHost && Object.values(myVotes).some(v => v != null);

  boardList.innerHTML = players.map(pName => {
    const phraseKey = getParticipantUidByName(state.currentData, pName) || pName;
    if (phrases[phraseKey] === undefined && phrases[pName] === undefined) return '';
    const actualPhraseKey = phrases[phraseKey] !== undefined ? phraseKey : pName;
    const isRevealed = revealedPhrases[actualPhraseKey] ?? revealedPhrases[pName];
    const pDet = phraseDetails[actualPhraseKey] || phraseDetails[pName] || [];
    
    const safePName = escapeHTML(pName);
    const jsPName = escapeJS(pName);
    // 表示名には記号や日本語が含まれる可能性があるため、selectのIDはURLエンコードした句キーで作る。
    // onclickに渡す表示名のエスケープ結果とDOMのIDを混同しないようにする。
    const voteSelectId = `vote-select-${encodeURIComponent(actualPhraseKey)}`;

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
    }).join(' ') : `<strong>${escapeHTML(phrases[actualPhraseKey] ?? phrases[pName])}</strong>`;

    const spectators = state.currentData.spectators || [];
    const participantUid = (name) => getParticipantUidByName(state.currentData, name);
    const playerUids = new Set(players.map(participantUid).filter(Boolean));
    const spectatorUids = new Set(spectators.map(participantUid).filter(Boolean));
    const currentHostUid = String(state.currentData.currentHostUid || '') || participantUid(currentHost);
    const roleOfVoter = (name, uid) => {
      if ((currentHostUid && uid === currentHostUid) || (!currentHostUid && name === currentHost)) return 'host';
      if ((uid && spectatorUids.has(uid)) || (!uid && spectators.includes(name))) return 'spectator';
      if ((uid && playerUids.has(uid)) || (!uid && players.includes(name))) return 'child';
      return null;
    };
    const allVoters = [...players, ...spectators];
    const voteEntries = [];
    allVoters.forEach(voter => {
      const voterUid = participantUid(voter);
      const voterKey = voterUid || voter;
      const vData = votes[voterKey]?.[actualPhraseKey] ?? votes[voterKey]?.[pName] ?? votes[voter]?.[pName];
      if (!vData) return;
      const role = roleOfVoter(voter, voterUid);
      if (!role) return;
      const keys = Array.isArray(vData) ? vData : [vData];
      keys.forEach(key => {
        if (evalOptionsMaster[key]) voteEntries.push({ key, name: voter, role });
      });
    });
    const renderVoteIcon = (key) => {
      const option = evalOptionsMaster[key];
      return `<span class="eval-vote-icon" title="${escapeHTML(option.label)}" aria-label="${escapeHTML(option.label)}">${escapeHTML(option.icon)}</span>`;
    };
    const renderNamedVote = ({ key, name }) =>
      `<span class="eval-vote-entry">${renderVoteIcon(key)}<span class="eval-vote-name">${escapeHTML(name)}</span></span>`;
    const renderVoteRow = (label, items) => items.length
      ? `<div class="eval-vote-row"><span class="eval-vote-role">${label}</span><div class="eval-vote-items">${items.join('')}</div></div>`
      : '';
    const evalSummaryHtml = voteEntries.length
      ? `<div class="eval-votes" aria-label="御印">
          <div class="eval-vote-title">御印</div>
          ${renderVoteRow('親', voteEntries.filter(entry => entry.role === 'host').map(entry => renderVoteIcon(entry.key)))}
          ${renderVoteRow('子', voteEntries.filter(entry => entry.role === 'child').map(renderNamedVote))}
          ${renderVoteRow('見学', voteEntries.filter(entry => entry.role === 'spectator').map(renderNamedVote))}
        </div>`
      : '';

    const hasAlreadyVotedAsChild = !isHost && (myVotes[actualPhraseKey] != null || myVotes[pName] != null || hasVotedAnywhereAsChild);

    const isSelfPraised = selfPraiseData[actualPhraseKey] ?? selfPraiseData[pName];
    let selfPraiseHtml = '';
    if (pName === state.myName) {
      if (isSelfPraised) {
        selfPraiseHtml = `<span class="self-praise-badge">🪞 自画自賛 🪞</span>`;
      } else {
        selfPraiseHtml = `<button class="self-praise-btn" onclick="doSelfPraise()">自画自賛する</button>`;
      }
    } else if (isSelfPraised) {
      selfPraiseHtml = `<span class="self-praise-badge">🪞 自画自賛 🪞</span>`;
    }

    return `
      <div class="player-board">
        <div class="board-header phrase-board-header" style="display: flex; justify-content: space-between; align-items: center;">
          <strong>${safePName} の句</strong>
          <div class="board-actions" style="display: flex; align-items: center; gap: 6px;">
            <button class="btn-audio" onclick="speakPhrase('${escapeJS(phrases[actualPhraseKey] ?? phrases[pName])}')">🔊 読み上げ</button>
            ${selfPraiseHtml}
          </div>
        </div>
        <div style="margin-top: 6px;">${phraseHtml}</div>
        ${evalSummaryHtml}
        ${pName !== state.myName ? `
          <div class="vote-select-group" style="margin-top:8px;">
            ${hasAlreadyVotedAsChild ? `
              <span style="font-size:13px; color:#10b981; font-weight:bold;">✅ ${(myVotes[actualPhraseKey] ?? myVotes[pName]) != null ? `御印送信済み (${evalOptionsMaster[myVotes[actualPhraseKey] ?? myVotes[pName]]?.label || ''})` : '御印は1節につき1つだけ（他の句に贈りました）'}</span>
            ` : state.isSpectator ? `
              <button class="vote-submit-btn" onclick="submitVote('${jsPName}', '${spectatorOptionKeys[0]}')">${evalOptionsMaster[spectatorOptionKeys[0]].label}</button>
            ` : `
              <select class="vote-select" id="${escapeHTML(voteSelectId)}">
                <option value="">-- 御印を選択 --</option>
                ${availableKeys.map(k => `<option value="${k}">${evalOptionsMaster[k].label}</option>`).join('')}
              </select>
              <button class="vote-submit-btn" onclick="submitVote('${jsPName}', null, '${escapeJS(voteSelectId)}')">御印を贈る</button>
            `}
            ${state.isSpectator ? '<div style="font-size:11px; color:#94a3b8; margin-top:4px;">👀 見学者の御印はお楽しみ用（得点には反映されません）</div>' : ''}
          </div>
        ` : ''}
      </div>
    `;
    }).join('');

  // 同じ句のselectが再生成されていれば、退避していた選択値を復元する。
  selectedVoteValues.forEach((value, id) => {
    const select = document.getElementById(id);
    if (select && [...select.options].some(option => option.value === value)) {
      select.value = value;
    }
  });

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

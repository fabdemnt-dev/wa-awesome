import { db } from "./firebase-config.js";
import { doc, setDoc, onSnapshot, updateDoc, arrayUnion, arrayRemove } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// 評価マスタ定義（外部ファイル依存を解除）
const evalOptionsMaster = {
  okashi:   { icon: "🌸", label: "🌸 いとおかし", pts: 1 },
  aware:    { icon: "🌾", label: "🌾 もののあはれ", pts: 1 },
  wabisabi: { icon: "❄️", label: "❄️ わびさび", pts: 1 },
  ayashi:   { icon: "🌀", label: "🌀 あやし", pts: 1 },
  kuruoshi: { icon: "🍶", label: "🍶 狂おし", pts: 1 },
  wabishi:  { icon: "🍃", label: "🍃 わびし", pts: 1 },
  yugen:    { icon: "🌙", label: "🌙 幽玄", pts: 1 },
  tae:      { icon: "🪭", label: "🪭 妙なり", pts: 10 }
};
const hostOptionKeys = [
  "okashi",
  "aware",
  "wabisabi",
  "ayashi",
  "kuruoshi",
  "wabishi",
  "yugen",
  "tae"
];

const childOptionKeys = [
  "okashi",
  "aware",
  "wabisabi"
];

let roomId = "";
let myName = "";
let isSpectator = false;
let roomRef = null;
let myHand5 = [];
let myHand7 = [];
let selectedHand = [null, null, null];
let currentData = null;

const colorPalette = [
  { bg: '#dbeafe', text: '#1e40af', border: '#bfdbfe' }, // 1: 青
  { bg: '#fef3c7', text: '#92400e', border: '#fde68a' }, // 2: 黄
  { bg: '#dcfce7', text: '#166534', border: '#bbf7d0' }, // 3: 緑
  { bg: '#fce7f3', text: '#9d174d', border: '#fbcfe8' }, // 4: ピンク
  { bg: '#e0e7ff', text: '#3730a3', border: '#c7d2fe' }, // 5: インディゴ
  { bg: '#f3e8ff', text: '#6b21a8', border: '#e9d5ff' }, // 6: 紫
  { bg: '#ffedd5', text: '#9a3412', border: '#fed7aa' }, // 7: オレンジ
  { bg: '#cffafe', text: '#155e75', border: '#a5f3fc' }  // 8: シアン
];

function getAuthorStyle(authorName) {
  if (!currentData || !currentData.players) return colorPalette[0];
  const idx = currentData.players.indexOf(authorName);
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

window.joinRoom = async function() {
  myName = document.getElementById('player-name')?.value.trim() || "";
  roomId = document.getElementById('room-id')?.value.trim() || "";
  const specCheck = document.getElementById('spectator-check');
  isSpectator = specCheck ? specCheck.checked : false;

  if (!myName || !roomId) return alert('名前とルームIDを入力してください');

  try {
    roomRef = doc(db, "rooms", "haiku_" + roomId);
    
    const updateData = {
      status: "lobby", hostIndex: 0, roundCount: 1, history: [],
      words5: [], words7: [], hands5: {}, hands7: {}, phrases: {}, phraseDetails: {}, votes: {}, scores: {},
      settings: { in5: 5, in7: 3, hand5: 5, hand7: 3 }
    };

    if (isSpectator) {
      updateData.spectators = arrayUnion(myName);
    } else {
      updateData.players = arrayUnion(myName);
    }

    await setDoc(roomRef, updateData, { merge: true });

    document.getElementById('login-sec').style.display = 'none';
    document.getElementById('lobby-sec').style.display = 'block';

    onSnapshot(roomRef, (snapshot) => {
      currentData = snapshot.data();
      if (!currentData) return;

      const players = currentData.players || [];
      const spectators = currentData.spectators || [];
      
      if (spectators.includes(myName)) isSpectator = true;
      if (players.includes(myName)) isSpectator = false;

      const currentHost = players[(currentData.hostIndex || 0) % (players.length || 1)] || '未設定';
      const hostText = `👑 今節の選者（親）: <strong>${currentHost}</strong> ${currentHost === myName ? '（あなた）' : ''}`;
      
      if (document.getElementById('host-info-lobby')) document.getElementById('host-info-lobby').innerHTML = hostText;
      if (document.getElementById('host-info-game')) document.getElementById('host-info-game').innerHTML = hostText;

      const roleBtnText = isSpectator ? "⚔️ プレイヤーとして途中参戦する" : "👀 見学モードに切り替える";
      if (document.getElementById('role-toggle-btn-lobby')) document.getElementById('role-toggle-btn-lobby').innerText = roleBtnText;
      if (document.getElementById('role-toggle-btn-game')) document.getElementById('role-toggle-btn-game').innerText = roleBtnText;

      const st = currentData.settings || { in5: 5, in7: 3, hand5: 5, hand7: 3 };
      if (document.getElementById('set-in-5')) document.getElementById('set-in-5').value = st.in5;
      if (document.getElementById('set-in-7')) document.getElementById('set-in-7').value = st.in7;
      if (document.getElementById('set-hand-5')) document.getElementById('set-hand-5').value = st.hand5;
      if (document.getElementById('set-hand-7')) document.getElementById('set-hand-7').value = st.hand7;

      renderInputFields(st.in5, st.in7);
      if (document.getElementById('total-words-5')) document.getElementById('total-words-5').innerText = currentData.words5?.length || 0;
      if (document.getElementById('total-words-7')) document.getElementById('total-words-7').innerText = currentData.words7?.length || 0;

      const scores = currentData.scores || {};
      let playerListHtml = players.map((p, idx) => `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
          <span>・ ${p} ${idx === (currentData.hostIndex % players.length) ? '<span class="role-badge">選者（親）</span>' : ''}</span>
          <div>
            <span class="score-badge" style="margin-right:8px;">${scores[p] || 0} 誉</span>
            <button onclick="removePlayer('${p}')" style="width:auto; margin:0; padding:4px 8px; font-size:12px; background-color:#ef4444;">鯖落ち</button>
          </div>
        </div>
      `).join('');

      if (spectators.length > 0) {
        playerListHtml += `<div style="font-size:12px; color:#64748b; margin-top:8px;">👀 見学者: ${spectators.join(', ')}</div>`;
      }

      if (document.getElementById('player-list')) document.getElementById('player-list').innerHTML = playerListHtml;

      if (currentData.status === 'lobby') {
        if (document.getElementById('game-sec')) document.getElementById('game-sec').style.display = 'none';
        if (document.getElementById('lobby-sec')) document.getElementById('lobby-sec').style.display = 'block';
        myHand5 = []; myHand7 = []; selectedHand = [null, null, null];
      } else if (currentData.status === 'playing') {
        if (document.getElementById('lobby-sec')) document.getElementById('lobby-sec').style.display = 'none';
        if (document.getElementById('game-sec')) document.getElementById('game-sec').style.display = 'block';
        if (currentData.hands5?.[myName]) myHand5 = currentData.hands5[myName];
        if (currentData.hands7?.[myName]) myHand7 = currentData.hands7[myName];
        renderHand();
        renderBoards();
      }
    });
  } catch (e) {
    alert('接続エラーが発生しました: ' + e.message);
  }
};

window.toggleRole = async function() {
  if (!roomRef) return;
  if (isSpectator) {
    await updateDoc(roomRef, {
      spectators: arrayRemove(myName),
      players: arrayUnion(myName)
    });
    isSpectator = false;
    alert("プレイヤーとして参加しました！");
  } else {
    await updateDoc(roomRef, {
      players: arrayRemove(myName),
      spectators: arrayUnion(myName)
    });
    isSpectator = true;
    alert("見学モードに切り替えました！");
  }
};

function renderInputFields(c5, c7) {
  ['5', '7'].forEach(type => {
    const container = document.getElementById(`inputs-${type}-container`);
    if (!container) return;
    if (isSpectator) {
      container.innerHTML = '<div style="font-size:13px; color:#94a3b8; padding:8px 0;">※見学モードのため素材入力はありません</div>';
      return;
    }
    const count = type === '5' ? c5 : c7;
    if (container.children.length !== count) {
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

window.updateSettings = async function() {
  if (!roomRef) return;
  await updateDoc(roomRef, {
    settings: {
      in5: parseInt(document.getElementById('set-in-5').value) || 5,
      in7: parseInt(document.getElementById('set-in-7').value) || 3,
      hand5: parseInt(document.getElementById('set-hand-5').value) || 5,
      hand7: parseInt(document.getElementById('set-hand-7').value) || 3
    }
  });
};

window.addWords = async function() {
  if (!currentData || isSpectator) return;
  const st = currentData.settings || { in5: 5, in7: 3 };
  const getWords = (type, count) => {
    const arr = [];
    for (let i = 1; i <= count; i++) {
      const val = document.getElementById(`word-${type}-input-${i}`)?.value.trim();
      if (val) arr.push({ text: val, author: myName });
    }
    return arr;
  };

  const new5 = getWords('5', st.in5);
  const new7 = getWords('7', st.in7);
  if (new5.length < st.in5 || new7.length < st.in7) return alert('全ての素材を入力してください');

  await updateDoc(roomRef, { words5: arrayUnion(...new5), words7: arrayUnion(...new7) });
  renderInputFields(st.in5, st.in7);
  const addBtn = document.getElementById('add-word-btn');
  if (addBtn) addBtn.innerText = "✅ 追加完了！";
};

window.removePlayer = async function(pName) {
  if (confirm(`${pName} さんを退出させますか？`)) {
    await updateDoc(roomRef, { players: arrayRemove(pName), spectators: arrayRemove(pName) });
  }
};

window.startGame = async function() {
  const players = currentData?.players || [];
  const st = currentData?.settings || { hand5: 5, hand7: 3 };
  const w5 = currentData?.words5 || [], w7 = currentData?.words7 || [];

  if (w5.length < players.length * st.hand5 || w7.length < players.length * st.hand7) {
    return alert('素材が足りません！');
  }

  const s5 = [...w5].sort(() => Math.random() - 0.5);
  const s7 = [...w7].sort(() => Math.random() - 0.5);
  const h5 = {}, h7 = {};
  players.forEach(p => { h5[p] = s5.splice(0, st.hand5); h7[p] = s7.splice(0, st.hand7); });

  await updateDoc(roomRef, { status: "playing", hands5: h5, hands7: h7, phrases: {}, phraseDetails: {}, votes: {} });
};

function renderHand() {
  const h5List = document.getElementById('hand-5-list');
  if (h5List) {
    if (isSpectator) {
      h5List.innerHTML = '<div style="font-size:13px; color:#94a3b8;">※見学モード中</div>';
    } else {
      h5List.innerHTML = myHand5.map((item, idx) => `
        <div class="card card-5 ${selectedHand.includes(item) ? 'selected' : ''}" onclick="selectCard(5, ${idx})">${item.text}</div>
      `).join('');
    }
  }

  const h7List = document.getElementById('hand-7-list');
  if (h7List) {
    if (isSpectator) {
      h7List.innerHTML = '<div style="font-size:13px; color:#94a3b8;">※見学モード中</div>';
    } else {
      h7List.innerHTML = myHand7.map((item, idx) => `
        <div class="card card-7 ${selectedHand[1] === item ? 'selected' : ''}" onclick="selectCard(7, ${idx})">${item.text}</div>
      `).join('');
    }
  }

  if (document.getElementById('phrase-1')) document.getElementById('phrase-1').innerText = selectedHand[0]?.text || '（選択してください）';
  if (document.getElementById('phrase-2')) document.getElementById('phrase-2').innerText = selectedHand[1]?.text || '（選択してください）';
  if (document.getElementById('phrase-3')) document.getElementById('phrase-3').innerText = selectedHand[2]?.text || '（選択してください）';
}

window.selectCard = function(type, idx) {
  if (isSpectator) return;
  if (type === 5) {
    const item = myHand5[idx];
    if (selectedHand[0] === item) selectedHand[0] = null;
    else if (selectedHand[2] === item) selectedHand[2] = null;
    else if (!selectedHand[0]) selectedHand[0] = item;
    else if (!selectedHand[2]) selectedHand[2] = item;
  } else {
    selectedHand[1] = selectedHand[1] === myHand7[idx] ? null : myHand7[idx];
  }
  renderHand();
};

window.swap5Cards = function() { if (!isSpectator) { [selectedHand[0], selectedHand[2]] = [selectedHand[2], selectedHand[0]]; renderHand(); } };
window.clearPhrase = function() { if (!isSpectator) { selectedHand = [null, null, null]; renderHand(); } };

window.submitPhrase = async function() {
  if (isSpectator) return alert('見学モードでは句の投稿はできません');
  if (!selectedHand[0] || !selectedHand[1] || !selectedHand[2]) return alert('すべて選択してください');
  await updateDoc(roomRef, {
    [`phrases.${myName}`]: `${selectedHand[0].text} ${selectedHand[1].text} ${selectedHand[2].text}`,
    [`phraseDetails.${myName}`]: selectedHand
  });
  alert('一句披露しました！');
};

function renderBoards() {
  const boardList = document.getElementById('board-list');
  if (!boardList || !currentData) return;

  const phrases = currentData.phrases || {};
  const phraseDetails = currentData.phraseDetails || {};
  const votes = currentData.votes || {};
  const players = currentData.players || [];
  const currentHost = players[(currentData.hostIndex || 0) % (players.length || 1)];
  const isHost = (myName === currentHost);
  const availableKeys = isHost ? hostOptionKeys : childOptionKeys;

  boardList.innerHTML = Object.keys(phrases).map(pName => {
    const pDet = phraseDetails[pName] || [];
    const phraseHtml = pDet.length === 3 ? pDet.map(d => {
      const s = getAuthorStyle(d.author);
      return `<span class="word-tag" style="background:${s.bg}; color:${s.text}; border-color:${s.border};">${d.text}<span class="author-label">(${d.author})</span></span>`;
    }).join(' ') : `<strong>${phrases[pName]}</strong>`;

    let evalBadgesHtml = '';
    Object.keys(votes).forEach(voter => {
      const vData = votes[voter]?.[pName];
      if (vData) {
        const keys = Array.isArray(vData) ? vData : [vData];
        keys.forEach(k => {
          if (evalOptionsMaster[k]) {
            evalBadgesHtml += `<span style="font-size:12px; background:#f1f5f9; padding:2px 6px; border-radius:10px; margin-right:4px; border:1px solid #cbd5e1;">${evalOptionsMaster[k].icon} ${voter}</span>`;
          }
        });
      }
    });

    const hasAlreadyVotedAsChild = !isHost && votes[myName]?.[pName] != null;

    return `
      <div class="player-board">
        <div class="board-header"><strong>${pName} の句</strong></div>
        <div>${phraseHtml}</div>
        <div style="margin-top:6px;">${evalBadgesHtml}</div>
        ${pName !== myName ? `
          <div class="vote-select-group" style="margin-top:8px;">
            ${hasAlreadyVotedAsChild ? `
              <span style="font-size:13px; color:#10b981; font-weight:bold;">✅ 御印送信済み (${evalOptionsMaster[votes[myName][pName]]?.label || ''})</span>
            ` : `
              <select class="vote-select" id="vote-select-${pName}">
                <option value="">-- 御印を選択 --</option>
                ${availableKeys.map(k => `<option value="${k}">${evalOptionsMaster[k].label}</option>`).join('')}
              </select>
              <button class="vote-submit-btn" onclick="submitVote('${pName}')">御印を贈る</button>
            `}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

window.submitVote = async function(targetPlayer) {
  const evalKey = document.getElementById(`vote-select-${targetPlayer}`)?.value;
  if (!evalKey) return alert('御印を選択してください');

  const players = currentData.players || [];
  const currentHost = players[(currentData.hostIndex || 0) % (players.length || 1)];
  const isHost = (myName === currentHost);

  if (isHost) {
    const currentVotes = currentData.votes?.[myName]?.[targetPlayer] || [];
    const currentVotesArr = Array.isArray(currentVotes) ? currentVotes : [currentVotes];
    const newVotesArr = [...currentVotesArr, evalKey];

    await updateDoc(roomRef, { [`votes.${myName}.${targetPlayer}`]: newVotesArr });
    alert('御印を追加で贈りました！');
  } else {
    const existingVote = currentData.votes?.[myName]?.[targetPlayer];
    if (existingVote) {
      return alert('この句にはすでに御印を送信しています（子は1度だけ送信できます）');
    }

    await updateDoc(roomRef, { [`votes.${myName}.${targetPlayer}`]: evalKey });
    alert('御印を贈りました！');
  }
};

window.nextRound = async function() {
  if (!currentData) return;
  const votes = currentData.votes || {}, phrases = currentData.phrases || {}, scores = currentData.scores || {};
  const players = currentData.players || [], hostIndex = currentData.hostIndex || 0;
  const newScores = { ...scores };

  let taeWinners = [];
  const taePoints = Math.max(10, players.length * 2);

  Object.keys(votes).forEach(voter => {
    Object.keys(votes[voter] || {}).forEach(target => {
      const vData = votes[voter][target];
      const keys = Array.isArray(vData) ? vData : [vData];

      keys.forEach(k => {
        if (k === 'tae' && !taeWinners.includes(target)) {
          taeWinners.push(target);
        }
        const opt = evalOptionsMaster[k];
        const pts = (k === 'tae') ? taePoints : (opt ? opt.pts : 0);
        newScores[target] = (newScores[target] || 0) + pts;
      });
    });
  });

  let alertMessage = '次の節に進みます！';
  if (taeWinners.length > 0) {
    alertMessage = `🪭 妙なりが出ました！今節の最高功労者: ${taeWinners.join(', ')} さん！(+${taePoints}誉)\n` + alertMessage;
  }

  await updateDoc(roomRef, {
    status: "lobby", hostIndex: hostIndex + 1, roundCount: (currentData.roundCount || 1) + 1,
    scores: newScores, history: [...(currentData.history || []), { round: currentData.roundCount || 1, phrases, phraseDetails: currentData.phraseDetails || {}, votes, host: players[hostIndex % (players.length || 1)] || '' }],
    words5: [], words7: [], hands5: {}, hands7: {}, phrases: {}, phraseDetails: {}, votes: {}
  });
  alert(alertMessage);
};

// --- 拡張版：御印（評価）データも含めて出力するテキスト保存 ---
window.exportText = function() {
  if (!currentData) return;
  const history = currentData.history || [];
  let txt = `【わ〜鯖句会 記録】\n\n`;
  history.forEach(h => {
    txt += `--- 第${h.round}節 (選者: ${h.host}) ---\n`;
    Object.keys(h.phrases || {}).forEach(p => {
      txt += `[句] ${p}: ${h.phrases[p]}\n`;
      
      // 誰からどんな御印が贈られたかをまとめる
      let voteStrs = [];
      Object.keys(h.votes || {}).forEach(voter => {
        const vData = h.votes[voter]?.[p];
        if (vData) {
          const keys = Array.isArray(vData) ? vData : [vData];
          keys.forEach(k => {
            if (evalOptionsMaster[k]) {
              voteStrs.push(`${voter}：${evalOptionsMaster[k].label}`);
            }
          });
        }
      });
      if (voteStrs.length > 0) {
        txt += `   └ 御印 → ${voteStrs.join(', ')}\n`;
      } else {
        txt += `   └ 御印 → なし\n`;
      }
    });
    txt += `\n`;
  });
  const blob = new Blob([txt], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `haiku_${roomId}.txt`;
  a.click();
};

// --- 拡張版：御印（評価）データも含めて出力するCSV保存 ---
window.exportCSV = function() {
  if (!currentData) return;
  const history = currentData.history || [];
  let csv = `節,選者,風流名,句,贈られた御印\n`;
  history.forEach(h => {
    Object.keys(h.phrases || {}).forEach(p => {
      const phraseText = h.phrases[p] || '';
      
      // この句に贈られたすべての御印を集約
      let voteLabels = [];
      Object.keys(h.votes || {}).forEach(voter => {
        const vData = h.votes[voter]?.[p];
        if (vData) {
          const keys = Array.isArray(vData) ? vData : [vData];
          keys.forEach(k => {
            if (evalOptionsMaster[k]) {
              // CSVのセル内改行やカンマを避けるためラベルのみ、またはシンプルな形式に
              voteLabels.push(`${voter}(${evalOptionsMaster[k].label.replace(/[🌸🌾❄️🌀🍶🍃🌙🪭]/g, '').trim()})`);
            }
          });
        }
      });
      const votesStr = voteLabels.join(' / ');

      csv += `${h.round},"${h.host}","${p}","${phraseText}","${votesStr}"\n`;
    });
  });
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `haiku_${roomId}.csv`;
  a.click();
};

document.getElementById("join-btn")
  ?.addEventListener("click", window.joinRoom);

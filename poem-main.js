import { db } from "./firebase-config.js";
import { doc, setDoc, onSnapshot, updateDoc, arrayUnion, arrayRemove } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { exportPoemText, exportPoemCSV } from "./poem-export.js";

// 【修正】XSS対策：入力された文字を安全な形式に変換する関数を追加
function escapeHTML(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[&'`"<>]/g, function(match) {
    return {
      '&': '&amp;',
      "'": '&#x27;',
      '`': '&#x60;',
      '"': '&quot;',
      '<': '&lt;',
      '>': '&gt;',
    }[match]
  });
}

// 【修正】XSS対策：JSの引数用にシングルクォート等をエスケープする関数を追加
function escapeJS(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/'/g, "\\'").replace(/"/g, '\\"');
}

let roomId = "";
let myName = "";
let isSpectator = false;
let roomRef = null;
let currentData = null;

// 選択中の手札のインデックスを管理するセット（「使った」状態のもの）
let selectedHandIndices = new Set();

const SAMPLE_PHRASES = [
  "護法夜叉",
  "ひざ",
  "エドワード・エルリック",
  "サイコパス",
  "降魔大聖", 
  "画面越し",
  "壊れかけ",
  "人魚の鱗",
  "カリスマ",
  "深夜三時のボボンガリンガ", 
  "月", 
  "帰り道", 
  "溶けかけ", 
  "黒縁メガネ", 
  "合言葉", 
  "踏切の音", 
  "枯れたひまわり", 
  "ハチワレ", 
  "ちいかわ", 
  "ローレライ"
];

window.joinRoom = async function() {
  myName = document.getElementById('player-name').value.trim();
  roomId = document.getElementById('room-id').value.trim();
  const specCheck = document.getElementById('spectator-check');
  isSpectator = specCheck ? specCheck.checked : false;

  if (!myName || !roomId) return alert('名前とルームIDを入力してください');

  try {
    roomRef = doc(db, "rooms", "poem_" + roomId);
    
    const updateData = {
      status: "lobby",
      words: [],
      hands: {},
      poems: {},
      settings: { handCount: 5 }
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

      const st = currentData.settings || { handCount: 5 };
      const handInput = document.getElementById('set-hand-count');
      if (handInput && document.activeElement !== handInput) {
        handInput.value = st.handCount;
      }

      renderInputFields(st.handCount);

      const roleBtnText = isSpectator ? "⚔️ プレイヤーとして途中参戦する" : "👀 見学モードに切り替える";
      if (document.getElementById('role-toggle-btn-lobby')) document.getElementById('role-toggle-btn-lobby').innerText = roleBtnText;
      if (document.getElementById('role-toggle-btn-game')) document.getElementById('role-toggle-btn-game').innerText = roleBtnText;

      // 【修正】XSS対策：プレイヤー名をエスケープ処理
      let playerListHtml = players.map(p => `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
          <span>・ ${escapeHTML(p)} ${p === myName ? '（あなた）' : ''}</span>
          <button onclick="removePlayer('${escapeJS(p)}')" style="width:auto; margin:0; padding:4px 8px; font-size:12px; background-color:#ef4444;">鯖落ち</button>
        </div>
      `).join('');

      if (spectators.length > 0) {
        // 【修正】XSS対策：見学者名もエスケープ処理
        playerListHtml += `<div style="font-size:12px; color:#64748b; margin-top:8px;">👀 見学者: ${spectators.map(s => escapeHTML(s)).join(', ')}</div>`;
      }
      document.getElementById('player-list').innerHTML = playerListHtml;

      if (currentData.status === 'lobby') {
        document.getElementById('game-sec').style.display = 'none';
        document.getElementById('lobby-sec').style.display = 'block';
        selectedHandIndices.clear(); // ロビーに戻ったら選択状態をリセット
        const textarea = document.getElementById('poem-input-area');
        if (textarea) {
          textarea.value = '';
          textarea.style.height = 'auto';
        }
      } else if (currentData.status === 'playing') {
        document.getElementById('lobby-sec').style.display = 'none';
        document.getElementById('game-sec').style.display = 'block';
        renderHand();
        renderBoards();
        setupAutoResize();
      }
    });
  } catch (e) { alert('接続エラー: ' + e.message); }
};

window.updateHandCountSetting = async function() {
  if (!roomRef) return;
  const count = parseInt(document.getElementById('set-hand-count').value) || 5;
  await updateDoc(roomRef, { "settings.handCount": count });
};

function renderInputFields(count) {
  const container = document.getElementById('word-inputs');
  if (!container) return;

  if (isSpectator) {
    container.innerHTML = '<div style="font-size:13px; color:#94a3b8; padding:8px 0;">※見学モードのため素材入力はありません</div>';
    return;
  }

  if (container.children.length !== count) {
    container.innerHTML = '';
    const shuffledSamples = [...SAMPLE_PHRASES].sort(() => Math.random() - 0.5);

    for (let i = 1; i <= count; i++) {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'poem-input';
      const sampleText = shuffledSamples[(i - 1) % shuffledSamples.length];
      inp.placeholder = `例: ${sampleText}`;

      inp.style.marginBottom = '6px';
      inp.style.display = 'block';
      inp.style.width = '100%';
      inp.style.padding = '8px';
      inp.style.boxSizing = 'border-box';
      container.appendChild(inp);
    }
  }
}

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

window.removePlayer = async function(pName) {
  if (confirm(`${pName} さんを退出させますか？`)) {
    await updateDoc(roomRef, { 
      players: arrayRemove(pName), 
      spectators: arrayRemove(pName) 
    });
  }
};

window.addWords = async function() {
  if (isSpectator) return alert('見学モードでは素材投稿はできません');
  const inputs = document.querySelectorAll('#word-inputs input');
  const newWords = [];
  
  inputs.forEach(inp => {
    const val = inp.value.trim();
    // 【修正】素材重複バグ対策：同じ単語でもFirebaseが別物として認識するように、ランダムなIDを追加
    if (val) {
      newWords.push({ 
        text: val, 
        author: myName, 
        id: Date.now() + "_" + Math.random().toString(36).substring(2, 9) 
      });
    }
  });

  const st = currentData?.settings || { handCount: 5 };
  if (newWords.length < st.handCount) return alert(`設定された手札の枚数（${st.handCount}個）分すべて入力してください`);

  await updateDoc(roomRef, { words: arrayUnion(...newWords) });
  inputs.forEach(inp => inp.value = '');
  alert('素材を追加しました！');
};

window.startGame = async function() {
  if (!currentData) return;
  
  // 【修正】誤操作防止：本当にゲームを開始するか確認のポップアップを入れる
  if (!confirm('全員の素材が集まりましたか？\nポエム作りを開始します。')) return;

  const players = currentData.players || [];
  const words = currentData.words || [];
  
  const st = currentData.settings || { handCount: 5 };
  const handCount = st.handCount;

  if (words.length < players.length * handCount) {
    return alert(`素材の数が足りません！\n現在 ${words.length}個 ですが、(プレイヤー ${players.length}人 × 手札 ${handCount}枚 = ${players.length * handCount}個) 必要です。`);
  }

  const shuffledWords = [...words].sort(() => Math.random() - 0.5);
  const newHands = {};

  players.forEach(p => {
    newHands[p] = shuffledWords.splice(0, handCount);
  });

  selectedHandIndices.clear();
  await updateDoc(roomRef, { 
    status: "playing", 
    hands: newHands, 
    poems: {} 
  });
};

function renderHand() {
  const handList = document.getElementById('hand-list');
  const textarea = document.getElementById('poem-input-area');
  if (!handList || !currentData) return;

  if (isSpectator) {
    handList.innerHTML = '<div style="font-size:13px; color:#94a3b8;">※見学モード中</div>';
    if (textarea) {
      textarea.value = '（見学モード中）';
      textarea.disabled = true;
    }
    return;
  }

  if (textarea) textarea.disabled = false;

  const myHands = currentData.hands?.[myName] || [];
  
  if (myHands.length === 0) {
    handList.innerHTML = '<div style="font-size:13px; color:#94a3b8;">手札がありません</div>';
    return;
  }

  // 【修正】XSS対策：手札のテキストをエスケープ処理
  handList.innerHTML = myHands.map((item, idx) => {
    const isSelected = selectedHandIndices.has(idx);
    const bgStyle = isSelected 
      ? 'background-color: #dbeafe; border-color: #3b82f6;' 
      : 'background-color: #fff; border-color: #cbd5e1;';

    return `
      <div class="card" onclick="onCardClick(${idx})" style="cursor: pointer; padding: 8px 12px; margin-bottom: 6px; border-radius: 6px; border: 1px solid; transition: all 0.2s; ${bgStyle}">
        ${escapeHTML(item.text)} ${isSelected ? '✓' : ''}
      </div>
    `;
  }).join('');
}

function setupAutoResize() {
  const textarea = document.getElementById('poem-input-area');
  if (!textarea) return;

  textarea.removeEventListener('input', resizeTextarea);
  textarea.addEventListener('input', resizeTextarea);
}

function resizeTextarea() {
  this.style.height = 'auto';
  this.style.height = (this.scrollHeight) + 'px';
}

window.onCardClick = function(idx) {
  if (isSpectator) return;
  const myHands = currentData.hands?.[myName] || [];
  const item = myHands[idx];
  const textarea = document.getElementById('poem-input-area');
  if (!textarea || !item) return;

  const wordText = item.text;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = textarea.value;

  textarea.value = text.substring(0, start) + wordText + text.substring(end);
  textarea.selectionStart = textarea.selectionEnd = start + wordText.length;
  
  resizeTextarea.call(textarea);
  textarea.focus();

  if (selectedHandIndices.has(idx)) {
    selectedHandIndices.delete(idx);
  } else {
    selectedHandIndices.add(idx);
  }

  renderHand();
};

window.clearPoem = function() {
  if (isSpectator) return;
  const textarea = document.getElementById('poem-input-area');
  if (textarea) {
    textarea.value = '';
    textarea.style.height = 'auto';
    textarea.focus();
  }
  selectedHandIndices.clear();
  renderHand();
};

window.submitPoem = async function() {
  if (isSpectator) return alert('見学モードではポエムの投稿はできません');
  const textarea = document.getElementById('poem-input-area');
  if (!textarea) return;

  const poemText = textarea.value.trim();
  if (!poemText) return alert('ポエムを入力してください');

  const myHands = currentData.hands?.[myName] || [];
  const usedHands = [];
  selectedHandIndices.forEach(idx => {
    if (myHands[idx]) {
      usedHands.push(myHands[idx]);
    }
  });

  await updateDoc(roomRef, {
    [`poems.${myName}`]: {
      text: poemText,
      hands: usedHands,
      revealed: false,
      likes: 0,
      emos: 0
    }
  });
  alert('ポエムを投稿しました！');
};

window.revealPoem = async function(pName) {
  if (!roomRef) return;
  await updateDoc(roomRef, {
    [`poems.${pName}.revealed`]: true
  });
};

window.addReaction = async function(pName, type) {
  if (!roomRef || !currentData) return;
  const poems = currentData.poems || {};
  const target = poems[pName];
  if (!target) return;

  const currentCount = (type === 'like' ? target.likes : target.emos) || 0;

  await updateDoc(roomRef, {
    [`poems.${pName}.${type === 'like' ? 'likes' : 'emos'}`]: currentCount + 1
  });
};

function renderBoards() {
  const boardList = document.getElementById('board-list');
  if (!boardList || !currentData) return;

  const poems = currentData.poems || {};
  
  if (Object.keys(poems).length === 0) {
    boardList.innerHTML = '<div style="font-size:13px; color:#64748b;">まだ投稿された作品はありません。</div>';
    return;
  }

  function getColorFromName(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const colors = ['#4f46e5', '#e11d48', '#059669', '#d97706', '#7c3aed', '#0284c7', '#db2777', '#ca8a04'];
    return colors[Math.abs(hash) % colors.length];
  }

  const sortedPlayerNames = Object.keys(poems).sort();

  boardList.innerHTML = sortedPlayerNames.map(pName => {
    const poemData = poems[pName];
    // 【修正】XSS対策：表示用の名前をエスケープ
    const safePName = escapeHTML(pName);
    const jsPName = escapeJS(pName);

    if (typeof poemData === 'string') {
      return `
        <div class="player-board" style="margin-bottom: 20px; padding: 16px; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff;">
          <strong>${safePName} の作品</strong>
          <div style="margin-top: 8px; padding: 12px; background: #f8fafc; border-left: 4px solid #4f46e5; border-radius: 4px;">
            <p style="font-size: 15px; line-height: 1.5; white-space: pre-wrap; margin: 0;">${escapeHTML(poemData)}</p>
          </div>
        </div>
      `;
    }

    const isRevealed = poemData.revealed;
    const hands = poemData.hands || [];
    const likes = poemData.likes || 0;
    const emos = poemData.emos || 0;
    
    const userColor = getColorFromName(pName);

    // 【修正】XSS対策：使用した手札のテキストと作者名をエスケープ
    const handsHtml = hands.map(h => {
      const authorColor = getColorFromName(h.author);
      return `
        <div style="display: inline-block; background-color: ${authorColor}22; border: 1px solid ${authorColor}66; color: #1e293b; padding: 4px 8px; margin: 2px; border-radius: 4px; font-size: 13px;">
          ${escapeHTML(h.text)} <span style="font-size: 10px; color: #64748b; font-weight: bold;">(${escapeHTML(h.author)})</span>
        </div>
      `;
    }).join('');

    // 【修正】XSS対策：ポエム本文をエスケープ
    return `
      <div class="player-board" style="margin-bottom: 20px; padding: 16px; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff;">
        <strong>${safePName} の作品</strong>
        
        <div style="margin-top: 8px;">
          <div style="font-size: 12px; color: #64748b; margin-bottom: 4px;">📌 使用した手札（元素材の作者）:</div>
          <div>${handsHtml.length > 0 ? handsHtml : '<span style="font-size: 12px; color: #94a3b8;">なし</span>'}</div>
        </div>

        <div style="margin-top: 12px;">
          ${!isRevealed ? `
            <button onclick="revealPoem('${jsPName}')" style="background-color: #4f46e5; width: 100%; padding: 12px; font-size: 15px;">
              🎁 タップして作品を開く
            </button>
          ` : `
            <div style="margin-top: 8px; padding: 12px; background: #f8fafc; border-left: 4px solid ${userColor}; border-radius: 4px;">
              <p style="font-size: 15px; line-height: 1.5; white-space: pre-wrap; margin: 0;">${escapeHTML(poemData.text)}</p>
            </div>
          `}
        </div>

        <div style="display: flex; gap: 16px; margin-top: 12px; align-items: center;">
          <button onclick="addReaction('${jsPName}', 'like')" style="background: none; border: none; color: #334155; width: auto; padding: 6px 8px; font-size: 14px; cursor: pointer;">
            👍 いいね (${likes})
          </button>
          <button onclick="addReaction('${jsPName}', 'emo')" style="background: none; border: none; color: #334155; width: auto; padding: 6px 8px; font-size: 14px; cursor: pointer;">
            💖 エモい (${emos})
          </button>
        </div>
      </div>
    `;
  }).join('');
}

window.nextGame = async function() {
  if (!roomRef) return;
  // 【修正】誤操作防止：間違えてリセットしないように確認ポップアップを入れる
  if (!confirm('本当に新しいポエム作りに進みますか？\n（現在の作品はリセットされます）')) return;

  await updateDoc(roomRef, {
    status: "lobby",
    words: [],
    hands: {},
    poems: {}
  });
  alert('次のポエム作成に進みます！');
};

window.exportText = function() { exportPoemText(currentData); };
window.exportCSV = function() { exportPoemCSV(currentData, roomId); };

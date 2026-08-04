import { db } from "./firebase-config.js";
import { doc, setDoc, onSnapshot, updateDoc, arrayUnion, arrayRemove } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { exportPoemText, exportPoemCSV } from "./poem-export.js";

let roomId = "";
let myName = "";
let isSpectator = false;
let roomRef = null;
let currentData = null;

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

      let playerListHtml = players.map(p => `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
          <span>・ ${p} ${p === myName ? '（あなた）' : ''}</span>
          <button onclick="removePlayer('${p}')" style="width:auto; margin:0; padding:4px 8px; font-size:12px; background-color:#ef4444;">鯖落ち</button>
        </div>
      `).join('');

      if (spectators.length > 0) {
        playerListHtml += `<div style="font-size:12px; color:#64748b; margin-top:8px;">👀 見学者: ${spectators.join(', ')}</div>`;
      }
      document.getElementById('player-list').innerHTML = playerListHtml;

      if (currentData.status === 'lobby') {
        document.getElementById('game-sec').style.display = 'none';
        document.getElementById('lobby-sec').style.display = 'block';
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
    for (let i = 1; i <= count; i++) {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'poem-input';
      inp.placeholder = `フレーズ ${i}`;
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
    if (val) newWords.push({ text: val, author: myName });
  });

  const st = currentData?.settings || { handCount: 5 };
  if (newWords.length < st.handCount) return alert(`設定された手札の枚数（${st.handCount}個）分すべて入力してください`);

  await updateDoc(roomRef, { words: arrayUnion(...newWords) });
  inputs.forEach(inp => inp.value = '');
  alert('素材を追加しました！');
};

window.startGame = async function() {
  if (!currentData) return;
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

  handList.innerHTML = myHands.map((item, idx) => `
    <div class="card" onclick="insertWord(${idx})">${item.text}</div>
  `).join('');
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

window.insertWord = function(idx) {
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
};

window.clearPoem = function() {
  if (isSpectator) return;
  const textarea = document.getElementById('poem-input-area');
  if (textarea) {
    textarea.value = '';
    textarea.style.height = 'auto';
    textarea.focus();
  }
};

window.submitPoem = async function() {
  if (isSpectator) return alert('見学モードではポエムの投稿はできません');
  const textarea = document.getElementById('poem-input-area');
  if (!textarea) return;

  const poemText = textarea.value.trim();
  if (!poemText) return alert('ポエムを入力してください');

  await updateDoc(roomRef, {
    [`poems.${myName}`]: poemText
  });
  alert('ポエムを投稿しました！');
};

function renderBoards() {
  const boardList = document.getElementById('board-list');
  if (!boardList || !currentData) return;

  const poems = currentData.poems || {};
  boardList.innerHTML = Object.keys(poems).map(pName => `
    <div class="player-board">
      <strong>${pName} の作品</strong>
      <p style="margin-top:6px; font-size:15px; line-height:1.5; white-space: pre-wrap;">${poems[pName]}</p>
    </div>
  `).join('');
}

window.nextGame = async function() {
  if (!roomRef) return;
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

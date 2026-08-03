import { db } from "./firebase-config.js";
import { doc, setDoc, onSnapshot, updateDoc, arrayUnion, arrayRemove } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

let roomId = "";
let myName = "";
let isSpectator = false;
let roomRef = null;
let selectedWords = [];
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
      poems: {}
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

      // 自分の役割状態を同期
      if (spectators.includes(myName)) isSpectator = true;
      if (players.includes(myName)) isSpectator = false;

      // ボタンの表示更新
      const roleBtnText = isSpectator ? "⚔️ プレイヤーとして途中参戦する" : "👀 見学モードに切り替える";
      if (document.getElementById('role-toggle-btn-lobby')) document.getElementById('role-toggle-btn-lobby').innerText = roleBtnText;
      if (document.getElementById('role-toggle-btn-game')) document.getElementById('role-toggle-btn-game').innerText = roleBtnText;

      let playerListHtml = players.map(p => `<div>・ ${p}</div>`).join('');
      if (spectators.length > 0) {
        playerListHtml += `<div style="font-size:12px; color:#64748b; margin-top:8px;">👀 見学者: ${spectators.join(', ')}</div>`;
      }
      document.getElementById('player-list').innerHTML = playerListHtml;

      if (currentData.status === 'lobby') {
        document.getElementById('game-sec').style.display = 'none';
        document.getElementById('lobby-sec').style.display = 'block';
        selectedWords = [];
      } else if (currentData.status === 'playing') {
        document.getElementById('lobby-sec').style.display = 'none';
        document.getElementById('game-sec').style.display = 'block';
        renderHand();
        renderBoards();
      }
    });
  } catch (e) { alert('接続エラー: ' + e.message); }
};

// 参戦 ⇔ 見学の動的切り替え
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

window.addWords = async function() {
  if (isSpectator) return alert('見学モードでは素材投稿はできません');
  const inputs = document.querySelectorAll('#word-inputs input');
  const newWords = [];
  inputs.forEach(inp => {
    const val = inp.value.trim();
    if (val) newWords.push({ text: val, author: myName });
  });

  if (newWords.length === 0) return alert('素材を入力してください');

  await updateDoc(roomRef, { words: arrayUnion(...newWords) });
  inputs.forEach(inp => inp.value = '');
  alert('素材を追加しました！');
};

window.startGame = async function() {
  await updateDoc(roomRef, { status: "playing" });
};

function renderHand() {
  const handList = document.getElementById('hand-list');
  if (!handList || !currentData) return;

  if (isSpectator) {
    handList.innerHTML = '<div style="font-size:13px; color:#94a3b8;">※見学モード中</div>';
    document.getElementById('poem-display').innerText = '（見学モード中）';
    return;
  }

  const words = currentData.words || [];
  handList.innerHTML = words.map((item, idx) => `
    <div class="card ${selectedWords.includes(item.text) ? 'selected' : ''}" onclick="selectWord(${idx})">${item.text}</div>
  `).join('');

  document.getElementById('poem-display').innerText = selectedWords.join(' ') || '（選択した言葉がここに並びます）';
}

window.selectWord = function(idx) {
  if (isSpectator) return;
  const item = currentData.words[idx];
  const wordText = item.text;
  
  if (selectedWords.includes(wordText)) {
    selectedWords = selectedWords.filter(w => w !== wordText);
  } else {
    selectedWords.push(wordText);
  }
  renderHand();
};

window.clearPoem = function() {
  if (isSpectator) return;
  selectedWords = [];
  renderHand();
};

window.submitPoem = async function() {
  if (isSpectator) return alert('見学モードではポエムの投稿はできません');
  if (selectedWords.length === 0) return alert('言葉を選択してください');
  await updateDoc(roomRef, {
    [`poems.${myName}`]: selectedWords.join(' ')
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
      <p style="margin-top:6px; font-size:15px; line-height:1.5;">${poems[pName]}</p>
    </div>
  `).join('');
}

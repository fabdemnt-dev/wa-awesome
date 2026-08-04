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

      if (spectators.includes(myName)) isSpectator = true;
      if (players.includes(myName)) isSpectator = false;

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
        const textarea = document.getElementById('poem-input-area');
        if (textarea) textarea.value = '';
      } else if (currentData.status === 'playing') {
        document.getElementById('lobby-sec').style.display = 'none';
        document.getElementById('game-sec').style.display = 'block';
        renderHand();
        renderBoards();
      }
    });
  } catch (e) { alert('接続エラー: ' + e.message); }
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

  const words = currentData.words || [];
  // 手札をクリックしたときにテキストエリアに文字を追加する関数を呼び出す
  handList.innerHTML = words.map((item, idx) => `
    <div class="card" onclick="insertWord(${idx})">${item.text}</div>
  `).join('');
}

// 手札をクリックした際、テキストエリアに言葉を追加する
window.insertWord = function(idx) {
  if (isSpectator) return;
  const item = currentData.words[idx];
  const textarea = document.getElementById('poem-input-area');
  if (!textarea || !item) return;

  const wordText = item.text;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = textarea.value;

  // カーソル位置（または選択範囲）に言葉を挿入する
  textarea.value = text.substring(0, start) + wordText + text.substring(end);
  // カーソル位置を挿入した文字の末尾に移動
  textarea.selectionStart = textarea.selectionEnd = start + wordText.length;
  textarea.focus();
};

window.clearPoem = function() {
  if (isSpectator) return;
  const textarea = document.getElementById('poem-input-area');
  if (textarea) {
    textarea.value = '';
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
    poems: {}
  });
  alert('次のポエム作成に進みます！');
};

window.exportText = function() { exportPoemText(currentData); };
window.exportCSV = function() { exportPoemCSV(currentData, roomId); };

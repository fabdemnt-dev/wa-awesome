import { db } from "./firebase-config.js";
import { doc, setDoc, onSnapshot, updateDoc, arrayUnion } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

let roomId = "";
let myName = "";
let roomRef = null;
let selectedWords = [];
let currentData = null;

window.joinRoom = async function() {
  myName = document.getElementById('player-name').value.trim();
  roomId = document.getElementById('room-id').value.trim();

  if (!myName || !roomId) return alert('名前とルームIDを入力してください');

  try {
    roomRef = doc(db, "rooms", "poem_" + roomId);
    await setDoc(roomRef, {
      status: "lobby",
      players: arrayUnion(myName),
      words: [],
      poems: {}
    }, { merge: true });

    document.getElementById('login-sec').style.display = 'none';
    document.getElementById('lobby-sec').style.display = 'block';

    onSnapshot(roomRef, (snapshot) => {
      currentData = snapshot.data();
      if (!currentData) return;

      const players = currentData.players || [];
      document.getElementById('player-list').innerHTML = players.map(p => `<div>・ ${p}</div>`).join('');

      if (currentData.status === 'playing') {
        document.getElementById('lobby-sec').style.display = 'none';
        document.getElementById('game-sec').style.display = 'block';
        renderHand();
        renderBoards();
      }
    });
  } catch (e) { alert('接続エラー: ' + e.message); }
};

window.addWords = async function() {
  const inputs = document.querySelectorAll('.poem-input');
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

  const words = currentData.words || [];
  handList.innerHTML = words.map((item, idx) => `
    <div class="card ${selectedWords.includes(item.text) ? 'selected' : ''}" onclick="selectWord(${idx})">${item.text}</div>
  `).join('');

  document.getElementById('poem-display').innerText = selectedWords.join(' ') || '（選択した言葉がここに並びます）';
}

window.selectWord = function(idx) {
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
  selectedWords = [];
  renderHand();
};

window.submitPoem = async function() {
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

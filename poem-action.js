import { db } from "./firebase-config.js";
import { doc, setDoc, onSnapshot, updateDoc, arrayUnion, arrayRemove } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import state from './poem-state.js';
import { escapeHTML, escapeJS, renderInputFields, renderHand, renderBoards } from './poem-render.js';
import { exportPoemText, exportPoemCSV } from './poem-export.js';

export const SAMPLE_PHRASES = [
  "岩王帝君", "ひざ", "瑠璃色", 
  "サイコパス", "降魔大聖", "画面越し",
  "壊れかけ", "人魚の鱗", "カリスマ", 
  "深夜三時のボボンガリンガ", "夜明け前", 
  "帰り道", "溶けそうな", "黒縁メガネ",
  "合言葉", "踏切の音", "枯れたひまわり", 
  "跡部景吾", "ちいかわ", "記憶喪失"
];

window.joinRoom = async function() {
  state.myName = document.getElementById('player-name').value.trim();
  state.roomId = document.getElementById('room-id').value.trim();
  const specCheck = document.getElementById('spectator-check');
  state.isSpectator = specCheck ? specCheck.checked : false;

  if (!state.myName || !state.roomId) return alert('名前とルームIDを入力してください');

  try {
    state.roomRef = doc(db, "rooms", "poem_" + state.roomId);
    
    const updateData = {
      status: "lobby",
      roundCount: 1, 
      history: [],   
      words: [],
      hands: {},
      poems: {},
      settings: { handCount: 5 }
    };

    if (state.isSpectator) {
      updateData.spectators = arrayUnion(state.myName);
    } else {
      updateData.players = arrayUnion(state.myName);
    }

    await setDoc(state.roomRef, updateData, { merge: true });

    document.getElementById('login-sec').style.display = 'none';
    document.getElementById('lobby-sec').style.display = 'block';

    onSnapshot(state.roomRef, (snapshot) => {
      state.currentData = snapshot.data();
      if (!state.currentData) return;

      const players = state.currentData.players || [];
      const spectators = state.currentData.spectators || [];

      if (spectators.includes(state.myName)) state.isSpectator = true;
      if (players.includes(state.myName)) state.isSpectator = false;

      const st = state.currentData.settings || { handCount: 5 };
      const handInput = document.getElementById('set-hand-count');
      if (handInput && document.activeElement !== handInput) {
        handInput.value = st.handCount;
      }

      renderInputFields(st.handCount, SAMPLE_PHRASES);

      const roleBtnText = state.isSpectator ? "⚔️ プレイヤーとして途中参戦する" : "👀 見学モードに切り替える";
      if (document.getElementById('role-toggle-btn-lobby')) document.getElementById('role-toggle-btn-lobby').innerText = roleBtnText;
      if (document.getElementById('role-toggle-btn-game')) document.getElementById('role-toggle-btn-game').innerText = roleBtnText;

      let playerListHtml = players.map(p => `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
          <span>・ ${escapeHTML(p)} ${p === state.myName ? '（あなた）' : ''}</span>
          <button onclick="removePlayer('${escapeJS(p)}')" style="width:auto; margin:0; padding:4px 8px; font-size:12px; background-color:#ef4444;">鯖落ち</button>
        </div>
      `).join('');

      if (spectators.length > 0) {
        playerListHtml += `<div style="font-size:12px; color:#64748b; margin-top:8px;">👀 見学者: ${spectators.map(s => escapeHTML(s)).join(', ')}</div>`;
      }
      document.getElementById('player-list').innerHTML = playerListHtml;

      if (state.currentData.status === 'lobby') {
        document.getElementById('game-sec').style.display = 'none';
        document.getElementById('lobby-sec').style.display = 'block';
        state.selectedHandIndices.clear();
        const textarea = document.getElementById('poem-input-area');
        if (textarea) {
          textarea.value = '';
          textarea.style.height = 'auto';
        }
      } else if (state.currentData.status === 'playing') {
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
  if (!state.roomRef) return;
  const count = parseInt(document.getElementById('set-hand-count').value) || 5;
  await updateDoc(state.roomRef, { "settings.handCount": count });
};

window.toggleRole = async function() {
  if (!state.roomRef) return;
  if (state.isSpectator) {
    await updateDoc(state.roomRef, {
      spectators: arrayRemove(state.myName),
      players: arrayUnion(state.myName)
    });
    state.isSpectator = false;
    alert("プレイヤーとして参加しました！");
  } else {
    await updateDoc(state.roomRef, {
      players: arrayRemove(state.myName),
      spectators: arrayUnion(state.myName)
    });
    state.isSpectator = true;
    alert("見学モードに切り替えました！");
  }
};

window.removePlayer = async function(pName) {
  if (confirm(`${pName} さんを退出させますか？`)) {
    await updateDoc(state.roomRef, { 
      players: arrayRemove(pName), 
      spectators: arrayRemove(pName) 
    });
  }
};

window.addWords = async function() {
  if (state.isSpectator) return alert('見学モードでは素材投稿はできません');
  const inputs = document.querySelectorAll('#word-inputs input');
  const newWords = [];
  
  inputs.forEach(inp => {
    const val = inp.value.trim();
    if (val) {
      newWords.push({ 
        text: val, 
        author: state.myName, 
        id: Date.now() + "_" + Math.random().toString(36).substring(2, 9) 
      });
    }
  });

  const st = state.currentData?.settings || { handCount: 5 };
  if (newWords.length < st.handCount) return alert(`設定された手札の枚数（${st.handCount}個）分すべて入力してください`);

  await updateDoc(state.roomRef, { words: arrayUnion(...newWords) });
  inputs.forEach(inp => inp.value = '');
  alert('素材を追加しました！');
};

window.startGame = async function() {
  if (!state.currentData) return;
  if (!confirm('全員の素材が集まりましたか？\nポエム作りを開始します。')) return;

  const players = state.currentData.players || [];
  const words = state.currentData.words || [];
  const st = state.currentData.settings || { handCount: 5 };
  const handCount = st.handCount;

  if (words.length < players.length * handCount) {
    return alert(`素材の数が足りません！\n現在 ${words.length}個 ですが、(プレイヤー ${players.length}人 × 手札 ${handCount}枚 = ${players.length * handCount}個) 必要です。`);
  }

  const shuffledWords = [...words].sort(() => Math.random() - 0.5);
  const newHands = {};
  players.forEach(p => { newHands[p] = shuffledWords.splice(0, handCount); });

  state.selectedHandIndices.clear();
  await updateDoc(state.roomRef, { 
    status: "playing", 
    hands: newHands, 
    poems: {} 
  });
};

function setupAutoResize() {
  const textarea = document.getElementById('poem-input-area');
  if (!textarea) return;

  const savedDraft = sessionStorage.getItem('poemDraft');
  if (savedDraft) {
    textarea.value = savedDraft;
    resizeTextarea.call(textarea);
  }

  textarea.removeEventListener('input', resizeTextarea);
  textarea.addEventListener('input', function() {
    resizeTextarea.call(this);
    sessionStorage.setItem('poemDraft', this.value);
  });
}

function resizeTextarea() {
  this.style.height = 'auto';
  this.style.height = (this.scrollHeight) + 'px';
}

window.onCardClick = function(idx) {
  if (state.isSpectator) return;
  const myHands = state.currentData.hands?.[state.myName] || [];
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
  sessionStorage.setItem('poemDraft', textarea.value);
  textarea.focus();

  if (state.selectedHandIndices.has(idx)) {
    state.selectedHandIndices.delete(idx);
  } else {
    state.selectedHandIndices.add(idx);
  }

  renderHand();
};

window.clearPoem = function() {
  if (state.isSpectator) return;
  const textarea = document.getElementById('poem-input-area');
  if (textarea) {
    textarea.value = '';
    textarea.style.height = 'auto';
    textarea.focus();
  }
  state.selectedHandIndices.clear();
  sessionStorage.removeItem('poemDraft');
  renderHand();
};

window.submitPoem = async function() {
  if (state.isSpectator) return alert('見学モードではポエムの投稿はできません');
  const textarea = document.getElementById('poem-input-area');
  if (!textarea) return;

  const poemText = textarea.value.trim();
  if (!poemText) return alert('ポエムを入力してください');

  const myHands = state.currentData.hands?.[state.myName] || [];
  const usedHands = [];
  state.selectedHandIndices.forEach(idx => {
    if (myHands[idx]) usedHands.push(myHands[idx]);
  });

  await updateDoc(state.roomRef, {
    [`poems.${state.myName}`]: {
      text: poemText,
      hands: usedHands,
      revealed: false,
      likes: 0,
      emos: 0
    }
  });
  
  sessionStorage.removeItem('poemDraft');
  alert('ポエムを投稿しました！');
};

window.revealPoem = async function(pName) {
  if (!state.roomRef) return;
  await updateDoc(state.roomRef, { [`poems.${pName}.revealed`]: true });
};

window.addReaction = async function(pName, type) {
  if (!state.roomRef || !state.currentData) return;
  const poems = state.currentData.poems || {};
  const target = poems[pName];
  if (!target) return;

  const currentCount = (type === 'like' ? target.likes : target.emos) || 0;
  await updateDoc(state.roomRef, {
    [`poems.${pName}.${type === 'like' ? 'likes' : 'emos'}`]: currentCount + 1
  });
};

window.nextGame = async function() {
  if (!state.roomRef || !state.currentData) return;
  if (!confirm('本当に新しいポエム作りに進みますか？\n（現在の作品は履歴に保存され、新しく作り直します）')) return;

  const currentRoundHistory = {
    round: state.currentData.roundCount || 1,
    poems: state.currentData.poems || {}
  };
  const nextRoundNum = (state.currentData.roundCount || 1) + 1;

  await updateDoc(state.roomRef, {
    status: "lobby",
    roundCount: nextRoundNum,
    history: arrayUnion(currentRoundHistory),
    words: [],
    hands: {},
    poems: {}
  });
  
  alert('作品を履歴に保存しました！次の作成に進みます。');
};

window.exportText = function() { 
  const exportAll = document.getElementById('export-all-check')?.checked ?? true;
  exportPoemText(state.currentData, exportAll); 
};
window.exportCSV = function() { 
  const exportAll = document.getElementById('export-all-check')?.checked ?? true;
  exportPoemCSV(state.currentData, state.roomId, exportAll); 
};

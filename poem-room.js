import { db } from "./firebase-config.js";
import { doc, getDoc, setDoc, onSnapshot, updateDoc, arrayUnion, arrayRemove } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import state from './poem-state.js';
import { escapeHTML, escapeJS, renderInputFields, renderHand, renderBoards } from './poem-render.js';
import { setupAutoResize } from './poem-action.js';

export const SAMPLE_PHRASES = [
  "当て馬の男", "ショタのひざ",  
  "サイコパス", "傷だらけの降魔大聖", "画面越し",
  "食べさし", "人魚の鱗", "カリスマ", "踏切の音",
  "深夜三時のボボンガリンガ", "夜明け前", 
  "帰り道", "溶けそうな", "黒縁メガネ", "ちいかわ",
  "激しく降る横殴りの雨", "枯れたひまわり", 
  "跡部景吾", "記憶喪失", "降臨する王者"
];

window.joinRoom = async function() {
  const nameInput = document.getElementById('player-name');
  const roomInput = document.getElementById('room-id');
  
  if (!nameInput || !roomInput) {
    return alert('入力フォームの要素が見つかりません');
  }

  state.myName = nameInput.value.trim();
  state.roomId = roomInput.value.trim();
  const specCheck = document.getElementById('spectator-check');
  state.isSpectator = specCheck ? specCheck.checked : false;

  if (!state.myName || !state.roomId) return alert('名前とルームIDを入力してください');

  try {
    state.roomRef = doc(db, "rooms", "poem_" + state.roomId);

const roomSnapshot = await getDoc(state.roomRef);

if (!roomSnapshot.exists()) {
  const initialData = {
    status: "lobby",
    roundCount: 1,
    history: [],
    words: [],
    hands: {},
    poems: {},
    settings: { handCount: 5 },
    players: [],
    spectators: []
  };

  if (state.isSpectator) {
    initialData.spectators = [state.myName];
  } else {
    initialData.players = [state.myName];
  }

  await setDoc(state.roomRef, initialData);

} else {

  if (state.isSpectator) {
    await updateDoc(state.roomRef, {
      spectators: arrayUnion(state.myName)
    });
  } else {
    await updateDoc(state.roomRef, {
      players: arrayUnion(state.myName)
    });
  }

}

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
const currentWords = (state.currentData.words || []).length;
const requiredWords = players.length * st.handCount;

const materialCount = document.getElementById('material-count');
if (materialCount) {
  materialCount.textContent =
    `📦 集まった素材：${currentWords} / ${requiredWords}個` +
    (requiredWords > 0 && currentWords >= requiredWords ? " ✅" : "");
}
      renderInputFields(st.handCount, SAMPLE_PHRASES);

      const roleBtnText = state.isSpectator ? "⚔️ プレイヤーとして途中参戦する" : "👀 見学モードに切り替える";
      if (document.getElementById('role-toggle-btn-lobby')) document.getElementById('role-toggle-btn-lobby').innerText = roleBtnText;
      if (document.getElementById('role-toggle-btn-game')) document.getElementById('role-toggle-btn-game').innerText = roleBtnText;

      // 見学者は「開始」「次へ」を押せないように、見た目でも無効化する
      const startBtn = document.getElementById('start-game-btn');
      if (startBtn) {
        startBtn.disabled = state.isSpectator;
        startBtn.style.opacity = state.isSpectator ? '0.5' : '1';
        startBtn.style.cursor = state.isSpectator ? 'not-allowed' : 'pointer';
        startBtn.innerText = state.isSpectator ? '👀 見学者は開始できません' : 'ポエム作りを開始';
      }
      const nextBtn = document.getElementById('next-game-btn');
      if (nextBtn) {
        nextBtn.disabled = state.isSpectator;
        nextBtn.style.opacity = state.isSpectator ? '0.5' : '1';
        nextBtn.style.cursor = state.isSpectator ? 'not-allowed' : 'pointer';
        nextBtn.innerText = state.isSpectator ? '👀 見学者は次へ進めません' : '🔄 新しいポエムを作る（ロビーへ戻る）';
      }

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


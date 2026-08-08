import { db } from "./firebase-config.js";
import { doc, getDoc, setDoc, onSnapshot, updateDoc, arrayUnion, arrayRemove } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import state from './poem-state.js';
import { escapeHTML, escapeJS, renderInputFields, renderHand, renderBoards } from './poem-render.js';
import { setupAutoResize } from './poem-action.js';

// Firestoreの部屋データを受け取り、画面表示を最新状態へ反映する。
// onSnapshotでの受信時と、Chrome復帰時のvisibilitychange再取得時の両方から呼ばれる共通処理。
function applyRoomData(data) {
  state.currentData = data;
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

  // 自分がこれまでに提出した素材を一覧表示する
  const myWordsEl = document.getElementById('my-submitted-words');
  if (myWordsEl) {
    const myWords = (state.currentData.words || []).filter(w => w.author === state.myName);
    if (myWords.length === 0) {
      myWordsEl.innerHTML = '';
    } else {
      const chip = 'display:inline-block; background:#eff6ff; border:1px solid #93c5fd; border-radius:6px; padding:2px 8px; font-size:12px; margin:2px;';
      myWordsEl.innerHTML = `
        <div style="margin-top:8px; font-size:13px; color:#475569;">📝 あなたが提出した素材（${myWords.length}個）</div>
        <div style="margin-top:4px;">
          ${myWords.map(w => `<span style="${chip}">${escapeHTML(w.text)}</span>`).join('')}
        </div>
      `;
    }
  }

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
}

// ブラウザがバックグラウンドから復帰したタイミングで、Firestoreの最新データを再取得して画面に反映する。
// visibilitychangeとpageshowがほぼ同時に発火する可能性があるため、isResyncingRoomで二重実行を防ぐ。
// ここでは読み取りと再描画のみを行い、ゲーム状態を変更する書き込みは一切行わない。
let isResyncingRoom = false;
async function resyncRoomFromFirestore() {
  if (!state.roomRef) return;
  if (isResyncingRoom) return;

  isResyncingRoom = true;
  try {
    const snapshot = await getDoc(state.roomRef);
    if (snapshot.exists()) {
      applyRoomData(snapshot.data());
    }
  } catch (e) {
    // 復帰時の再取得に失敗しても、既存のonSnapshot監視やゲーム操作は壊さない
    console.warn('復帰時の再同期に失敗しました:', e);
  } finally {
    isResyncingRoom = false;
  }
}

// メイン: タブ/アプリの表示・非表示切替を検知する標準API
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  resyncRoomFromFirestore();
});

// 保険: ブラウザがページをbfcacheから復元した場合(event.persisted)にも同様に再同期する
// (特定ブラウザ専用の分岐ではなく、標準のpageshowイベントを使う)
window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  resyncRoomFromFirestore();
});

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
      applyRoomData(snapshot.data());
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
    // ゲーム中の途中参戦は、まず余っている素材を使い、足りない分だけデフォルトのお題（SAMPLE_PHRASES）で自動補充する
    if (state.currentData?.status === 'playing') {
      const st = state.currentData.settings || { handCount: 5 };
      const words = state.currentData.words || [];
      const hands = state.currentData.hands || {};

      // 自分の古い手札も含めた「今どこかに配られている素材」のIDを集める
      // （↓この後で自分の手札は新しいものに上書きされるので、古い分は自然に余りへ戻る）
      const assignedIds = new Set(Object.values(hands).flat().map(w => w.id));
      const leftover = words.filter(w => !assignedIds.has(w.id));

      // ①まず余っている素材を使う
      const fromLeftover = [...leftover].sort(() => Math.random() - 0.5).slice(0, st.handCount);

      // ②余りだけでは手札枚数に足りない分を、SAMPLE_PHRASESからランダムに補充する
      const shortfall = st.handCount - fromLeftover.length;
      const filled = [];
      if (shortfall > 0) {
        const shuffledSamples = [...SAMPLE_PHRASES].sort(() => Math.random() - 0.5);
        for (let i = 0; i < shortfall; i++) {
          filled.push({
            text: shuffledSamples[i % shuffledSamples.length],
            author: "🎴お題ぶくろ",
            id: Date.now() + "_" + Math.random().toString(36).substring(2, 9)
          });
        }
      }

      // ③合計が手札枚数になった状態で配る
      const newHand = [...fromLeftover, ...filled];

      await updateDoc(state.roomRef, {
        spectators: arrayRemove(state.myName),
        players: arrayUnion(state.myName),
        [`hands.${state.myName}`]: newHand
      });
      state.isSpectator = false;
      alert(shortfall > 0
        ? `素材の余り${fromLeftover.length}枚＋お題ぶくろから${shortfall}枚を手札として配りました！プレイヤーとして参加しました！`
        : "素材の余りから手札を配りました！プレイヤーとして参加しました！");
      return;
    }

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


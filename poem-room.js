import { db } from "./firebase-config.js";
import { doc, getDoc, setDoc, onSnapshot, updateDoc, runTransaction, arrayUnion, arrayRemove } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { normalizeParticipantName, setParticipantRole, normalizeParticipantRoles, getParticipantStorageKey } from './participant-utils.js';
import state from './poem-state.js';
import { escapeHTML, escapeJS, renderInputFields, renderHand, renderBoards } from './poem-render.js';
import { setupAutoResize } from './poem-action.js';
import { removePoemWord, updatePoemSettings } from './poem-functions.js';
import { subscribeRoomHistory } from './room-history.js';
import { ensureSignedIn } from './wordset-auth.js';
import { showGameError } from './game-error.js';

async function saveParticipantRole(role) {
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(state.roomRef);
    if (!snapshot.exists()) throw new Error('ルームが見つかりません');
    transaction.update(state.roomRef, setParticipantRole(snapshot.data(), state.myName, role));
  });
}

// Firestoreの部屋データを受け取り、画面表示を最新状態へ反映する。
// onSnapshotでの受信時と、Chrome復帰時のvisibilitychange再取得時の両方から呼ばれる共通処理。
function applyRoomData(data) {
  const normalizedRoles = normalizeParticipantRoles(data);
  data = { ...data, ...normalizedRoles };
  const embeddedHistory = Array.isArray(data?.history)
    ? data.history
    : (state.legacyHistory || []);
  if (Array.isArray(data?.history)) state.legacyHistory = data.history;
  state.currentData = {
    ...data,
    history: [...embeddedHistory, ...(state.roomHistory || [])],
  };
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
      const chip = 'display:inline-flex; align-items:center; background:#f1f5f9; border:1px solid #cbd5e1; color:#1e293b; border-radius:8px; padding:6px 10px; font-size:13px; font-weight:bold; margin:2px;';
      myWordsEl.innerHTML = `
        <div style="margin-top:8px; font-size:13px; color:#475569;">📝 あなたが提出した素材（${myWords.length}個）</div>
        <div style="margin-top:4px;">
          ${myWords.map(w => `<button type="button" onclick="removeSubmittedWord('${escapeJS(w.id)}')" style="${chip} cursor:pointer;">${escapeHTML(w.text)} ×</button>`).join('')}
        </div>
        <div style="font-size:11px; color:#64748b; margin-top:4px;">取り消したい素材の「×」を押してください（ポエム開始前のみ）</div>
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
      debugShowSnapshotInfo(snapshot.data(), 'resync'); // ==== DEBUG: 確認後にこの行だけ削除 ====
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

// 手動更新ボタン: 電波状況などでリアルタイム反映が遅れているときに、
// ユーザーがボタンを押した瞬間にFirestoreから最新状態を取得して画面に反映する。
// resyncRoomFromFirestoreと同じ処理を使うため、書き込みは一切行わない。
window.manualResync = async function(where) {
  const btn = document.getElementById(where === 'game' ? 'manual-resync-btn-game' : 'manual-resync-btn-lobby');
  if (btn) { btn.disabled = true; btn.innerText = '🔄 更新中…'; }
  await resyncRoomFromFirestore();
  if (btn) { btn.disabled = false; btn.innerText = '🔄 最新の状態に更新'; }
};

export const SAMPLE_PHRASES = [
  "当て馬の男", "ショタのひざ",  
  "サイコパス", "傷だらけの降魔大聖", "画面越し",
  "食べさし", "人魚の鱗", "カリスマ", "踏切の音",
  "深夜三時のボボンガリンガ", "夜明け前", 
  "帰り道", "溶けそうな", "黒縁メガネ", "ちいかわ",
  "激しく降る横殴りの雨", "枯れたひまわり", 
  "跡部景吾", "記憶喪失", "降臨する王者"
];

// ==== DEBUG START: onSnapshot発火状況の確認用（確認が終わったらこのブロックごと削除） ====
// Firestore・ゲームロジックには一切書き込まない。普段は右下の小さいボタンだけを表示し、
// タップしたときだけログを開くので、画面下の入力欄やボタンを隠さないようにしている。
// ログはこの端末のlocalStorageに保存され、ページを閉じたり開き直したりしても消えない。
const DEBUG_LOG_KEY = 'poemDebugSnapshotLog';
const DEBUG_LOG_MAX = 200;

function debugLoadLog() {
  try {
    return JSON.parse(localStorage.getItem(DEBUG_LOG_KEY) || '[]');
  } catch (e) {
    return [];
  }
}
function debugSaveLog(lines) {
  try {
    localStorage.setItem(DEBUG_LOG_KEY, JSON.stringify(lines.slice(0, DEBUG_LOG_MAX)));
  } catch (e) {
    // 保存に失敗しても画面表示は続ける
  }
}

function debugEnsureUI() {
  if (document.getElementById('debug-snapshot-toggle')) return;

  const btn = document.createElement('button');
  btn.id = 'debug-snapshot-toggle';
  btn.innerText = `🐛 ログ(${debugLoadLog().length})`;
  btn.style.cssText = 'position:fixed; bottom:8px; right:8px; z-index:100000; font-size:11px; padding:6px 10px; background:#111; color:#0f0; border:1px solid #0f0; border-radius:6px;';

  const panel = document.createElement('div');
  panel.id = 'debug-snapshot-panel';
  panel.style.cssText = 'position:fixed; bottom:44px; left:8px; right:8px; max-height:30vh; overflow-y:auto; background:rgba(0,0,0,0.9); color:#0f0; font-size:11px; font-family:monospace; padding:8px; z-index:99999; white-space:pre-wrap; border-radius:6px; display:none;';

  const toolbar = document.createElement('div');
  toolbar.style.cssText = 'position:fixed; bottom:44px; left:8px; right:8px; display:none; gap:6px; z-index:100001; transform:translateY(-100%); padding-bottom:4px;';
  toolbar.id = 'debug-snapshot-toolbar';

  const copyBtn = document.createElement('button');
  copyBtn.innerText = '📋 コピー';
  copyBtn.style.cssText = 'font-size:11px; padding:4px 8px; background:#0369a1; color:#fff; border:none; border-radius:6px;';
  copyBtn.onclick = async () => {
    const text = debugLoadLog().join('\n');
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.innerText = '✅ コピーした！';
      setTimeout(() => { copyBtn.innerText = '📋 コピー'; }, 1500);
    } catch (e) {
      alert('コピーに失敗しました。ログを長押しして手動で選択・コピーしてください。');
    }
  };

  const clearBtn = document.createElement('button');
  clearBtn.innerText = '🗑 ログを消す';
  clearBtn.style.cssText = 'font-size:11px; padding:4px 8px; background:#b91c1c; color:#fff; border:none; border-radius:6px;';
  clearBtn.onclick = () => {
    debugSaveLog([]);
    panel.textContent = '';
    document.getElementById('debug-snapshot-toggle').innerText = '🐛 ログ(0)';
  };

  toolbar.appendChild(copyBtn);
  toolbar.appendChild(clearBtn);

  btn.onclick = () => {
    const showing = panel.style.display !== 'none';
    panel.style.display = showing ? 'none' : 'block';
    toolbar.style.display = showing ? 'none' : 'flex';
  };

  document.body.appendChild(panel);
  document.body.appendChild(toolbar);
  document.body.appendChild(btn);

  panel.textContent = debugLoadLog().join('\n');
}
function debugRecordError(error, source = 'unknown') {
  debugEnsureUI();
  const code = error?.code || 'no-code';
  const message = error?.message || String(error);
  const lines = debugLoadLog();
  lines.unshift(`[${new Date().toLocaleTimeString()}] [error:${source}] code=${code} message=${message}`);
  debugSaveLog(lines);
  const panel = document.getElementById('debug-snapshot-panel');
  if (panel) panel.textContent = lines.slice(0, DEBUG_LOG_MAX).join('\n');
  const btn = document.getElementById('debug-snapshot-toggle');
  if (btn) btn.innerText = `🐛 ログ(${Math.min(lines.length, DEBUG_LOG_MAX)})`;
  console.error(`[${source}]`, error);
}
function debugShowSnapshotInfo(data, source = 'onSnapshot') {
  debugEnsureUI();
  const time = new Date().toLocaleTimeString();
  const lines = debugLoadLog();
  lines.unshift(`[${time}] [${source}] players=${JSON.stringify(data?.players)} spectators=${JSON.stringify(data?.spectators)}`);
  debugSaveLog(lines);
  const panel = document.getElementById('debug-snapshot-panel');
  if (panel) panel.textContent = lines.slice(0, DEBUG_LOG_MAX).join('\n');
  const btn = document.getElementById('debug-snapshot-toggle');
  if (btn) btn.innerText = `🐛 ログ(${Math.min(lines.length, DEBUG_LOG_MAX)})`;
}
// ==== DEBUG END ====

window.joinRoom = async function() {
  let currentUser;
  try {
    currentUser = await ensureSignedIn();
  } catch (e) {
    return alert('認証に失敗しました。ページを再読み込みしてください: ' + e.message);
  }

  const nameInput = document.getElementById('player-name');
  const roomInput = document.getElementById('room-id');
  
  if (!nameInput || !roomInput) {
    return alert('入力フォームの要素が見つかりません');
  }

  state.myUid = currentUser.uid;
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
    schemaVersion: 2,
    status: "lobby",
    roundCount: 1,
    words: [],
    hands: {},
    poems: {},
    settings: { handCount: 5 },
    players: [],
    spectators: [],
    participantUids: { [currentUser.uid]: state.myName }
  };

  if (state.isSpectator) {
    initialData.spectators = [state.myName];
  } else {
    initialData.players = [state.myName];
  }

  await setDoc(state.roomRef, initialData);

} else {

  // 見学モードで再入室した場合はplayersから、プレイヤーとして再入室した場合はspectatorsから、
  // 前回いた側の名前を確実に消す。片方だけarrayUnionすると、以前と逆の役割で入り直した人が
  // players/spectators両方に名前が残ったままになる（見学モード切替時の不整合の原因だった）。
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(state.roomRef);
    if (!snapshot.exists()) throw new Error('ルームが見つかりません');
    const data = snapshot.data() || {};
    const roles = setParticipantRole(data, state.myName, state.isSpectator ? 'spectator' : 'player');
    const update = { ...roles };
    if (data.participantUids && typeof data.participantUids === 'object') {
      update.participantUids = { ...data.participantUids, [currentUser.uid]: state.myName };
    }
    transaction.update(state.roomRef, update);
  });

}

    document.getElementById('login-sec').style.display = 'none';
    document.getElementById('lobby-sec').style.display = 'block';

    onSnapshot(state.roomRef, (snapshot) => {
      debugShowSnapshotInfo(snapshot.data()); // ==== DEBUG: 確認後にこの行だけ削除 ====
      applyRoomData(snapshot.data());
    }, (error) => {
      debugRecordError(error, 'room-onSnapshot');
    });
    state.roomHistory = [];
    state.legacyHistory = [];
    subscribeRoomHistory(state.roomRef, (history) => {
      state.roomHistory = history;
      if (state.currentData) {
        const roomData = { ...state.currentData };
        delete roomData.history;
        applyRoomData(roomData);
      }
    }, (error) => {
      debugRecordError(error, 'history-onSnapshot');
      showGameError(error, '履歴の読み込み');
    });
  } catch (e) {
    debugRecordError(e, 'joinRoom');
    alert('接続エラー: ' + e.message);
  }
};

window.updateHandCountSetting = async function() {
  if (!state.roomRef) return;
  const count = parseInt(document.getElementById('set-hand-count').value) || 5;
  if (state.currentData?.schemaVersion === 2) {
    await updatePoemSettings(state.roomId, count);
  } else {
    await updateDoc(state.roomRef, { "settings.handCount": count });
  }
};

window.removeSubmittedWord = async function(wordId) {
  if (!state.roomRef || !state.currentData) return;
  if (state.currentData.status !== 'lobby') return alert('素材の取り消しはポエム開始前のみできます');
  const target = (state.currentData.words || []).find(w => w.id === wordId && w.author === state.myName);
  if (!target) return alert('この素材は取り消せません');
  if (!confirm(`「${target.text}」を取り消しますか？`)) return;
  try {
    if (state.currentData.schemaVersion === 2) {
      await removePoemWord(state.roomId, wordId);
    } else {
      await updateDoc(state.roomRef, { words: arrayRemove(target) });
    }
  } catch (e) {
    debugRecordError(e, 'remove-submitted-word');
    showGameError(e, '素材の取り消し');
  }
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

    await saveParticipantRole('player');
    state.isSpectator = false;
    alert("プレイヤーとして参加しました！");
  } else {
    await saveParticipantRole('spectator');
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


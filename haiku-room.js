import { db } from "./firebase-config.js";
import { doc, getDoc, setDoc, onSnapshot, updateDoc, arrayUnion, arrayRemove } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import state from './haiku-state.js';
import { escapeHTML, escapeJS } from './haiku-utils.js';
import { renderInputFields, renderHand, renderBoards } from './haiku-render.js';
import { subscribeRoomHistory } from './room-history.js';
import { ensureSignedIn } from './wordset-auth.js';
import { showGameError } from './game-error.js';

let previousStatus = null; // 直前のstatusを記録し、「lobbyに遷移した瞬間」だけ入力欄をクリアするために使う

// Firestoreの部屋データを受け取り、画面表示を最新状態へ反映する。
// onSnapshotでの受信時と、Chrome復帰時のvisibilitychange再取得時の両方から呼ばれる共通処理。
function applyRoomData(data) {
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

  const currentHost = players.includes(state.currentData.currentHost) ? state.currentData.currentHost : (players[0] || '未設定');
  const hostText = `👑 今節の選者（親）: <strong>${escapeHTML(currentHost)}</strong> ${currentHost === state.myName ? '（あなた）' : ''}`;

  if (document.getElementById('host-info-lobby')) document.getElementById('host-info-lobby').innerHTML = hostText;
  if (document.getElementById('host-info-game')) document.getElementById('host-info-game').innerHTML = hostText;

  const roleBtnText = state.isSpectator ? "⚔️ プレイヤーとして途中参戦する" : "👀 見学モードに切り替える";
  if (document.getElementById('role-toggle-btn-lobby')) document.getElementById('role-toggle-btn-lobby').innerText = roleBtnText;

  // ラウンド中は選者本人だけ、見学モードへの切り替えボタンを無効化する
  const isHostDuringPlaying = state.currentData.status === 'playing' && !state.isSpectator && state.myName === currentHost;
  const gameRoleBtn = document.getElementById('role-toggle-btn-game');
  if (gameRoleBtn) {
    gameRoleBtn.innerText = isHostDuringPlaying ? "👑 選者はラウンド中切替不可" : roleBtnText;
    gameRoleBtn.disabled = isHostDuringPlaying;
    gameRoleBtn.style.opacity = isHostDuringPlaying ? '0.5' : '1';
    gameRoleBtn.style.cursor = isHostDuringPlaying ? 'not-allowed' : 'pointer';
  }

  const st = state.currentData.settings || { hand5: 5, hand7: 3, carryOver: true };
  if (document.getElementById('set-hand-5')) document.getElementById('set-hand-5').value = st.hand5;
  if (document.getElementById('set-hand-7')) document.getElementById('set-hand-7').value = st.hand7;
  if (document.getElementById('set-carry-over')) document.getElementById('set-carry-over').checked = st.carryOver !== false;

  renderInputFields(st.hand5, st.hand7);
  if (document.getElementById('total-words-5')) document.getElementById('total-words-5').innerText = state.currentData.words5?.length || 0;
  if (document.getElementById('total-words-7')) document.getElementById('total-words-7').innerText = state.currentData.words7?.length || 0;

  // 自分がこれまでに提出した素材を一覧表示する
  const myWordsEl = document.getElementById('my-submitted-words');
  if (myWordsEl) {
    const myWords5 = (state.currentData.words5 || []).filter(w => w.author === state.myName);
    const myWords7 = (state.currentData.words7 || []).filter(w => w.author === state.myName);
    if (myWords5.length === 0 && myWords7.length === 0) {
      myWordsEl.innerHTML = '';
    } else {
      const chip5 = 'display:inline-block; background:#eff6ff; border:1px solid #93c5fd; border-radius:6px; padding:2px 8px; font-size:12px; margin:2px;';
      const chip7 = 'display:inline-block; background:#fefce8; border:1px solid #fde047; border-radius:6px; padding:2px 8px; font-size:12px; margin:2px;';
      myWordsEl.innerHTML = `
        <div style="margin-top:8px; font-size:13px; color:#475569;">📝 あなたが提出した素材（五音${myWords5.length}個・七音${myWords7.length}個）</div>
        <div style="margin-top:4px;">
          ${myWords5.map(w => `<span style="${chip5}">${escapeHTML(w.text)}</span>`).join('')}
          ${myWords7.map(w => `<span style="${chip7}">${escapeHTML(w.text)}</span>`).join('')}
        </div>
      `;
    }
  }

  const scores = state.currentData.scores || {};
  let playerListHtml = players.map((p) => `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
      <span>・ ${escapeHTML(p)} ${p === currentHost ? '<span class="role-badge">選者（親）</span>' : ''}</span>
      <div>
        <span class="score-badge" style="margin-right:8px;">${scores[p] || 0} 誉</span>
        <button onclick="removePlayer('${escapeJS(p)}')" style="width:auto; margin:0; padding:4px 8px; font-size:12px; background-color:#ef4444;">鯖落ち</button>
      </div>
    </div>
  `).join('');

  if (spectators.length > 0) {
    playerListHtml += `<div style="font-size:12px; color:#64748b; margin-top:8px;">👀 見学者: ${spectators.map(s => escapeHTML(s)).join(', ')}</div>`;
  }

  if (document.getElementById('player-list')) document.getElementById('player-list').innerHTML = playerListHtml;

  if (state.currentData.status === 'lobby') {
    if (document.getElementById('game-sec')) document.getElementById('game-sec').style.display = 'none';
    if (document.getElementById('lobby-sec')) document.getElementById('lobby-sec').style.display = 'block';

    // 他の状態(playing等)からlobbyに遷移した瞬間だけリセットする。
    // status===lobbyのまま毎回ここを通すと、他プレイヤーの素材提出などで
    // onSnapshotが発火するたびに、自分が入力中の素材まで消えてしまうため。
    if (previousStatus !== 'lobby') {
      state.myHand5 = []; state.myHand7 = []; state.selectedHand = [null, null, null];
      state.redrawSelected5 = []; state.redrawSelected7 = [];

      // ロビーに戻ったら、一時保存していた手札データを消す
      sessionStorage.removeItem('haikuSelectedHand');

      ['5', '7'].forEach(type => {
        const container = document.getElementById(`inputs-${type}-container`);
        if (container) {
          container.querySelectorAll('input').forEach(inp => inp.value = '');
        }
      });
      const addBtn = document.getElementById('add-word-btn');
      if (addBtn) addBtn.innerText = '素材を提出する';
    }

  } else if (state.currentData.status === 'playing') {
    if (document.getElementById('lobby-sec')) document.getElementById('lobby-sec').style.display = 'none';
    if (document.getElementById('game-sec')) document.getElementById('game-sec').style.display = 'block';
    if (state.currentData.hands5?.[state.myName]) state.myHand5 = state.currentData.hands5[state.myName];
    if (state.currentData.hands7?.[state.myName]) state.myHand7 = state.currentData.hands7[state.myName];
    renderHand();
    renderBoards();
  }

  previousStatus = state.currentData.status;
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

// ==== DEBUG START: onSnapshot発火状況の確認用（確認が終わったらこのブロックごと削除） ====
// Firestore・ゲームロジックには一切書き込まない。普段は右下の小さいボタンだけを表示し、
// タップしたときだけログを開くので、画面下の入力欄やボタンを隠さないようにしている。
// ログはこの端末のlocalStorageに保存され、ページを閉じたり開き直したりしても消えない。
const DEBUG_LOG_KEY = 'haikuDebugSnapshotLog';
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
  try {
    await ensureSignedIn();
  } catch (e) {
    return alert('認証に失敗しました。ページを再読み込みしてください: ' + e.message);
  }

  state.myName = document.getElementById('player-name')?.value.trim() || "";
  state.roomId = document.getElementById('room-id')?.value.trim() || "";
  const specCheck = document.getElementById('spectator-check');
  state.isSpectator = specCheck ? specCheck.checked : false;

  if (!state.myName || !state.roomId) return alert('名前とルームIDを入力してください');

  try {
    state.roomRef = doc(db, "rooms", "haiku_" + state.roomId);

const roomSnapshot = await getDoc(state.roomRef);

if (!roomSnapshot.exists()) {
  const initialData = {
    status: "lobby",
    currentHost: state.isSpectator ? '' : state.myName,
    roundCount: 1,
    words5: [],
    words7: [],
    hands5: {},
    hands7: {},
    phrases: {},
    phraseDetails: {},
    votes: {},
    scores: {},
    selfPraise: {},
    settings: {
      hand5: 5,
      hand7: 3,
      carryOver: true
    },
    players: [],
    spectators: [],
    redraws: {}
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
  if (state.isSpectator) {
    await updateDoc(state.roomRef, {
      spectators: arrayUnion(state.myName),
      players: arrayRemove(state.myName)
    });
  } else {
    await updateDoc(state.roomRef, {
      players: arrayUnion(state.myName),
      spectators: arrayRemove(state.myName)
    });
  }
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
    alert('接続エラーが発生しました: ' + e.message);
  }
};
window.toggleRole = async function() {
  if (!state.roomRef) return;
  if (state.isSpectator) {
    // ゲーム中の途中参戦は、山札(deck5/deck7)に手札分の余りがあるときだけ許可する
    if (state.currentData?.status === 'playing') {
      const st = state.currentData.settings || { hand5: 5, hand7: 3 };
      const deck5 = state.currentData.deck5 || [];
      const deck7 = state.currentData.deck7 || [];

      // 五音・七音のどちらかだけ配って中途半端にならないよう、両方揃っているか先に確認する
      if (deck5.length < st.hand5 || deck7.length < st.hand7) {
        return alert(`途中参戦できません。山札に配るための素材が足りていません。\n（五音: 山札残り${deck5.length}個 / 必要${st.hand5}個、七音: 山札残り${deck7.length}個 / 必要${st.hand7}個）`);
      }

      // 山札から直接、途中参戦者の手札を引く
      const shuffled5 = [...deck5].sort(() => Math.random() - 0.5);
      const shuffled7 = [...deck7].sort(() => Math.random() - 0.5);
      const newHand5 = shuffled5.slice(0, st.hand5);
      const newHand7 = shuffled7.slice(0, st.hand7);
      const drawnIds5 = new Set(newHand5.map(w => w.id));
      const drawnIds7 = new Set(newHand7.map(w => w.id));

      // 配った札は必ず山札から取り除く（他の誰かの引き直しと重複しないようにするため）
      const newDeck5 = deck5.filter(w => !drawnIds5.has(w.id));
      const newDeck7 = deck7.filter(w => !drawnIds7.has(w.id));

      await updateDoc(state.roomRef, {
        spectators: arrayRemove(state.myName),
        players: arrayUnion(state.myName),
        [`hands5.${state.myName}`]: newHand5,
        [`hands7.${state.myName}`]: newHand7,
        deck5: newDeck5,
        deck7: newDeck7
      });
      state.isSpectator = false;
      alert("山札から手札を配りました！プレイヤーとして参加しました！");
      return;
    }

    await updateDoc(state.roomRef, {
      spectators: arrayRemove(state.myName),
      players: arrayUnion(state.myName)
    });
    state.isSpectator = false;
    alert("プレイヤーとして参加しました！");
  } else {
    // ラウンド中に選者本人が見学モードへ切り替わると、進行が止まってしまうため、選者本人の切り替えを禁止する
    if (state.currentData?.status === 'playing') {
      const players = state.currentData.players || [];
      const currentHost = players.includes(state.currentData.currentHost) ? state.currentData.currentHost : (players[0] || '');
      if (state.myName === currentHost) {
        return alert('今節の選者（親）はラウンド中に見学モードへ切り替えられません。\n次の節に進んでから切り替えてください。');
      }
    }

    const currentPlayers = state.currentData?.players || [];
    const currentHost = currentPlayers.includes(state.currentData?.currentHost)
      ? state.currentData.currentHost
      : (currentPlayers[0] || '');
    const remainingPlayers = currentPlayers.filter((player) => player !== state.myName);
    const nextHost = currentHost === state.myName
      ? (remainingPlayers[0] || '')
      : currentHost;

    await updateDoc(state.roomRef, {
      players: arrayRemove(state.myName),
      spectators: arrayUnion(state.myName),
      currentHost: nextHost
    });
    state.isSpectator = true;
    alert("見学モードに切り替えました！");
  }
};
window.updateSettings = async function() {
  if (!state.roomRef) return;
  await updateDoc(state.roomRef, {
    settings: {
      hand5: parseInt(document.getElementById('set-hand-5').value) || 5,
      hand7: parseInt(document.getElementById('set-hand-7').value) || 3,
      carryOver: document.getElementById('set-carry-over')?.checked ?? true
    }
  });
};
window.removePlayer = async function(pName) {
  if (confirm(`${pName} さんを退出させますか？`)) {
    const currentPlayers = state.currentData?.players || [];
    const currentHost = currentPlayers.includes(state.currentData?.currentHost)
      ? state.currentData.currentHost
      : (currentPlayers[0] || '');
    const remainingPlayers = currentPlayers.filter((player) => player !== pName);
    const nextHost = currentHost === pName || !remainingPlayers.includes(currentHost)
      ? (remainingPlayers[0] || '')
      : currentHost;

    await updateDoc(state.roomRef, {
      players: arrayRemove(pName),
      spectators: arrayRemove(pName),
      currentHost: nextHost
    });
  }
};

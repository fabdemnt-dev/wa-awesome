import { db } from "./firebase-config.js";
import { doc, getDoc, setDoc, onSnapshot, updateDoc, runTransaction, serverTimestamp, arrayUnion, arrayRemove } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import state from './haiku-state.js';
import { escapeHTML, escapeJS } from './haiku-utils.js';
import { renderInputFields, renderHand, renderBoards } from './haiku-render.js';
import { subscribeRoomHistory } from './room-history.js';
import { ensureSignedIn } from './wordset-auth.js';
import { showGameError } from './game-error.js';
import { defaultWords5, defaultWords7 } from './haiku-default-words.js';
import { normalizeParticipantName, setParticipantRole, normalizeParticipantRoles, getParticipantStorageKey, canClaimHost } from './participant-utils.js';
import { changeHaikuRole } from './haiku-functions.js';

async function saveParticipantRole(role) {
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(state.roomRef);
    if (!snapshot.exists()) throw new Error('ルームが見つかりません');
    transaction.update(state.roomRef, setParticipantRole(snapshot.data(), state.myName, role));
  });
}

let previousStatus = null; // 直前のstatusを記録し、「lobbyに遷移した瞬間」だけ入力欄をクリアするために使う
let handUnsubscribe = null;
let handSubscriptionKey = '';

function subscribeOwnHand(data) {
  if (!state.roomRef || !state.myUid || data?.schemaVersion !== 2 || data.status !== 'playing') {
    if (handUnsubscribe) handUnsubscribe();
    handUnsubscribe = null;
    handSubscriptionKey = '';
    return;
  }
  const key = `${state.roomRef.path}/hands/${state.myUid}`;
  if (handSubscriptionKey === key) return;
  if (handUnsubscribe) handUnsubscribe();
  handSubscriptionKey = key;
  handUnsubscribe = onSnapshot(doc(state.roomRef, 'hands', state.myUid), (snapshot) => {
    const hand = snapshot.exists() ? snapshot.data() : {};
    state.myHand5 = Array.isArray(hand.hand5) ? hand.hand5 : [];
    state.myHand7 = Array.isArray(hand.hand7) ? hand.hand7 : [];
    state.redrawUsed = hand.redrawUsed === true;
    renderHand();
    renderBoards();
  }, (error) => {
    debugRecordError(error, 'hand-onSnapshot');
  });
}
function refreshHostRecoveryUI() {
  const data = state.currentData;
  const players = data?.players || [];
  const currentHost = players.includes(data?.currentHost) ? data.currentHost : (players[0] || '');
  const isPlaying = data?.status === 'playing';
  const canTakeover = canClaimHost(data, state.myName, state.isSpectator);
  const hostRecoveryBtn = document.getElementById('host-recovery-btn');
  if (hostRecoveryBtn) {
    hostRecoveryBtn.style.display = isPlaying ? 'block' : 'none';
    hostRecoveryBtn.disabled = !canTakeover;
    hostRecoveryBtn.style.opacity = canTakeover ? '1' : '0.55';
    hostRecoveryBtn.style.cursor = canTakeover ? 'pointer' : 'not-allowed';
    hostRecoveryBtn.innerText = state.isSpectator
      ? '親を引き継ぐ（プレイヤーのみ）'
      : currentHost === state.myName
        ? '親を引き継ぐ（現在あなたが親です）'
        : '親を引き継ぐ';
  }

  const nextHint = document.getElementById('next-round-hint');
  if (nextHint) {
    nextHint.style.display = isPlaying ? 'block' : 'none';
    nextHint.innerText = '※押すと最新のルーム状態を確認し、確認後に親を引き継ぎます（プレイヤーのみ）';
  }
}

window.claimHost = async function() {
  if (!state.roomRef || state.isSpectator) return;
  if (state.currentData?.status !== 'playing') return;
  if (!confirm('親が不在・操作不能になったことを確認しましたか？\n引き継ぐと、あなたが新しい親になり、次の節へ進めるようになります。')) return;

  try {
    const claimed = await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(state.roomRef);
      const data = snapshot.data() || {};
      if (!canClaimHost(data, state.myName, state.isSpectator)) {
        return false;
      }

      const nextHost = state.myName;
      if (!nextHost) return false;
      const nextHostUid = Object.entries(data.participantUids || {})
        .find(([, name]) => name === nextHost)?.[0] || '';
      transaction.update(state.roomRef, {
        currentHost: nextHost,
        ...(data.schemaVersion === 2 ? { currentHostUid: nextHostUid } : {})
      });
      return nextHost === state.myName;
    });

    if (claimed) {
      alert('あなたが新しい親になりました。');
    } else {
      alert('別の参加者が先に親を引き継いだか、親が復帰しました。画面を更新してください。');
    }
  } catch (error) {
    debugRecordError(error, 'claim-host');
    showGameError(error, '親の引き継ぎ');
  }
};

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

  subscribeOwnHand(state.currentData);

  const currentHost = players.includes(state.currentData.currentHost) ? state.currentData.currentHost : (players[0] || '未設定');
  const hostText = `👑 今節の選者（親）: <strong>${escapeHTML(currentHost)}</strong> ${currentHost === state.myName ? '（あなた）' : ''}`;


  refreshHostRecoveryUI();

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
      const chip5 = 'display:inline-block; background:#eff6ff; border:1px solid #93c5fd; color:#1e293b; border-radius:8px; padding:6px 10px; font-size:13px; font-weight:bold; margin:2px;';
      const chip7 = 'display:inline-block; background:#fefce8; border:1px solid #fde047; color:#1e293b; border-radius:8px; padding:6px 10px; font-size:13px; font-weight:bold; margin:2px;';
      myWordsEl.innerHTML = `
        <div style="margin-top:8px; font-size:13px; color:#475569;">📝 あなたが提出した素材（五音${myWords5.length}個・七音${myWords7.length}個）</div>
        <div style="margin-top:4px;">
          ${myWords5.map(w => `<button type="button" onclick="removeSubmittedWord('5','${escapeJS(w.id)}')" style="${chip5} cursor:pointer;">${escapeHTML(w.text)} <span style="color:#94a3b8;">×</span></button>`).join('')}
          ${myWords7.map(w => `<button type="button" onclick="removeSubmittedWord('7','${escapeJS(w.id)}')" style="${chip7} cursor:pointer;">${escapeHTML(w.text)} <span style="color:#94a3b8;">×</span></button>`).join('')}
        </div>
        <div style="font-size:11px; color:#64748b; margin-top:4px;">取り消したい素材の「×」を押してください（句会開始前のみ）</div>
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
    const storageKey = getParticipantStorageKey(state.currentData, state.myUid, state.myName);
    if (state.currentData.schemaVersion !== 2) {
      if (state.currentData.hands5?.[storageKey]) state.myHand5 = state.currentData.hands5[storageKey];
      if (state.currentData.hands7?.[storageKey]) state.myHand7 = state.currentData.hands7[storageKey];
      renderHand();
    }
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
  let currentUser;
  try {
    currentUser = await ensureSignedIn();
  } catch (e) {
    return alert('認証に失敗しました。ページを再読み込みしてください: ' + e.message);
  }

  state.myUid = currentUser.uid;
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
      schemaVersion: 2,
      status: "lobby",
      currentHost: state.isSpectator ? '' : state.myName,
      currentHostUid: state.isSpectator ? '' : currentUser.uid,
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
    redraws: {},
    participantUids: { [currentUser.uid]: state.myName }
  };

  if (state.isSpectator) {
    initialData.spectators = [state.myName];
  } else {
    initialData.players = [state.myName];
  }

  await setDoc(state.roomRef, initialData);
} else {
  const role = state.isSpectator ? 'spectator' : 'player';
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(state.roomRef);
    if (!snapshot.exists()) throw new Error('ルームが見つかりません');
    const data = snapshot.data() || {};
    const roles = setParticipantRole(data, state.myName, role);
    const update = { ...roles };
    if (data.participantUids && typeof data.participantUids === 'object') {
      const participantUids = Object.fromEntries(
        Object.entries(data.participantUids).filter(([uid, name]) => name !== state.myName || uid === currentUser.uid)
      );
      participantUids[currentUser.uid] = state.myName;
      update.participantUids = participantUids;
      if (data.schemaVersion === 2 && data.currentHost === state.myName) {
        update.currentHostUid = currentUser.uid;
      }
    }
    if (role === 'player' && !data.currentHost) {
      update.currentHost = state.myName;
      if (data.schemaVersion === 2) update.currentHostUid = currentUser.uid;
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
    alert('接続エラーが発生しました: ' + e.message);
  }
};
window.removeSubmittedWord = async function(type, wordId) {
  if (!state.roomRef || !state.currentData) return;
  if (state.currentData.status !== 'lobby') return alert('素材の取り消しは句会開始前のみできます');
  const field = type === '5' ? 'words5' : 'words7';
  const target = (state.currentData[field] || []).find(w => w.id === wordId && w.author === state.myName);
  if (!target) return alert('この素材は取り消せません');
  if (!confirm(`「${target.text}」を取り消しますか？`)) return;
  try {
    await updateDoc(state.roomRef, { [field]: arrayRemove(target) });
  } catch (e) {
    debugRecordError(e, 'remove-submitted-word');
    showGameError(e, '素材の取り消し');
  }
};

window.toggleRole = async function() {
  if (!state.roomRef) return;
  if (state.isSpectator) {
    // ゲーム中の途中参戦は、本人の手札分と引き直し用の予備を山札に確保してから配る。
    if (state.currentData?.status === 'playing') {
      const st = state.currentData.settings || { hand5: 5, hand7: 3 };
      const players = state.currentData.players || [];
      let deck5 = [...(state.currentData.deck5 || [])];
      let deck7 = [...(state.currentData.deck7 || [])];
      const selectedPool5 = state.currentData.supplementPool5?.length ? state.currentData.supplementPool5 : defaultWords5;
      const selectedPool7 = state.currentData.supplementPool7?.length ? state.currentData.supplementPool7 : defaultWords7;
      const supplementAuthorLabel = state.currentData.supplementAuthorLabel || '🎴お題ぶくろ';
      const makeDefaultCards = (pool, fallbackPool, count) => {
        const sourcePool = pool.length ? pool : fallbackPool;
        if (count <= 0 || sourcePool.length === 0) return [];
        const shuffled = [...sourcePool].sort(() => Math.random() - 0.5);
        return Array.from({ length: count }, (_, index) => ({
          text: shuffled[index % shuffled.length],
          author: supplementAuthorLabel,
          id: `${Date.now()}_${Math.random().toString(36).substring(2, 9)}_${index}`
        }));
      };



      // 途中参加後の全プレイヤーが1回、手札を全て引き直しても不足しないようにする。
      // 配布後に「参加者全員分の手札1回分」が山札に残る必要があるため、
      // 配布前は「現在のプレイヤー数＋新規参加者＋引き直し分」の量を確保する。
      const reserve5 = (players.length + 2) * st.hand5;
      const reserve7 = (players.length + 2) * st.hand7;
      const add5 = makeDefaultCards(selectedPool5, defaultWords5, Math.max(0, reserve5 - deck5.length));
      const add7 = makeDefaultCards(selectedPool7, defaultWords7, Math.max(0, reserve7 - deck7.length));
      deck5.push(...add5);
      deck7.push(...add7);

      const shuffled5 = [...deck5].sort(() => Math.random() - 0.5);
      const shuffled7 = [...deck7].sort(() => Math.random() - 0.5);
      const newHand5 = shuffled5.slice(0, st.hand5);
      const newHand7 = shuffled7.slice(0, st.hand7);
      const drawnIds5 = new Set(newHand5.map(w => w.id));
      const drawnIds7 = new Set(newHand7.map(w => w.id));
      // 配った札は山札から取り除き、残りは途中参加者・既存プレイヤーの引き直しに使う。
      const newDeck5 = deck5.filter(w => !drawnIds5.has(w.id));
      const newDeck7 = deck7.filter(w => !drawnIds7.has(w.id));
      await changeHaikuRole(state.roomId, 'player', add5, add7);
      state.isSpectator = false;
      const addedMessage = (add5.length || add7.length)
        ? `\nデフォルト素材を五音${add5.length}個・七音${add7.length}個、山札へ補充しました。`
        : '';
      alert(`山札から手札を配りました！プレイヤーとして参加しました！${addedMessage}`);
      return;
    }

    if (state.currentData?.schemaVersion === 2) {
      await changeHaikuRole(state.roomId, 'player');
    } else {
      await saveParticipantRole('player');
    }
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

    if (state.currentData?.schemaVersion === 2) {
      await changeHaikuRole(state.roomId, 'spectator');
    } else {
      await saveParticipantRole('spectator');
    }
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
    await updateDoc(state.roomRef, { players: arrayRemove(pName), spectators: arrayRemove(pName) });
  }
};

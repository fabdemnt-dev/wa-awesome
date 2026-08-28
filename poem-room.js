import { db } from "./firebase-config.js";
import { doc, getDocFromServer, setDoc, onSnapshot, updateDoc, runTransaction, arrayUnion, arrayRemove } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { normalizeParticipantName, setParticipantRole, normalizeParticipantRoles, getParticipantStorageKey } from './participant-utils.js';
import state from './poem-state.js';
import { escapeHTML, escapeJS, renderInputFields, renderHand, renderBoards } from './poem-render.js';
import { setupAutoResize } from './poem-action.js';
import { removePoemWord, updatePoemSettings, removePlayer as removePlayerSecure, changePoemRole } from './poem-functions.js';
import { subscribeRoomHistory } from './room-history.js';
import { ensureSignedIn } from './wordset-auth.js';
import { showGameError } from './game-error.js';

function updatePhaseStatus(data) {
  const lobbyText = data?.status === 'lobby' ? '素材準備中' : '';
  let gameText = '';
  if (data?.status === 'playing') {
    const players = data.players || [];
    const poems = data.poems || {};
    const submitted = Object.keys(poems).length;
    const unrevealed = Object.values(poems).filter(poem => !poem?.revealed).length;
    if (submitted < players.length) gameText = 'ポエムを作成中';
    else if (unrevealed > 0) gameText = '作品を披露中';
    else gameText = '作品を鑑賞中';
  }
  const setStatus = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text ? `現在のフェーズ：${text}` : '';
  };
  setStatus('phase-status-lobby', lobbyText);
  setStatus('phase-status-game', gameText);
}

function updateSubmissionStatus(data) {
  const players = data?.players || [];
  const participantUids = data?.participantUids || {};
  const uidFor = name => Object.entries(participantUids).find(([, value]) => value === name)?.[0];
  const wordsFor = name => (data?.words || []).some(word => word?.author === name);
  const poemFor = name => {
    const uid = uidFor(name);
    const poems = data?.poems || {};
    return (uid && poems[uid] !== undefined) || poems[name] !== undefined;
  };
  const render = (id, label, doneText, doneFor) => {
    const el = document.getElementById(id);
    if (!el || !players.length) return;
    const submittedCount = players.filter(doneFor).length;
    el.innerHTML = `<div class="submission-status-line" aria-live="polite">${label}：${submittedCount}/${players.length} ${doneText}</div>`;
  };
  render('submission-status-lobby', '素材の提出状況', '提出済み', wordsFor);
  render('submission-status-game', '作品の提出状況', '投稿済み', poemFor);
}

function updateRoleHelp(data) {
  const role = state.isSpectator ? '見学者' : 'プレイヤー';
  const text = data?.status === 'lobby'
    ? (state.isSpectator ? '見学者：参加者の準備状況を確認できます。素材投稿や開始操作はできません。' : 'プレイヤー：素材を投稿し、準備ができたらポエム作りを開始できます。')
    : (state.isSpectator ? '見学者：作品の披露とリアクションを楽しめます。ゲーム操作はできません。' : 'プレイヤー：ポエムを投稿し、みんなの作品を鑑賞できます。');
  ['role-help-lobby', 'role-help-game'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = `<strong>あなたの役割：${role}</strong><br>${text}`;
  });
}

const initialRoomId = new URLSearchParams(window.location.search).get('room')?.trim() || '';
document.addEventListener('DOMContentLoaded', () => {
  const roomInput = document.getElementById('room-id');
  if (roomInput && initialRoomId && !roomInput.value) roomInput.value = initialRoomId;
});

async function saveParticipantRole(role) {
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(state.roomRef);
    if (!snapshot.exists()) throw new Error('ルームが見つかりません');
    transaction.update(state.roomRef, setParticipantRole(snapshot.data(), state.myName, role));
  });
}

// Firestoreの部屋データを受け取り、画面表示を最新状態へ反映する。
// onSnapshotでの受信時と、Chrome復帰時のvisibilitychange再取得時の両方から呼ばれる共通処理。
let previousStatus = null;
let roomUpdateSequence = 0;
let lastAppliedRoomUpdateSequence = 0;

function scrollToStatusSection(status) {
  const sectionId = status === 'playing' ? 'game-sec' : 'lobby-sec';
  requestAnimationFrame(() => {
    document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function applyRoomData(data, sequence = ++roomUpdateSequence) {
  if (sequence < lastAppliedRoomUpdateSequence) return;
  lastAppliedRoomUpdateSequence = sequence;
  const statusBeforeUpdate = previousStatus;
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

  updatePhaseStatus(state.currentData);
  updateSubmissionStatus(state.currentData);
  const players = state.currentData.players || [];
  const spectators = state.currentData.spectators || [];

  if (spectators.includes(state.myName)) state.isSpectator = true;
  if (players.includes(state.myName)) state.isSpectator = false;
  updateRoleHelp(state.currentData);

  const st = state.currentData.settings || { handCount: 5 };
  const handInput = document.getElementById('set-hand-count');
  if (handInput && document.activeElement !== handInput) {
    handInput.value = st.handCount;
  }
  const currentWords = (state.currentData.words || []).length;

  const materialCount = document.getElementById('material-count');
  if (materialCount) {
    materialCount.textContent = `📦 集まった素材：${currentWords}個`;
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

  const participantCard = (name, role) => {
    const isMe = name === state.myName;
    const label = role === 'spectator' ? '見学者' : 'プレイヤー';
    const initial = escapeHTML((name || '？').slice(0, 1));
    return `
      <div class="participant-card participant-card-${role}${isMe ? ' participant-card-me' : ''}">
        <div class="participant-avatar" aria-hidden="true">${initial}</div>
        <div class="participant-main">
          <div class="participant-name">${escapeHTML(name)}${isMe ? '<span class="participant-self">あなた</span>' : ''}</div>
          <div class="participant-role">${label}</div>
        </div>
        <button class="participant-kick" onclick="removePlayer('${escapeJS(name)}')">鯖落ち</button>
      </div>`;
  };
  const playerCards = players.map((name) => participantCard(name, 'player')).join('');
  const spectatorCards = spectators.map((name) => participantCard(name, 'spectator')).join('');
  const playerListHtml = `
    <div class="participant-roster">
      <div class="participant-roster-header"><strong>参加メンバー</strong><span>${players.length}人プレイ中 · ${spectators.length}人見学</span></div>
      <div class="participant-group-title">プレイヤー</div>
      <div class="participant-grid">${playerCards || '<div class="participant-empty">プレイヤーがいません</div>'}</div>
      ${spectators.length ? `<div class="participant-group-title participant-group-spectator">見学者</div><div class="participant-grid">${spectatorCards}</div>` : ''}
    </div>`;
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

  const statusChanged = statusBeforeUpdate === null || statusBeforeUpdate !== state.currentData.status;
  previousStatus = state.currentData.status;
  if (statusChanged && (state.currentData.status === 'lobby' || state.currentData.status === 'playing')) {
    scrollToStatusSection(state.currentData.status);
  }
}

// ブラウザがバックグラウンドから復帰したタイミングで、Firestoreの最新データを再取得して画面に反映する。
// visibilitychangeとpageshowがほぼ同時に発火しても、同じ取得を共有する。
// ここでは読み取りと再描画のみを行い、ゲーム状態を変更する書き込みは一切行わない。
let roomResyncPromise = null;
let roomResyncInterval = null;
async function resyncRoomFromFirestore() {
  if (!state.roomRef) return { ok: false, error: new Error('ルームが未接続です。') };
  if (roomResyncPromise) {
    await roomResyncPromise;
    // 待機中に投稿・披露などの更新が完了している可能性があるため、
    // 既存取得の結果を使わず、サーバーからもう一度取得する。
    return resyncRoomFromFirestore();
  }

  const sequence = ++roomUpdateSequence;
  roomResyncPromise = (async () => {
    try {
      const snapshot = await getDocFromServer(state.roomRef);
      if (!snapshot.exists()) throw new Error('ルームが見つかりません。');
      applyRoomData(snapshot.data(), sequence);
      return { ok: true };
    } catch (e) {
      // 再取得に失敗しても、既存のonSnapshot監視やゲーム操作は壊さない
      console.warn('サーバーからの再同期に失敗しました:', e);
      return { ok: false, error: e };
    }
  })();

  try {
    return await roomResyncPromise;
  } finally {
    roomResyncPromise = null;
  }
}

window.resyncPoemRoom = resyncRoomFromFirestore;

// 一部ブラウザでonSnapshotが一時停止したり、キャッシュ値が残ったりしても、
// 参加者の投稿を取りこぼさないため、表示中はサーバーから定期的に再取得する。
function startRoomResyncPolling() {
  if (roomResyncInterval) clearInterval(roomResyncInterval);
  roomResyncInterval = setInterval(() => {
    if (document.visibilityState === 'visible' && state.roomRef) resyncRoomFromFirestore();
  }, 5000);
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

    const roomSnapshot = await getDocFromServer(state.roomRef);

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
    currentHost: state.isSpectator ? null : state.myName,
    currentHostUid: state.isSpectator ? null : currentUser.uid,
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
      // キャッシュ由来の古い値で、サーバー取得済みの最新状態を巻き戻さない。
      // 最新値は5秒ポーリングのgetDocFromServerで補完する。
      if (snapshot.metadata?.fromCache) return;
      applyRoomData(snapshot.data(), ++roomUpdateSequence);
    }, (error) => {
      console.error('[room-onSnapshot]', error);
      resyncRoomFromFirestore();
    });
    startRoomResyncPolling();
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
      console.error('[history-onSnapshot]', error);
      showGameError(error, '履歴の読み込み');
    });
  } catch (e) {
    console.error('[joinRoom]', e);
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
    console.error('[remove-submitted-word]', e);
    showGameError(e, '素材の取り消し');
  }
};

window.toggleRole = async function() {
  if (!state.roomRef) return;
  if (state.isSpectator) {
    // ゲーム中の途中参戦も、役割変更と手札配布をサーバー側で一括検証する。
    if (state.currentData?.schemaVersion === 2) {
      const st = state.currentData.settings || { handCount: 5 };
      const supplementalWords = SAMPLE_PHRASES.slice(0, st.handCount).map((text, index) => ({
        text,
        author: '🎴お題ぶくろ',
        id: `supplement_${Date.now()}_${index}`
      }));
      await changePoemRole(state.roomId, 'player', supplementalWords);
      state.isSpectator = false;
      alert('余っている素材を優先して手札を配り、プレイヤーとして参加しました！');
      return;
    }

    await saveParticipantRole('player');
    state.isSpectator = false;
    alert("プレイヤーとして参加しました！");
  } else {
    if (state.currentData?.schemaVersion === 2) {
      await changePoemRole(state.roomId, 'spectator');
    } else {
      await saveParticipantRole('spectator');
    }
    state.isSpectator = true;
    alert("見学モードに切り替えました！");
  }
};

window.removePlayer = async function(pName) {
  if (!confirm(`${pName} さんを退出させますか？`)) return;
  try {
    if (state.currentData?.schemaVersion === 2) {
      const targetUid = Object.entries(state.currentData.participantUids || {}).find(([, name]) => name === pName)?.[0];
      if (!targetUid) throw new Error('対象プレイヤーのUIDが見つかりません。');
      await removePlayerSecure(state.roomId, targetUid);
    } else {
      await updateDoc(state.roomRef, { players: arrayRemove(pName), spectators: arrayRemove(pName) });
    }
  } catch (error) {
    console.error('[remove-player]', error);
    showGameError(error, '鯖落ち');
  }
};


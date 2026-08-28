import { db } from "./firebase-config.js";
import { doc, getDocFromServer, onSnapshot, updateDoc, runTransaction, serverTimestamp, arrayUnion, arrayRemove } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import state from './haiku-state.js';
import { escapeHTML, escapeJS } from './haiku-utils.js';
import { renderInputFields, renderHand, renderBoards, refreshRoleBasedControls } from './haiku-render.js';
import { subscribeRoomHistory } from './room-history.js';
import { ensureSignedIn } from './wordset-auth.js';
import { showGameError } from './game-error.js';
import { defaultWords5, defaultWords7 } from './haiku-default-words.js';

const initialRoomId = new URLSearchParams(window.location.search).get('room')?.trim() || '';
document.addEventListener('DOMContentLoaded', () => {
  const roomInput = document.getElementById('room-id');
  if (roomInput && initialRoomId && !roomInput.value) roomInput.value = initialRoomId;
});
import { normalizeParticipantName, setParticipantRole, normalizeParticipantRoles, getParticipantStorageKey, canClaimHost, getCurrentHostName } from './participant-utils.js';
import { changeHaikuRole, removeHaikuWord, updateHaikuSettings, removePlayer as removePlayerSecure, claimHost as claimHostSecure } from './haiku-functions.js';

async function saveParticipantRole(role) {
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(state.roomRef);
    if (!snapshot.exists()) throw new Error('ルームが見つかりません');
    transaction.update(state.roomRef, setParticipantRole(snapshot.data(), state.myName, role));
  });
}

let previousStatus = null; // 直前のstatusを記録し、画面遷移と入力リセットの判定に使う

function rerenderAfterRoleChange() {
  const settings = state.currentData?.settings || { hand5: 5, hand7: 3 };
  updateRoleHelp(state.currentData);
  refreshHostRecoveryUI();
  renderInputFields(settings.hand5, settings.hand7);
  renderHand();
  renderBoards();
  refreshRoleBasedControls();
}

function scrollToStatusSection(status) {
  const sectionId = status === 'playing' ? 'game-sec' : 'lobby-sec';
  requestAnimationFrame(() => {
    document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function updatePhaseStatus(data) {
  const lobbyText = data?.status === 'lobby' ? '開始待ち・素材準備中' : '';
  let gameText = '';
  if (data?.status === 'playing') {
    const players = data.players || [];
    const submitted = Object.keys(data.phrases || {}).length;
    const revealed = Object.values(data.revealedPhrases || {}).filter(Boolean).length;
    if (submitted < players.length) gameText = `句を作成中（${submitted}/${players.length}人提出済み）`;
    else if (revealed < submitted) gameText = `句を披露中（${revealed}/${submitted}句披露済み）`;
    else gameText = '御印受付中';
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
  const submittedFor = (name, type) => (data?.[type] || []).some(word => word?.author === name);
  const phraseFor = name => {
    const uid = uidFor(name);
    const phrases = data?.phrases || {};
    return (uid && phrases[uid] !== undefined) || phrases[name] !== undefined;
  };
  const render = (id, label, doneFor) => {
    const el = document.getElementById(id);
    if (!el || !players.length) return;
    const items = players.map(name => `<span class="submission-person ${doneFor(name) ? 'is-done' : ''}">${doneFor(name) ? '✅' : '⏳'} ${escapeHTML(name)}：${doneFor(name) ? '提出済み' : '未提出'}</span>`).join('');
    el.innerHTML = `<div class="submission-title">${label}</div><div class="submission-people">${items}</div>`;
  };
  render('submission-status-lobby', '素材の提出状況', name => submittedFor(name, 'words5') || submittedFor(name, 'words7'));
  render('submission-status-game', '句の提出状況', phraseFor);
}

function updateRoundResult(data) {
  const el = document.getElementById('round-result-lobby');
  if (!el) return;
  const result = data?.lastRoundResult;
  const winners = Array.isArray(result?.taeWinners) ? result.taeWinners.filter(Boolean) : [];
  if (!winners.length) {
    el.innerHTML = '';
    el.style.display = 'none';
    return;
  }
  const points = Number(result.taePoints) || 10;
  el.innerHTML = `🪭 <strong>妙なり、おめでとうございます！</strong><br>${winners.map(name => `${escapeHTML(name)}さん（+${points}誉）`).join('、')}`;
  el.style.display = 'block';
}

function updateScoreboard(data) {
  const el = document.getElementById('scoreboard');
  if (!el) return;
  const players = data?.players || [];
  const scores = data?.scores || {};
  const ranking = [...players].sort((a, b) => (Number(scores[b]) || 0) - (Number(scores[a]) || 0));
  el.innerHTML = `<div class="scoreboard-title">累計得点ランキング</div><div class="scoreboard-list">${ranking.map((name, index) => `<div class="score-row"><span>${index + 1}位　${escapeHTML(name)}</span><strong>${Number(scores[name]) || 0} 誉</strong></div>`).join('')}</div>`;
}

function updateScoreHistory(data) {
  const el = document.getElementById('score-history');
  if (!el) return;
  const history = Array.isArray(data?.history)
    ? data.history.filter(entry => Number.isFinite(Number(entry?.round)))
    : [];
  if (history.length === 0) {
    // 履歴購読の一時的な空スナップショットで、表示済みの履歴を消さない。
    if (!el.querySelector('.score-history-details')) el.innerHTML = '';
    return;
  }

  const rounds = [...history].sort((a, b) => Number(a.round) - Number(b.round));
  const wasOpen = el.querySelector('.score-history-details')?.open === true;
  const renderScores = (scores) => Object.entries(scores || {})
    .filter(([, value]) => Number.isFinite(Number(value)))
    .sort(([, a], [, b]) => Number(b) - Number(a))
    .map(([name, score], index) => `<div class="score-history-total"><span>${index + 1}位　${escapeHTML(name)}</span><strong>${Number(score)} 誉</strong></div>`)
    .join('');

  const roundHtml = rounds.map((entry) => {
    const deltas = Object.entries(entry.scoreDeltas || {})
      .filter(([, value]) => Number(value) > 0)
      .sort(([, a], [, b]) => Number(b) - Number(a));
    const hasScoreDetails = entry.scoreDeltas && entry.scoresAfter;
    const deltaHtml = hasScoreDetails
      ? (deltas.length > 0
        ? `<div class="score-history-deltas">${deltas.map(([name, points]) => `<span class="score-history-delta">${escapeHTML(name)} <strong>+${Number(points)} 誉</strong></span>`).join('')}</div>`
        : '<div class="score-history-empty">この節の得点はありません</div>')
      : '<div class="score-history-empty">この節は旧形式の履歴のため、得点の詳細は表示できません</div>';
    const totalsHtml = hasScoreDetails ? renderScores(entry.scoresAfter) : '';
    return `
      <section class="score-history-round">
        <div class="score-history-round-title"><strong>第${Number(entry.round)}節</strong><span>選者：${escapeHTML(entry.host || '未設定')}</span></div>
        <div class="score-history-label">この節の加点</div>
        ${deltaHtml}
        ${totalsHtml ? `<div class="score-history-label">節終了時の累計</div><div class="score-history-totals">${totalsHtml}</div>` : ''}
      </section>
    `;
  }).join('');

  el.innerHTML = `
    <details class="score-history-details"${wasOpen ? ' open' : ''}>
      <summary>得点履歴（${rounds.length}節）</summary>
      <p class="score-history-note">各節の御印による加点と、その節を終えた時点の累計です。</p>
      ${roundHtml}
    </details>
  `;
}

function updateRoleHelp(data) {
  const isHost = data?.currentHostUid && state.myUid
    ? data.currentHostUid === state.myUid
    : data?.currentHost === state.myName;
  const role = state.isSpectator ? '見学者' : (isHost ? '親・選者' : 'プレイヤー');
  const text = data?.status === 'lobby'
    ? (state.isSpectator ? '見学者：参加者の準備状況を確認できます。素材提出や句会開始はできません。' : (isHost ? '親・選者：素材を確認し、準備ができたら「句会を始める！」を押します。' : 'プレイヤー：素材を提出し、親が句会を開始するまで待ちます。'))
    : (state.isSpectator ? '見学者：句の披露と御印を楽しめます。ゲーム進行の操作はできません。' : (isHost ? '親・選者：他の参加者の句を披露し、確認後に「次の節に進む」を押します。' : 'プレイヤー：手札から句を作って披露し、親の進行を待ちます。'));
  ['role-help-lobby', 'role-help-game'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = `<strong>あなたの役割：${role}</strong><br>${text}`;
  });
}
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
    console.error('[hand-onSnapshot]', error);
  });
}
function refreshHostRecoveryUI() {
  const data = state.currentData;
  const players = data?.players || [];
  const currentHost = getCurrentHostName(data);
  const isPlaying = data?.status === 'playing';
  const canTakeover = canClaimHost(data, state.myName, state.isSpectator);
  const hostRecoveryBtn = document.getElementById('host-recovery-btn');
  if (hostRecoveryBtn) {
    hostRecoveryBtn.style.display = isPlaying && !state.isSpectator ? 'block' : 'none';
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
    if (state.currentData?.schemaVersion === 2) {
      await claimHostSecure(state.roomId);
      state.currentData = { ...state.currentData, currentHost: state.myName, currentHostUid: state.myUid };
      refreshHostRecoveryUI();
      renderBoards();
      alert('あなたが新しい親になりました。次の節へ進めます。');
      return;
    }
    const claimed = await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(state.roomRef);
      const data = snapshot.data() || {};
      if (!canClaimHost(data, state.myName, state.isSpectator)) return false;
      transaction.update(state.roomRef, { currentHost: state.myName });
      return true;
    });
    alert(claimed ? 'あなたが新しい親になりました。' : '別の参加者が先に親を引き継いだか、親が復帰しました。画面を更新してください。');
  } catch (error) {
    console.error('[claim-host]', error);
    showGameError(error, '親の引き継ぎ');
  }
};

// Firestoreの部屋データを受け取り、画面表示を最新状態へ反映する。
// onSnapshotでの受信時と、Chrome復帰時のvisibilitychange再取得時の両方から呼ばれる共通処理。
let roomUpdateSequence = 0;
let lastAppliedRoomUpdateSequence = 0;

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
  updateRoundResult(state.currentData);
  updateSubmissionStatus(state.currentData);
  updateScoreboard(state.currentData);
  updateScoreHistory(state.currentData);
  const players = state.currentData.players || [];
  const spectators = state.currentData.spectators || [];

  if (spectators.includes(state.myName)) state.isSpectator = true;
  if (players.includes(state.myName)) state.isSpectator = false;
  updateRoleHelp(state.currentData);

  subscribeOwnHand(state.currentData);

  const currentHost = getCurrentHostName(state.currentData) || '未設定';
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
  refreshRoleBasedControls();
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
  const participantCard = (name, role) => {
    const isHost = role === 'player' && name === currentHost;
    const isMe = name === state.myName;
    const label = role === 'spectator' ? '見学者' : (isHost ? '親・選者' : 'プレイヤー');
    const initial = escapeHTML((name || '？').slice(0, 1));
    return `
      <div class="participant-card participant-card-${role}${isHost ? ' participant-card-host' : ''}${isMe ? ' participant-card-me' : ''}">
        <div class="participant-avatar" aria-hidden="true">${initial}</div>
        <div class="participant-main">
          <div class="participant-name">${escapeHTML(name)}${isMe ? '<span class="participant-self">あなた</span>' : ''}</div>
          <div class="participant-role">${label}${isHost ? ' · 次の節を進行' : ''}</div>
        </div>
        ${role === 'player' ? `<span class="score-badge participant-score">${scores[name] || 0} 誉</span>` : ''}<button class="participant-kick" onclick="removePlayer('${escapeJS(name)}')">鯖落ち</button>
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

  const statusChanged = statusBeforeUpdate === null || statusBeforeUpdate !== state.currentData.status;
  previousStatus = state.currentData.status;
  if (statusChanged && (state.currentData.status === 'lobby' || state.currentData.status === 'playing')) {
    scrollToStatusSection(state.currentData.status);
  }
}

// ブラウザがバックグラウンドから復帰したタイミングで、Firestoreの最新データを再取得して画面に反映する。
// visibilitychangeとpageshowがほぼ同時に発火する可能性があるため、roomResyncPromiseで二重実行を防ぐ。
// ここでは読み取りと再描画のみを行い、ゲーム状態を変更する書き込みは一切行わない。
let roomResyncPromise = null;
let resyncRequestedWhileBusy = false;
let roomResyncInterval = null;
async function resyncRoomFromFirestore(options = {}) {
  const requireSuccess = options.requireSuccess === true;
  if (!state.roomRef) return { ok: false, error: new Error('ルームが未接続です。') };

  // 送信直後に定期同期と重なっても、現在の取得が終わった後にもう一度
  // サーバーから取得する。これにより、送信前のスナップショットで成功表示しない。
  if (roomResyncPromise) {
    resyncRequestedWhileBusy = true;
    const result = await roomResyncPromise;
    if (resyncRequestedWhileBusy) {
      resyncRequestedWhileBusy = false;
      return resyncRoomFromFirestore(options);
    }
    if (requireSuccess && !result.ok) throw result.error;
    return result;
  }

  const sequence = ++roomUpdateSequence;
  roomResyncPromise = (async () => {
    try {
      const snapshot = await getDocFromServer(state.roomRef);
      if (snapshot.exists()) {
        const data = snapshot.data();
        applyRoomData(data, sequence);
      }
      return { ok: true };
    } catch (e) {
      // 通常の定期同期に失敗しても、既存のonSnapshot監視やゲーム操作は壊さない。
      // 送信直後のrequireSuccessでは呼び出し側へエラーを返す。
      console.warn('サーバーからの再同期に失敗しました:', e);
      return { ok: false, error: e };
    }
  })();

  let result;
  try {
    result = await roomResyncPromise;
  } finally {
    roomResyncPromise = null;
  }
  if (requireSuccess && !result.ok) throw result.error;
  return result;
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
window.resyncHaikuRoom = resyncRoomFromFirestore;

// 一部ブラウザでonSnapshotが一時停止しても、他参加者の開始・提出・投票を取りこぼさないための保険。
// 画面表示中だけサーバーから定期取得し、古い状態を検知したら共通処理で再描画する。
function startRoomResyncPolling() {
  if (roomResyncInterval) clearInterval(roomResyncInterval);
  roomResyncInterval = setInterval(() => {
    if (document.visibilityState === 'visible' && state.roomRef) resyncRoomFromFirestore();
  }, 5000);
}

window.manualResync = async function(where) {
  const btn = document.getElementById(where === 'game' ? 'manual-resync-btn-game' : 'manual-resync-btn-lobby');
  if (btn) { btn.disabled = true; btn.innerText = '🔄 更新中…'; }
  await resyncRoomFromFirestore();
  if (btn) { btn.disabled = false; btn.innerText = '🔄 最新の状態に更新'; }
};


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

    const role = state.isSpectator ? 'spectator' : 'player';
    const initialData = {
      schemaVersion: 2,
      status: 'lobby',
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
      settings: { hand5: 5, hand7: 3, carryOver: true },
      players: state.isSpectator ? [] : [state.myName],
      spectators: state.isSpectator ? [state.myName] : [],
      redraws: {},
      participantUids: { [currentUser.uid]: state.myName },
    };

    // 入室判定と新規ルーム作成を同じサーバー側トランザクションで行う。
    // キャッシュ上の「存在しない」を根拠に既存ルームをsetDocで上書きしない。
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(state.roomRef);
      if (!snapshot.exists()) {
        transaction.set(state.roomRef, initialData);
        return;
      }

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

    document.getElementById('login-sec').style.display = 'none';
    document.getElementById('lobby-sec').style.display = 'block';

    onSnapshot(state.roomRef, (snapshot) => {
      // キャッシュ由来の古いスナップショットで、サーバー取得済みの最新状態を巻き戻さない。
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
    alert('接続エラーが発生しました: ' + e.message);
  }
};
window.removeSubmittedWord = async function(type, wordId) {
  if (!state.roomRef || !state.currentData || state.isSpectator) return;
  if (state.currentData.status !== 'lobby') return alert('素材の取り消しは句会開始前のみできます');
  const field = type === '5' ? 'words5' : 'words7';
  const target = (state.currentData[field] || []).find(w => w.id === wordId && w.author === state.myName);
  if (!target) return alert('この素材は取り消せません');
  if (!confirm(`「${target.text}」を取り消しますか？`)) return;
  try {
    if (state.currentData.schemaVersion === 2) {
      await removeHaikuWord(state.roomId, type, wordId);
    } else {
      await updateDoc(state.roomRef, { [field]: arrayRemove(target) });
    }
  } catch (e) {
    console.error('[remove-submitted-word]', e);
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
      rerenderAfterRoleChange();
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
    rerenderAfterRoleChange();
    alert("プレイヤーとして参加しました！");
  } else {
    // ラウンド中に選者本人が見学モードへ切り替わると、進行が止まってしまうため、選者本人の切り替えを禁止する
    if (state.currentData?.status === 'playing') {
      const players = state.currentData.players || [];
      const currentHost = getCurrentHostName(state.currentData);
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
    rerenderAfterRoleChange();
    alert("見学モードに切り替えました！");
  }
};
window.updateSettings = async function() {
  if (!state.roomRef || !state.currentData || state.isSpectator) return;
  const hostName = getCurrentHostName(state.currentData);
  const hostUid = String(state.currentData.currentHostUid || '');
  const hostNameUid = getParticipantUidByName(state.currentData, hostName);
  const isHost = Boolean(state.myUid && ((hostUid && state.myUid === hostUid) || (!hostUid && hostNameUid && state.myUid === hostNameUid)))
    || (!state.myUid && state.myName === hostName);
  if (!isHost) return;
  const hand5 = parseInt(document.getElementById('set-hand-5').value) || 5;
  const hand7 = parseInt(document.getElementById('set-hand-7').value) || 3;
  const carryOver = document.getElementById('set-carry-over')?.checked ?? true;
  if (state.currentData?.schemaVersion === 2) {
    await updateHaikuSettings(state.roomId, hand5, hand7, carryOver);
  } else {
    await updateDoc(state.roomRef, { settings: { hand5, hand7, carryOver } });
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

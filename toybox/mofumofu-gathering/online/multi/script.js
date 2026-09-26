// もふもふ大集合！ 人間3〜6人オンライン版 Phase E: クライアント本体。
//
// 判断はすべて multi-core.js（純粋核）と Firestore 公開room（サーバー正本）に委ねる。
// このファイルは「Firebaseとの結線」と「決まった内容の描画」だけを行い、
// 手番・判定・勝敗を独自判断しない（clientからゲーム状態を書き換える経路はCallableだけ）。
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { getAuth, connectAuthEmulator, signInAnonymously } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app-check.js';
import { getFirestore, connectFirestoreEmulator, doc, onSnapshot, getDocFromServer } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js';
import { getDatabase, connectDatabaseEmulator, ref, onValue, onDisconnect, set, update, serverTimestamp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js';
import { resolveEnvironment, REGION } from './firebase-config.js?v=20260926-1';
import * as core from './multi-core.js?v=20260926-1';
import { runMofumofuMultiFullResume, createMultiResumeCoordinator, handleMultiSessionFailure } from './multi-resume.js?v=20260926-1';

const environment = resolveEnvironment();
const app = initializeApp(environment.firebase);
if (environment.appCheck.debug) globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
initializeAppCheck(app, {
  provider: new ReCaptchaEnterpriseProvider(environment.appCheck.debug ? 'debug-provider' : environment.appCheck.siteKey),
  isTokenAutoRefreshEnabled: true,
});
const auth = getAuth(app);
const firestore = getFirestore(app);
const functions = getFunctions(app, REGION);
const database = getDatabase(app);
if (environment.name === 'emulator') {
  connectAuthEmulator(auth, `http://localhost:${environment.emulator.authPort}`, { disableWarnings: true });
  connectFirestoreEmulator(firestore, 'localhost', environment.emulator.firestorePort);
  connectFunctionsEmulator(functions, 'localhost', environment.emulator.functionsPort);
  connectDatabaseEmulator(database, 'localhost', environment.emulator.databasePort);
}
const call = (name, data) => httpsCallable(functions, name)(data).then((response) => response.data);
const $ = (id) => document.getElementById(id);
const SAFETY_SYNC_MS = 5_000;
const LISTENER_RETRY_MS = 2_000;
const MAX_LISTENER_RETRIES = 3;
const ROOM_COLLECTION = 'mofumofuMultiRooms';

const state = {
  roomId: null, seatId: null, room: null, cards: [], handStatus: 'pending',
  presence: {}, presenceReady: 0, connectionId: null, presenceRef: null, presenceUnsubscribe: null,
  unsubscribe: null, heartbeatTimer: null, accessTimer: null, safetySyncTimer: null, listenerRetryTimer: null,
  listenerRetryCount: 0, resumeFlight: null, resumeGeneration: 0, connectionState: 'syncing',
  lastSuccessfulResumeAt: 0, lastSuccessfulResumeRoomId: null,
  entryBusy: false, startBusy: false, makeBusy: false, judgeBusy: false,
  makeRequest: null, judgeRequest: null, handRetryFlight: null,
};
const ui = { cardId: null, claim: null, flashTimer: null, logoTimer: null, copyTimer: null, lastLogKey: null, gatheringShown: false };

function message(text) { $('status').textContent = text; }
function newId() { return crypto.randomUUID(); }
function remember(roomId, seatId) {
  state.roomId = roomId; state.seatId = seatId;
  core.saveRoom(localStorage, { roomId, seatId });
}
function forgetInvite(roomId = state.roomId) {
  core.forgetInvite(sessionStorage, roomId);
}

/* ------------------------------------------------------------------ あそびかた */

const helpDialog = $('help-dialog');
(function renderHelp() {
  const body = $('help-body');
  for (const section of core.helpSections()) {
    const heading = document.createElement('h3');
    heading.textContent = section.title;
    const list = document.createElement('ul');
    for (const item of section.items) {
      const line = document.createElement('li');
      line.textContent = item;
      list.append(line);
    }
    body.append(heading, list);
  }
})();
for (const id of ['open-help', 'open-help-lobby', 'game-help']) $(id).addEventListener('click', () => helpDialog.showModal());
$('close-help').addEventListener('click', () => helpDialog.close());
// 画面に収まらないときは、初期表示を末尾（「わかった！」の見える位置）へ寄せる。
helpDialog.addEventListener('toggle', () => {
  if (!helpDialog.open) return;
  if (helpDialog.scrollHeight > helpDialog.clientHeight + 24) helpDialog.scrollTop = helpDialog.scrollHeight;
});

/* ------------------------------------------------------------------ 描画部品 */

function cardImage(animalType, alt) {
  const node = document.createElement('img');
  node.src = core.cardImagePath(animalType);
  node.alt = alt;
  node.draggable = false;
  return node;
}
function chip(text, kind) {
  const node = document.createElement('span');
  node.className = `chip${kind ? ` ${kind}` : ''}`;
  node.textContent = text;
  return node;
}
function faceChips(seat) {
  const line = document.createElement('div');
  line.className = 'face-line';
  if (!seat.faceUp.length) { line.append(chip('表向きなし')); return line; }
  for (const entry of seat.faceUp) {
    const node = document.createElement('span');
    node.className = 'face-chip';
    node.append(cardImage(entry.animalType, ''), document.createTextNode(`${entry.label}×${entry.count}`));
    line.append(node);
  }
  return line;
}
function seatBox(seat, { self = false } = {}) {
  const box = document.createElement('section');
  box.className = `player-box${seat.isTurn ? ' current' : ''}${seat.isJudgeTarget ? ' judge-target' : ''}${self ? ' self' : ''}`;
  box.dataset.seat = seat.seatId;
  box.setAttribute('aria-label', seat.ariaLabel);
  const name = document.createElement('strong');
  name.className = 'name';
  // 内部seat ID（S1〜S6）は主表示にしない。表示名か「あなた」「あいてN」だけを出す。
  name.textContent = seat.label;
  box.append(name);
  const chips = document.createElement('div');
  chips.className = 'chip-line';
  if (seat.presenceText) chips.append(chip(seat.presenceText, seat.online ? 'online' : 'wait'));
  chips.append(chip(`手札${seat.handCount}枚`));
  box.append(chips, faceChips(seat));
  return box;
}
function pushLog(text) {
  const line = document.createElement('p');
  line.textContent = text;
  $('log').append(line);
  $('log').scrollTop = $('log').scrollHeight;
}
function flash(text) {
  const node = $('flash');
  node.textContent = text;
  node.classList.add('show');
  clearTimeout(ui.flashTimer);
  ui.flashTimer = setTimeout(() => { node.textContent = ''; node.classList.remove('show'); }, 2_600);
}
function showGatheringLogo(onDone) {
  const overlay = $('gathering-overlay');
  overlay.classList.remove('hidden');
  clearTimeout(ui.logoTimer);
  ui.logoTimer = setTimeout(() => { overlay.classList.add('hidden'); onDone(); }, 2_600);
}
async function copyText(value, button, resetLabel) {
  const done = (text) => {
    button.textContent = text;
    clearTimeout(ui.copyTimer);
    ui.copyTimer = setTimeout(() => { button.textContent = resetLabel; }, 2_400);
  };
  try { await navigator.clipboard.writeText(value); done(core.COPY_DONE_LABEL); return; } catch { /* フォールバックへ */ }
  try {
    const area = document.createElement('textarea');
    area.value = value; area.setAttribute('readonly', '');
    area.style.position = 'fixed'; area.style.opacity = '0';
    document.body.append(area); area.select();
    const ok = document.execCommand('copy');
    area.remove();
    done(ok ? core.COPY_DONE_LABEL : core.COPY_FAILED_LABEL);
  } catch { done(core.COPY_FAILED_LABEL); }
}
function setConnectionState(next, detail = '') {
  state.connectionState = next;
  message(next === 'connected' ? core.TEXT.connecting : next === 'syncing' ? core.TEXT.syncing : `同期エラー${detail ? `（${detail}）` : ''}`);
}
function errorCode(error) { return String(error?.code || 'unknown').replace(/^functions\//, ''); }

/* -------------------------------------------------------------- 画面の切り替え */

function showScreen(room) {
  $('entry').hidden = Boolean(room);
  $('lobby').hidden = !room || room.status !== core.ROOM_STATUS.WAITING;
  $('game').hidden = !room || room.status === core.ROOM_STATUS.WAITING;
}
function renderLobby(room) {
  const view = core.lobbyView(room, state.seatId);
  $('room-id').textContent = room.roomId ? `${String(room.roomId).slice(0, 8)}…` : '';
  $('room-id').title = room.roomId ? `${core.TEXT.roomIdPrefix}${room.roomId}` : '';
  $('room-id').setAttribute('aria-label', $('room-id').title);
  // 招待コードはホストのwaiting中だけ。平文はsessionStorageにだけ置き、URLへは出さない。
  const code = view.inviteVisible ? core.restoreInvite(sessionStorage, room.roomId) : '';
  $('invite-box').hidden = !view.inviteVisible;
  $('shown-invite').textContent = code;
  $('copy-invite').hidden = !code;
  $('copy-invite').textContent = core.COPY_LABEL;
  $('invite-note').textContent = view.inviteVisible
    ? (code ? core.TEXT.inviteNote : '招待コードを表示できませんでした。部屋をつくり直してください。')
    : view.waitingNote;
  $('players').replaceChildren(...view.seats.map((seat) => {
    const box = seatBox({
      seatId: seat.seatId, isSelf: seat.isSelf, isTurn: false, isJudgeTarget: false,
      label: seat.label, handCount: 0, faceUp: [], faceUpCount: 0,
      presenceText: '', online: false,
      ariaLabel: `${seat.label} ${seat.joined ? '参加ずみ' : core.TEXT.emptySeatLabel}`,
    }, { self: seat.isSelf });
    const chips = box.querySelector('.chip-line');
    chips.textContent = '';
    chips.append(chip(seat.joined ? '参加ずみ' : core.TEXT.emptySeatLabel));
    if (seat.isHost) chips.append(chip('ホスト', 'host'));
    box.querySelector('.face-line')?.remove();
    return box;
  }));
  $('start-game').hidden = !view.startVisible;
  $('start-game').disabled = !view.canStart;
  $('start-note').textContent = view.waitingNote || view.startNote || (view.full ? view.fullText : '');
}
function renderGame(room) {
  const presenceReady = state.presenceReady === state.resumeGeneration;
  const view = core.gameView(room, state.seatId, state.presence, {
    presenceReady, now: Date.now(), staleMs: core.PRESENCE_STALE_MS,
  });
  if (!view) return;
  $('turn').textContent = view.turnText;
  $('turn').classList.toggle('mine', view.isMyTurn);
  // 他のplayerは上側・最大5人・2列折返し。自分は下部の self-seat に固定する。
  $('others').replaceChildren(...view.others.map((seat) => seatBox(seat)));
  $('self-seat').replaceChildren(seatBox(view.self, { self: true }));
  const wait = $('reconnect-wait');
  wait.hidden = !view.reconnect;
  wait.textContent = view.reconnect ? view.reconnect.text : '';
  $('deckCount').textContent = view.board.deckText;
  $('deckCard').classList.toggle('empty', view.board.deckEmpty);
  if (view.board.card) {
    $('tableCard').classList.add('revealed');
    $('tableCardMain').replaceChildren(cardImage(view.board.card.animalType, view.board.card.label));
  } else {
    $('tableCard').classList.remove('revealed');
    $('tableCardMain').textContent = '？';
  }
  $('tableCardSub').textContent = view.board.cardSub;
  $('offer-message').textContent = view.board.message;
  renderSteps(view);
  // 判定済みの結果は公開room（正本）の publicOffer だけで組み立てる。
  const offer = room.publicOffer;
  const finished = view.finished;
  $('result').hidden = true;
  $('final-result').hidden = true;
  if (offer && offer.status === 'completed') {
    $('result').hidden = false;
    $('result').textContent = view.board.resultLine;
    const key = `${room.turnNumber}:${offer.fromPlayerId}:${offer.claimAnimal}`;
    if (key !== ui.lastLogKey) {
      ui.lastLogKey = key;
      pushLog(`${core.seatDisplayName(room, offer.fromPlayerId, state.seatId)}「${core.ANIMAL_LABELS[offer.claimAnimal]}だよ」→ ほんとは${core.ANIMAL_LABELS[offer.actualAnimal]}（判定${offer.success ? '成功' : '失敗'}）`);
      flash(offer.success ? '○ あたり！' : '× うそだった！');
    }
  }
  if (finished && view.result) {
    // 集合演出（正式ロゴ）は集合成立のときだけ。hand-empty / too-few-active では出さない。
    if (view.result.showGatheringOverlay && !ui.gatheringShown) {
      ui.gatheringShown = true;
      showGatheringLogo(() => renderResult(view.result));
      return;
    }
    renderResult(view.result);
  }
}
function renderSteps(view) {
  const canMake = view.canMakeOffer;
  if (!canMake) { ui.cardId = null; ui.claim = null; }
  if (ui.cardId && !state.cards.some((entry) => entry.cardId === ui.cardId)) { ui.cardId = null; ui.claim = null; }
  $('offer-form').hidden = !canMake;
  $('hand').replaceChildren(...(canMake ? state.cards : []).map((entry) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = `hand-card${entry.cardId === ui.cardId ? ' selected' : ''}`;
    node.append(cardImage(entry.animalType, core.ANIMAL_LABELS[entry.animalType]));
    node.setAttribute('aria-label', core.ANIMAL_LABELS[entry.animalType]);
    node.addEventListener('click', () => {
      if (!core.canMakeOffer(state.room, state.seatId) || state.makeBusy) return;
      ui.cardId = entry.cardId; ui.claim = null; renderGame(state.room);
    });
    return node;
  }));
  const claimButtons = $('claimButtons');
  const showClaims = canMake && Boolean(ui.cardId);
  claimButtons.replaceChildren(...(showClaims ? view.claims.map((option) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = ui.claim === option.animalType ? 'selected' : '';
    node.textContent = `${option.emoji} ${option.label}`;
    node.addEventListener('click', () => {
      if (state.makeBusy || !ui.cardId) return;
      ui.claim = option.animalType; renderGame(state.room);
    });
    return node;
  }) : []));
  $('claimStep').hidden = !showClaims;
  const targetButtons = $('targetButtons');
  const showTargets = canMake && Boolean(ui.claim);
  if (showTargets) {
    // 渡す相手は自分以外の参加中の人（最大5人）。
    targetButtons.replaceChildren(...view.targets.map((target) => {
      const node = document.createElement('button');
      node.type = 'button';
      node.dataset.target = target.seatId;
      node.textContent = `${target.label}へ`;
      node.addEventListener('click', () => void submitOffer(target.seatId, node));
      return node;
    }));
  } else targetButtons.replaceChildren();
  $('targetStep').hidden = !showTargets;
  $('judgeStep').hidden = !view.canJudge;
  // 判定できるのは受け取った本人だけ。自分の手札だけを見せる。
  if (view.canJudge) {
    $('judgeHand').replaceChildren(...state.cards.map((entry) => {
      const node = document.createElement('span');
      node.className = 'hand-card';
      node.append(cardImage(entry.animalType, core.ANIMAL_LABELS[entry.animalType]));
      return node;
    }));
  } else $('judgeHand').replaceChildren();
}
function renderResult(result) {
  $('final-result').hidden = false;
  $('final-title').textContent = result.title;
  $('final-reason').textContent = result.reason;
  $('final-winners').textContent = result.winnerText;
  $('final-players').replaceChildren(...result.players.map((player) => {
    const box = document.createElement('section');
    const title = document.createElement('strong');
    title.textContent = player.label;
    box.append(title);
    if (player.verdict) {
      const verdict = document.createElement('p');
      verdict.className = `final-verdict ${player.isWinner ? 'won' : 'lost'}`;
      verdict.textContent = player.verdict;
      box.append(verdict);
    }
    const hand = document.createElement('p');
    hand.textContent = `手札${player.handCount}枚`;
    box.append(hand);
    if (player.faceUp.length) {
      for (const entry of player.faceUp) {
        const line = document.createElement('p');
        line.textContent = `${entry.emoji}${entry.label} ×${entry.count}`;
        box.append(line);
      }
    } else {
      const line = document.createElement('p');
      line.textContent = '表向きカード なし';
      box.append(line);
    }
    return box;
  }));
}
function renderAll() {
  const room = state.room;
  showScreen(room);
  if (!room) return;
  if (room.status === core.ROOM_STATUS.WAITING) renderLobby(room);
  else renderGame(room);
}
function resetEntryView() {
  state.room = null; state.roomId = null; state.seatId = null; state.cards = [];
  state.presence = {}; state.connectionId = null; state.presenceReady = 0;
  state.makeRequest = null; state.judgeRequest = null;
  ui.cardId = null; ui.claim = null; ui.lastLogKey = null; ui.gatheringShown = false;
  for (const id of ['turn', 'tableCardSub', 'offer-message', 'invite-note', 'start-note', 'flash', 'result']) $(id).textContent = '';
  $('tableCardMain').textContent = '？';
  for (const id of ['others', 'self-seat', 'hand', 'judgeHand', 'log', 'players', 'claimButtons', 'targetButtons', 'judgeHand', 'final-players']) $(id).replaceChildren();
  for (const id of ['game', 'lobby', 'final-result', 'reconnect-wait', 'claimStep', 'targetStep', 'judgeStep']) $(id).hidden = true;
  $('copy-invite').textContent = core.COPY_LABEL;
  renderEntry();
}
function renderEntry() {
  const busy = Boolean(state.entryBusy);
  $('create-room').disabled = busy;
  $('join-room').disabled = busy;
}

/* -------------------------------------------------------------------- 通信 */

async function beginPresence(seatId, generation, connectionId) {
  const uid = auth.currentUser.uid;
  const path = `${core.RTDB_ROOTS.presence}/${state.roomId}/${uid}/connections/${connectionId}`;
  state.presenceRef = ref(database, path);
  const ownPresenceRef = state.presenceRef;
  const base = { uid, roomId: state.roomId, seatId, connectionId };
  const connectedAt = Date.now();
  await onDisconnect(ownPresenceRef).set({ ...base, state: 'disconnected', lastHeartbeatAt: serverTimestamp(), connectedAt });
  await set(ownPresenceRef, { ...base, state: 'online', lastHeartbeatAt: serverTimestamp(), connectedAt });
  if (generation !== state.resumeGeneration) return;
  state.heartbeatTimer = setInterval(() => {
    if (generation !== state.resumeGeneration) return;
    update(ownPresenceRef, { state: 'online', lastHeartbeatAt: serverTimestamp() })
      .catch(() => requestResume('heartbeat-error'));
  }, core.HEARTBEAT_INTERVAL_MS);
  state.accessTimer = setInterval(() => {
    if (generation !== state.resumeGeneration) return;
    // presence認可は5分で切れるため、4分ごとに取り直す。
    call('authorizeMofumofuMultiPresence', { roomId: state.roomId }).catch(() => requestResume('presence-access-error'));
  }, core.ACCESS_REFRESH_MS);
  state.presenceUnsubscribe = onValue(ref(database, `${core.RTDB_ROOTS.presence}/${state.roomId}`), (snapshot) => {
    if (generation !== state.resumeGeneration) return;
    state.presence = snapshot.val() || {};
    if (core.connectionOnline(state.presence?.[uid]?.connections?.[connectionId])) state.presenceReady = generation;
    if (state.room?.status !== core.ROOM_STATUS.WAITING) renderGame(state.room);
  }, () => requestResume('rtdb-listener-error'));
}
async function retirePresence() {
  const oldRef = state.presenceRef;
  state.presenceRef = null;
  if (!oldRef) return;
  await onDisconnect(oldRef).cancel().catch(() => {});
  await update(oldRef, { state: 'disconnected', lastHeartbeatAt: serverTimestamp() }).catch(() => {});
}
function stopRealtime(generation = state.resumeGeneration) {
  if (generation !== state.resumeGeneration) return;
  clearInterval(state.heartbeatTimer); state.heartbeatTimer = null;
  clearInterval(state.accessTimer); state.accessTimer = null;
  clearInterval(state.safetySyncTimer); state.safetySyncTimer = null;
  clearTimeout(state.listenerRetryTimer); state.listenerRetryTimer = null;
  state.unsubscribe?.(); state.unsubscribe = null;
  state.presenceUnsubscribe?.(); state.presenceUnsubscribe = null;
}
// resume応答はroomの公開フィールドが平坦に入る（playerUidsは含まれない）。
// playerUidsはFirestore公開roomのlistenerが届け次第そのまま正本になる。
function roomFromResume(value) {
  const seatOrder = [...(value.seatOrder || [])];
  return {
    roomId: value.roomId, status: value.status, hostUid: value.hostUid, seatOrder,
    players: { ...(value.players || {}) }, playerStatus: { ...(value.playerStatus || {}) },
    dealt: Boolean(value.dealt), currentTurnPlayerId: value.currentTurnPlayerId, turnState: value.turnState,
    turnNumber: Number(value.turnNumber || 0), publicOffer: value.publicOffer || null,
    faceUpCards: { ...(value.faceUpCards || {}) }, handCounts: { ...(value.handCounts || {}) },
    winnerPlayerIds: [...(value.winnerPlayerIds || [])], loserPlayerIds: [...(value.loserPlayerIds || [])],
    leftPlayerIds: [...(value.leftPlayerIds || [])], draw: Boolean(value.draw),
    finishReason: value.finishReason ?? null, gatheringReason: value.gatheringReason ?? null,
    finalResult: value.finalResult || null,
  };
}
async function fullResume(reason) {
  if (!state.roomId) return;
  const generation = state.resumeGeneration + 1;
  state.resumeGeneration = generation;
  state.presenceReady = 0;
  setConnectionState('syncing');
  stopRealtime(generation);
  try {
    await runMofumofuMultiFullResume({
      auth,
      signInAnonymously,
      isCurrent: () => generation === state.resumeGeneration,
      retirePresence,
      createConnectionId: newId,
      authorizePresence: () => call('authorizeMofumofuMultiPresence', { roomId: state.roomId }),
      beginPresence: async (seatId, connectionId) => {
        state.connectionId = connectionId;
        await beginPresence(seatId, generation, connectionId);
      },
      resumeRoom: () => call('resumeMofumofuMultiRoom', { roomId: state.roomId }),
      applyResume: (value) => {
        remember(state.roomId, value.seatId);
        state.cards = Array.isArray(value.cards) ? value.cards : [];
        state.handStatus = value.handStatus || 'pending';
        state.room = roomFromResume(value);
        renderAll();
        listenRoom(generation);
        startSafetySync(generation);
        setConnectionState('connected');
        // 配布直後などで自分の手札がまだ読めない場合だけ、少し待って取り直す（永久ループはしない）。
        if (value.handStatus === 'retry') void retryOwnHand(generation);
      },
    });
  } catch (error) {
    if (generation === state.resumeGeneration) {
      stopRealtime(generation);
      await retirePresence();
      const handled = handleMultiSessionFailure({
        error,
        storage: localStorage,
        forgetInvite: () => forgetInvite(),
        resetEntryView,
        message,
      });
      if (handled) { state.resumeGeneration += 1; return; }
    }
    throw error;
  }
}
// resumeがhandStatus='retry'を返した場合の1回だけの取り直し。
async function retryOwnHand(generation) {
  if (state.handRetryFlight || generation !== state.resumeGeneration) return;
  state.handRetryFlight = (async () => {
    await new Promise((resolve) => { setTimeout(resolve, 1_500); });
    if (generation !== state.resumeGeneration) return;
    try {
      const value = await call('resumeMofumofuMultiRoom', { roomId: state.roomId });
      if (generation !== state.resumeGeneration) return;
      if (value.handStatus === 'ready' || value.handStatus === 'left' || value.handStatus === 'finished') {
        state.cards = Array.isArray(value.cards) ? value.cards : [];
        state.handStatus = value.handStatus;
        if (state.room) renderGame(state.room);
      }
    } catch (error) { message(error.message); }
    finally { state.handRetryFlight = null; }
  })();
  return state.handRetryFlight;
}
const requestResume = createMultiResumeCoordinator({
  state,
  getRoomId: () => state.roomId,
  runResume: fullResume,
  onError: (error, reason) => setConnectionState('error', `復帰:${errorCode(error)}`),
});
function applyPublicRoom(room, generation) {
  if (generation !== state.resumeGeneration) return;
  state.room = room;
  renderAll();
}
function handleRoomGone() {
  if (!state.roomId) return;
  state.resumeGeneration += 1;
  stopRealtime();
  core.clearSavedRoom(localStorage);
  forgetInvite();
  resetEntryView();
  message(core.sessionRecoveryNotice(core.SESSION_REASONS.ROOM_NOT_FOUND));
}
function listenRoom(generation) {
  if (generation !== state.resumeGeneration) return;
  state.unsubscribe?.(); state.unsubscribe = null;
  state.unsubscribe = onSnapshot(doc(firestore, ROOM_COLLECTION, state.roomId), (snap) => {
    if (generation !== state.resumeGeneration) return;
    if (!snap.exists()) { handleRoomGone(); return; }
    state.listenerRetryCount = 0;
    applyPublicRoom({ ...snap.data() }, generation);
  }, (error) => {
    if (generation !== state.resumeGeneration) return;
    state.unsubscribe?.(); state.unsubscribe = null;
    const code = errorCode(error);
    setConnectionState('error', `Firestore listener:${code}`);
    const retryLimit = code === 'permission-denied' ? 1 : MAX_LISTENER_RETRIES;
    if (state.listenerRetryCount >= retryLimit) return;
    state.listenerRetryCount += 1;
    clearTimeout(state.listenerRetryTimer);
    state.listenerRetryTimer = setTimeout(() => {
      if (generation === state.resumeGeneration) void requestResume(`firestore-listener-error:${code}`);
    }, LISTENER_RETRY_MS * state.listenerRetryCount);
  });
}
async function lightweightSync(generation) {
  if (!state.roomId || document.hidden || generation !== state.resumeGeneration) return;
  try {
    const snap = await getDocFromServer(doc(firestore, ROOM_COLLECTION, state.roomId));
    if (generation !== state.resumeGeneration) return;
    if (!snap.exists()) { handleRoomGone(); return; }
    applyPublicRoom({ ...snap.data() }, generation);
  } catch (error) {
    if (generation !== state.resumeGeneration) return;
    setConnectionState('error', `Firestore fetch:${errorCode(error)}`);
  }
}
function startSafetySync(generation) {
  clearInterval(state.safetySyncTimer);
  state.safetySyncTimer = setInterval(() => void lightweightSync(generation), SAFETY_SYNC_MS);
}

/* ------------------------------------------------------------------ 操作 */

async function submitOffer(targetSeatId, button) {
  const room = state.room;
  if (state.makeBusy || !ui.cardId || !ui.claim || !core.canMakeOffer(room, state.seatId)) return;
  if (button.disabled) return;
  state.makeBusy = true;
  button.disabled = true;
  for (const node of $('targetButtons').children) node.disabled = true;
  // 同じ操作の再送は同じactionIdを使う（サーバー側の冪等性と対で二重消費を防ぐ）。
  state.makeRequest ||= {
    roomId: state.roomId, actionId: newId(), cardId: ui.cardId,
    claimedAnimalType: ui.claim, targetPlayerId: targetSeatId,
  };
  try {
    await call('makeMofumofuMultiOffer', state.makeRequest);
    state.makeRequest = null;
    ui.cardId = null; ui.claim = null;
    renderGame(state.room);
  } catch (error) {
    message(error.message);
    for (const node of $('targetButtons').children) node.disabled = false;
  } finally {
    state.makeBusy = false;
  }
}
async function submitJudgment(judgment, buttons) {
  const room = state.room;
  if (state.judgeBusy || !core.canJudge(room, state.seatId)) return;
  state.judgeBusy = true;
  for (const node of buttons) node.disabled = true;
  state.judgeRequest ||= { roomId: state.roomId, actionId: newId(), judgment };
  try {
    await call('judgeMofumofuMultiOffer', state.judgeRequest);
    state.judgeRequest = null;
    renderGame(state.room);
  } catch (error) {
    message(error.message);
    for (const node of buttons) node.disabled = false;
  } finally {
    state.judgeBusy = false;
  }
}
$('judge-buttons').addEventListener('click', (event) => {
  const judgment = event.target.dataset?.judgment;
  if (!judgment) return;
  void submitJudgment(judgment, [...event.currentTarget.querySelectorAll('button')]);
});
$('copy-invite').addEventListener('click', async () => {
  const code = core.restoreInvite(sessionStorage, state.roomId);
  if (code) await copyText(code, $('copy-invite'), core.COPY_LABEL);
});
$('copy-room-id').addEventListener('click', () => {
  if (state.roomId) return copyText(state.roomId, $('copy-room-id'), core.ROOM_ID_COPY_LABEL);
});
$('create-room').addEventListener('click', async () => {
  if (state.entryBusy) return;
  state.entryBusy = true; renderEntry();
  try {
    const value = await call('createMofumofuMultiRoom', { actionId: newId() });
    forgetInvite(value.roomId);
    remember(value.roomId, value.seatId);
    // 平文inviteはcreate応答だけを正本にし、そのタブのsessionStorageへだけ置く。
    core.rememberInvite(sessionStorage, value.roomId, value.inviteCode);
    await requestResume('create-room');
  } catch (error) { message(error.message); }
  finally { state.entryBusy = false; renderEntry(); }
});
$('join-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.entryBusy) return;
  state.entryBusy = true; renderEntry();
  try {
    const value = await call('joinMofumofuMultiRoom', {
      inviteCode: core.normalizeInviteCode($('invite-code').value),
      actionId: newId(),
    });
    forgetInvite(value.roomId);
    remember(value.roomId, value.seatId);
    await requestResume('join-room');
  } catch (error) { message(error.message); }
  finally { state.entryBusy = false; renderEntry(); }
});
$('start-game').addEventListener('click', async () => {
  if (state.startBusy) return;
  const button = $('start-game');
  if (button.disabled) return;
  state.startBusy = true;
  button.disabled = true;
  try {
    await call('startMofumofuMultiGame', { roomId: state.roomId, actionId: newId() });
    renderGame(state.room);
  } catch (error) {
    message(error.message);
    button.disabled = false;
  } finally {
    state.startBusy = false;
  }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) void requestResume('lifecycle'); });
globalThis.addEventListener('pageshow', () => void requestResume('lifecycle'));
globalThis.addEventListener('online', () => void requestResume('lifecycle'));

/* -------------------------------------------------------------------- 起動 */

const saved = core.loadRoom(localStorage);
if (saved) { state.roomId = saved.roomId; state.seatId = saved.seatId; }
renderEntry();
await auth.authStateReady();
if (!auth.currentUser) await signInAnonymously(auth);
if (state.roomId) await requestResume('initial');
else message('接続しました。');

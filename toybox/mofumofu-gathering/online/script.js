import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { getAuth, connectAuthEmulator, signInAnonymously } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app-check.js';
import { getFirestore, connectFirestoreEmulator, doc, onSnapshot, getDocFromServer } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js';
import { getDatabase, connectDatabaseEmulator, ref, onValue, onDisconnect, set, update, serverTimestamp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js';
import { resolveEnvironment, REGION } from './firebase-config.js';
import { completeInitialConnection } from './initial-connection.js';
import { beginEntrySubmit, connectionIsOnline, createResumeCoordinator, dialogScrollTargets, endEntrySubmit, playerPresenceState, proxyEvaluationReady, runStartGame, shouldStartNpcProxy } from './connection-control.js?v=20260925-5';
import { runMofumofuFullResume } from './full-resume.js';
import { isSavedRoomGoneError, createRoomGoneRecovery } from './room-recovery.js?v=20260925-3';
import { roomGoneNotice } from './room-recovery.js?v=20260925-3';

const animals = ['cat', 'rabbit', 'bear', 'chick', 'fox', 'penguin', 'panda', 'polar'];
const labels = { cat: 'ねこ', rabbit: 'うさぎ', bear: 'くま', chick: 'ひよこ', fox: 'きつね', penguin: 'ぺんぎん', panda: 'ぱんだ', polar: 'しろくま' };
const emoji = { cat: '🐱', rabbit: '🐰', bear: '🐻', chick: '🐥', fox: '🦊', penguin: '🐧', panda: '🐼', polar: '🐻‍❄️' };
const cardImages = { cat: 'cat.png', rabbit: 'rabbit.png', chick: 'chick.png', bear: 'bear.png', polar: 'polar-bear.png', fox: 'fox.png', penguin: 'penguin.png', panda: 'panda.png' };
const assetBase = '../../../assets/mofumofu-gathering/';
const environment = resolveEnvironment();
const app = initializeApp(environment.firebase);
if (environment.appCheck.debug) globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
initializeAppCheck(app, {
  provider: new ReCaptchaEnterpriseProvider(environment.appCheck.debug ? 'debug-provider' : environment.appCheck.siteKey),
  isTokenAutoRefreshEnabled: true,
});
const auth = getAuth(app); const firestore = getFirestore(app); const functions = getFunctions(app, REGION);
const database = getDatabase(app);
if (environment.name === 'emulator') {
  connectAuthEmulator(auth, `http://localhost:${environment.emulator.authPort}`, { disableWarnings: true });
  connectFirestoreEmulator(firestore, 'localhost', environment.emulator.firestorePort);
  connectFunctionsEmulator(functions, 'localhost', environment.emulator.functionsPort);
  connectDatabaseEmulator(database, 'localhost', environment.emulator.databasePort);
}
const call = (name, data) => httpsCallable(functions, name)(data).then((response) => response.data);
// 新Callable（closeMofumofuRoom）がstaging/productionへdeployされるまではfalseに保つ公開ゲート。
// falseの間は一般ユーザーに「部屋を閉じる」を表示せず、呼び出しも一切行わない。
const CLOSE_ROOM_ENABLED = true;
const $ = (id) => document.getElementById(id);
function cardImage(animalType, alt) { const node = document.createElement('img'); node.src = `${assetBase}${cardImages[animalType]}`; node.alt = alt; node.draggable = false; return node; }
const helpDialog = $('help-dialog');
for (const helpId of ['open-help', 'open-help-lobby', 'game-help']) $(helpId).addEventListener('click', () => helpDialog.showModal());
$('close-help').addEventListener('click', () => helpDialog.close());
// ダイアログが画面に収まらないとき、初期表示を末尾（閉じるボタンの見える位置）へ寄せる。収まる場合は位置を変えない。
function enhanceDialogScroll(dialog) {
  if (!dialog) return;
  let wasAtBottom = false;
  dialog.addEventListener('scroll', () => { wasAtBottom = dialog.scrollTop + dialog.clientHeight >= dialog.scrollHeight - 24; }, { passive: true });
  dialog.addEventListener('toggle', () => {
    if (!dialog.open) return;
    const targets = dialogScrollTargets({ contentH: dialog.scrollHeight, viewH: dialog.clientHeight, wasAtBottom });
    dialog.scrollTop = targets[targets.length - 1];
  });
}
for (const dialogId of ['help-dialog', 'close-room-dialog']) enhanceDialogScroll($(dialogId));
const HEARTBEAT_MS = 15_000;
const STALE_MS = 120_000;
const ACCESS_REFRESH_MS = 4 * 60_000;
const SAFETY_SYNC_MS = 5_000;
const LISTENER_RETRY_MS = 2_000;
const MAX_LISTENER_RETRIES = 3;
const state = { roomId: localStorage.getItem('mofumofuRoomId'), seatId: localStorage.getItem('mofumofuSeatId'), room: null, cards: [], presence: {}, connectionId: null, presenceRef: null, presenceUnsubscribe: null, heartbeatTimer: null, accessTimer: null, safetySyncTimer: null, listenerRetryTimer: null, listenerRetryCount: 0, resumeFlight: null, resumeGeneration: 0, presenceReadyGeneration: 0, lastSuccessfulResumeAt: 0, lastSuccessfulResumeRoomId: null, lifecycleDisconnected: navigator.onLine === false, playingResumeKey: null, connectionState: 'syncing', startBusy: false, makeRequest: null, judgeRequest: null, npcRequest: null, proxyStartRequest: null, proxyActionRequest: null, makeBusy: false, judgeBusy: false, npcBusy: false, proxyBusy: false, unsubscribe: null, invite: null, entryBusy: false, closeBusy: false, closeRequest: null };
const ui = { selectedUid: null, claim: null, flashTimer: null, lastOfferActionId: null, seenEliminations: new Set(), controlTimer: null, gatheringShown: false, logoTimer: null, copyTimer: null };
function newId() { return crypto.randomUUID(); }
function remember(roomId, seatId) { state.roomId = roomId; state.seatId = seatId; localStorage.setItem('mofumofuRoomId', roomId); localStorage.setItem('mofumofuSeatId', seatId); }
// 招待コードはcreate正常responseの平文だけを正本にする。stateと、現在タブ・現在room用のsessionStorageだけに保持する。
const INVITE_CODE_RE = /^[A-Za-z0-9]{8}$/;
const inviteKey = (roomId) => `mofumofuInvite:${roomId}`;
function rememberInvite(roomId, code) { if (!roomId || !INVITE_CODE_RE.test(code || '')) return; state.invite = { roomId, code }; try { sessionStorage.setItem(inviteKey(roomId), code); } catch {} }
function restoreInvite(roomId) { if (!roomId) return ''; if (state.invite?.roomId === roomId && INVITE_CODE_RE.test(state.invite.code || '')) return state.invite.code; try { const code = sessionStorage.getItem(inviteKey(roomId)); if (code && INVITE_CODE_RE.test(code)) { state.invite = { roomId, code }; return code; } } catch {} return ''; }
function forgetInvite(roomId) { if (!roomId) { if (state.invite) { try { sessionStorage.removeItem(inviteKey(state.invite.roomId)); } catch {} } state.invite = null; return; } try { sessionStorage.removeItem(inviteKey(roomId)); } catch {} if (state.invite?.roomId === roomId) state.invite = null; }
function renderInvite(room) {
  const hostWaiting = room.status === 'waiting' && room.hostUid === auth.currentUser?.uid && state.seatId === 'A' && state.roomId;
  if (!hostWaiting) { $('shown-invite').textContent = ''; $('invite-note').textContent = ''; $('copy-invite').hidden = true; $('copy-invite').textContent = 'コピー'; return; }
  const code = restoreInvite(state.roomId);
  $('shown-invite').textContent = code;
  $('copy-invite').hidden = !code;
  $('copy-invite').textContent = 'コピー';
  $('invite-note').textContent = code ? 'この8文字の招待コードを相手に教えてね。' : '招待コードを表示できませんでした。部屋をつくり直してください。';
}
function message(text) { $('status').textContent = text; }
const seatEmoji = { A: '🐰', B: '🐻', koharu: '🌸' };
function seatName(playerId) { return playerId === 'koharu' ? 'こはる' : playerId === state.seatId ? 'あなた' : '相手'; }
function seatNode(room, playerId, isSelf) {
  const seat = document.createElement('section');
  seat.className = 'player-box';
  const name = document.createElement('strong');
  name.textContent = `${seatEmoji[playerId] || '🙂'} ${seatName(playerId)}`;
  const chip = document.createElement('span');
  chip.className = 'chip';
  const online = playerOnline(playerId);
  const mode = room.controlModes?.[playerId]?.mode || 'human';
  chip.textContent = mode === 'npc-controlled' ? 'NPC代理中' : mode === 'return-pending' ? '本人復帰済み／代理終了待ち' : mode === 'ended' ? '代理終了' : online ? '● 接続中' : '○ 再接続待ち';
  seat.append(name, chip);
  return seat;
}
function renderLobbySeats(room) {
  const seats = ['A', 'B', 'koharu'].map((playerId) => {
    const seat = document.createElement('section');
    seat.className = 'player-box lobby-seat';
    const name = document.createElement('strong');
    name.textContent = `${seatEmoji[playerId] || '🙂'} ${seatName(playerId)}`;
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = playerId === 'koharu' ? 'NPC' : room.players?.[playerId]?.joined ? '参加ずみ' : '参加まち';
    seat.append(name, chip);
    return seat;
  });
  $('players').replaceChildren(...seats);
}
function pushLog(text) {
  const line = document.createElement('p');
  line.textContent = text;
  $('log').append(line);
}
function flash(text) {
  const node = $('flash');
  node.textContent = text;
  clearTimeout(ui.flashTimer);
  ui.flashTimer = setTimeout(() => { node.textContent = ''; }, 2600);
}
function showControlStatus(text, sticky) {
  const node = $('control-status');
  node.textContent = text;
  clearTimeout(ui.controlTimer);
  if (text && !sticky) ui.controlTimer = setTimeout(() => { node.textContent = ''; }, 3200);
}
function gatheringReasonText(reason, eliminationAnimal) {
  if (reason === 'four-and-eight') return `${labels[eliminationAnimal]}が4枚、全8種類がそろってしまいました`;
  if (reason === 'four-of-a-kind') return `${labels[eliminationAnimal]}が4枚そろってしまいました`;
  return '全8種類の動物が表向きにそろってしまいました';
}
function showGatheringLogo(onDone) {
  const overlay = $('gathering-overlay');
  overlay.classList.remove('hidden');
  clearTimeout(ui.logoTimer);
  ui.logoTimer = setTimeout(() => { overlay.classList.add('hidden'); onDone(); }, 2600);
}
function observeRoomEvents(room, previous) {
  if (!previous) return;
  for (const snapshot of Object.values(room.eliminationSnapshots || {})) {
    if (ui.seenEliminations.has(snapshot.eliminatedAt)) continue;
    ui.seenEliminations.add(snapshot.eliminatedAt);
    pushLog(`${seatName(snapshot.playerId)}が${emoji[snapshot.eliminationAnimal]}${labels[snapshot.eliminationAnimal]}を4枚そろって「もふもふ大集合！」`);
  }
}

const recoverFromRoomGone = createRoomGoneRecovery({
  state,
  storage: localStorage,
  message,
  resetEntryView: () => {
    $('entry').hidden = false;
    for (const id of ['lobby', 'game', 'result', 'final-result', 'offer-form', 'claimStep', 'targetStep', 'judgeStep', 'npc-status', 'reconnect-wait', 'close-room']) $(id).hidden = true;
    if ($('close-room-dialog').open) $('close-room-dialog').close();
    for (const id of ['players', 'presence-list', 'hand', 'judgeHand', 'log', 'self-seat']) $(id).replaceChildren();
    for (const id of ['turn', 'shown-invite', 'control-status', 'offer-message', 'flash']) $(id).textContent = '';
    $('invite-note').textContent = '';
    forgetInvite();
    ui.gatheringShown = false;
    renderEntry();
  },
});
// roomが消えた（hostが閉じた／TTL cleanup）ときは、保存room・seatを解除して入口へ戻す。
function handleRoomGone(notice = null) {
  if (!state.roomId) return;
  const generation = state.resumeGeneration + 1;
  state.resumeGeneration = generation;
  stopRealtime(generation);
  recoverFromRoomGone(notice);
}
function setConnectionState(next, detail = '') {
  state.connectionState = next;
  message(next === 'connected' ? '接続中' : next === 'syncing' ? '再接続中／同期中…' : `同期エラー${detail ? `（${detail}）` : ''}`);
}
function errorCode(error) { return String(error?.code || 'unknown').replace(/^firestore\//, ''); }
function connectionOnline(connection, now = Date.now()) { return connectionIsOnline(connection, now, STALE_MS); }
function playerPresence(playerId) {
  const uid = state.room?.playerUids?.[playerId];
  return uid ? state.presence?.[uid] : null;
}
function playerOnline(playerId) {
  if (playerId === 'koharu') return true;
  return playerPresenceState(playerPresence(playerId), Date.now(), STALE_MS).online;
}
function renderPresence() {
  if (!state.room) return;
  const room = state.room;
  const top = ['A', 'B', 'koharu'].filter((playerId) => playerId !== state.seatId).map((playerId) => seatNode(room, playerId, false));
  $('presence-list').replaceChildren(...top);
  $('self-seat').replaceChildren(seatNode(room, state.seatId, true));
  const waitingPlayer = room.status === 'playing' && (
    (room.turnState === 'awaitingJudgment' && room.publicOffer?.toPlayerId !== 'koharu' && !playerOnline(room.publicOffer?.toPlayerId))
    || (room.currentTurnPlayerId !== 'koharu' && !playerOnline(room.currentTurnPlayerId))
  ) ? (room.turnState === 'awaitingJudgment' ? room.publicOffer.toPlayerId : room.currentTurnPlayerId) : null;
  const wait = $('reconnect-wait');
  wait.hidden = !waitingPlayer;
  wait.textContent = waitingPlayer ? waitingPlayer === state.seatId ? '接続の復帰を待っています' : `${seatName(waitingPlayer)}の再接続を待っています` : '';
}
async function authorizePresence(connectionId = state.connectionId) {
  return call('authorizeMofumofuPresence', { roomId: state.roomId, connectionId });
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
async function retirePresence() {
  const oldRef = state.presenceRef;
  state.presenceRef = null;
  if (!oldRef) return;
  await onDisconnect(oldRef).cancel().catch(() => {});
  await update(oldRef, { state: 'disconnected', lastHeartbeatAt: serverTimestamp() }).catch(() => {});
}
const requestFullResume = createResumeCoordinator({
  state,
  getRoomId: () => state.roomId,
  runResume: fullResume,
  onError: (error, reason) => {
    if (reason.includes('waiting-playing')) state.playingResumeKey = null;
    setConnectionState('error', `復帰:${errorCode(error)}`);
  },
});
async function beginPresence(seatId, generation, connectionId) {
  const uid = auth.currentUser.uid;
  const path = `mofumofuOnlinePresence/${state.roomId}/${uid}/connections/${connectionId}`;
  state.presenceRef = ref(database, path);
  const ownPresenceRef = state.presenceRef;
  const base = { uid, roomId: state.roomId, seatId, connectionId };
  const connectedAt = Date.now();
  await onDisconnect(ownPresenceRef).set({ ...base, state: 'disconnected', lastHeartbeatAt: serverTimestamp(), connectedAt });
  await set(ownPresenceRef, { ...base, state: 'online', lastHeartbeatAt: serverTimestamp(), connectedAt });
  if (generation !== state.resumeGeneration) return;
  state.heartbeatTimer = setInterval(() => {
    if (generation !== state.resumeGeneration) return;
    update(ownPresenceRef, { state: 'online', lastHeartbeatAt: serverTimestamp() }).catch(() => requestFullResume('heartbeat-error'));
  }, HEARTBEAT_MS);
  state.accessTimer = setInterval(() => {
    if (generation !== state.resumeGeneration) return;
    authorizePresence(connectionId).catch(() => requestFullResume('presence-access-error'));
  }, ACCESS_REFRESH_MS);
  state.presenceUnsubscribe = onValue(ref(database, `mofumofuOnlinePresence/${state.roomId}`), (snapshot) => {
    if (generation !== state.resumeGeneration) return;
    state.presence = snapshot.val() || {};
    if (connectionOnline(state.presence?.[uid]?.connections?.[connectionId])) state.presenceReadyGeneration = generation;
    renderPresence();
    if (proxyEvaluationReady(state)) void runProxyIfNeeded();
  }, () => requestFullResume('rtdb-listener-error'));
}
function hostWaitingRoom(room) { return Boolean(room) && room.status === 'waiting' && room.hostUid === auth.currentUser?.uid && state.seatId === 'A'; }
function renderCloseRoom(room) { $('close-room').hidden = !(CLOSE_ROOM_ENABLED && hostWaitingRoom(room)); }
// 入口操作のenabledは state.entryBusy だけから導出する。DOMを直接いじらず、次回renderでも同じ結果になる。
function renderEntry() { const busy = Boolean(state.entryBusy); $('create-room').disabled = busy; $('join-room').disabled = busy; }
function showRoom(room) {
  if (room.status === 'finished' || room.playerStatus?.[state.seatId] === 'eliminated') {
    state.cards = [];
    state.makeRequest = null;
    state.judgeRequest = null;
    state.npcRequest = null;
  }
  state.room = room; $('entry').hidden = true; $('lobby').hidden = room.status !== 'waiting'; $('game').hidden = !['playing', 'finished'].includes(room.status);
  if (room.status === 'playing' || room.status === 'finished') forgetInvite(state.roomId);
  $('room-id').textContent = state.roomId ? `${state.roomId.slice(0, 8)}…` : '';
  $('room-id').title = state.roomId ? `部屋ID：${state.roomId}` : '';
  $('room-id').setAttribute('aria-label', $('room-id').title);
  renderInvite(room);
  renderLobbySeats(room);
  $('start-game').hidden = room.hostUid !== auth.currentUser?.uid;
  renderCloseRoom(room);
  if (room.status === 'playing' || room.status === 'finished') renderGame();
  renderPresence();
}
function applyPublicRoom(room, generation, source) {
  if (generation !== state.resumeGeneration) return;
  const wasWaiting = state.room?.status === 'waiting';
  const previousRoom = state.room;
  showRoom(room);
  observeRoomEvents(room, previousRoom);
  if (wasWaiting && room.status === 'playing') {
    const key = `${state.roomId}:playing`;
    if (state.playingResumeKey !== key) { state.playingResumeKey = key; void requestFullResume(`${source}:waiting-playing`); }
  }
}
function listenRoom(generation) {
  if (generation !== state.resumeGeneration) return;
  state.unsubscribe?.(); state.unsubscribe = null;
  const roomRef = doc(firestore, 'mofumofuOnlineRooms', state.roomId);
  state.unsubscribe = onSnapshot(roomRef, (snap) => {
    if (generation !== state.resumeGeneration) return;
    if (!snap.exists()) { handleRoomGone(roomGoneNotice(state.room)); return; }
    state.listenerRetryCount = 0;
    applyPublicRoom(snap.data(), generation, 'firestore-listener');
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
      if (generation === state.resumeGeneration) void requestFullResume(`firestore-listener-error:${code}`);
    }, LISTENER_RETRY_MS * state.listenerRetryCount);
  });
}
async function lightweightSync(generation = state.resumeGeneration) {
  if (!state.roomId || document.hidden || generation !== state.resumeGeneration) return;
  try {
    const snap = await getDocFromServer(doc(firestore, 'mofumofuOnlineRooms', state.roomId));
    if (generation !== state.resumeGeneration) return;
    if (!snap.exists()) { handleRoomGone(roomGoneNotice(state.room)); return; }
    applyPublicRoom(snap.data(), generation, 'safety-sync');
  } catch (error) {
    if (generation !== state.resumeGeneration) return;
    const code = errorCode(error);
    setConnectionState('error', `Firestore fetch:${code}`);
    if (code === 'permission-denied') { clearInterval(state.safetySyncTimer); state.safetySyncTimer = null; }
  }
}
function startSafetySync(generation) {
  clearInterval(state.safetySyncTimer);
  state.safetySyncTimer = setInterval(() => void lightweightSync(generation), SAFETY_SYNC_MS);
}
async function fullResume(reason = 'manual') {
  if (!state.roomId) return;
  const generation = state.resumeGeneration + 1;
  state.resumeGeneration = generation;
  state.presenceReadyGeneration = 0;
  setConnectionState('syncing');
  stopRealtime(generation);
  try {
    await runMofumofuFullResume({
      auth,
      signInAnonymously,
      isCurrent: () => generation === state.resumeGeneration,
      retirePresence,
      createConnectionId: newId,
      authorizePresence,
      beginPresence: async (seatId, connectionId) => {
        state.connectionId = connectionId;
        await beginPresence(seatId, generation, connectionId);
      },
      resumeRoom: () => call('resumeMofumofuRoom', { roomId: state.roomId }),
      applyResume: (value) => {
        remember(state.roomId, value.seatId); state.cards = value.cards || []; showRoom(value.room);
        listenRoom(generation); startSafetySync(generation); setConnectionState('connected');
      },
    });
  }
  catch (error) {
    if (generation === state.resumeGeneration) {
      stopRealtime(generation);
      await retirePresence();
      // 保存済みroomの存在確認で返るnot-foundだけを「room終了」として扱い、入室画面へ戻す。
      if (isSavedRoomGoneError(error)) {
        state.resumeGeneration += 1;
        recoverFromRoomGone();
        return;
      }
    }
    throw error;
  }
}
function renderGame() {
  const room = state.room; const offer = room.publicOffer; const ownStatus = room.playerStatus?.[state.seatId]; const finished = room.status === 'finished';
  const ownControl = room.controlModes?.[state.seatId]?.mode || 'human';
  const canMake = !finished && ownStatus === 'active' && ownControl === 'human' && room.turnState === 'awaitingOffer' && room.currentTurnPlayerId === state.seatId;
  const canJudge = !finished && ownStatus === 'active' && ownControl === 'human' && offer?.status === 'pending' && offer.toPlayerId === state.seatId;
  for (const stepId of ['claimStep', 'targetStep', 'judgeStep']) $(stepId).classList.remove('hidden');
  $('turn').textContent = finished ? 'ゲーム終了' : `${seatName(room.currentTurnPlayerId)}の番`;
  $('turn').classList.toggle('mine', !finished && room.currentTurnPlayerId === state.seatId);
  $('npc-status').hidden = finished || room.turnState !== 'awaitingNpcPhase';
  const controlText = ownControl === 'human' ? '本人へ操作権返却済み' : ownControl === 'npc-controlled' ? 'NPC代理中' : ownControl === 'return-pending' ? '本人復帰済み／代理終了待ち' : '代理終了';
  showControlStatus(controlText, ownControl !== 'human');
  $('offer-form').hidden = !canMake;
  $('hand').replaceChildren(...state.cards.map((card) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = `hand-card${ui.selectedUid === card.cardId ? ' selected' : ''}`;
    node.append(cardImage(card.animalType, ''));
    node.setAttribute('aria-label', labels[card.animalType]);
    node.disabled = !canMake;
    node.addEventListener('click', () => { if (!canMake) return; ui.selectedUid = card.cardId; ui.claim = null; renderGame(); });
    return node;
  }));
  const claimButtons = $('claimButtons');
  if (canMake && ui.selectedUid) {
    claimButtons.replaceChildren(...animals.map((animal) => {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = `animal-button${ui.claim === animal ? ' selected' : ''}`;
      node.textContent = `${emoji[animal]} ${labels[animal]}`;
      node.addEventListener('click', () => { if (!canMake) return; ui.claim = animal; renderGame(); });
      return node;
    }));
  } else claimButtons.replaceChildren();
  $('claimStep').hidden = !(canMake && ui.selectedUid);
  const targetButtons = $('targetButtons');
  const targets = ['A', 'B', 'koharu'].filter((playerId) => playerId !== state.seatId && room.playerStatus?.[playerId] === 'active');
  if (canMake && ui.claim) {
    targetButtons.replaceChildren(...targets.map((playerId) => {
      const node = document.createElement('button');
      node.type = 'button';
      node.dataset.target = playerId;
      node.textContent = `${seatName(playerId)}へ`;
      node.addEventListener('click', async () => {
        if (state.makeBusy || !canMake || !ui.selectedUid || !ui.claim) return;
        const button = node; if (button.disabled) return; button.disabled = true;
        state.makeRequest ||= { roomId: state.roomId, cardId: ui.selectedUid, claimAnimal: ui.claim, targetPlayerId: button.dataset.target, actionId: newId() };
        state.makeBusy = true; [...$('targetButtons').children].forEach((b) => { b.disabled = true; });
        try {
          await call('makeMofumofuOffer', state.makeRequest); state.makeRequest = null;
          ui.selectedUid = null; ui.claim = null;
          await refresh();
        } catch (error) { message(error.message); [...$('targetButtons').children].forEach((b) => { b.disabled = false; }); }
        finally { state.makeBusy = false; }
      });
      return node;
    }));
  } else targetButtons.replaceChildren();
  $('targetStep').hidden = !(canMake && ui.claim);
  $('judgeStep').hidden = !canJudge;
  $('judge-buttons').hidden = !canJudge;
  if (canJudge) {
    $('judgeHand').replaceChildren(...state.cards.map((card) => {
      const node = document.createElement('span');
      node.className = 'hand-card static';
      node.append(cardImage(card.animalType, ''));
      node.setAttribute('aria-label', labels[card.animalType]);
      return node;
    }));
  } else $('judgeHand').replaceChildren();
  if (offer && (offer.status === 'pending' || offer.status === 'completed')) {
    $('tableCardMain').replaceChildren(cardImage(offer.claimAnimal, labels[offer.claimAnimal]));
    $('tableCardSub').textContent = `${seatName(offer.fromPlayerId)}の宣言`;
  } else {
    $('tableCardMain').textContent = '？';
    $('tableCardSub').textContent = '';
  }
  $('offer-message').textContent = offer?.status === 'pending' && offer.toPlayerId !== state.seatId ? '相手の判定を待っています…' : offer?.status === 'pending' ? 'うそ？ ほんと？ えらんでね。' : '';
  if (offer?.status === 'completed' && offer.actionId && offer.actionId !== ui.lastOfferActionId) {
    ui.lastOfferActionId = offer.actionId;
    pushLog(`${seatName(offer.fromPlayerId)}「${labels[offer.claimAnimal]}だよ」→ ほんとは${labels[offer.actualAnimal]}（判定${offer.success ? '成功' : '失敗'}）`);
    flash(offer.success ? '○ あたり！' : '× うそだった！');
  }
  $('result').hidden = offer?.status !== 'completed';
  if (offer?.status === 'completed') $('result').textContent = `本当は${labels[offer.actualAnimal]}。判定${offer.success ? '成功' : '失敗'}。${seatName(offer.faceUpRecipientPlayerId)}が表向きカードを受け取りました。${finished ? 'ゲーム終了です。' : `次は${seatName(room.currentTurnPlayerId)}です。`}`;
  if (finished) {
    const gathering = Array.isArray(room.finalResult?.winnerPlayerIds);
    if (gathering && !ui.gatheringShown) {
      ui.gatheringShown = true;
      showGatheringLogo(() => { $('final-result').hidden = false; renderFinalResult(room.finalResult); });
      return;
    }
    $('final-result').hidden = false;
    renderFinalResult(room.finalResult);
  } else $('final-result').hidden = true;
  if (!finished && ownStatus === 'active' && room.turnState === 'awaitingNpcPhase') void runNpc();
  if (!finished) void runProxyIfNeeded();
}
async function runProxyIfNeeded() {
  if (state.proxyBusy || !state.room || !proxyEvaluationReady(state)) return;
  const room = state.room;
  const seatId = room.turnState === 'awaitingJudgment' ? room.publicOffer?.toPlayerId : room.currentTurnPlayerId;
  if (!['A', 'B'].includes(seatId)) return;
  const mode = room.controlModes?.[seatId]?.mode || 'human';
  if (mode === 'return-pending') { if (seatId === state.seatId) await refresh().catch(() => {}); return; }
  if (mode === 'human' && !shouldStartNpcProxy({ state, mode, presence: playerPresence(seatId), staleMs: STALE_MS })) return;
  state.proxyBusy = true;
  try {
    if (mode === 'human') {
      state.proxyStartRequest ||= { roomId: state.roomId, actionId: newId() };
      await call('startMofumofuNpcProxy', state.proxyStartRequest); state.proxyStartRequest = null;
    }
    state.proxyActionRequest ||= { roomId: state.roomId, actionId: newId() };
    await call('runMofumofuNpcProxyAction', state.proxyActionRequest); state.proxyActionRequest = null; await refresh();
  } catch (error) { if (!String(error.code || '').includes('failed-precondition')) message(error.message); }
  finally { state.proxyBusy = false; }
}
function renderFinalResult(finalResult) {
  if (!finalResult) return;
  const gathering = Array.isArray(finalResult.winnerPlayerIds);
  const loser = gathering ? finalResult.players.find((player) => player.eliminated) : null;
  $('final-title').textContent = gathering ? `🐾 もふもふ大集合！ ${loser ? `${seatName(loser.playerId)}の負け` : ''}` : finalResult.draw ? '🤝 引き分け！' : `${seatName(finalResult.winnerPlayerId)}の勝ち！`;
  $('final-reason').textContent = gatheringReasonText(finalResult.finishReason, loser?.eliminationAnimal);
  $('final-players').replaceChildren(...finalResult.players.map((player) => {
    const box = document.createElement('section'); box.className = `final-player${player.eliminated ? ' eliminated' : ''}`;
    const title = document.createElement('strong'); title.textContent = seatName(player.playerId); box.append(title);
    if (gathering) { const verdict = document.createElement('p'); verdict.className = `final-verdict ${player.eliminated ? 'lost' : 'won'}`; verdict.textContent = player.eliminated ? 'もふもふ大集合！／負け' : finalResult.winnerPlayerIds.includes(player.playerId) ? '勝ち！' : ''; box.append(verdict); }
    for (const animal of animals) if (player.faceUpCardsByAnimal?.[animal]) { const line = document.createElement('p'); line.textContent = `${emoji[animal]}${labels[animal]} ×${player.faceUpCardsByAnimal[animal]}`; box.append(line); }
    if (!player.faceUpCardsTotal) { const line = document.createElement('p'); line.textContent = '表向きカード なし'; box.append(line); }
    if (player.eliminated && player.eliminationAnimal) { const line = document.createElement('p'); line.textContent = `${emoji[player.eliminationAnimal]}${labels[player.eliminationAnimal]}が4枚そろいました`; box.append(line); }
    return box;
  }));
}
async function refresh() {
  const generation = state.resumeGeneration;
  const value = await call('resumeMofumofuRoom', { roomId: state.roomId });
  if (generation !== state.resumeGeneration) return;
  state.cards = value.cards || []; showRoom(value.room);
}
async function runNpc() {
  if (state.npcBusy) return; state.npcRequest ||= { roomId: state.roomId, actionId: newId() }; state.npcBusy = true;
  try { await call('runMofumofuNpcTurn', state.npcRequest); state.npcRequest = null; await refresh(); if (state.room?.turnState === 'awaitingNpcPhase') setTimeout(runNpc, 250); }
  catch (error) { message(error.message); setTimeout(runNpc, 1000); }
  finally { state.npcBusy = false; }
}
async function copyText(value, button, resetLabel) {
  const done = (text) => { button.textContent = text; clearTimeout(ui.copyTimer); ui.copyTimer = setTimeout(() => { button.textContent = resetLabel; }, 2400); };
  try { await navigator.clipboard.writeText(value); done('コピーしました！'); return; } catch {}
  try { const area = document.createElement('textarea'); area.value = value; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0'; document.body.append(area); area.select(); const ok = document.execCommand('copy'); area.remove(); done(ok ? 'コピーしました！' : 'コピーできませんでした'); } catch { done('コピーできませんでした'); }
}
$('copy-invite').addEventListener('click', async () => { const code = restoreInvite(state.roomId); if (code) await copyText(code, $('copy-invite'), 'コピー'); });
$('copy-room-id').addEventListener('click', () => { if (state.roomId) return copyText(state.roomId, $('copy-room-id'), '部屋IDをコピー'); });
$('create-room').addEventListener('click', async () => {
  if (!beginEntrySubmit(state)) return; renderEntry();
  try { const value = await call('createMofumofuRoom', {}); forgetInvite(); remember(value.roomId, value.seatId); rememberInvite(value.roomId, value.inviteCode); await requestFullResume('create-room'); }
  catch (error) { message(error.message); }
  finally { endEntrySubmit(state); renderEntry(); }
});
$('join-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (!beginEntrySubmit(state)) return; renderEntry();
  try { const value = await call('joinMofumofuRoom', { inviteCode: $('invite-code').value }); forgetInvite(); remember(value.roomId, value.seatId); await requestFullResume('join-room'); }
  catch (error) { message(error.message); }
  finally { endEntrySubmit(state); renderEntry(); }
});
$('start-game').addEventListener('click', async () => {
  try {
    await runStartGame({ state, button: $('start-game'), roomId: state.roomId, startGame: (data) => call('startMofumofuGame', data), refresh });
  } catch (error) { message(error.message); }
});
$('judge-buttons').addEventListener('click', async (event) => {
  const judgment = event.target.dataset.judgment; if (!judgment || state.judgeBusy) return; const buttons = [...event.currentTarget.querySelectorAll('button')]; state.judgeRequest ||= { roomId: state.roomId, actionId: state.room.publicOffer.actionId, judgment }; state.judgeBusy = true; buttons.forEach((button) => { button.disabled = true; });
  try { await call('judgeMofumofuOffer', state.judgeRequest); state.judgeRequest = null; await refresh(); } catch (error) { message(error.message); } finally { state.judgeBusy = false; buttons.forEach((button) => { button.disabled = false; }); }
});
$('close-room').addEventListener('click', () => { if (!CLOSE_ROOM_ENABLED || !hostWaitingRoom(state.room)) return; $('close-room-dialog').showModal(); });
$('close-room-cancel').addEventListener('click', () => $('close-room-dialog').close());
$('close-room-confirm').addEventListener('click', async () => {
  if (!CLOSE_ROOM_ENABLED || state.closeBusy || !hostWaitingRoom(state.room)) return;
  const button = $('close-room-confirm'); if (button.disabled) return; button.disabled = true; state.closeBusy = true;
  try {
    state.closeRequest ||= { roomId: state.roomId, actionId: newId() };
    await call('closeMofumofuRoom', state.closeRequest);
    state.closeRequest = null;
    $('close-room-dialog').close();
    handleRoomGone('部屋を閉じました。');
  } catch (error) { message(error.message); button.disabled = false; }
  finally { state.closeBusy = false; }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) void requestFullResume('visibilitychange'); });
globalThis.addEventListener('pageshow', () => void requestFullResume('pageshow'));
globalThis.addEventListener('online', () => void requestFullResume('online'));
globalThis.addEventListener('offline', () => { state.lifecycleDisconnected = true; });
await completeInitialConnection({
  auth,
  signInAnonymously,
  roomId: state.roomId,
  markConnected: () => message('接続しました。'),
  resumeRoom: () => requestFullResume('initial'),
});

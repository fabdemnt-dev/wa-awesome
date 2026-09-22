import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { getAuth, connectAuthEmulator, signInAnonymously } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider, getToken } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app-check.js';
import { getFirestore, connectFirestoreEmulator, doc, onSnapshot, getDocFromServer } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js';
import { getDatabase, connectDatabaseEmulator, ref, onValue, onDisconnect, set, update, serverTimestamp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js';
import { resolveEnvironment, REGION } from './firebase-config.js';

const animals = ['cat', 'rabbit', 'bear', 'chick', 'fox', 'penguin', 'panda', 'polar'];
const labels = { cat: 'ねこ', rabbit: 'うさぎ', bear: 'くま', chick: 'ひよこ', fox: 'きつね', penguin: 'ぺんぎん', panda: 'ぱんだ', polar: 'しろくま' };
const emoji = { cat: '🐱', rabbit: '🐰', bear: '🐻', chick: '🐥', fox: '🦊', penguin: '🐧', panda: '🐼', polar: '🐻‍❄️' };
const environment = resolveEnvironment();
const app = initializeApp(environment.firebase);
if (environment.appCheck.debug) globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
const appCheck = initializeAppCheck(app, {
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
const $ = (id) => document.getElementById(id);
const HEARTBEAT_MS = 15_000;
const STALE_MS = 120_000;
const ACCESS_REFRESH_MS = 4 * 60_000;
const SAFETY_SYNC_MS = 5_000;
const LISTENER_RETRY_MS = 2_000;
const MAX_LISTENER_RETRIES = 3;
const state = { roomId: localStorage.getItem('mofumofuRoomId'), seatId: localStorage.getItem('mofumofuSeatId'), room: null, cards: [], presence: {}, connectionId: null, presenceRef: null, presenceUnsubscribe: null, heartbeatTimer: null, accessTimer: null, safetySyncTimer: null, listenerRetryTimer: null, listenerRetryCount: 0, resumeFlight: null, resumeGeneration: 0, playingResumeKey: null, connectionState: 'syncing', makeRequest: null, judgeRequest: null, npcRequest: null, proxyStartRequest: null, proxyActionRequest: null, makeBusy: false, judgeBusy: false, npcBusy: false, proxyBusy: false, unsubscribe: null };
function newId() { return crypto.randomUUID(); }
function remember(roomId, seatId) { state.roomId = roomId; state.seatId = seatId; localStorage.setItem('mofumofuRoomId', roomId); localStorage.setItem('mofumofuSeatId', seatId); }
function message(text) { $('status').textContent = text; }
function setConnectionState(next, detail = '') {
  state.connectionState = next;
  message(next === 'connected' ? '接続中' : next === 'syncing' ? '再接続中／同期中…' : `同期エラー${detail ? `（${detail}）` : ''}`);
}
function errorCode(error) { return String(error?.code || 'unknown').replace(/^firestore\//, ''); }
function connectionOnline(connection, now = Date.now()) { return connection?.state === 'online' && Number(connection.lastHeartbeatAt) >= now - STALE_MS; }
function playerOnline(playerId) {
  if (playerId === 'koharu') return true;
  const uid = state.room?.playerUids?.[playerId];
  return !!uid && Object.values(state.presence?.[uid]?.connections || {}).some((connection) => connectionOnline(connection));
}
function renderPresence() {
  if (!state.room) return;
  const rows = ['A', 'B', 'koharu'].map((playerId) => {
    const li = document.createElement('li');
    const online = playerOnline(playerId);
    li.className = online ? 'presence-online' : 'presence-wait';
    const mode = state.room.controlModes?.[playerId]?.mode || 'human';
    const status = mode === 'npc-controlled' ? 'NPC代理中' : mode === 'return-pending' ? '本人復帰済み／代理終了待ち' : mode === 'ended' ? '代理終了' : online ? '● 接続中' : '○ 再接続待ち';
    li.textContent = playerId === 'koharu' ? 'こはる　● NPC' : `プレイヤー${playerId}　${status}`;
    return li;
  });
  $('presence-list').replaceChildren(...rows);
  const room = state.room;
  const waitingPlayer = room.status === 'playing' && (
    (room.turnState === 'awaitingJudgment' && room.publicOffer?.toPlayerId !== 'koharu' && !playerOnline(room.publicOffer?.toPlayerId))
    || (room.currentTurnPlayerId !== 'koharu' && !playerOnline(room.currentTurnPlayerId))
  ) ? (room.turnState === 'awaitingJudgment' ? room.publicOffer.toPlayerId : room.currentTurnPlayerId) : null;
  $('reconnect-wait').hidden = !waitingPlayer;
  $('reconnect-wait').textContent = waitingPlayer ? `プレイヤー${waitingPlayer}の再接続を待っています` : '';
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
function requestFullResume(reason) {
  if (!state.roomId) return Promise.resolve();
  const promise = fullResume(reason);
  const generation = state.resumeGeneration;
  return promise.catch((error) => {
    if (state.resumeGeneration !== generation) return;
    if (reason.includes('waiting-playing')) state.playingResumeKey = null;
    setConnectionState('error', `復帰:${errorCode(error)}`);
  });
}
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
    state.presence = snapshot.val() || {}; renderPresence();
  }, () => requestFullResume('rtdb-listener-error'));
}
function showRoom(room) {
  if (room.status === 'finished' || room.playerStatus?.[state.seatId] === 'eliminated') {
    state.cards = [];
    state.makeRequest = null;
    state.judgeRequest = null;
    state.npcRequest = null;
  }
  state.room = room; $('entry').hidden = true; $('lobby').hidden = room.status !== 'waiting'; $('game').hidden = !['playing', 'finished'].includes(room.status);
  $('room-id').textContent = state.roomId; $('players').innerHTML = `<li>A: ${room.players.A.joined ? '参加' : '待機'}</li><li>B: ${room.players.B.joined ? '参加' : '待機'}</li><li>こはる: 参加</li>`;
  $('start-game').hidden = room.hostUid !== auth.currentUser?.uid;
  if (room.status === 'playing' || room.status === 'finished') renderGame();
  renderPresence();
}
function applyPublicRoom(room, generation, source) {
  if (generation !== state.resumeGeneration) return;
  const wasWaiting = state.room?.status === 'waiting';
  showRoom(room);
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
    if (generation !== state.resumeGeneration || !snap.exists()) return;
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
    if (generation !== state.resumeGeneration || !snap.exists()) return;
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
  if (state.resumeFlight) return state.resumeFlight;
  const generation = state.resumeGeneration + 1;
  state.resumeGeneration = generation;
  setConnectionState('syncing');
  stopRealtime(generation);
  const flight = (async () => {
    await auth.authStateReady();
    if (!auth.currentUser) await signInAnonymously(auth);
    await getToken(appCheck, false);
    if (generation !== state.resumeGeneration) return;
    await retirePresence();
    if (generation !== state.resumeGeneration) return;
    const connectionId = newId();
    const admission = await authorizePresence(connectionId);
    if (generation !== state.resumeGeneration) return;
    state.connectionId = connectionId;
    await beginPresence(admission.seatId, generation, connectionId);
    if (generation !== state.resumeGeneration) return;
    const value = await call('resumeMofumofuRoom', { roomId: state.roomId });
    if (generation !== state.resumeGeneration) return;
    remember(state.roomId, value.seatId); state.cards = value.cards || []; showRoom(value.room);
    listenRoom(generation); startSafetySync(generation); setConnectionState('connected');
  })();
  state.resumeFlight = flight;
  try { await flight; }
  catch (error) {
    if (generation === state.resumeGeneration) { stopRealtime(generation); await retirePresence(); }
    throw error;
  }
  finally { if (state.resumeFlight === flight) state.resumeFlight = null; }
}
function renderGame() {
  const room = state.room; const offer = room.publicOffer; const ownStatus = room.playerStatus?.[state.seatId]; const finished = room.status === 'finished';
  $('turn').textContent = finished ? 'ゲーム終了' : `手番: ${room.currentTurnPlayerId}`;
  $('hand').replaceChildren(...state.cards.map((card) => { const node = document.createElement('span'); node.className = 'card'; node.textContent = labels[card.animalType]; return node; }));
  const latestElimination = Object.values(room.eliminationSnapshots || {}).sort((a, b) => (b.eliminatedAt || 0) - (a.eliminatedAt || 0))[0];
  $('elimination-notice').hidden = !latestElimination;
  if (latestElimination) $('elimination-notice').textContent = `${latestElimination.playerId === 'koharu' ? 'こはる' : `プレイヤー${latestElimination.playerId}`}は${emoji[latestElimination.eliminationAnimal]}${labels[latestElimination.eliminationAnimal]}が4枚そろって「もふもふ大集合！」／脱落`;
  const ownControl = room.controlModes?.[state.seatId]?.mode || 'human';
  $('control-status').textContent = ownControl === 'human' ? '本人へ操作権返却済み' : ownControl === 'npc-controlled' ? 'NPC代理中' : ownControl === 'return-pending' ? '本人復帰済み／代理終了待ち' : '代理終了';
  const canMake = !finished && ownStatus === 'active' && ownControl === 'human' && room.turnState === 'awaitingOffer' && room.currentTurnPlayerId === state.seatId;
  $('offer-form').hidden = !canMake; $('offer-card').innerHTML = state.cards.map((card) => `<option value="${card.cardId}">${labels[card.animalType]}</option>`).join('');
  $('claim-animal').innerHTML = animals.map((animal) => `<option value="${animal}">${labels[animal]}</option>`).join('');
  const targets = ['A', 'B', 'koharu'].filter((playerId) => playerId !== state.seatId && room.playerStatus?.[playerId] === 'active');
  $('target-player').innerHTML = targets.map((playerId) => `<option value="${playerId}">${playerId === 'koharu' ? 'こはる' : playerId}</option>`).join('');
  $('npc-status').hidden = finished || room.turnState !== 'awaitingNpcPhase';
  $('offer').hidden = finished || !offer; $('judge-buttons').hidden = finished || ownStatus !== 'active' || ownControl !== 'human' || !(offer?.status === 'pending' && offer.toPlayerId === state.seatId);
  $('offer-message').textContent = offer ? `${offer.fromPlayerId === 'koharu' ? 'こはる' : offer.fromPlayerId}「${labels[offer.claimAnimal]}だよ」` : '';
  $('result').hidden = offer?.status !== 'completed';
  if (offer?.status === 'completed') $('result').textContent = `本当は${labels[offer.actualAnimal]}。判定${offer.success ? '成功' : '失敗'}。${offer.faceUpRecipientPlayerId}が表向きカードを受け取りました。${finished ? 'ゲーム終了です。' : `次は${room.currentTurnPlayerId}です。`}`;
  $('final-result').hidden = !finished;
  if (finished) renderFinalResult(room.finalResult);
  if (!finished && ownStatus === 'active' && room.turnState === 'awaitingNpcPhase') void runNpc();
  if (!finished) void runProxyIfNeeded();
  renderPresence();
}
async function runProxyIfNeeded() {
  if (state.proxyBusy || !state.room) return;
  const room = state.room;
  const seatId = room.turnState === 'awaitingJudgment' ? room.publicOffer?.toPlayerId : room.currentTurnPlayerId;
  if (!['A', 'B'].includes(seatId)) return;
  const mode = room.controlModes?.[seatId]?.mode || 'human';
  if (mode === 'return-pending') { if (seatId === state.seatId) await refresh().catch(() => {}); return; }
  if (mode === 'human' && playerOnline(seatId)) return;
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
  $('final-title').textContent = finalResult.draw ? '🤝 引き分け！' : `${finalResult.winnerPlayerId === 'koharu' ? 'こはる' : `プレイヤー${finalResult.winnerPlayerId}`}の勝ち！`;
  $('final-reason').textContent = finalResult.finishReason === 'last-player-standing' ? '最後の1人が残ったため終了' : '手札が0枚になったため終了';
  $('final-players').replaceChildren(...finalResult.players.map((player) => {
    const box = document.createElement('section'); box.className = `final-player${player.eliminated ? ' eliminated' : ''}`;
    const title = document.createElement('strong'); title.textContent = player.playerId === 'koharu' ? 'こはる' : `プレイヤー${player.playerId}`; box.append(title);
    for (const animal of animals) if (player.faceUpCardsByAnimal?.[animal]) { const line = document.createElement('p'); line.textContent = `${emoji[animal]}${labels[animal]} ×${player.faceUpCardsByAnimal[animal]}`; box.append(line); }
    if (!player.faceUpCardsTotal) { const line = document.createElement('p'); line.textContent = '表向きカード なし'; box.append(line); }
    if (player.eliminated) { const line = document.createElement('p'); line.textContent = `もふもふ大集合！／脱落（${emoji[player.eliminationAnimal]}${labels[player.eliminationAnimal]}）`; box.append(line); }
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
$('create-room').addEventListener('click', async () => { const value = await call('createMofumofuRoom', {}); remember(value.roomId, value.seatId); $('shown-invite').textContent = value.inviteCode; await requestFullResume('create-room'); });
$('join-form').addEventListener('submit', async (event) => { event.preventDefault(); const value = await call('joinMofumofuRoom', { inviteCode: $('invite-code').value }); remember(value.roomId, value.seatId); await requestFullResume('join-room'); });
$('start-game').addEventListener('click', async () => { await call('startMofumofuGame', { roomId: state.roomId }); await refresh(); });
$('offer-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (state.makeBusy) return; state.makeRequest ||= { roomId: state.roomId, cardId: $('offer-card').value, claimAnimal: $('claim-animal').value, targetPlayerId: $('target-player').value, actionId: newId() }; state.makeBusy = true;
  try { await call('makeMofumofuOffer', state.makeRequest); state.makeRequest = null; await refresh(); } catch (error) { message(error.message); } finally { state.makeBusy = false; }
});
$('judge-buttons').addEventListener('click', async (event) => {
  const judgment = event.target.dataset.judgment; if (!judgment || state.judgeBusy) return; state.judgeRequest ||= { roomId: state.roomId, actionId: state.room.publicOffer.actionId, judgment }; state.judgeBusy = true;
  try { await call('judgeMofumofuOffer', state.judgeRequest); state.judgeRequest = null; await refresh(); } catch (error) { message(error.message); } finally { state.judgeBusy = false; }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) void requestFullResume('visibilitychange'); });
globalThis.addEventListener('pageshow', () => void requestFullResume('pageshow'));
globalThis.addEventListener('online', () => void requestFullResume('online'));
await auth.authStateReady();
if (!auth.currentUser) await signInAnonymously(auth);
await requestFullResume('initial');

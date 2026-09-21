import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { getAuth, connectAuthEmulator, signInAnonymously } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { getFirestore, connectFirestoreEmulator, doc, onSnapshot } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js';
import { firebaseConfig, emulatorConfig } from './firebase-config.js';

const animals = ['cat', 'rabbit', 'bear', 'chick', 'fox', 'penguin', 'panda', 'polar'];
const labels = { cat: 'ねこ', rabbit: 'うさぎ', bear: 'くま', chick: 'ひよこ', fox: 'きつね', penguin: 'ぺんぎん', panda: 'ぱんだ', polar: 'しろくま' };
const app = initializeApp(firebaseConfig);
const auth = getAuth(app); const firestore = getFirestore(app); const functions = getFunctions(app, emulatorConfig.region);
connectAuthEmulator(auth, `http://${emulatorConfig.authHost}:${emulatorConfig.authPort}`, { disableWarnings: true });
connectFirestoreEmulator(firestore, emulatorConfig.firestoreHost, emulatorConfig.firestorePort);
connectFunctionsEmulator(functions, emulatorConfig.functionsHost, emulatorConfig.functionsPort);
const call = (name, data) => httpsCallable(functions, name)(data).then((response) => response.data);
const $ = (id) => document.getElementById(id);
const state = { roomId: localStorage.getItem('mofumofuRoomId'), seatId: localStorage.getItem('mofumofuSeatId'), room: null, cards: [], makeRequest: null, judgeRequest: null, npcRequest: null, makeBusy: false, judgeBusy: false, npcBusy: false, unsubscribe: null };
function newId() { return crypto.randomUUID(); }
function remember(roomId, seatId) { state.roomId = roomId; state.seatId = seatId; localStorage.setItem('mofumofuRoomId', roomId); localStorage.setItem('mofumofuSeatId', seatId); }
function message(text) { $('status').textContent = text; }
function showRoom(room) {
  state.room = room; $('entry').hidden = true; $('lobby').hidden = room.status !== 'waiting'; $('game').hidden = room.status !== 'playing';
  $('room-id').textContent = state.roomId; $('players').innerHTML = `<li>A: ${room.players.A.joined ? '参加' : '待機'}</li><li>B: ${room.players.B.joined ? '参加' : '待機'}</li><li>こはる: 参加</li>`;
  $('start-game').hidden = room.hostUid !== auth.currentUser?.uid;
  if (room.status === 'playing') renderGame();
}
function listenRoom() { state.unsubscribe?.(); state.unsubscribe = onSnapshot(doc(firestore, 'mofumofuOnlineRooms', state.roomId), (snap) => snap.exists() && showRoom(snap.data())); }
async function resume() { if (!state.roomId) return; const value = await call('resumeMofumofuRoom', { roomId: state.roomId }); remember(state.roomId, value.seatId); state.cards = value.cards || []; showRoom(value.room); listenRoom(); }
function renderGame() {
  const room = state.room; const offer = room.publicOffer; $('turn').textContent = `手番: ${room.currentTurnPlayerId}`;
  $('hand').replaceChildren(...state.cards.map((card) => { const node = document.createElement('span'); node.className = 'card'; node.textContent = labels[card.animalType]; return node; }));
  const canMake = room.turnState === 'awaitingOffer' && room.currentTurnPlayerId === state.seatId;
  $('offer-form').hidden = !canMake; $('offer-card').innerHTML = state.cards.map((card) => `<option value="${card.cardId}">${labels[card.animalType]}</option>`).join('');
  $('claim-animal').innerHTML = animals.map((animal) => `<option value="${animal}">${labels[animal]}</option>`).join('');
  const other = state.seatId === 'A' ? 'B' : 'A'; $('target-player').innerHTML = `<option value="${other}">${other}</option><option value="koharu">こはる</option>`;
  $('npc-status').hidden = room.turnState !== 'awaitingNpcPhase';
  $('offer').hidden = !offer; $('judge-buttons').hidden = !(offer?.status === 'pending' && offer.toPlayerId === state.seatId);
  $('offer-message').textContent = offer ? `${offer.fromPlayerId === 'koharu' ? 'こはる' : offer.fromPlayerId}「${labels[offer.claimAnimal]}だよ」` : '';
  $('result').hidden = offer?.status !== 'completed';
  if (offer?.status === 'completed') $('result').textContent = `本当は${labels[offer.actualAnimal]}。判定${offer.success ? '成功' : '失敗'}。${offer.faceUpRecipientPlayerId}が表向きカードを受け取りました。次は${room.currentTurnPlayerId}です。`;
  if (room.turnState === 'awaitingNpcPhase') void runNpc();
}
async function refresh() { const value = await call('resumeMofumofuRoom', { roomId: state.roomId }); state.cards = value.cards || []; showRoom(value.room); }
async function runNpc() {
  if (state.npcBusy) return; state.npcRequest ||= { roomId: state.roomId, actionId: newId() }; state.npcBusy = true;
  try { await call('runMofumofuNpcTurn', state.npcRequest); state.npcRequest = null; await refresh(); if (state.room?.turnState === 'awaitingNpcPhase') setTimeout(runNpc, 250); }
  catch (error) { message(error.message); setTimeout(runNpc, 1000); }
  finally { state.npcBusy = false; }
}
$('create-room').addEventListener('click', async () => { const value = await call('createMofumofuRoom', {}); remember(value.roomId, value.seatId); $('shown-invite').textContent = value.inviteCode; await resume(); });
$('join-form').addEventListener('submit', async (event) => { event.preventDefault(); const value = await call('joinMofumofuRoom', { inviteCode: $('invite-code').value }); remember(value.roomId, value.seatId); await resume(); });
$('start-game').addEventListener('click', async () => { await call('startMofumofuGame', { roomId: state.roomId }); await refresh(); });
$('offer-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (state.makeBusy) return; state.makeRequest ||= { roomId: state.roomId, cardId: $('offer-card').value, claimAnimal: $('claim-animal').value, targetPlayerId: $('target-player').value, actionId: newId() }; state.makeBusy = true;
  try { await call('makeMofumofuOffer', state.makeRequest); state.makeRequest = null; await refresh(); } catch (error) { message(error.message); } finally { state.makeBusy = false; }
});
$('judge-buttons').addEventListener('click', async (event) => {
  const judgment = event.target.dataset.judgment; if (!judgment || state.judgeBusy) return; state.judgeRequest ||= { roomId: state.roomId, actionId: state.room.publicOffer.actionId, judgment }; state.judgeBusy = true;
  try { await call('judgeMofumofuOffer', state.judgeRequest); state.judgeRequest = null; await refresh(); } catch (error) { message(error.message); } finally { state.judgeBusy = false; }
});
await signInAnonymously(auth); message('接続しました。'); await resume().catch((error) => message(error.message));

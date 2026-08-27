import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js";
import { app } from './firebase-config.js';
import { diagLog } from './diagnostic-log.js';

const functions = getFunctions(app, 'asia-northeast1');
const submitPoemSecureCallable = httpsCallable(functions, 'submitPoemSecure');
const revealPoemSecureCallable = httpsCallable(functions, 'revealPoemSecure');
const reactPoemSecureCallable = httpsCallable(functions, 'reactPoemSecure');
const submitPoemWordsCallable = httpsCallable(functions, 'submitPoemWords');
const removePoemWordCallable = httpsCallable(functions, 'removePoemWord');
const updatePoemSettingsCallable = httpsCallable(functions, 'updatePoemSettings');
const dealPoemHandsCallable = httpsCallable(functions, 'dealPoemHands');
const removePlayerCallable = httpsCallable(functions, 'removePlayer');
const claimHostCallable = httpsCallable(functions, 'claimHost');
const changePoemRoleCallable = httpsCallable(functions, 'changePoemRole');

function requireRoomId(roomId) {
  if (typeof roomId !== 'string' || !roomId.trim()) throw new Error('ルームIDがありません。');
  return roomId.trim();
}

async function callWithDiag(name, callable, data) {
  diagLog(`${name}:start`, { roomId: data?.roomId, targetUid: data?.targetUid });
  try {
    const result = await callable(data);
    diagLog(`${name}:success`, { roomId: data?.roomId, targetUid: data?.targetUid });
    return result.data;
  } catch (error) {
    diagLog(`${name}:error`, { roomId: data?.roomId, targetUid: data?.targetUid, code: error?.code, message: error?.message });
    throw error;
  }
}

export async function dealPoemHands(roomId) {
  return callWithDiag('dealPoemHands', dealPoemHandsCallable, { roomId: requireRoomId(roomId) });
}

export async function changePoemRole(roomId, role, supplementWords = []) {
  const result = await changePoemRoleCallable({ roomId: requireRoomId(roomId), role, supplementWords: Array.isArray(supplementWords) ? supplementWords : [] });
  return result.data;
}

export async function removePlayer(roomId, targetUid) {
  const result = await removePlayerCallable({ roomId: requireRoomId(roomId), game: 'poem', targetUid });
  return result.data;
}

export async function claimHost(roomId) {
  return callWithDiag('claimHost', claimHostCallable, { roomId: requireRoomId(roomId), game: 'poem' });
}

export async function updatePoemSettings(roomId, handCount) {
  const result = await updatePoemSettingsCallable({ roomId: requireRoomId(roomId), handCount });
  return result.data;
}

export async function submitPoemWords(roomId, words) {
  const result = await submitPoemWordsCallable({ roomId: requireRoomId(roomId), words });
  return result.data;
}

export async function removePoemWord(roomId, wordId) {
  const result = await removePoemWordCallable({ roomId: requireRoomId(roomId), wordId });
  return result.data;
}

export async function submitPoemSecure(roomId, text, usedHands) {
  return callWithDiag('submitPoemSecure', submitPoemSecureCallable, { roomId: requireRoomId(roomId), text, usedHands });
}

export async function revealPoemSecure(roomId, targetUid) {
  return callWithDiag('revealPoemSecure', revealPoemSecureCallable, { roomId: requireRoomId(roomId), targetUid });
}

export async function reactPoemSecure(roomId, targetUid, type) {
  return callWithDiag('reactPoemSecure', reactPoemSecureCallable, { roomId: requireRoomId(roomId), targetUid, type });
}

export { requireRoomId };

// Poem Secure Callable client wrapper
// Existing rooms continue to use their legacy direct-update path.

import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js";
import { app } from './firebase-config.js';

const functions = getFunctions(app, 'asia-northeast1');
const submitPoemSecureCallable = httpsCallable(functions, 'submitPoemSecure');
const revealPoemSecureCallable = httpsCallable(functions, 'revealPoemSecure');
const reactPoemSecureCallable = httpsCallable(functions, 'reactPoemSecure');
const submitPoemWordsCallable = httpsCallable(functions, 'submitPoemWords');
const removePoemWordCallable = httpsCallable(functions, 'removePoemWord');

function requireRoomId(roomId) {
  if (typeof roomId !== 'string' || !roomId.trim()) throw new Error('ルームIDがありません。');
  return roomId.trim();
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
  const result = await submitPoemSecureCallable({ roomId: requireRoomId(roomId), text, usedHands });
  return result.data;
}

export async function revealPoemSecure(roomId, targetUid) {
  const result = await revealPoemSecureCallable({ roomId: requireRoomId(roomId), targetUid });
  return result.data;
}

export async function reactPoemSecure(roomId, targetUid, type) {
  const result = await reactPoemSecureCallable({ roomId: requireRoomId(roomId), targetUid, type });
  return result.data;
}

export { requireRoomId };

// Poem Secure Callable client wrapper
// Existing rooms continue to use their legacy direct-update path.

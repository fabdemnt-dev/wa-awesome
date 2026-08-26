import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js";
import { app } from './firebase-config.js';

const functions = getFunctions(app, 'asia-northeast1');
const dealHaikuHandsCallable = httpsCallable(functions, 'dealHaikuHands');
const changeHaikuRoleCallable = httpsCallable(functions, 'changeHaikuRole');
const submitHaikuWordsCallable = httpsCallable(functions, 'submitHaikuWords');
const removeHaikuWordCallable = httpsCallable(functions, 'removeHaikuWord');
const redrawHaikuHandCallable = httpsCallable(functions, 'redrawHaikuHand');
const submitHaikuPhraseCallable = httpsCallable(functions, 'submitHaikuPhrase');
const revealHaikuPhraseCallable = httpsCallable(functions, 'revealHaikuPhrase');
const selfPraiseHaikuPhraseCallable = httpsCallable(functions, 'selfPraiseHaikuPhrase');
const submitHaikuVoteCallable = httpsCallable(functions, 'submitHaikuVote');

function requireRoomId(roomId) {
  if (typeof roomId !== 'string' || !roomId.trim()) throw new Error('ルームIDがありません。');
  return roomId.trim();
}

export async function submitHaikuWords(roomId, words5, words7) {
  const result = await submitHaikuWordsCallable({ roomId: requireRoomId(roomId), words5, words7 });
  return result.data;
}

export async function removeHaikuWord(roomId, type, wordId) {
  const result = await removeHaikuWordCallable({ roomId: requireRoomId(roomId), type, wordId });
  return result.data;
}

export async function changeHaikuRole(roomId, role, supplement5 = [], supplement7 = []) {
  const result = await changeHaikuRoleCallable({
    roomId: requireRoomId(roomId),
    role,
    supplement5: Array.isArray(supplement5) ? supplement5 : [],
    supplement7: Array.isArray(supplement7) ? supplement7 : [],
  });
  return result.data;
}

export async function dealHaikuHands(roomId) {
  const result = await dealHaikuHandsCallable({ roomId: requireRoomId(roomId) });
  return result.data;
}

export async function redrawHaikuHand(roomId, selectedIds5, selectedIds7) {
  const result = await redrawHaikuHandCallable({
    roomId: requireRoomId(roomId),
    selectedIds5: Array.isArray(selectedIds5) ? selectedIds5 : [],
    selectedIds7: Array.isArray(selectedIds7) ? selectedIds7 : [],
  });
  return result.data;
}

export async function submitHaikuPhrase(roomId, phrase, phraseDetails) {
  const result = await submitHaikuPhraseCallable({ roomId: requireRoomId(roomId), phrase, phraseDetails });
  return result.data;
}

export async function revealHaikuPhrase(roomId, targetUid) {
  const result = await revealHaikuPhraseCallable({ roomId: requireRoomId(roomId), targetUid });
  return result.data;
}

export async function selfPraiseHaikuPhrase(roomId) {
  const result = await selfPraiseHaikuPhraseCallable({ roomId: requireRoomId(roomId) });
  return result.data;
}

export async function submitHaikuVote(roomId, targetUid, evalKey) {
  const result = await submitHaikuVoteCallable({ roomId: requireRoomId(roomId), targetUid, evalKey });
  return result.data;
}

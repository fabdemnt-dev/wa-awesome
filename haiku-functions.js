import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js";
import { app } from './firebase-config.js';
import { diagLog } from './diagnostic-log.js';

const functions = getFunctions(app, 'asia-northeast1');
const dealHaikuHandsCallable = httpsCallable(functions, 'dealHaikuHands');
const changeHaikuRoleCallable = httpsCallable(functions, 'changeHaikuRole');
const submitHaikuWordsCallable = httpsCallable(functions, 'submitHaikuWords');
const removeHaikuWordCallable = httpsCallable(functions, 'removeHaikuWord');
const updateHaikuSettingsCallable = httpsCallable(functions, 'updateHaikuSettings');
const advanceHaikuRoundCallable = httpsCallable(functions, 'advanceHaikuRound');
const redrawHaikuHandCallable = httpsCallable(functions, 'redrawHaikuHand');
const submitHaikuPhraseCallable = httpsCallable(functions, 'submitHaikuPhrase');
const revealHaikuPhraseCallable = httpsCallable(functions, 'revealHaikuPhrase');
const selfPraiseHaikuPhraseCallable = httpsCallable(functions, 'selfPraiseHaikuPhrase');
const submitHaikuVoteCallable = httpsCallable(functions, 'submitHaikuVote');
const removePlayerCallable = httpsCallable(functions, 'removePlayer');
const claimHostCallable = httpsCallable(functions, 'claimHost');

function requireRoomId(roomId) {
  if (typeof roomId !== 'string' || !roomId.trim()) throw new Error('ルームIDがありません。');
  return roomId.trim();
}

async function callWithDiag(name, callable, data) {
  diagLog(`${name}:start`, {
    roomId: data?.roomId,
    targetUid: data?.targetUid,
    words5Count: Array.isArray(data?.words5) ? data.words5.length : undefined,
    words7Count: Array.isArray(data?.words7) ? data.words7.length : undefined,
  });
  try {
    const result = await callable(data);
    diagLog(`${name}:success`, {
      roomId: data?.roomId,
      targetUid: data?.targetUid,
      words5Count: Array.isArray(data?.words5) ? data.words5.length : undefined,
      words7Count: Array.isArray(data?.words7) ? data.words7.length : undefined,
    });
    return result.data;
  } catch (error) {
    diagLog(`${name}:error`, {
      roomId: data?.roomId,
      targetUid: data?.targetUid,
      words5Count: Array.isArray(data?.words5) ? data.words5.length : undefined,
      words7Count: Array.isArray(data?.words7) ? data.words7.length : undefined,
      code: error?.code,
      message: error?.message,
    });
    throw error;
  }
}

export async function removePlayer(roomId, targetUid) {
  const result = await removePlayerCallable({ roomId: requireRoomId(roomId), game: 'haiku', targetUid });
  return result.data;
}

export async function claimHost(roomId) {
  return callWithDiag('claimHost', claimHostCallable, { roomId: requireRoomId(roomId), game: 'haiku' });
}

export async function advanceHaikuRound(roomId) {
  return callWithDiag('advanceHaikuRound', advanceHaikuRoundCallable, { roomId: requireRoomId(roomId) });
}

export async function updateHaikuSettings(roomId, hand5, hand7, carryOver) {
  const result = await updateHaikuSettingsCallable({ roomId: requireRoomId(roomId), hand5, hand7, carryOver });
  return result.data;
}

export async function submitHaikuWords(roomId, words5, words7) {
  return callWithDiag('submitHaikuWords', submitHaikuWordsCallable, {
    roomId: requireRoomId(roomId),
    words5: Array.isArray(words5) ? words5 : [],
    words7: Array.isArray(words7) ? words7 : [],
  });
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
  return callWithDiag('dealHaikuHands', dealHaikuHandsCallable, { roomId: requireRoomId(roomId) });
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
  return callWithDiag('submitHaikuPhrase', submitHaikuPhraseCallable, { roomId: requireRoomId(roomId), phrase, phraseDetails });
}

export async function revealHaikuPhrase(roomId, targetUid) {
  return callWithDiag('revealHaikuPhrase', revealHaikuPhraseCallable, { roomId: requireRoomId(roomId), targetUid });
}

export async function selfPraiseHaikuPhrase(roomId) {
  const result = await selfPraiseHaikuPhraseCallable({ roomId: requireRoomId(roomId) });
  return result.data;
}

export async function submitHaikuVote(roomId, targetUid, evalKey) {
  const result = await submitHaikuVoteCallable({ roomId: requireRoomId(roomId), targetUid, evalKey });
  return result.data;
}

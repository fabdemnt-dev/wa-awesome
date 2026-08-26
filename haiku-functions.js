import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js";
import { app } from './firebase-config.js';

const functions = getFunctions(app, 'asia-northeast1');
const dealHaikuHandsCallable = httpsCallable(functions, 'dealHaikuHands');
const redrawHaikuHandCallable = httpsCallable(functions, 'redrawHaikuHand');

function requireRoomId(roomId) {
  if (typeof roomId !== 'string' || !roomId.trim()) throw new Error('ルームIDがありません。');
  return roomId.trim();
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

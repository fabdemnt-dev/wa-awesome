import { ref, onDisconnect, set, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js';
import { rtdb } from './moon-scale-duel-online-firebase.js';

export async function beginPresence(roomId, uid) {
  const presence = ref(rtdb, `moonScaleDuelPresence/${roomId}/${uid}`);
  await onDisconnect(presence).set({ state: 'offline', lastChanged: serverTimestamp() });
  await set(presence, { state: 'online', lastChanged: serverTimestamp() });
}

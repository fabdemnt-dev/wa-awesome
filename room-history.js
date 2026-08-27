import {
  addDoc,
  collection,
  onSnapshot,
  orderBy,
  query,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

export function subscribeRoomHistory(roomRef, onChange, onError = () => {}) {
  const historyQuery = query(collection(roomRef, 'history'), orderBy('round', 'asc'));
  return onSnapshot(historyQuery, (snapshot) => {
    // キャッシュ由来の一時的な空・古い履歴で、表示済みの履歴を巻き戻さない。
    if (snapshot.metadata?.fromCache) return;
    onChange(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() })));
  }, onError);
}

export function appendRoomHistory(roomRef, entry) {
  return addDoc(collection(roomRef, 'history'), entry);
}

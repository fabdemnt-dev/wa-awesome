import {
  addDoc,
  collection,
  onSnapshot,
  orderBy,
  query,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

export function subscribeRoomHistory(roomRef, onChange) {
  const historyQuery = query(collection(roomRef, 'history'), orderBy('round', 'asc'));
  return onSnapshot(historyQuery, (snapshot) => {
    onChange(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() })));
  });
}

export function appendRoomHistory(roomRef, entry) {
  return addDoc(collection(roomRef, 'history'), entry);
}

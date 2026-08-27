import { db } from './firebase-config.js';
import { collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { normalizeWordSet, getIconById, iconForId } from './wordset-utils.js';

let cachedSets = [];

export function getWordSetById(id) {
  return cachedSets.find(s => s.id === id) || null;
}

function escapeOpt(str) {
  return String(str).replace(/[<>&"]/g, m => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[m]));
}

function iconForSet(set) {
  const legacyIcon = getIconById(set.icon);
  if (legacyIcon) return legacyIcon.emoji;
  if (typeof set.icon === 'string' && set.icon.trim()) return set.icon.trim();
  return iconForId(set.id).emoji;
}

function renderOptions() {
  const sel = document.getElementById('wordset-select');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="builtin">🎲 標準セット（おまかせ）</option>' +
    cachedSets.map(s => `<option value="${s.id}">${escapeOpt(iconForSet(s))} ${escapeOpt(s.name)}（五音${(s.words5 || []).length}・七音${(s.words7 || []).length}）</option>`).join('');
  if ([...sel.options].some(o => o.value === current)) sel.value = current;
}

const q = query(collection(db, 'wordsets'), where('type', '==', 'haiku'));
onSnapshot(q, (snap) => {
  cachedSets = snap.docs.map(d => normalizeWordSet({ id: d.id, ...d.data() }));
  renderOptions();
});

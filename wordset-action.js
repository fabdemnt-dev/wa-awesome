import { db } from './firebase-config.js';
import {
  collection, addDoc, updateDoc, deleteDoc, doc, onSnapshot, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import state from './wordset-state.js';
import { splitWords } from './wordset-utils.js';
import { renderAll } from './wordset-render.js';

window.switchMode = function (mode) {
  state.mode = mode;
  renderAll();
};

window.startNewWordSet = function () {
  const mode = state.mode;
  state.editingId[mode] = null;
  state.forms[mode] = mode === 'poem'
    ? { name: '', words: '' }
    : { name: '', words5: '', words7: '' };
  renderAll();
};

// 入力欄が変化するたびに呼ばれ、状態を更新してプレビューだけ再描画する
window.onWordSetFormInput = function () {
  const mode = state.mode;
  if (mode === 'poem') {
    state.forms.poem.name = document.getElementById('poem-set-name')?.value || '';
    state.forms.poem.words = document.getElementById('poem-words-input')?.value || '';
  } else {
    state.forms.haiku.name = document.getElementById('haiku-set-name')?.value || '';
    state.forms.haiku.words5 = document.getElementById('haiku-words5-input')?.value || '';
    state.forms.haiku.words7 = document.getElementById('haiku-words7-input')?.value || '';
  }
  renderAll();
};

window.saveWordSet = async function () {
  const mode = state.mode;
  const form = state.forms[mode];
  const name = (form.name || '').trim();
  if (!name) return alert('セットのなまえを入力してください');

  let payload;
  if (mode === 'poem') {
    const words = splitWords(form.words);
    if (words.length === 0) return alert('ことばを入力してください');
    payload = { type: 'poem', name, words };
  } else {
    const words5 = splitWords(form.words5);
    const words7 = splitWords(form.words7);
    if (words5.length === 0 || words7.length === 0) {
      return alert('五音・七音のことばをそれぞれ入力してください');
    }
    payload = { type: 'haiku', name, words5, words7 };
  }

  try {
    const editingId = state.editingId[mode];
    if (editingId) {
      await updateDoc(doc(db, 'wordsets', editingId), payload);
      alert('ワードセットを更新しました！');
    } else {
      payload.createdAt = serverTimestamp();
      await addDoc(collection(db, 'wordsets'), payload);
      alert('ワードセットを保存しました！');
    }
    window.startNewWordSet();
  } catch (e) {
    console.error(e);
    alert('保存に失敗しました: ' + e.message);
  }
};

window.editWordSet = function (id) {
  const mode = state.mode;
  const target = state.sets[mode].find(s => s.id === id);
  if (!target) return;
  state.editingId[mode] = id;
  state.forms[mode] = mode === 'poem'
    ? { name: target.name, words: (target.words || []).join('　') }
    : { name: target.name, words5: (target.words5 || []).join('　'), words7: (target.words7 || []).join('　') };
  renderAll();
  document.getElementById(`panel-${mode}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

window.deleteWordSet = async function (id) {
  if (!confirm('このワードセットを削除しますか？\n（この操作は取り消せません）')) return;
  try {
    await deleteDoc(doc(db, 'wordsets', id));
  } catch (e) {
    console.error(e);
    alert('削除に失敗しました: ' + e.message);
  }
};

export function listenWordSets() {
  ['poem', 'haiku'].forEach((type) => {
    const q = query(collection(db, 'wordsets'), where('type', '==', type));
    onSnapshot(q, (snap) => {
      state.sets[type] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderAll();
    });
  });
}

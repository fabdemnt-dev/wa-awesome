import { db } from './firebase-config.js';
import {
  collection, addDoc, updateDoc, deleteDoc, doc, onSnapshot, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import state from './wordset-state.js';
import { splitWords, simpleHash } from './wordset-utils.js';
import { renderAll } from './wordset-render.js';

// 変更のたびに、そのワードセットの「history」サブコレクションにスナップショットを1件残しておく。
// 見るための画面はまだ無いが、後で作るときのためにデータだけ先に貯めておく。
// ※Firestoreはドキュメントを削除してもサブコレクションを自動削除しないので、
//   削除記録もこのサブコレクションに書けば、セット自体が消えた後も残り続ける。
async function logHistory(docId, action, editor, snapshot) {
  try {
    await addDoc(collection(db, 'wordsets', docId, 'history'), {
      action, // 'created' | 'edited'
      editor: editor || '不明',
      snapshot,
      timestamp: serverTimestamp()
    });
  } catch (e) {
    console.error('編集履歴の記録に失敗しました', e);
  }
}

window.switchMode = function (mode) {
  state.mode = mode;
  renderAll();
};

window.startNewWordSet = function () {
  const mode = state.mode;
  state.editingId[mode] = null;
  state.forms[mode] = mode === 'poem'
    ? { name: '', words: '', creatorName: '', hasPassword: false, password: '' }
    : { name: '', words5: '', words7: '', creatorName: '', hasPassword: false, password: '' };
  renderAll();
};

// 入力欄が変化するたびに呼ばれ、状態を更新してプレビューだけ再描画する
window.onWordSetFormInput = function () {
  const mode = state.mode;
  if (mode === 'poem') {
    state.forms.poem.name = document.getElementById('poem-set-name')?.value || '';
    state.forms.poem.words = document.getElementById('poem-words-input')?.value || '';
    state.forms.poem.creatorName = document.getElementById('poem-creator-name')?.value || '';
    state.forms.poem.hasPassword = document.getElementById('poem-has-password')?.checked || false;
    state.forms.poem.password = document.getElementById('poem-password')?.value || '';
  } else {
    state.forms.haiku.name = document.getElementById('haiku-set-name')?.value || '';
    state.forms.haiku.words5 = document.getElementById('haiku-words5-input')?.value || '';
    state.forms.haiku.words7 = document.getElementById('haiku-words7-input')?.value || '';
    state.forms.haiku.creatorName = document.getElementById('haiku-creator-name')?.value || '';
    state.forms.haiku.hasPassword = document.getElementById('haiku-has-password')?.checked || false;
    state.forms.haiku.password = document.getElementById('haiku-password')?.value || '';
  }
  renderAll();
};

window.saveWordSet = async function () {
  const mode = state.mode;
  const form = state.forms[mode];
  const name = (form.name || '').trim();
  const creatorName = (form.creatorName || '').trim();
  if (!name) return alert('セットのなまえを入力してください');
  if (!creatorName) return alert('作った人の名前を入力してください');
  if (form.hasPassword && !form.password && !state.editingId[mode]) {
    return alert('パスワードをつける場合は、パスワードを入力してください');
  }

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
  payload.hasPassword = !!form.hasPassword;

  try {
    const editingId = state.editingId[mode];
    const original = editingId ? state.sets[mode].find(s => s.id === editingId) : null;

    // 過去の編集者リストに、今回操作した人の名前を（重複しなければ）追加していく
    const existingCreators = original
      ? (original.creators && original.creators.length ? original.creators : (original.creatorName ? [original.creatorName] : []))
      : [];
    payload.creators = existingCreators.includes(creatorName) ? existingCreators : [...existingCreators, creatorName];

    if (payload.hasPassword) {
      // パスワードを新しく入力していればそれを使い、空欄なら元のパスワードを維持する
      payload.passwordHash = form.password ? simpleHash(form.password) : (original?.passwordHash || null);
      if (!payload.passwordHash) return alert('パスワードをつける場合は、パスワードを入力してください');
    } else {
      payload.passwordHash = null;
    }

    if (editingId) {
      await updateDoc(doc(db, 'wordsets', editingId), payload);
      await logHistory(editingId, 'edited', creatorName, mode === 'poem'
        ? { name, words: payload.words }
        : { name, words5: payload.words5, words7: payload.words7 });
      alert('ワードセットを更新しました！');
    } else {
      payload.createdAt = serverTimestamp();
      const newRef = await addDoc(collection(db, 'wordsets'), payload);
      await logHistory(newRef.id, 'created', creatorName, mode === 'poem'
        ? { name, words: payload.words }
        : { name, words5: payload.words5, words7: payload.words7 });
      alert('ワードセットを保存しました！');
    }
    window.startNewWordSet();
  } catch (e) {
    console.error(e);
    alert('保存に失敗しました: ' + e.message);
  }
};

// パスワードつきのセットを編集・削除する前に、名前とパスワードが一致するか確認する
// 戻り値: { ok: 通過したか, name: 入力された名前（パスワード無しの場合はnull） }
function checkAuth(target) {
  if (!target.hasPassword) return { ok: true, name: null };

  const creators = (target.creators && target.creators.length) ? target.creators : (target.creatorName ? [target.creatorName] : []);
  const inputName = prompt(`🔒「${target.name}」はパスワード付きセットです。\nこれまでの編集者（${creators.join('、') || '不明'}）のお名前を入力してください。`, '');
  if (inputName === null) return { ok: false };
  const trimmedName = inputName.trim();
  if (!creators.includes(trimmedName)) {
    alert('お名前が一致しません。');
    return { ok: false };
  }

  const inputPass = prompt('パスワードを入力してください。');
  if (inputPass === null) return { ok: false };
  if (simpleHash(inputPass) !== target.passwordHash) {
    alert('パスワードが一致しません。');
    return { ok: false };
  }
  return { ok: true, name: trimmedName };
}

window.editWordSet = function (id) {
  const mode = state.mode;
  const target = state.sets[mode].find(s => s.id === id);
  if (!target) return;
  if (!checkAuth(target).ok) return;

  state.editingId[mode] = id;
  // 名前欄は空にしておき、今回編集する人が自分の名前を入力する（入力した名前が編集者リストに追加される）
  const base = { creatorName: '', hasPassword: !!target.hasPassword, password: '' };
  state.forms[mode] = mode === 'poem'
    ? { name: target.name, words: (target.words || []).join('　'), ...base }
    : { name: target.name, words5: (target.words5 || []).join('　'), words7: (target.words7 || []).join('　'), ...base };
  renderAll();
  document.getElementById(`panel-${mode}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

window.toggleWordSetDetail = function (id) {
  const mode = state.mode;
  state.expandedId[mode] = state.expandedId[mode] === id ? null : id;
  renderAll();
};

window.deleteWordSet = async function (id) {
  const mode = state.mode;
  const target = state.sets[mode].find(s => s.id === id);
  if (!target) return;

  const auth = checkAuth(target);
  if (!auth.ok) return;

  // パスワード無しの場合は名前を確認していないので、記録用にここで聞く（空欄でもOK）
  let deleterName = auth.name;
  if (!deleterName) {
    deleterName = (prompt(`「${target.name}」を削除する人のお名前を入力してください（記録用・空欄でも削除できます）`, '') || '').trim();
  }

  if (!confirm('このワードセットを削除しますか？\n（この操作は取り消せません）')) return;

  const snapshot = mode === 'poem'
    ? { name: target.name, words: target.words || [] }
    : { name: target.name, words5: target.words5 || [], words7: target.words7 || [] };

  try {
    // ドキュメントを消す前に、historyサブコレクションへ「削除された」記録を残しておく
    // （Firestoreはサブコレクションを自動で消さないので、親ドキュメントが無くなってもこの記録は残る）
    await logHistory(id, 'deleted', deleterName, snapshot);
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

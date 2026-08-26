import { db } from './firebase-config.js';
import {
  collection, onSnapshot, query, where,
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import state from './wordset-state.js';
import { splitWords, normalizeIcon } from './wordset-utils.js';
import { renderAll } from './wordset-render.js';
import {
  deleteWordSetSecurely, saveWordSetSecurely, userFacingError,
  verifyWordSetPassword,
} from './wordset-auth.js';

// 編集を始める時に入力した現在のパスワードは、画面を閉じるまでメモリ内だけに保持する。
// FirestoreやlocalStorageには保存しない。
const unlockedPasswords = new Map();

window.switchMode = function (mode) {
  state.mode = mode;
  renderAll();
};

window.startNewWordSet = function () {
  const mode = state.mode;
  state.editingId[mode] = null;
  state.forms[mode] = mode === 'poem'
    ? { name: '', words: '', creatorName: '', hasPassword: false, password: '', icon: '', copyAllowed: true }
    : { name: '', words5: '', words7: '', creatorName: '', hasPassword: false, password: '', icon: '', copyAllowed: true };
  renderAll();
};

window.onWordSetFormInput = function () {
  const mode = state.mode;
  if (mode === 'poem') {
    state.forms.poem.name = document.getElementById('poem-set-name')?.value || '';
    state.forms.poem.words = document.getElementById('poem-words-input')?.value || '';
    state.forms.poem.creatorName = document.getElementById('poem-creator-name')?.value || '';
    state.forms.poem.icon = document.getElementById('poem-icon-input')?.value || '';
    state.forms.poem.hasPassword = document.getElementById('poem-has-password')?.checked || false;
    state.forms.poem.password = document.getElementById('poem-password')?.value || '';
    state.forms.poem.copyAllowed = document.getElementById('poem-copy-allowed')?.checked !== false;
  } else {
    state.forms.haiku.name = document.getElementById('haiku-set-name')?.value || '';
    state.forms.haiku.words5 = document.getElementById('haiku-words5-input')?.value || '';
    state.forms.haiku.words7 = document.getElementById('haiku-words7-input')?.value || '';
    state.forms.haiku.creatorName = document.getElementById('haiku-creator-name')?.value || '';
    state.forms.haiku.icon = document.getElementById('haiku-icon-input')?.value || '';
    state.forms.haiku.hasPassword = document.getElementById('haiku-has-password')?.checked || false;
    state.forms.haiku.password = document.getElementById('haiku-password')?.value || '';
    state.forms.haiku.copyAllowed = document.getElementById('haiku-copy-allowed')?.checked !== false;
  }
  renderAll();
};

window.removeWordSetWord = function (field, index) {
  const form = state.forms[state.mode];
  const words = splitWords(form[field]);
  words.splice(index, 1);
  form[field] = words.join('\n');
  renderAll();
};

function buildWordSet(form, mode) {
  const name = (form.name || '').trim();
  if (!name) throw new Error('セットのなまえを入力してください');

  const wordSet = {
    type: mode,
    name,
    hasPassword: !!form.hasPassword,
    copyAllowed: form.copyAllowed !== false,
    icon: normalizeIcon(form.icon),
  };

  if (mode === 'poem') {
    wordSet.words = splitWords(form.words);
    if (wordSet.words.length === 0) throw new Error('ことばを入力してください');
  } else {
    wordSet.words5 = splitWords(form.words5);
    wordSet.words7 = splitWords(form.words7);
    if (wordSet.words5.length === 0 || wordSet.words7.length === 0) {
      throw new Error('五音・七音のことばをそれぞれ入力してください');
    }
  }
  return wordSet;
}

window.saveWordSet = async function () {
  const mode = state.mode;
  const form = state.forms[mode];
  const editorName = (form.creatorName || '').trim();

  try {
    const wordSet = buildWordSet(form, mode);
    const id = state.editingId[mode];
    const currentPassword = id ? unlockedPasswords.get(id)?.password : null;
    const newPassword = wordSet.hasPassword ? (form.password || null) : null;

    if (!id && wordSet.hasPassword && !newPassword) {
      return alert('パスワード付きセットには、8文字以上のパスワードを入力してください');
    }
    if (newPassword && newPassword.length < 8) {
      return alert('パスワードは8文字以上で入力してください');
    }

    await saveWordSetSecurely({ id, editorName, wordSet, currentPassword, newPassword });
    if (id) unlockedPasswords.delete(id);
    alert(id ? 'ワードセットを更新しました！' : 'ワードセットを保存しました！');
    window.startNewWordSet();
  } catch (error) {
    console.error(error);
    alert(userFacingError(error));
  }
};

async function requestPassword(target) {
  if (!target.hasPassword) return { ok: true, password: null };
  const password = prompt(`🔒「${target.name}」はパスワード付きセットです。\n編集するには、作成時のパスワードを入力してください。`);
  if (password === null) return { ok: false };
  if (!password) {
    alert('パスワードを入力してください。');
    return { ok: false };
  }
  try {
    // 編集画面を開く前に実際のサーバー照合を行う。
    await verifyWordSetPassword({ id: target.id, currentPassword: password });
    return { ok: true, password };
  } catch (error) {
    console.error(error);
    alert(userFacingError(error));
    return { ok: false };
  }
}

window.editWordSet = async function (id) {
  const mode = state.mode;
  const target = state.sets[mode].find((set) => set.id === id);
  if (!target) return;

  const auth = await requestPassword(target);
  if (!auth.ok) return;
  unlockedPasswords.set(id, { password: auth.password });

  state.editingId[mode] = id;
  const base = {
    creatorName: '',
    hasPassword: !!target.hasPassword,
    password: '',
    icon: target.icon || '',
    copyAllowed: target.copyAllowed !== false,
  };
  state.forms[mode] = mode === 'poem'
    ? { name: target.name, words: (target.words || []).join('\n'), ...base }
    : { name: target.name, words5: (target.words5 || []).join('\n'), words7: (target.words7 || []).join('\n'), ...base };
  renderAll();
  document.getElementById(`panel-${mode}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

window.toggleWordSetDetail = function (id) {
  const mode = state.mode;
  state.expandedId[mode] = state.expandedId[mode] === id ? null : id;
  renderAll();
};

// 元のセットを変更せず、パスワードなしの新しいセットとしてフォームへコピーする。
window.copyWordSet = function (id) {
  const mode = state.mode;
  const target = state.sets[mode].find((set) => set.id === id);
  if (!target) return;
  if (target.copyAllowed === false) {
    alert('このワードセットはコピーできない設定です。');
    return;
  }

  state.editingId[mode] = null;
  const copiedName = `${target.name}（コピー）`.slice(0, 20);
  const base = {
    creatorName: '',
    hasPassword: false,
    password: '',
    icon: target.icon || '',
    copyAllowed: true,
  };
  state.forms[mode] = mode === 'poem'
    ? { name: copiedName, words: (target.words || []).join('\n'), ...base }
    : {
      name: copiedName,
      words5: (target.words5 || []).join('\n'),
      words7: (target.words7 || []).join('\n'),
      ...base,
    };
  renderAll();
  document.getElementById(`panel-${mode}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  alert('内容をコピーしました。パスワードなしの新しいセットとして保存できます。');
};

window.deleteWordSet = async function (id) {
  const mode = state.mode;
  const target = state.sets[mode].find((set) => set.id === id);
  if (!target) return;

  const auth = await requestPassword(target);
  if (!auth.ok) return;
  const editorName = (prompt(`「${target.name}」を削除する人のお名前を入力してください（記録用・空欄でもOK）`, '') || '').trim();
  if (!confirm('このワードセットを削除しますか？\n（この操作は取り消せません）')) return;

  try {
    await deleteWordSetSecurely({ id, editorName, currentPassword: auth.password });
    alert('ワードセットを削除しました。');
  } catch (error) {
    console.error(error);
    alert(userFacingError(error));
  }
};

export function listenWordSets() {
  ['poem', 'haiku'].forEach((type) => {
    const q = query(collection(db, 'wordsets'), where('type', '==', type));
    onSnapshot(q, (snap) => {
      state.sets[type] = snap.docs.map((docSnapshot) => ({ id: docSnapshot.id, ...docSnapshot.data() }));
      renderAll();
    });
  });
}

import { updateDoc, increment } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import state from './poem-state.js';
import { renderHand } from './poem-render.js';
import { exportPoemText, exportPoemCSV } from './poem-export.js';

export function setupAutoResize() {
  const textarea = document.getElementById('poem-input-area');
  if (!textarea) return;

  const savedDraft = sessionStorage.getItem('poemDraft');
  if (savedDraft) {
    textarea.value = savedDraft;
    resizeTextarea.call(textarea);
  }

  textarea.removeEventListener('input', resizeTextarea);
  textarea.addEventListener('input', function() {
    resizeTextarea.call(this);
    sessionStorage.setItem('poemDraft', this.value);
  });
}

function resizeTextarea() {
  this.style.height = 'auto';
  this.style.height = (this.scrollHeight) + 'px';
}

window.onCardClick = function(idx) {
  if (state.isSpectator) return;
  const myHands = state.currentData.hands?.[state.myName] || [];
  const item = myHands[idx];
  const textarea = document.getElementById('poem-input-area');
  if (!textarea || !item) return;

  const wordText = item.text;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = textarea.value;

  textarea.value = text.substring(0, start) + wordText + text.substring(end);
  textarea.selectionStart = textarea.selectionEnd = start + wordText.length;
  
  resizeTextarea.call(textarea);
  sessionStorage.setItem('poemDraft', textarea.value);
  textarea.focus();

  if (state.selectedHandIndices.has(idx)) {
    state.selectedHandIndices.delete(idx);
  } else {
    state.selectedHandIndices.add(idx);
  }

  renderHand();
};

window.clearPoem = function() {
  if (state.isSpectator) return;
  const textarea = document.getElementById('poem-input-area');
  if (textarea) {
    textarea.value = '';
    textarea.style.height = 'auto';
    textarea.focus();
  }
  state.selectedHandIndices.clear();
  sessionStorage.removeItem('poemDraft');
  renderHand();
};

window.submitPoem = async function() {
  if (state.isSpectator) return alert('見学モードではポエムの投稿はできません');
  const textarea = document.getElementById('poem-input-area');
  if (!textarea) return;

  const poemText = textarea.value.trim();
  if (!poemText) return alert('ポエムを入力してください');

  const myHands = state.currentData.hands?.[state.myName] || [];
  const usedHands = [];
  state.selectedHandIndices.forEach(idx => {
    if (myHands[idx]) usedHands.push(myHands[idx]);
  });

  await updateDoc(state.roomRef, {
    [`poems.${state.myName}`]: {
      text: poemText,
      hands: usedHands,
      revealed: false,
      likes: 0,
      emos: 0
    }
  });
  
  sessionStorage.removeItem('poemDraft');
  alert('ポエムを投稿しました！');
};

window.revealPoem = async function(pName) {
  if (!state.roomRef) return;
  await updateDoc(state.roomRef, { [`poems.${pName}.revealed`]: true });
};

window.addReaction = async function(pName, type) {
  if (!state.roomRef || !state.currentData) return;
  const poems = state.currentData.poems || {};
  const target = poems[pName];
  if (!target) return;

  // increment()でサーバー側に加算させることで、同時押しでもカウントが失われないようにする
  await updateDoc(state.roomRef, {
    [`poems.${pName}.${type === 'like' ? 'likes' : 'emos'}`]: increment(1)
  });
};


window.exportText = function() { 
  const exportAll = document.getElementById('export-all-check')?.checked ?? true;
  exportPoemText(state.currentData, exportAll); 
};
window.exportCSV = function() { 
  const exportAll = document.getElementById('export-all-check')?.checked ?? true;
  exportPoemCSV(state.currentData, state.roomId, exportAll); 
};

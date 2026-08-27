import { updateDoc, increment } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import state from './poem-state.js';
import { renderHand } from './poem-render.js';
import { exportPoemText, exportPoemCSV } from './poem-export.js';
import { getParticipantStorageKey, getParticipantUidByName } from './participant-utils.js';
import { submitPoemSecure, revealPoemSecure, reactPoemSecure } from './poem-functions.js';

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
  const storageKey = getParticipantStorageKey(state.currentData, state.myUid, state.myName);
  const myHands = state.currentData.hands?.[storageKey] || [];
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

  const storageKey = getParticipantStorageKey(state.currentData, state.myUid, state.myName);
  const myHands = state.currentData.hands?.[storageKey] || [];
  const usedHands = [];
  state.selectedHandIndices.forEach(idx => {
    if (myHands[idx]) usedHands.push(myHands[idx]);
  });

  if (state.currentData.schemaVersion === 2) {
    await submitPoemSecure(state.roomId, poemText, usedHands);
    if (typeof window.resyncPoemRoom === 'function') {
      const result = await window.resyncPoemRoom();
      if (!result?.ok) throw result.error || new Error('投稿の画面反映を確認できませんでした。');
    }
  } else {
    await updateDoc(state.roomRef, {
      [`poems.${getParticipantStorageKey(state.currentData, state.myUid, state.myName)}`]: {
        text: poemText,
        hands: usedHands,
        revealed: false,
        likes: 0,
        emos: 0
      }
    });
  }

  sessionStorage.removeItem('poemDraft');
  if (textarea) {
    textarea.value = '';
    textarea.style.height = 'auto';
  }
  state.selectedHandIndices.clear();
  renderHand();
  alert('ポエムを投稿しました。画面への反映も確認しました！');
};

window.revealPoem = async function(pName) {
  if (!state.roomRef) return;
  const targetUid = getParticipantUidByName(state.currentData, pName) || pName;
  if (state.currentData.schemaVersion === 2) {
    await revealPoemSecure(state.roomId, targetUid);
  } else {
    await updateDoc(state.roomRef, { [`poems.${pName}.revealed`]: true });
  }
};

window.addReaction = async function(pName, type) {
  if (!state.roomRef || !state.currentData) return;
  const poems = state.currentData.poems || {};
  const targetUid = getParticipantUidByName(state.currentData, pName) || pName;
  const target = poems[targetUid] || poems[pName];
  if (!target) return;

  // increment()でサーバー側に加算させることで、同時押しでもカウントが失われないようにする
  if (state.currentData.schemaVersion === 2) {
    await reactPoemSecure(state.roomId, targetUid, type);
    if (typeof window.resyncPoemRoom === 'function') {
      const result = await window.resyncPoemRoom();
      if (!result?.ok) throw result.error || new Error('リアクションの画面反映を確認できませんでした。');
    }
  } else {
    await updateDoc(state.roomRef, {
      [`poems.${pName}.${type === 'like' ? 'likes' : 'emos'}`]: increment(1)
    });
  }
};


window.exportText = function() { 
  const exportAll = document.getElementById('export-all-check')?.checked ?? true;
  exportPoemText(state.currentData, exportAll); 
};
window.exportCSV = function() { 
  const exportAll = document.getElementById('export-all-check')?.checked ?? true;
  exportPoemCSV(state.currentData, state.roomId, exportAll); 
};

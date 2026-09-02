import { updateDoc, increment } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import state from './poem-state.js';
import { renderHand } from './poem-render.js';
import { exportPoemText, exportPoemCSV } from './poem-export.js';
import { getParticipantStorageKey, getParticipantUidByName } from './participant-utils.js';
import { submitPoemSecure, revealPoemSecure, reactPoemSecure } from './poem-functions.js';

let draftContext = null;
let draftWasSpectator = false;

export function syncPoemDraftContext() {
  const data = state.currentData;
  if (!data || !state.roomId) return;
  const context = JSON.stringify([state.roomId, state.myUid || state.myName, data.roundCount || 1]);
  const storageKey = getParticipantStorageKey(data, state.myUid, state.myName);
  const submitted = data.poems?.[storageKey] !== undefined;
  if (!submitted && context === draftContext && draftWasSpectator === state.isSpectator) return;
  draftWasSpectator = state.isSpectator;
  draftContext = context;
  const savedContext = sessionStorage.getItem('poemDraftContext');
  const savedText = !submitted && savedContext === context ? sessionStorage.getItem('poemDraft') || '' : '';
  let selectedIds = [];
  if (!submitted && savedContext === context) {
    try { selectedIds = JSON.parse(sessionStorage.getItem('poemDraftSelectedIds') || '[]'); } catch { /* 壊れた選択情報だけを無視する */ }
  }
  if (!Array.isArray(selectedIds)) selectedIds = [];
  if (submitted || savedContext !== context) {
    sessionStorage.removeItem('poemDraft');
    sessionStorage.removeItem('poemDraftContext');
    sessionStorage.removeItem('poemDraftSelectedIds');
  }
  state.selectedHandIndices.clear();
  (data.hands?.[storageKey] || []).forEach((card, index) => {
    if (selectedIds.includes(card.id)) state.selectedHandIndices.add(index);
  });
  const textarea = document.getElementById('poem-input-area');
  if (textarea) {
    textarea.value = savedText;
    textarea.style.height = 'auto';
  }
}

export function setupAutoResize() {
  syncPoemDraftContext();
  const textarea = document.getElementById('poem-input-area');
  if (!textarea) return;
  if (!state.isSpectator) resizeTextarea.call(textarea);
  textarea.removeEventListener('input', handlePoemInput);
  textarea.addEventListener('input', handlePoemInput);
}

function savePoemDraft(text) {
  if (!draftContext || state.isSpectator || state.currentData?.status !== 'playing') return;
  sessionStorage.setItem('poemDraftContext', draftContext);
  sessionStorage.setItem('poemDraft', text);
  const storageKey = getParticipantStorageKey(state.currentData, state.myUid, state.myName);
  const hand = state.currentData.hands?.[storageKey] || [];
  sessionStorage.setItem('poemDraftSelectedIds', JSON.stringify(
    [...state.selectedHandIndices].map(index => hand[index]?.id).filter(Boolean)
  ));
}

export function saveCurrentPoemDraft() {
  const textarea = document.getElementById('poem-input-area');
  const key = getParticipantStorageKey(state.currentData, state.myUid, state.myName);
  if (textarea && state.currentData?.poems?.[key] === undefined) savePoemDraft(textarea.value);
}

function handlePoemInput() {
  resizeTextarea.call(this);
  savePoemDraft(this.value);
}

function resizeTextarea() {
  this.style.height = 'auto';
  this.style.height = (this.scrollHeight) + 'px';
}

window.onCardClick = function(idx) {
  if (state.isSpectator) return;
  const storageKey = getParticipantStorageKey(state.currentData, state.myUid, state.myName);
  if (state.currentData.poems?.[storageKey] !== undefined) return;
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
  textarea.focus();

  if (state.selectedHandIndices.has(idx)) {
    state.selectedHandIndices.delete(idx);
  } else {
    state.selectedHandIndices.add(idx);
  }

  savePoemDraft(textarea.value);

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
  sessionStorage.removeItem('poemDraftSelectedIds');
  renderHand();
};

window.submitPoem = async function() {
  if (state.isSpectator) return alert('見学モードではポエムの投稿はできません');
  const textarea = document.getElementById('poem-input-area');
  if (!textarea) return;

  const poemText = textarea.value.trim();
  if (!poemText) return alert('ポエムを入力してください');

  const storageKey = getParticipantStorageKey(state.currentData, state.myUid, state.myName);
  if (state.currentData.poems?.[storageKey] !== undefined) return alert('この回のポエムは投稿済みです');
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
  sessionStorage.removeItem('poemDraftSelectedIds');
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

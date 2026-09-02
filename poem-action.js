import { updateDoc, increment, runTransaction } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { db } from './firebase-config.js';
import { showGameNotice } from './ui-feedback.js';
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
  const submitted = data.poems?.[storageKey] !== undefined ||
    (state.poemSubmission?.context === context && state.poemSubmission.saved);
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
  if (state.poemSubmission?.context === poemSubmissionContext() && (state.poemSubmission.pending || state.poemSubmission.saved)) return;
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
  if (state.poemSubmission?.context === poemSubmissionContext() && (state.poemSubmission.pending || state.poemSubmission.saved)) return;
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

function poemSubmissionContext() {
  return JSON.stringify([state.roomId, state.myUid || state.myName, state.currentData?.roundCount || 1]);
}

window.submitPoem = async function() {
  if (!state.roomRef || state.currentData?.status !== 'playing') return;
  if (state.isSpectator) return alert('見学モードではポエムの投稿はできません');
  const context = poemSubmissionContext();
  if (state.poemSubmission?.context === context && (state.poemSubmission.pending || state.poemSubmission.saved)) return;
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

  const roomId = state.roomId;
  const roomRef = state.roomRef;
  const round = state.currentData.roundCount || 1;
  const submission = { context, pending: true, saved: false };
  state.poemSubmission = submission;
  renderHand();
  try {
    if (state.currentData.schemaVersion === 2) {
      await submitPoemSecure(roomId, poemText, usedHands, round);
    } else {
      await runTransaction(db, async transaction => {
        const snapshot = await transaction.get(roomRef);
        const data = snapshot.exists() ? snapshot.data() : null;
        if (!data || data.status !== 'playing' || (data.roundCount || 1) !== round) throw new Error('作成回が変わったため、前の回の投稿は保存しませんでした。');
        if (data.poems?.[storageKey] !== undefined) throw new Error('この回のポエムは投稿済みです');
        transaction.update(roomRef, { [`poems.${storageKey}`]: { text: poemText, hands: usedHands, revealed: false, likes: 0, emos: 0 } });
      });
    }
    submission.saved = true;
    // 保存成功の確認と画面同期は別。古い処理で新しい回の下書きを触らない。
    if (poemSubmissionContext() !== context) return;
    syncPoemDraftContext();
    renderHand();
    try {
      if (typeof window.resyncPoemRoom !== 'function') throw new Error('同期処理がありません');
      const result = await window.resyncPoemRoom();
      if (!result?.ok) throw result?.error || new Error('画面更新に失敗しました');
    } catch {
      if (poemSubmissionContext() === context) showGameNotice('投稿は保存済みですが、画面更新に失敗しました。「最新の状態に更新」を押してください。再投稿は不要です。', 'error');
      return;
    }
    if (poemSubmissionContext() === context) alert('ポエムを投稿しました。画面への反映も確認しました！');
  } catch (error) {
    if (poemSubmissionContext() !== context) {
      showGameNotice('前の回・ルームへの投稿の保存を確認できませんでした。現在の下書きはそのまま残しています。', 'error');
    } else {
      throw error;
    }
  } finally {
    submission.pending = false;
    renderHand();
  }
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

const pendingReactions = new Set();

window.addReaction = async function(pName, type, button) {
  if (!state.roomRef || !state.currentData) return;
  const poems = state.currentData.poems || {};
  const targetUid = getParticipantUidByName(state.currentData, pName) || pName;
  const target = poems[targetUid] || poems[pName];
  if (!target) return;

  const key = JSON.stringify([state.roomId, targetUid, type]);
  if (pendingReactions.has(key)) return;
  pendingReactions.add(key);
  if (button) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  }

  try {
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
  } finally {
    pendingReactions.delete(key);
    if (button) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
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

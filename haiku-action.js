import { updateDoc, runTransaction } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { db } from './firebase-config.js';
import { getParticipantStorageKey, getParticipantUidByName } from './participant-utils.js';
import state from './haiku-state.js';
import { renderHand } from './haiku-render.js';
import { submitHaikuPhrase, revealHaikuPhrase, selfPraiseHaikuPhrase, submitHaikuVote } from './haiku-functions.js';

window.selectCard = function(type, idx) {
  if (state.isSpectator) return;
  if (type === 5) {
    const item = state.myHand5[idx];
    if (state.selectedHand[0] === item) state.selectedHand[0] = null;
    else if (state.selectedHand[2] === item) state.selectedHand[2] = null;
    else if (!state.selectedHand[0]) state.selectedHand[0] = item;
    else if (!state.selectedHand[2]) state.selectedHand[2] = item;
  } else {
    state.selectedHand[1] = state.selectedHand[1] === state.myHand7[idx] ? null : state.myHand7[idx];
  }
  renderHand();
};
window.swap5Cards = function() { if (!state.isSpectator) { [state.selectedHand[0], state.selectedHand[2]] = [state.selectedHand[2], state.selectedHand[0]]; renderHand(); } };
// 「引き直し対象として選ぶ」用の選択切り替え。句をつくるための選択(selectCard)とは完全に別枠で管理する
window.toggleRedrawCard = function(type, idx) {
  if (state.isSpectator) return;
  const item = type === 5 ? state.myHand5[idx] : state.myHand7[idx];
  if (!item) return;
  const key = type === 5 ? 'redrawSelected5' : 'redrawSelected7';
  const list = state[key];
  const pos = list.indexOf(item.id);
  if (pos === -1) list.push(item.id);
  else list.splice(pos, 1);
  renderHand();
};
window.clearPhrase = function() { if (!state.isSpectator) { state.selectedHand = [null, null, null]; renderHand(); } };
window.submitPhrase = async function() {
  if (state.isSpectator) return alert('見学モードでは句の投稿はできません');
  if (!state.selectedHand[0] || !state.selectedHand[1] || !state.selectedHand[2]) return alert('すべて選択してください');
  const storageKey = getParticipantStorageKey(state.currentData, state.myUid, state.myName);
  const phrase = `${state.selectedHand[0].text} ${state.selectedHand[1].text} ${state.selectedHand[2].text}`;
  if (state.currentData.schemaVersion === 2) {
    await submitHaikuPhrase(state.roomId, phrase, state.selectedHand);
    if (typeof window.resyncHaikuRoom === 'function') await window.resyncHaikuRoom();
  } else {
    await updateDoc(state.roomRef, {
      [`phrases.${storageKey}`]: phrase,
      [`phraseDetails.${storageKey}`]: state.selectedHand
    });
  }
};
window.revealPhrase = async function(pName) {
  if (!state.roomRef) return;
  const targetKey = getParticipantUidByName(state.currentData, pName) || pName;
  if (state.currentData.schemaVersion === 2) {
    await revealHaikuPhrase(state.roomId, targetKey);
    if (typeof window.resyncHaikuRoom === 'function') await window.resyncHaikuRoom();
  } else {
    await updateDoc(state.roomRef, { [`revealedPhrases.${targetKey}`]: true });
  }
};
window.doSelfPraise = async function() {
  if (!state.roomRef || state.isSubmittingSelfPraise) return;
  state.isSubmittingSelfPraise = true;
  try {
    const storageKey = getParticipantStorageKey(state.currentData, state.myUid, state.myName);
    if (state.currentData.schemaVersion === 2) {
      await selfPraiseHaikuPhrase(state.roomId);
    } else {
      await updateDoc(state.roomRef, { [`selfPraise.${storageKey}`]: true });
    }
  } catch (e) {
    alert('自画自賛の登録に失敗しました: ' + e.message);
  } finally {
    state.isSubmittingSelfPraise = false;
  }
};
window.submitVote = async function(targetPlayer, forcedKey, selectId) {
  const evalKey = forcedKey || document.getElementById(selectId || `vote-select-${targetPlayer}`)?.value;
  if (!evalKey) return alert('御印を選択してください');

  if (state.currentData.schemaVersion === 2) {
    const targetUid = getParticipantUidByName(state.currentData, targetPlayer);
    if (!targetUid) return alert('対象の句が見つかりません');
    try {
      await submitHaikuVote(state.roomId, targetUid, evalKey);
      if (typeof window.resyncHaikuRoom === 'function') await window.resyncHaikuRoom();
      alert('御印を贈りました！');
    } catch (e) {
      alert('御印の送信に失敗しました: ' + (e.message || 'サーバーエラー'));
    }
    return;
  }

  const players = state.currentData.players || [];
  const currentHost = players.includes(state.currentData.currentHost) ? state.currentData.currentHost : (players[0] || '');
  const isHost = (state.myName === currentHost);

  if (isHost) {
    // トランザクションでサーバー側に読み込み〜追加をまとめて行うことで、
    // 連打しても加算が消えず、かつ同じ御印を何個でも贈れる仕様を維持する
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(state.roomRef);
        const data = snap.data() || {};
        const voterKey = getParticipantStorageKey(data, state.myUid, state.myName);
        const targetKey = getParticipantUidByName(data, targetPlayer) || targetPlayer;
        const currentVotes = data.votes?.[voterKey]?.[targetKey] || [];
        const currentVotesArr = Array.isArray(currentVotes) ? currentVotes : [currentVotes];
        tx.update(state.roomRef, { [`votes.${voterKey}.${targetKey}`]: [...currentVotesArr, evalKey] });
      });
      alert('御印を追加で贈りました！');
    } catch (e) {
      console.error(e);
      alert('御印の送信に失敗しました: ' + e.message);
    }
  } else {
    // トランザクションでサーバー側から最新のvotesを読んでチェックすることで、
    // 複数の句をほぼ同時にタップしても「1節1回」の制限をすり抜けられないようにする
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(state.roomRef);
        const data = snap.data() || {};
        const voterKey = getParticipantStorageKey(data, state.myUid, state.myName);
        const targetKey = getParticipantUidByName(data, targetPlayer) || targetPlayer;
        const myVotes = data.votes?.[voterKey] || {};
        const hasVotedAnywhere = Object.values(myVotes).some(vote => vote != null);
        if (hasVotedAnywhere) {
          throw new Error('ALREADY_VOTED');
        }
        tx.update(state.roomRef, { [`votes.${voterKey}.${targetKey}`]: evalKey });
      });
      alert('御印を贈りました！');
    } catch (e) {
      if (e.message === 'ALREADY_VOTED') {
        alert('御印は1節につき1つまでしか贈れません！');
      } else {
        console.error(e);
        alert('御印の送信に失敗しました: ' + e.message);
      }
    }
  }
};

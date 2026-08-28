import { updateDoc, runTransaction } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { db } from './firebase-config.js';
import { getParticipantStorageKey, getParticipantUidByName } from './participant-utils.js';
import state from './haiku-state.js';
import { renderHand, refreshPhraseSubmitButton } from './haiku-render.js';
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

function hasSubmittedCurrentPhrase() {
  if (!state.currentData) return false;
  const storageKey = getParticipantStorageKey(state.currentData, state.myUid, state.myName);
  const phrases = state.currentData.phrases || {};
  return (storageKey && phrases[storageKey] !== undefined)
    || (state.myName && phrases[state.myName] !== undefined)
    || state.submittedPhraseKey === `${state.roomId}:${state.currentData.roundCount || 1}`;
}

function isDuplicatePhraseError(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  return code.includes('failed-precondition') && message.includes('句は1節につき1つまで');
}

window.submitPhrase = async function() {
  if (!state.currentData || state.isSubmittingPhrase) return;
  if (state.isSpectator) return alert('見学モードでは句の投稿はできません');
  if (hasSubmittedCurrentPhrase()) return alert('この節では、すでに句を投稿済みです。');
  if (!state.selectedHand[0] || !state.selectedHand[1] || !state.selectedHand[2]) return alert('すべて選択してください');

  const storageKey = getParticipantStorageKey(state.currentData, state.myUid, state.myName);
  const round = state.currentData.roundCount || 1;
  const submissionKey = `${state.roomId}:${round}`;
  const phrase = `${state.selectedHand[0].text} ${state.selectedHand[1].text} ${state.selectedHand[2].text}`;
  state.isSubmittingPhrase = true;
  refreshPhraseSubmitButton();

  try {
    if (state.currentData.schemaVersion === 2) {
      await submitHaikuPhrase(state.roomId, phrase, state.selectedHand);
    } else {
      await updateDoc(state.roomRef, {
        [`phrases.${storageKey}`]: phrase,
        [`phraseDetails.${storageKey}`]: state.selectedHand
      });
    }

    // Callableが成功した時点でサーバー保存済みとして扱い、再同期だけの失敗で再投稿可能に戻さない。
    state.submittedPhraseKey = submissionKey;
    if (typeof window.resyncHaikuRoom === 'function') {
      try {
        await window.resyncHaikuRoom({ requireSuccess: true });
      } catch (resyncError) {
        console.error('[submit-phrase-resync]', resyncError);
        alert('句は投稿されましたが、画面への反映を確認できませんでした。最新の状態に更新してください。');
      }
    }
  } catch (error) {
    console.error('[submit-phrase]', error);
    if (isDuplicatePhraseError(error)) {
      state.submittedPhraseKey = submissionKey;
      alert('この節では、すでに句を投稿済みです。');
    } else {
      let savedAfterError = false;
      if (typeof window.resyncHaikuRoom === 'function') {
        try {
          await window.resyncHaikuRoom({ requireSuccess: true });
          savedAfterError = hasSubmittedCurrentPhrase();
        } catch (resyncError) {
          console.error('[submit-phrase-error-resync]', resyncError);
        }
      }

      if (savedAfterError) {
        state.submittedPhraseKey = submissionKey;
        alert('句は投稿されましたが、送信結果の確認中にエラーが発生しました。最新の状態に更新してください。');
      } else {
        const code = String(error?.code || '');
        if (code.includes('unavailable') || code.includes('deadline-exceeded') || code.includes('internal')) {
          alert('句を投稿できませんでした。通信状態を確認して、もう一度お試しください。');
        } else {
          alert('句の投稿に失敗しました。入力内容を確認して、もう一度お試しください。');
        }
      }
    }
  } finally {
    state.isSubmittingPhrase = false;
    refreshPhraseSubmitButton();
  }
};
window.revealPhrase = async function(pName) {
  if (!state.roomRef || !state.currentData || state.isSpectator) return;
  const targetKey = getParticipantUidByName(state.currentData, pName) || pName;
  if (state.currentData.schemaVersion === 2) {
    await revealHaikuPhrase(state.roomId, targetKey);
    if (typeof window.resyncHaikuRoom === 'function') await window.resyncHaikuRoom();
  } else {
    await updateDoc(state.roomRef, { [`revealedPhrases.${targetKey}`]: true });
  }
};
window.doSelfPraise = async function() {
  if (!state.roomRef || state.isSpectator || state.isSubmittingSelfPraise) return;
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
  if (state.isSubmittingVote) return;
  const evalKey = forcedKey || document.getElementById(selectId || `vote-select-${targetPlayer}`)?.value;
  if (!evalKey) return alert('御印を選択してください');

  state.isSubmittingVote = true;
  try {
    const verifyLocalVote = () => {
      const data = state.currentData || {};
      const voterKey = getParticipantStorageKey(data, state.myUid, state.myName);
      const targetKey = getParticipantUidByName(data, targetPlayer) || targetPlayer;
      const value = data.votes?.[voterKey]?.[targetKey]
        ?? data.votes?.[voterKey]?.[targetPlayer]
        ?? data.votes?.[state.myUid]?.[targetKey];
      return Array.isArray(value) ? value.includes(evalKey) : value === evalKey;
    };
    const resyncAndVerify = async () => {
      try {
        if (typeof window.resyncHaikuRoom === 'function') {
          await window.resyncHaikuRoom({ requireSuccess: true });
        }
      } catch (error) {
        // 保存処理は完了済みなので、再同期だけの失敗を送信失敗として扱わない。
        return { verified: false, resyncFailed: true };
      }
      return { verified: verifyLocalVote(), resyncFailed: false };
    };

    if (state.currentData.schemaVersion === 2) {
      const targetUid = getParticipantUidByName(state.currentData, targetPlayer);
      if (!targetUid) return alert('対象の句が見つかりません');
      await submitHaikuVote(state.roomId, targetUid, evalKey);
      const voteVerification = await resyncAndVerify();
      if (!voteVerification.verified) {
        alert('御印はサーバーに保存されましたが、画面への反映確認に失敗しました。最新の状態に更新してください。');
        return;
      }
      alert('御印を贈りました！画面への反映も確認しました。');
      return;
    }

    const players = state.currentData.players || [];
    const currentHost = players.includes(state.currentData.currentHost) ? state.currentData.currentHost : (players[0] || '');
    const isHost = state.myName === currentHost;

    if (isHost) {
      // トランザクションでサーバー側に読み込み〜追加をまとめて行うことで、
      // 同じ御印を何個でも贈れる仕様を維持する。
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(state.roomRef);
        const data = snap.data() || {};
        const voterKey = getParticipantStorageKey(data, state.myUid, state.myName);
        const targetKey = getParticipantUidByName(data, targetPlayer) || targetPlayer;
        const currentVotes = data.votes?.[voterKey]?.[targetKey] || [];
        const currentVotesArr = Array.isArray(currentVotes) ? currentVotes : [currentVotes];
        tx.update(state.roomRef, { [`votes.${voterKey}.${targetKey}`]: [...currentVotesArr, evalKey] });
      });
      const voteVerification = await resyncAndVerify();
      if (!voteVerification.verified) {
        alert('御印はサーバーに保存されましたが、画面への反映確認に失敗しました。最新の状態に更新してください。');
        return;
      }
      alert('御印を追加で贈りました！');
      return;
    }

    // 最新votesをトランザクション内で確認し、子の「1節1回」を維持する。
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(state.roomRef);
      const data = snap.data() || {};
      const voterKey = getParticipantStorageKey(data, state.myUid, state.myName);
      const targetKey = getParticipantUidByName(data, targetPlayer) || targetPlayer;
      const myVotes = data.votes?.[voterKey] || {};
      if (Object.values(myVotes).some(vote => vote != null)) throw new Error('ALREADY_VOTED');
      tx.update(state.roomRef, { [`votes.${voterKey}.${targetKey}`]: evalKey });
    });
    const voteVerification = await resyncAndVerify();
    if (!voteVerification.verified) {
      alert('御印はサーバーに保存されましたが、画面への反映確認に失敗しました。最新の状態に更新してください。');
      return;
    }
    alert('御印を贈りました！');
  } catch (e) {
    if (e.message === 'ALREADY_VOTED') {
      alert('御印は1節につき1つまでしか贈れません！');
    } else {
      console.error(e);
      alert('御印の送信に失敗しました: ' + (e.message || 'サーバーエラー'));
    }
  } finally {
    state.isSubmittingVote = false;
  }
};

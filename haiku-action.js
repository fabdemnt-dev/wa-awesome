import { updateDoc, runTransaction } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { db } from './firebase-config.js';
import state from './haiku-state.js';
import { renderHand } from './haiku-render.js';

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
window.clearPhrase = function() { if (!state.isSpectator) { state.selectedHand = [null, null, null]; renderHand(); } };
window.submitPhrase = async function() {
  if (state.isSpectator) return alert('見学モードでは句の投稿はできません');
  if (!state.selectedHand[0] || !state.selectedHand[1] || !state.selectedHand[2]) return alert('すべて選択してください');
  await updateDoc(state.roomRef, {
    [`phrases.${state.myName}`]: `${state.selectedHand[0].text} ${state.selectedHand[1].text} ${state.selectedHand[2].text}`,
    [`phraseDetails.${state.myName}`]: state.selectedHand
  });
};
window.revealPhrase = async function(pName) {
  if (!state.roomRef) return;
  await updateDoc(state.roomRef, {
    [`revealedPhrases.${pName}`]: true
  });
};
window.doSelfPraise = async function() {
  if (!state.roomRef || state.isSubmittingSelfPraise) return;
  state.isSubmittingSelfPraise = true;
  try {
    await updateDoc(state.roomRef, {
      [`selfPraise.${state.myName}`]: true
    });
  } catch (e) {
    alert('自画自賛の登録に失敗しました: ' + e.message);
  } finally {
    state.isSubmittingSelfPraise = false;
  }
};
window.submitVote = async function(targetPlayer, forcedKey) {
  const evalKey = forcedKey || document.getElementById(`vote-select-${targetPlayer}`)?.value;
  if (!evalKey) return alert('御印を選択してください');

  const players = state.currentData.players || [];
  const currentHost = players.includes(state.currentData.currentHost) ? state.currentData.currentHost : (players[0] || '');
  const isHost = (state.myName === currentHost);

  if (isHost) {
    // トランザクションでサーバー側に読み込み〜追加をまとめて行うことで、
    // 連打しても加算が消えず、かつ同じ御印を何個でも贈れる仕様を維持する
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(state.roomRef);
        const currentVotes = snap.data()?.votes?.[state.myName]?.[targetPlayer] || [];
        const currentVotesArr = Array.isArray(currentVotes) ? currentVotes : [currentVotes];
        tx.update(state.roomRef, { [`votes.${state.myName}.${targetPlayer}`]: [...currentVotesArr, evalKey] });
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
        const myVotes = snap.data()?.votes?.[state.myName] || {};
        const hasVotedAnywhere = Object.values(myVotes).some(vote => vote != null);
        if (hasVotedAnywhere) {
          throw new Error('ALREADY_VOTED');
        }
        tx.update(state.roomRef, { [`votes.${state.myName}.${targetPlayer}`]: evalKey });
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

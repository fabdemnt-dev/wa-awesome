import { updateDoc, arrayUnion } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import state from './haiku-state.js';
import { evalOptionsMaster } from './haiku-utils.js';
import { renderInputFields } from './haiku-render.js';

window.addWords = async function() {
  if (!state.currentData || state.isSpectator) return;
  const st = state.currentData.settings || { in5: 5, in7: 3 };
  
  const getWords = (type, count) => {
    const arr = [];
    for (let i = 1; i <= count; i++) {
      const val = document.getElementById(`word-${type}-input-${i}`)?.value.trim();
      if (val) {
        arr.push({ 
          text: val, 
          author: state.myName,
          id: Date.now() + "_" + Math.random().toString(36).substring(2, 9) 
        });
      }
    }
    return arr;
  };

  const new5 = getWords('5', st.in5);
  const new7 = getWords('7', st.in7);
  if (new5.length < st.in5 || new7.length < st.in7) return alert('全ての素材を入力してください');

  await updateDoc(state.roomRef, { words5: arrayUnion(...new5), words7: arrayUnion(...new7) });
  renderInputFields(st.in5, st.in7);
  const addBtn = document.getElementById('add-word-btn');
  if (addBtn) addBtn.innerText = "✅ 追加完了！";
};
window.startGame = async function() {
  if (state.isSpectator) return alert('見学モードでは句会を開始できません');
  if (!confirm('全員の素材が集まりましたか？\n句会を始めます。')) return;

  const players = state.currentData?.players || [];
  const st = state.currentData?.settings || { hand5: 5, hand7: 3 };
  const w5 = state.currentData?.words5 || [], w7 = state.currentData?.words7 || [];

  if (w5.length < players.length * st.hand5 || w7.length < players.length * st.hand7) {
    return alert('素材が足りません！');
  }

  const s5 = [...w5].sort(() => Math.random() - 0.5);
  const s7 = [...w7].sort(() => Math.random() - 0.5);
  const h5 = {}, h7 = {};
  players.forEach(p => { h5[p] = s5.splice(0, st.hand5); h7[p] = s7.splice(0, st.hand7); });

  await updateDoc(state.roomRef, { status: "playing", hands5: h5, hands7: h7, phrases: {}, phraseDetails: {}, votes: {}, revealedPhrases: {}, selfPraise: {} });
};
window.nextRound = async function() {
  if (!state.currentData || state.isProcessingNextRound) return;

  const players = state.currentData.players || [];
  const currentHost = players[(state.currentData.hostIndex || 0) % (players.length || 1)];
  if (state.myName !== currentHost) {
    return alert('「次の節に進む」は今節の選者（親）だけが押せます');
  }

  if (!confirm('本当に次の節に進みますか？\n（現在の句は履歴に保存され、新しい節が始まります）')) return;

  state.isProcessingNextRound = true;

  try {
    const votes = state.currentData.votes || {}, phrases = state.currentData.phrases || {}, scores = state.currentData.scores || {};
    const players = state.currentData.players || [], hostIndex = state.currentData.hostIndex || 0;
    const spectators = state.currentData.spectators || [];
    const newScores = { ...scores };

    let taeWinners = [];
    const taePoints = Math.max(10, players.length * 2);

    Object.keys(votes).forEach(voter => {
      // 見学者の御印はお楽しみ用なので得点計算には含めない
      if (spectators.includes(voter)) return;

      Object.keys(votes[voter] || {}).forEach(target => {
        const vData = votes[voter][target];
        const keys = Array.isArray(vData) ? vData : [vData];

        keys.forEach(k => {
          if (k === 'tae' && !taeWinners.includes(target)) {
            taeWinners.push(target);
          }
          const opt = evalOptionsMaster[k];
          const pts = (k === 'tae') ? taePoints : (opt ? opt.pts : 0);
          newScores[target] = (newScores[target] || 0) + pts;
        });
      });
    });

    let alertMessage = '次の節に進みます！';
    if (taeWinners.length > 0) {
      alertMessage = `🪭 妙なりが出ました！今節の最高功労者: ${taeWinners.join(', ')} さん！(+${taePoints}誉)\n` + alertMessage;
    }

    const nextRoundNum = (state.currentData.roundCount || 1) + 1;

    const currentRoundHistory = { 
      round: state.currentData.roundCount || 1, 
      phrases, 
      phraseDetails: state.currentData.phraseDetails || {}, 
      votes, 
      host: players[hostIndex % (players.length || 1)] || '' 
    };

    await updateDoc(state.roomRef, {
      status: "lobby", 
      hostIndex: hostIndex + 1, 
      roundCount: nextRoundNum,
      scores: newScores, 
      history: arrayUnion(currentRoundHistory),
      words5: [], words7: [], hands5: {}, hands7: {}, phrases: {}, phraseDetails: {}, votes: {}, revealedPhrases: {}, selfPraise: {}
    });
    
    alert(alertMessage);
  } catch (e) {
    console.error(e);
    alert('エラーが発生しました: ' + e.message);
  } finally {
    state.isProcessingNextRound = false;
  }
};

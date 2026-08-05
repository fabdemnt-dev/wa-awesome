import { db } from "./firebase-config.js";
import { doc, setDoc, onSnapshot, updateDoc, arrayUnion, arrayRemove } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import state from './haiku-state.js';
import { escapeHTML, escapeJS, evalOptionsMaster } from './haiku-utils.js';
import { renderInputFields, renderHand, renderBoards } from './haiku-render.js';

window.joinRoom = async function() {
  state.myName = document.getElementById('player-name')?.value.trim() || "";
  state.roomId = document.getElementById('room-id')?.value.trim() || "";
  const specCheck = document.getElementById('spectator-check');
  state.isSpectator = specCheck ? specCheck.checked : false;

  if (!state.myName || !state.roomId) return alert('名前とルームIDを入力してください');

  try {
    state.roomRef = doc(db, "rooms", "haiku_" + state.roomId);
    
    const updateData = {
      status: "lobby", hostIndex: 0, roundCount: 1, history: [],
      words5: [], words7: [], hands5: {}, hands7: {}, phrases: {}, phraseDetails: {}, votes: {}, scores: {}, selfPraise: {},
      settings: { in5: 5, in7: 3, hand5: 5, hand7: 3 }
    };

    if (state.isSpectator) {
      updateData.spectators = arrayUnion(state.myName);
    } else {
      updateData.players = arrayUnion(state.myName);
    }

    await setDoc(state.roomRef, updateData, { merge: true });

    document.getElementById('login-sec').style.display = 'none';
    document.getElementById('lobby-sec').style.display = 'block';

    onSnapshot(state.roomRef, (snapshot) => {
      state.currentData = snapshot.data();
      if (!state.currentData) return;

      const players = state.currentData.players || [];
      const spectators = state.currentData.spectators || [];
      
      if (spectators.includes(state.myName)) state.isSpectator = true;
      if (players.includes(state.myName)) state.isSpectator = false;

      const currentHost = players[(state.currentData.hostIndex || 0) % (players.length || 1)] || '未設定';
      const hostText = `👑 今節の選者（親）: <strong>${escapeHTML(currentHost)}</strong> ${currentHost === state.myName ? '（あなた）' : ''}`;
      
      if (document.getElementById('host-info-lobby')) document.getElementById('host-info-lobby').innerHTML = hostText;
      if (document.getElementById('host-info-game')) document.getElementById('host-info-game').innerHTML = hostText;

      const roleBtnText = state.isSpectator ? "⚔️ プレイヤーとして途中参戦する" : "👀 見学モードに切り替える";
      if (document.getElementById('role-toggle-btn-lobby')) document.getElementById('role-toggle-btn-lobby').innerText = roleBtnText;
      if (document.getElementById('role-toggle-btn-game')) document.getElementById('role-toggle-btn-game').innerText = roleBtnText;

      const st = state.currentData.settings || { in5: 5, in7: 3, hand5: 5, hand7: 3 };
      if (document.getElementById('set-in-5')) document.getElementById('set-in-5').value = st.in5;
      if (document.getElementById('set-in-7')) document.getElementById('set-in-7').value = st.in7;
      if (document.getElementById('set-hand-5')) document.getElementById('set-hand-5').value = st.hand5;
      if (document.getElementById('set-hand-7')) document.getElementById('set-hand-7').value = st.hand7;

      renderInputFields(st.in5, st.in7);
      if (document.getElementById('total-words-5')) document.getElementById('total-words-5').innerText = state.currentData.words5?.length || 0;
      if (document.getElementById('total-words-7')) document.getElementById('total-words-7').innerText = state.currentData.words7?.length || 0;

      const scores = state.currentData.scores || {};
      let playerListHtml = players.map((p, idx) => `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
          <span>・ ${escapeHTML(p)} ${idx === ((state.currentData.hostIndex || 0) % players.length) ? '<span class="role-badge">選者（親）</span>' : ''}</span>
          <div>
            <span class="score-badge" style="margin-right:8px;">${scores[p] || 0} 誉</span>
            <button onclick="removePlayer('${escapeJS(p)}')" style="width:auto; margin:0; padding:4px 8px; font-size:12px; background-color:#ef4444;">鯖落ち</button>
          </div>
        </div>
      `).join('');

      if (spectators.length > 0) {
        playerListHtml += `<div style="font-size:12px; color:#64748b; margin-top:8px;">👀 見学者: ${spectators.map(s => escapeHTML(s)).join(', ')}</div>`;
      }

      if (document.getElementById('player-list')) document.getElementById('player-list').innerHTML = playerListHtml;

      if (state.currentData.status === 'lobby') {
        if (document.getElementById('game-sec')) document.getElementById('game-sec').style.display = 'none';
        if (document.getElementById('lobby-sec')) document.getElementById('lobby-sec').style.display = 'block';
        
        state.myHand5 = []; state.myHand7 = []; state.selectedHand = [null, null, null];
        
        // ロビーに戻ったら、一時保存していた手札データを消す
        sessionStorage.removeItem('haikuSelectedHand');

        ['5', '7'].forEach(type => {
          const container = document.getElementById(`inputs-${type}-container`);
          if (container) {
            container.querySelectorAll('input').forEach(inp => inp.value = '');
          }
        });
        const addBtn = document.getElementById('add-word-btn');
        if (addBtn) addBtn.innerText = '素材を提出する';

      } else if (state.currentData.status === 'playing') {
        if (document.getElementById('lobby-sec')) document.getElementById('lobby-sec').style.display = 'none';
        if (document.getElementById('game-sec')) document.getElementById('game-sec').style.display = 'block';
        if (state.currentData.hands5?.[state.myName]) state.myHand5 = state.currentData.hands5[state.myName];
        if (state.currentData.hands7?.[state.myName]) state.myHand7 = state.currentData.hands7[state.myName];
        renderHand();
        renderBoards();
      }
    });
  } catch (e) {
    alert('接続エラーが発生しました: ' + e.message);
  }
};

window.toggleRole = async function() {
  if (!state.roomRef) return;
  if (state.isSpectator) {
    await updateDoc(state.roomRef, {
      spectators: arrayRemove(state.myName),
      players: arrayUnion(state.myName)
    });
    state.isSpectator = false;
    alert("プレイヤーとして参加しました！");
  } else {
    await updateDoc(state.roomRef, {
      players: arrayRemove(state.myName),
      spectators: arrayUnion(state.myName)
    });
    state.isSpectator = true;
    alert("見学モードに切り替えました！");
  }
};

window.updateSettings = async function() {
  if (!state.roomRef) return;
  await updateDoc(state.roomRef, {
    settings: {
      in5: parseInt(document.getElementById('set-in-5').value) || 5,
      in7: parseInt(document.getElementById('set-in-7').value) || 3,
      hand5: parseInt(document.getElementById('set-hand-5').value) || 5,
      hand7: parseInt(document.getElementById('set-hand-7').value) || 3
    }
  });
};

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

window.removePlayer = async function(pName) {
  if (confirm(`${pName} さんを退出させますか？`)) {
    await updateDoc(state.roomRef, { players: arrayRemove(pName), spectators: arrayRemove(pName) });
  }
};

window.startGame = async function() {
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
  if (!state.roomRef || state.isSpectator || state.isSubmittingSelfPraise) return;
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

window.submitVote = async function(targetPlayer) {
  const evalKey = document.getElementById(`vote-select-${targetPlayer}`)?.value;
  if (!evalKey) return alert('御印を選択してください');

  const players = state.currentData.players || [];
  const currentHost = players[(state.currentData.hostIndex || 0) % (players.length || 1)];
  const isHost = (state.myName === currentHost);

  if (isHost) {
    const currentVotes = state.currentData.votes?.[state.myName]?.[targetPlayer] || [];
    const currentVotesArr = Array.isArray(currentVotes) ? currentVotes : [currentVotes];
    const newVotesArr = [...currentVotesArr, evalKey];

    await updateDoc(state.roomRef, { [`votes.${state.myName}.${targetPlayer}`]: newVotesArr });
    alert('御印を追加で贈りました！');
  } else {
    const myVotes = state.currentData.votes?.[state.myName] || {};
    const hasVotedAnywhere = Object.values(myVotes).some(vote => vote != null);

    if (hasVotedAnywhere) {
      return alert('御印は1節につき1つまでしか贈れません！');
    }

    await updateDoc(state.roomRef, { [`votes.${state.myName}.${targetPlayer}`]: evalKey });
    alert('御印を贈りました！');
  }
};

window.nextRound = async function() {
  if (!state.currentData || state.isProcessingNextRound) return;
  
  if (!confirm('本当に次の節に進みますか？\n（現在の句は履歴に保存され、新しい節が始まります）')) return;

  state.isProcessingNextRound = true;

  try {
    const votes = state.currentData.votes || {}, phrases = state.currentData.phrases || {}, scores = state.currentData.scores || {};
    const players = state.currentData.players || [], hostIndex = state.currentData.hostIndex || 0;
    const newScores = { ...scores };

    let taeWinners = [];
    const taePoints = Math.max(10, players.length * 2);

    Object.keys(votes).forEach(voter => {
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

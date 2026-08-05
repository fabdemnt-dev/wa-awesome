import { db } from "./firebase-config.js";
import { doc, getDoc, setDoc, onSnapshot, updateDoc, arrayUnion, arrayRemove } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import state from './haiku-state.js';
import { escapeHTML, escapeJS } from './haiku-utils.js';
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
window.removePlayer = async function(pName) {
  if (confirm(`${pName} さんを退出させますか？`)) {
    await updateDoc(state.roomRef, { players: arrayRemove(pName), spectators: arrayRemove(pName) });
  }
};

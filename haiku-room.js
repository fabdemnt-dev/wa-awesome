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

const roomSnapshot = await getDoc(state.roomRef);

if (!roomSnapshot.exists()) {
  const initialData = {
    status: "lobby",
    hostIndex: 0,
    roundCount: 1,
    history: [],
    words5: [],
    words7: [],
    hands5: {},
    hands7: {},
    phrases: {},
    phraseDetails: {},
    votes: {},
    scores: {},
    selfPraise: {},
    settings: {
      in5: 5,
      in7: 3,
      hand5: 5,
      hand7: 3
    },
    players: [],
    spectators: []
  };

  if (state.isSpectator) {
    initialData.spectators = [state.myName];
  } else {
    initialData.players = [state.myName];
  }

  await setDoc(state.roomRef, initialData);
} else {
  if (state.isSpectator) {
    await updateDoc(state.roomRef, {
      spectators: arrayUnion(state.myName)
    });
  } else {
    await updateDoc(state.roomRef, {
      players: arrayUnion(state.myName)
    });
  }
}

    document.getElementById('login-sec').style.display = 'none';
    document.getElementById('lobby-sec').style.display = 'block';

    let previousStatus = null; // 直前のstatusを記録し、「lobbyに遷移した瞬間」だけ入力欄をクリアするために使う

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

      // ラウンド中は選者本人だけ、見学モードへの切り替えボタンを無効化する
      const isHostDuringPlaying = state.currentData.status === 'playing' && !state.isSpectator && state.myName === currentHost;
      const gameRoleBtn = document.getElementById('role-toggle-btn-game');
      if (gameRoleBtn) {
        gameRoleBtn.innerText = isHostDuringPlaying ? "👑 選者はラウンド中切替不可" : roleBtnText;
        gameRoleBtn.disabled = isHostDuringPlaying;
        gameRoleBtn.style.opacity = isHostDuringPlaying ? '0.5' : '1';
        gameRoleBtn.style.cursor = isHostDuringPlaying ? 'not-allowed' : 'pointer';
      }

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

        // 他の状態(playing等)からlobbyに遷移した瞬間だけリセットする。
        // status===lobbyのまま毎回ここを通すと、他プレイヤーの素材提出などで
        // onSnapshotが発火するたびに、自分が入力中の素材まで消えてしまうため。
        if (previousStatus !== 'lobby') {
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
        }

      } else if (state.currentData.status === 'playing') {
        if (document.getElementById('lobby-sec')) document.getElementById('lobby-sec').style.display = 'none';
        if (document.getElementById('game-sec')) document.getElementById('game-sec').style.display = 'block';
        if (state.currentData.hands5?.[state.myName]) state.myHand5 = state.currentData.hands5[state.myName];
        if (state.currentData.hands7?.[state.myName]) state.myHand7 = state.currentData.hands7[state.myName];
        renderHand();
        renderBoards();
      }

      previousStatus = state.currentData.status;
    });
  } catch (e) {
    alert('接続エラーが発生しました: ' + e.message);
  }
};
window.toggleRole = async function() {
  if (!state.roomRef) return;
  if (state.isSpectator) {
    // ゲーム中の途中参戦は、配り終わってない素材の余りが手札分あるときだけ許可する
    if (state.currentData?.status === 'playing') {
      const st = state.currentData.settings || { hand5: 5, hand7: 3 };
      const words5 = state.currentData.words5 || [];
      const words7 = state.currentData.words7 || [];
      const hands5 = state.currentData.hands5 || {};
      const hands7 = state.currentData.hands7 || {};

      const assignedIds5 = new Set(Object.values(hands5).flat().map(w => w.id));
      const assignedIds7 = new Set(Object.values(hands7).flat().map(w => w.id));
      const leftover5 = words5.filter(w => !assignedIds5.has(w.id));
      const leftover7 = words7.filter(w => !assignedIds7.has(w.id));

      if (leftover5.length < st.hand5 || leftover7.length < st.hand7) {
        return alert(`途中参戦できません。手札に配るための素材が足りていません。\n（五音: 余り${leftover5.length}個 / 必要${st.hand5}個、七音: 余り${leftover7.length}個 / 必要${st.hand7}個）`);
      }

      const newHand5 = [...leftover5].sort(() => Math.random() - 0.5).slice(0, st.hand5);
      const newHand7 = [...leftover7].sort(() => Math.random() - 0.5).slice(0, st.hand7);

      await updateDoc(state.roomRef, {
        spectators: arrayRemove(state.myName),
        players: arrayUnion(state.myName),
        [`hands5.${state.myName}`]: newHand5,
        [`hands7.${state.myName}`]: newHand7
      });
      state.isSpectator = false;
      alert("素材の余りから手札を配りました！プレイヤーとして参加しました！");
      return;
    }

    await updateDoc(state.roomRef, {
      spectators: arrayRemove(state.myName),
      players: arrayUnion(state.myName)
    });
    state.isSpectator = false;
    alert("プレイヤーとして参加しました！");
  } else {
    // ラウンド中は選者本人が見学モードに切り替わると、players配列がズレて
    // hostIndexが指す「選者」が別人にすり替わってしまうため、選者本人の切り替えを禁止する
    if (state.currentData?.status === 'playing') {
      const players = state.currentData.players || [];
      const currentHost = players[(state.currentData.hostIndex || 0) % (players.length || 1)];
      if (state.myName === currentHost) {
        return alert('今節の選者（親）はラウンド中に見学モードへ切り替えられません。\n次の節に進んでから切り替えてください。');
      }
    }

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

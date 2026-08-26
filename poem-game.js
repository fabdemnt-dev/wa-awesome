import { updateDoc, arrayUnion, writeBatch, collection, doc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { db } from './firebase-config.js';
import state from './poem-state.js';
import { defaultWords } from './poem-default-words.js';
import { getWordSetById } from './poem-wordsets.js';
import { saveWordSetSecurely, userFacingError } from './wordset-auth.js';
import { getParticipantUidByName } from './participant-utils.js';

window.addWords = async function() {
  if (state.isSpectator) return alert('見学モードでは素材投稿はできません');
  const inputs = document.querySelectorAll('#word-inputs input');
  const newWords = [];
  
  inputs.forEach(inp => {
    const val = inp.value.trim();
    if (val) {
      newWords.push({ 
        text: val, 
        author: state.myName, 
        id: Date.now() + "_" + Math.random().toString(36).substring(2, 9) 
      });
    }
  });

  if (newWords.length === 0) return alert('少なくとも1つ素材を入力してください');

  await updateDoc(state.roomRef, { words: arrayUnion(...newWords) });
  inputs.forEach(inp => inp.value = '');
  alert('素材を追加しました！');
};

window.fillDefaultWords = async function() {
  if (!state.currentData) return;

  const players = state.currentData.players || [];
  const words = state.currentData.words || [];
  const st = state.currentData.settings || { handCount: 5 };

  // 今いる人数分の手札を配れる数まで、足りない分だけデフォルト素材で埋める
  const need = Math.max(0, players.length * st.handCount - words.length);
  if (need === 0) return alert('すでに開始できるだけの素材が集まっています！');

  // ロビーで選ばれたワードセットがあればそれを使い、なければ標準セットを使う
  const selectedId = document.getElementById('wordset-select')?.value || 'builtin';
  const customSet = selectedId !== 'builtin' ? getWordSetById(selectedId) : null;
  const pool = customSet?.words?.length ? customSet.words : defaultWords;
  const authorLabel = customSet ? `🎴${customSet.name}` : "🎴お題ぶくろ";

  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  const added = [];
  for (let i = 0; i < need; i++) {
    added.push({
      text: shuffled[i % shuffled.length],
      author: authorLabel,
      id: Date.now() + "_" + Math.random().toString(36).substring(2, 9)
    });
  }

  await updateDoc(state.roomRef, { words: arrayUnion(...added) });
  const setLabel = customSet ? `「${customSet.name}」` : '標準セット';
  alert(`🎴 ${setLabel}から ${added.length}個 を補充しました！`);
};

window.startGame = async function() {
  if (!state.currentData) return;
  if (state.isSpectator) return alert('見学モードではポエム作りを開始できません');
  if (!confirm('全員の素材が集まりましたか？\nポエム作りを開始します。')) return;

  const players = state.currentData.players || [];
  const words = state.currentData.words || [];
  const st = state.currentData.settings || { handCount: 5 };
  const handCount = st.handCount;

  if (words.length < players.length * handCount) {
    return alert(`素材の数が足りません！\n現在 ${words.length}個 ですが、(プレイヤー ${players.length}人 × 手札 ${handCount}枚 = ${players.length * handCount}個) 必要です。`);
  }

  const shuffledWords = [...words].sort(() => Math.random() - 0.5);
  const newHands = {};
  players.forEach(p => {
    const storageKey = getParticipantUidByName(state.currentData, p) || p;
    newHands[storageKey] = shuffledWords.splice(0, handCount);
  });

  state.selectedHandIndices.clear();
  await updateDoc(state.roomRef, { 
    status: "playing", 
    hands: newHands, 
    poems: {} 
  });
};


window.saveGameAsWordSet = async function() {
  if (!state.currentData) return;

  // ワードセット/デフォルト補充で埋めた分（🎴マーク）は除いて、プレイヤーが実際に入力した素材だけを対象にする
  const words = (state.currentData.words || []).filter(w => !(w.author || '').startsWith('🎴'));

  if (words.length === 0) {
    return alert('保存できる素材がありません（プレイヤーが入力した素材がまだ無いようです）');
  }

  const name = (prompt('このワードセットの名前を付けてください', `${state.roomId}のポエム`) || '').trim();
  if (!name) return;

  try {
    await saveWordSetSecurely({
      editorName: state.myName || '不明',
      wordSet: {
        type: 'poem',
        name,
        words: words.map(w => w.text).filter(Boolean),
        hasPassword: false,
        icon: null,
      },
    });
    alert(`🎴 ワードセット「${name}」として保存しました！\nワードセットのページから、いつでも使えます。`);
  } catch (e) {
    console.error(e);
    alert(userFacingError(e));
  }
};

window.nextGame = async function() {
  if (!state.roomRef || !state.currentData) return;
  if (state.isSpectator) return alert('見学モードでは次のポエム作りに進められません');
  if (!confirm('本当に新しいポエム作りに進みますか？\n（現在の作品は履歴に保存され、新しく作り直します）')) return;

  const currentRoundHistory = {
    round: state.currentData.roundCount || 1,
    poems: state.currentData.poems || {},
    participantUids: state.currentData.participantUids || {}
  };
  const nextRoundNum = (state.currentData.roundCount || 1) + 1;

  const batch = writeBatch(db);
  batch.update(state.roomRef, {
    status: "lobby",
    roundCount: nextRoundNum,
    words: [],
    hands: {},
    poems: {}
  });
  batch.set(doc(collection(state.roomRef, 'history')), currentRoundHistory);
  await batch.commit();
  
  alert('作品を履歴に保存しました！次の作成に進みます。');
};


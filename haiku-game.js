import { updateDoc, arrayUnion, addDoc, collection, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { db } from './firebase-config.js';
import state from './haiku-state.js';
import { evalOptionsMaster } from './haiku-utils.js';
import { renderInputFields } from './haiku-render.js';
import { defaultWords5, defaultWords7 } from './haiku-default-words.js';
import { getWordSetById } from './haiku-wordsets.js';
import { saveWordSetSecurely, userFacingError } from './wordset-auth.js';

window.addWords = async function() {
  if (!state.currentData || state.isSpectator) return;
  const st = state.currentData.settings || { hand5: 5, hand7: 3 };

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

  const new5 = getWords('5', st.hand5);
  const new7 = getWords('7', st.hand7);
  if (new5.length < st.hand5 || new7.length < st.hand7) return alert('全ての素材を入力してください');

  await updateDoc(state.roomRef, { words5: arrayUnion(...new5), words7: arrayUnion(...new7) });
  renderInputFields(st.hand5, st.hand7);
  const addBtn = document.getElementById('add-word-btn');
  if (addBtn) addBtn.innerText = "✅ 追加完了！";
};
window.fillDefaultWords = async function() {
  if (!state.currentData) return;

  const st = state.currentData.settings || { hand5: 5, hand7: 3 };
  const players = state.currentData.players || [];
  const w5 = state.currentData.words5 || [];
  const w7 = state.currentData.words7 || [];

  // 今いる人数分の句会を始められる数まで、足りない分だけデフォルト素材で埋める
  // ※引き直し用の山札分も確保するため、必要数は「最初の手札の2倍」
  //   （全員が1節に1回、手札を全部引き直しても足りる量）
  const need5 = Math.max(0, players.length * st.hand5 * 2 - w5.length);
  const need7 = Math.max(0, players.length * st.hand7 * 2 - w7.length);

  if (need5 === 0 && need7 === 0) {
    return alert('すでに句会を始められるだけの素材が集まっています！');
  }

  // ロビーで選ばれたワードセットがあればそれを使い、なければ標準セットを使う
  const selectedId = document.getElementById('wordset-select')?.value || 'builtin';
  const customSet = selectedId !== 'builtin' ? getWordSetById(selectedId) : null;
  const pool5 = customSet?.words5?.length ? customSet.words5 : defaultWords5;
  const pool7 = customSet?.words7?.length ? customSet.words7 : defaultWords7;
  const authorLabel = customSet ? `🎴${customSet.name}` : "🎴お題ぶくろ";

  const pickWords = (pool, count) => {
    if (count === 0 || pool.length === 0) return [];
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    const picked = [];
    for (let i = 0; i < count; i++) {
      picked.push({
        text: shuffled[i % shuffled.length],
        author: authorLabel,
        id: Date.now() + "_" + Math.random().toString(36).substring(2, 9)
      });
    }
    return picked;
  };

  const add5 = pickWords(pool5, need5);
  const add7 = pickWords(pool7, need7);

  await updateDoc(state.roomRef, { words5: arrayUnion(...add5), words7: arrayUnion(...add7) });
  const setLabel = customSet ? `「${customSet.name}」` : '標準セット';
  alert(`🎴 ${setLabel}から 五音${add5.length}個・七音${add7.length}個 を補充しました！`);
};
window.startGame = async function() {
  if (state.isSpectator) return alert('見学モードでは句会を開始できません');
  if (!confirm('全員の素材が集まりましたか？\n句会を始めます。')) return;

  const players = state.currentData?.players || [];
  const st = state.currentData?.settings || { hand5: 5, hand7: 3 };
  const w5 = state.currentData?.words5 || [], w7 = state.currentData?.words7 || [];

  // 必要素材数は「最初の手札分」＋「引き直し用の山札分」＝手札分の2倍
  // （全プレイヤーが1節に1回、手札を全部引き直しても足りる量を自動確保する）
  if (w5.length < players.length * st.hand5 * 2 || w7.length < players.length * st.hand7 * 2) {
    return alert('素材が足りません！（引き直し用の山札分も必要なため、通常の2倍の素材が必要です）');
  }

  const s5 = [...w5].sort(() => Math.random() - 0.5);
  const s7 = [...w7].sort(() => Math.random() - 0.5);
  const h5 = {}, h7 = {};
  players.forEach(p => { h5[p] = s5.splice(0, st.hand5); h7[p] = s7.splice(0, st.hand7); });

  // 手札を配り終わって残った分を、引き直し用の「山札」として保存する
  const deck5 = s5;
  const deck7 = s7;

  await updateDoc(state.roomRef, { status: "playing", hands5: h5, hands7: h7, deck5, deck7, phrases: {}, phraseDetails: {}, votes: {}, revealedPhrases: {}, selfPraise: {}, redraws: {} });
};
window.redrawHand = async function() {
  if (!state.currentData || state.isSpectator || state.isProcessingRedraw) return;
  if (state.currentData.status !== 'playing') return;

  const phrases = state.currentData.phrases || {};
  if (phrases[state.myName]) {
    return alert('すでに句を披露した後は手札を引き直せません。');
  }

  const redraws = state.currentData.redraws || {};
  if (redraws[state.myName]) {
    return alert('手札の引き直しは1節につき1回までです。');
  }

  const selectedIds5 = state.redrawSelected5 || [];
  const selectedIds7 = state.redrawSelected7 || [];
  const selectedCount5 = selectedIds5.length;
  const selectedCount7 = selectedIds7.length;

  if (selectedCount5 === 0 && selectedCount7 === 0) {
    return alert('🔄ボタンで引き直したい札を選んでください。');
  }

  const deck5 = state.currentData.deck5 || [];
  const deck7 = state.currentData.deck7 || [];

  // 山札が選んだ枚数分あるか確認する
  if (deck5.length < selectedCount5 || deck7.length < selectedCount7) {
    return alert(`選択した枚数分の山札がありません。\n（山札 五音:残り${deck5.length}枚 / 七音:残り${deck7.length}枚）`);
  }

  if (!confirm(`選んだ札（五音${selectedCount5}枚・七音${selectedCount7}枚）を引き直しますか？\n（1節につき1回までです）`)) return;

  state.isProcessingRedraw = true;
  try {
    const myHand5 = state.myHand5 || [];
    const myHand7 = state.myHand7 || [];

    // 選ばれた札を手札から取り除く（捨て札。山札には戻さない）
    const keptHand5 = myHand5.filter(w => !selectedIds5.includes(w.id));
    const keptHand7 = myHand7.filter(w => !selectedIds7.includes(w.id));

    // 山札から選んだ枚数分をランダムに引く
    const shuffledDeck5 = [...deck5].sort(() => Math.random() - 0.5);
    const shuffledDeck7 = [...deck7].sort(() => Math.random() - 0.5);
    const drawn5 = shuffledDeck5.slice(0, selectedCount5);
    const drawn7 = shuffledDeck7.slice(0, selectedCount7);
    const drawnIds5 = new Set(drawn5.map(w => w.id));
    const drawnIds7 = new Set(drawn7.map(w => w.id));

    const newHand5 = [...keptHand5, ...drawn5];
    const newHand7 = [...keptHand7, ...drawn7];
    const newDeck5 = deck5.filter(w => !drawnIds5.has(w.id));
    const newDeck7 = deck7.filter(w => !drawnIds7.has(w.id));

    await updateDoc(state.roomRef, {
      [`hands5.${state.myName}`]: newHand5,
      [`hands7.${state.myName}`]: newHand7,
      deck5: newDeck5,
      deck7: newDeck7,
      [`redraws.${state.myName}`]: true
    });

    state.redrawSelected5 = [];
    state.redrawSelected7 = [];
    alert('選んだ札を引き直しました！');
  } catch (e) {
    console.error(e);
    alert('引き直しに失敗しました: ' + e.message);
  } finally {
    state.isProcessingRedraw = false;
  }
};
window.saveGameAsWordSet = async function() {
  if (!state.currentData) return;

  // ワードセット/デフォルト補充で埋めた分（🎴マーク）は除いて、プレイヤーが実際に入力した素材だけを対象にする
  const words5 = (state.currentData.words5 || []).filter(w => !(w.author || '').startsWith('🎴'));
  const words7 = (state.currentData.words7 || []).filter(w => !(w.author || '').startsWith('🎴'));

  if (words5.length === 0 && words7.length === 0) {
    return alert('保存できる素材がありません（プレイヤーが入力した素材がまだ無いようです）');
  }

  const name = (prompt('このワードセットの名前を付けてください', `${state.roomId}の句会`) || '').trim();
  if (!name) return;

  try {
    await saveWordSetSecurely({
      editorName: state.myName || '不明',
      wordSet: {
        type: 'haiku',
        name,
        words5: words5.map(w => w.text).filter(Boolean),
        words7: words7.map(w => w.text).filter(Boolean),
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
window.nextRound = async function() {
  if (!state.currentData || state.isProcessingNextRound) return;

  const players = state.currentData.players || [];
  const currentHost = players.includes(state.currentData.currentHost) ? state.currentData.currentHost : (players[0] || '');
  if (state.myName !== currentHost) {
    return alert('「次の節に進む」は今節の選者（親）だけが押せます');
  }

  if (!confirm('本当に次の節に進みますか？\n（現在の句は履歴に保存され、新しい節が始まります）')) return;

  state.isProcessingNextRound = true;

  try {
    const votes = state.currentData.votes || {}, phrases = state.currentData.phrases || {}, scores = state.currentData.scores || {};
    const players = state.currentData.players || [];
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

    // 次の選者を「players配列の何番目か」ではなく名前そのもので決める。
    // こうすることで、途中で誰かが見学に切り替わったり抜けたりして配列が変わっても、
    // 順番がズレたり誰かが飛ばされたりしなくなる。
    const currentHostIdx = players.indexOf(currentHost);
    const nextHost = players.length > 0
      ? players[(currentHostIdx === -1 ? 0 : currentHostIdx + 1) % players.length]
      : '';

    const currentRoundHistory = { 
      round: state.currentData.roundCount || 1, 
      phrases, 
      phraseDetails: state.currentData.phraseDetails || {}, 
      votes, 
      host: currentHost 
    };

    // プレイヤーが入力した素材は、使われたかどうかに関わらず、設定がONなら次の節に持ち越す
    const carryOverEnabled = (state.currentData.settings?.carryOver) !== false;
    let carriedWords5 = [], carriedWords7 = [];

    if (carryOverEnabled) {
      const words5 = state.currentData.words5 || [];
      const words7 = state.currentData.words7 || [];

      // ワードセット/デフォルト補充で埋めた分（🎴マーク付き）だけ除外し、
      // プレイヤーが実際に入力した分は使用済みかどうかに関わらずすべて持ち越す
      carriedWords5 = words5.filter(w => !(w.author || '').startsWith('🎴'));
      carriedWords7 = words7.filter(w => !(w.author || '').startsWith('🎴'));

      const skipped5 = words5.length - carriedWords5.length;
      const skipped7 = words7.length - carriedWords7.length;

      if (carriedWords5.length > 0 || carriedWords7.length > 0) {
        alertMessage += `\n📦 プレイヤーが入力した素材（五音${carriedWords5.length}個・七音${carriedWords7.length}個）を次の節に持ち越しました。`;
      }
      if (skipped5 > 0 || skipped7 > 0) {
        alertMessage += `\n（ワードセット/デフォルト補充分の五音${skipped5}個・七音${skipped7}個は持ち越し対象外にしました）`;
      }
    }

    await updateDoc(state.roomRef, {
      status: "lobby", 
      currentHost: nextHost,
      roundCount: nextRoundNum,
      scores: newScores, 
      history: arrayUnion(currentRoundHistory),
      words5: carriedWords5, words7: carriedWords7, hands5: {}, hands7: {}, deck5: [], deck7: [], phrases: {}, phraseDetails: {}, votes: {}, revealedPhrases: {}, selfPraise: {}, redraws: {}
    });
    
    alert(alertMessage);
  } catch (e) {
    console.error(e);
    alert('エラーが発生しました: ' + e.message);
  } finally {
    state.isProcessingNextRound = false;
  }
};

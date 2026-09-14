import { resultPresentation } from './moon-scale-duel-online-state.js';

const ids = ['entry', 'lobby', 'started'];
export const el = (id) => document.getElementById(id);
const cards = Object.freeze({
  waxing: { name: '満ちる月', type: '回復', effect: '自分の月影を3増やす', image: 'moon-scale-duel/assets/images/cards/moon-full.webp' },
  waning: { name: '欠ける月', type: '攻撃', effect: '相手の月影を3減らす', image: 'moon-scale-duel/assets/images/cards/moon-waning.webp' },
  reflection: { name: '返照の月', type: '反転', effect: 'このラウンドの数値増減を反転する', image: 'moon-scale-duel/assets/images/cards/moon-reflection.webp' },
  stillness: { name: '静止の月', type: '防御', effect: '相手の月札の効果を無効にする', image: 'moon-scale-duel/assets/images/cards/moon-still.webp' },
  falseMoon: { name: '偽りの月', type: '変化', effect: '公開後、未使用の月札の効果を模倣する', image: 'moon-scale-duel/assets/images/cards/moon-false.webp' },
  oath: { name: '新月の誓い', type: '逆転', effect: '公開時に劣勢なら双方の月影を7にする', image: 'moon-scale-duel/assets/images/cards/moon-new-oath.webp' },
});
function hidden(node, value) { node.hidden = value; }
export function show(id) { ids.forEach((item) => hidden(el(item), item !== id)); }
export function status(text) { el('status').textContent = text; }
function escapeHtml(value) { const node = document.createElement('span'); node.textContent = String(value ?? ''); return node.innerHTML; }

export function lobby(snapshot) {
  show('lobby');
  el('shown-code').textContent = snapshot.inviteCode || '参加済み';
  el('members').innerHTML = snapshot.seats.map((seat) => `<li><strong>${seat.seatId === snapshot.you.seatId ? 'あなた' : '対手'}</strong><span>${seat.occupied ? escapeHtml(seat.displayName) : '相手の参加待ち'}</span></li>`).join('');
  const isHost = snapshot.you.role === 'host';
  hidden(el('start-match'), !isHost);
  el('start-match').disabled = snapshot.room.humanCount !== 2;
  el('lobby-note').textContent = isHost
    ? snapshot.room.humanCount === 2 ? '2人揃いました。決闘を開始できます。' : '対手が参加するまでお待ちください。'
    : 'ホストが決闘を始めるまでお待ちください。';
}

function cardHtml(id, selected, disabled) {
  const card = cards[id];
  return `<button class="online-card${selected ? ' selected' : ''}" type="button" data-card-id="${id}" aria-pressed="${selected}" ${disabled ? 'disabled' : ''}><span class="online-card-art"><img src="${card.image}" alt=""></span><strong>${card.name}</strong><span>${card.type}</span><small>${card.effect}</small></button>`;
}

function publicCardHtml(label, id, copyId = null) {
  const card = cards[id];
  const copy = copyId ? `<small>「${cards[copyId].name}」を模倣</small>` : '';
  return `<div class="public-card"><span>${label}</span><span class="public-card-art"><img src="${card.image}" alt=""></span><strong>${card.name}</strong>${copy}</div>`;
}

export function started(snapshot, selectedCardId = null, selectedCopyTarget = null) {
  show('started');
  const opponent = snapshot.seats.find((seat) => seat.seatId !== snapshot.you.seatId);
  el('started-you').textContent = snapshot.you.displayName;
  el('started-opponent').textContent = opponent?.displayName || '対手';
  el('started-state').textContent = `第 ${snapshot.game.round} ラウンド`;
  const yourSeat = snapshot.you.seatId;
  const opponentSeat = yourSeat === 'seat1' ? 'seat2' : 'seat1';
  el('started-you-moon').textContent = `月影 ${snapshot.game.moonShadow[yourSeat]}`;
  el('started-opponent-moon').textContent = `月影 ${snapshot.game.moonShadow[opponentSeat]}`;
  const finalVisible = ['ended', 'aborted'].includes(snapshot.game.phase);
  hidden(el('final-result'), !finalVisible);
  if (finalVisible) renderFinalResult(snapshot, yourSeat);
  const revealed = ['cards-revealed', 'choosing-copy', 'round-result', 'ended', 'aborted'].includes(snapshot.game.phase) && snapshot.game.publicCards;
  hidden(el('selection-area'), Boolean(revealed));
  hidden(el('revealed-area'), !revealed);
  hidden(el('copy-area'), snapshot.game.phase !== 'choosing-copy');
  const resultVisible = ['round-result', 'ended', 'aborted'].includes(snapshot.game.phase);
  hidden(el('round-result'), !resultVisible);
  renderHistory(snapshot.game.history || []);
  if (revealed) {
    el('revealed-cards').innerHTML = publicCardHtml('あなたの札', snapshot.game.publicCards[yourSeat], snapshot.game.publicCopies?.[yourSeat])
      + publicCardHtml('対手の札', snapshot.game.publicCards[opponentSeat], snapshot.game.publicCopies?.[opponentSeat]);
    if (snapshot.game.phase === 'choosing-copy') {
      const targets = snapshot.private?.legalCopyTargets || [];
      const submitted = snapshot.private?.copySubmitted === true;
      el('copy-choices').innerHTML = targets.map((id) => cardHtml(id, id === selectedCopyTarget, submitted)).join('');
      el('submit-copy').disabled = submitted || !selectedCopyTarget;
      el('copy-note').textContent = submitted
        ? '模倣先を伏せました。対手の選択を待っています…'
        : targets.length ? '本人だけに表示された候補から、模倣する効果を選んでください。' : '対手の模倣先選択を待っています…';
      el('stage-note').textContent = '必要な模倣先が揃うまで、相手の選択内容は公開されません。';
    } else if (resultVisible) {
      const result = snapshot.game.roundResult;
      el('round-result-title').textContent = `第${result?.round || snapshot.game.round}ラウンドの結果`;
      el('round-messages').innerHTML = (result?.messages || []).map((text) => `<li>${escapeHtml(text)}</li>`).join('');
      renderNextRoundActions(snapshot);
    } else {
      el('stage-note').textContent = '双方の月札が同時に公開されました。';
    }
    return;
  }
  const submitted = snapshot.private?.submitted === true;
  const available = snapshot.private?.availableCards || [];
  el('online-hand').innerHTML = available.map((id) => cardHtml(id, id === selectedCardId, submitted)).join('');
  el('submit-card').disabled = submitted || !selectedCardId;
  el('selection-note').textContent = submitted
    ? '月札を伏せました。対手の選択を待っています…'
    : selectedCardId ? `「${cards[selectedCardId].name}」を選択中です。` : '未使用の月札から1枚を選んでください。';
  el('stage-note').textContent = '双方が確定するまで、相手の月札は公開されません。';
}

function renderHistory(history) {
  const panel = el('history-panel');
  hidden(panel, history.length === 0);
  el('history-summary').textContent = `決闘の記録（${history.length}）`;
  el('round-history').innerHTML = history.map((item) => `<section><h4>第${item.round}ラウンド</h4><p>${(item.messages || []).map(escapeHtml).join('<br>')}</p><small>月影 ${item.moonShadowBefore.seat1} / ${item.moonShadowBefore.seat2} → ${item.moonShadowAfter.seat1} / ${item.moonShadowAfter.seat2}</small></section>`).join('');
}

function renderNextRoundActions(snapshot) {
  const game = snapshot.game;
  const actions = el('next-round-actions');
  const ended = game.phase === 'ended';
  const aborted = game.phase === 'aborted';
  hidden(actions, ended || aborted);
  if (ended) {
    el('stage-note').textContent = '決闘終了。完成版の最終結果画面は第5段階で実装します。';
    return;
  }
  if (aborted) {
    el('stage-note').textContent = 'この決闘は中断されました。';
    return;
  }
  const yourSeat = snapshot.you.seatId;
  const otherSeat = yourSeat === 'seat1' ? 'seat2' : 'seat1';
  const ready = game.nextRoundReady?.[yourSeat] === true;
  const otherReady = game.nextRoundReady?.[otherSeat] === true;
  hidden(el('ready-next-round'), ready);
  el('ready-next-round').disabled = false;
  const remaining = game.deadlineMillis == null ? null : Math.max(0, game.deadlineMillis - game.serverTimeMillis);
  const expired = ready && !otherReady && remaining === 0;
  hidden(el('expired-wait-actions'), !expired);
  el('next-round-countdown').textContent = ready && !expired && remaining != null
    ? `準備待ち期限まで約${Math.ceil(remaining / 1000)}秒` : '';
  el('next-round-note').textContent = ready ? '対手の準備を待っています…' : '双方が準備すると次のラウンドへ進みます。';
  el('stage-note').textContent = '前ラウンドの結果を確認し、準備ができたら次へ進んでください。';
}

function renderFinalResult(snapshot, yourSeat) {
  const game = snapshot.game;
  const presentation = resultPresentation(game, yourSeat);
  const aborted = presentation.kind === 'aborted';
  const art = el('final-result-art');
  const image = el('final-result-image');
  hidden(el('rematch-actions'), false);
  el('final-result-title').textContent = presentation.title;
  el('final-result-reason').textContent = presentation.reason;
  el('final-result-score').textContent = presentation.score;
  if (aborted) {
    hidden(art, true);
    image.removeAttribute('src');
    image.alt = '';
    hidden(el('request-rematch'), true);
    hidden(el('rematch-note'), true);
    el('stage-note').textContent = '対戦中断は、勝利・敗北・引き分けとは別の結果です。';
    return;
  }
  image.src = presentation.image.src;
  image.alt = presentation.image.alt;
  hidden(art, false);
  const requested = game.rematchReady?.[yourSeat] === true;
  hidden(el('rematch-note'), false);
  hidden(el('request-rematch'), requested);
  el('request-rematch').disabled = false;
  el('rematch-note').textContent = requested ? '対手の再戦希望を待っています…' : '双方が希望すると、同じ2人で新しい決闘を始めます。';
  el('stage-note').textContent = '決闘が終了しました。';
}

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
  const revealed = ['cards-revealed', 'choosing-copy', 'round-result'].includes(snapshot.game.phase) && snapshot.game.publicCards;
  hidden(el('selection-area'), Boolean(revealed));
  hidden(el('revealed-area'), !revealed);
  hidden(el('copy-area'), snapshot.game.phase !== 'choosing-copy');
  hidden(el('round-result'), snapshot.game.phase !== 'round-result');
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
    } else if (snapshot.game.phase === 'round-result') {
      el('round-messages').innerHTML = snapshot.game.roundResult.messages.map((text) => `<li>${escapeHtml(text)}</li>`).join('');
      el('stage-note').textContent = snapshot.game.roundResult.outcome
        ? '決着判定まで完了しました。最終結果画面は後の段階で実装します。'
        : '第1ラウンドの解決が完了しました。第2ラウンドへの遷移は第4段階で実装します。';
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

export const state = {
  uid: null,
  roomId: null,
  snapshot: null,
  selectedCardId: null,
  selectedCopyTarget: null,
  pendingRequestIds: new Map(),
};

export function requestIdFor(action) {
  if (!state.pendingRequestIds.has(action)) state.pendingRequestIds.set(action, crypto.randomUUID());
  return state.pendingRequestIds.get(action);
}

export function finishRequest(action) {
  state.pendingRequestIds.delete(action);
}

const resultImages = Object.freeze({
  win: { src: 'moon-scale-duel/assets/images/results/result-victory.webp', alt: '雲が左右へ開き、中央の大きな月から月光が広がる夜空' },
  lose: { src: 'moon-scale-duel/assets/images/results/result-defeat.webp', alt: '丸い月が雲に部分的に覆われ、月光が静かに退く夜空' },
  draw: { src: 'moon-scale-duel/assets/images/results/result-draw.webp', alt: '小さな月と左右に均衡した雲、水平の銀色の光が広がる夜空' },
});

export function resultPresentation(game, yourSeat) {
  const opponentSeat = yourSeat === 'seat1' ? 'seat2' : 'seat1';
  if (game?.phase === 'aborted' || game?.result?.type === 'aborted') {
    return {
      kind: 'aborted',
      title: '対戦中断',
      reason: game?.result?.reason === 'next-round-timeout'
        ? '次ラウンドの準備待ち期限後に、この決闘は中断されました。'
        : 'この決闘は中断されました。',
      score: `中断時の月影　あなた ${game?.moonShadow?.[yourSeat]} ／ 対手 ${game?.moonShadow?.[opponentSeat]}`,
      image: null,
    };
  }
  const outcome = game?.result?.outcome;
  const kind = outcome === 'draw' ? 'draw' : outcome === yourSeat ? 'win' : 'lose';
  const yourMoon = game?.result?.moonShadow?.[yourSeat] ?? game?.moonShadow?.[yourSeat];
  const opponentMoon = game?.result?.moonShadow?.[opponentSeat] ?? game?.moonShadow?.[opponentSeat];
  let reason;
  if (yourMoon === 0 && opponentMoon === 0) reason = '双方の月影が尽きました。決闘は引き分けです。';
  else if (opponentMoon === 0) reason = '対手の月影が尽きました。あなたの勝利です。';
  else if (yourMoon === 0) reason = 'あなたの月影が尽きました。今回は対手の勝利です。';
  else if (kind === 'win') reason = '6ラウンド終了時、あなたの月影が多いため勝利です。';
  else if (kind === 'lose') reason = '6ラウンド終了時、対手の月影が多いため敗北です。';
  else reason = '6ラウンド終了時、月影が同じため決闘は引き分けです。';
  return {
    kind,
    title: kind === 'win' ? '勝利' : kind === 'lose' ? '敗北' : '引き分け',
    reason,
    score: `最終月影　あなた ${yourMoon} ／ 対手 ${opponentMoon}`,
    image: resultImages[kind],
  };
}

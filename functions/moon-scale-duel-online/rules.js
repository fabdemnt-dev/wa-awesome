'use strict';

const MAX_MOON = 15;
const COPYABLE = Object.freeze(['waxing', 'waning', 'reflection', 'oath']);
const SEATS = Object.freeze(['seat1', 'seat2']);
const CARD_NAMES = Object.freeze({ waxing: '満ちる月', waning: '欠ける月', reflection: '返照の月', stillness: '静止の月', falseMoon: '偽りの月', oath: '新月の誓い' });

function otherSeat(seatId) { return seatId === 'seat1' ? 'seat2' : 'seat1'; }
function clampMoon(value) { return Math.max(0, Math.min(MAX_MOON, value)); }
function oathIsValid(seatId, moonShadow) {
  return Number(moonShadow[seatId]) < Number(moonShadow[otherSeat(seatId)]);
}

function copyCandidates(seatId, moonShadow, usedCards) {
  const used = new Set(Array.isArray(usedCards?.[seatId]) ? usedCards[seatId] : []);
  return COPYABLE.filter((cardId) => !used.has(cardId) && (cardId !== 'oath' || oathIsValid(seatId, moonShadow)));
}

function prepareCopyState({ actualCards, moonShadow, usedCards }) {
  const blocked = {
    seat1: actualCards.seat1 === 'falseMoon' && actualCards.seat2 === 'stillness',
    seat2: actualCards.seat2 === 'falseMoon' && actualCards.seat1 === 'stillness',
  };
  const candidates = { seat1: [], seat2: [] };
  const status = { seat1: null, seat2: null };
  for (const seatId of SEATS) {
    if (actualCards[seatId] !== 'falseMoon') continue;
    if (blocked[seatId]) {
      status[seatId] = 'blocked';
      continue;
    }
    candidates[seatId] = copyCandidates(seatId, moonShadow, usedCards);
    status[seatId] = candidates[seatId].length ? 'awaiting' : 'failed';
  }
  return { candidates, status };
}

function resolveRound({ round, moonShadow, actualCards, copyTargets = {}, falseStatus = {} }) {
  const before = { seat1: Number(moonShadow.seat1), seat2: Number(moonShadow.seat2) };
  const effectiveCards = {
    seat1: actualCards.seat1 === 'falseMoon' ? copyTargets.seat1 || null : actualCards.seat1,
    seat2: actualCards.seat2 === 'falseMoon' ? copyTargets.seat2 || null : actualCards.seat2,
  };
  const bothStill = actualCards.seat1 === 'stillness' && actualCards.seat2 === 'stillness';
  const blocked = {
    seat1: !bothStill && actualCards.seat2 === 'stillness',
    seat2: !bothStill && actualCards.seat1 === 'stillness',
  };
  const validOath = {
    seat1: effectiveCards.seat1 === 'oath' && oathIsValid('seat1', before),
    seat2: effectiveCards.seat2 === 'oath' && oathIsValid('seat2', before),
  };
  const reflectionCount = SEATS.filter((seatId) => effectiveCards[seatId] === 'reflection' && !blocked[seatId]).length;
  const reversed = reflectionCount === 1;
  const base = { ...before };
  if ((validOath.seat1 && !blocked.seat1) || (validOath.seat2 && !blocked.seat2)) {
    base.seat1 = 7;
    base.seat2 = 7;
  }
  const delta = { seat1: 0, seat2: 0 };
  for (const seatId of SEATS) {
    if (blocked[seatId]) continue;
    const sign = reversed ? -1 : 1;
    if (effectiveCards[seatId] === 'waxing') delta[seatId] += 3 * sign;
    if (effectiveCards[seatId] === 'waning') delta[otherSeat(seatId)] -= 3 * sign;
  }
  const after = {
    seat1: clampMoon(base.seat1 + delta.seat1),
    seat2: clampMoon(base.seat2 + delta.seat2),
  };
  let outcome = null;
  if (after.seat1 === 0 && after.seat2 === 0) outcome = 'draw';
  else if (after.seat2 === 0) outcome = 'seat1';
  else if (after.seat1 === 0) outcome = 'seat2';
  else if (round === 6) outcome = after.seat1 === after.seat2 ? 'draw' : after.seat1 > after.seat2 ? 'seat1' : 'seat2';

  const effects = {};
  for (const seatId of SEATS) {
    let status = blocked[seatId] ? 'blocked' : 'resolved';
    if (actualCards[seatId] === 'falseMoon') status = falseStatus[seatId] || (copyTargets[seatId] ? 'copied' : 'failed');
    else if (effectiveCards[seatId] === 'oath' && !validOath[seatId] && !blocked[seatId]) status = 'failed';
    effects[seatId] = {
      actualCardId: actualCards[seatId],
      effectiveCardId: effectiveCards[seatId],
      copyTargetId: copyTargets[seatId] || null,
      status,
    };
  }
  const messages = [];
  if (bothStill) messages.push('互いの「静止の月」は無効化し合った。');
  else for (const seatId of SEATS) if (blocked[seatId] && actualCards[seatId] !== 'falseMoon') messages.push(`${seatId === 'seat1' ? '先手' : '後手'}の月札は「静止の月」により無効化された。`);
  for (const seatId of SEATS) {
    if (actualCards[seatId] === 'falseMoon' && falseStatus[seatId] === 'blocked') messages.push(`${seatId === 'seat1' ? '先手' : '後手'}の「偽りの月」は「静止の月」により無効化された。`);
    if (actualCards[seatId] === 'falseMoon' && falseStatus[seatId] === 'failed') messages.push(`${seatId === 'seat1' ? '先手' : '後手'}の「偽りの月」は模倣先がなく不発となった。`);
    if (copyTargets[seatId]) messages.push(`${seatId === 'seat1' ? '先手' : '後手'}の「偽りの月」は「${CARD_NAMES[copyTargets[seatId]]}」を映した。`);
    if (effectiveCards[seatId] === 'oath' && !validOath[seatId] && !blocked[seatId]) messages.push(`${seatId === 'seat1' ? '先手' : '後手'}の「新月の誓い」は結ばれなかった。`);
  }
  if (reflectionCount === 2) messages.push('二つの「返照の月」は相殺され、増減は通常どおりとなった。');
  else if (reversed) messages.push('「返照の月」が月影の増減を反転した。');
  if ((validOath.seat1 && !blocked.seat1) || (validOath.seat2 && !blocked.seat2)) messages.push('「新月の誓い」により、双方の月影は7になった。');
  if (delta.seat1 || delta.seat2) messages.push(`月影は、先手 ${before.seat1} → ${after.seat1}、後手 ${before.seat2} → ${after.seat2} となった。`);
  else if (base.seat1 === before.seat1 && base.seat2 === before.seat2) messages.push('このラウンドでは月影は変わらなかった。');

  return {
    round,
    actualCards: { ...actualCards },
    effectiveCards,
    copyTargets: { seat1: copyTargets.seat1 || null, seat2: copyTargets.seat2 || null },
    effects,
    reflectionCount,
    reversed,
    moonShadowBefore: before,
    moonShadowAfter: after,
    outcome,
    messages,
  };
}

module.exports = { MAX_MOON, COPYABLE, SEATS, CARD_NAMES, clampMoon, oathIsValid, copyCandidates, prepareCopyState, resolveRound };

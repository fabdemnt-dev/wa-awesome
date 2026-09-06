'use strict';

const crypto = require('node:crypto');

const CARDS = Object.freeze({
  breakthrough: { id: 'breakthrough', name: '突破', type: 'offense', baseValue: 4 },
  'all-out': { id: 'all-out', name: '全力', type: 'offense', baseValue: 6 },
  assist: { id: 'assist', name: '援護', type: 'support', baseValue: 2 },
  defense: { id: 'defense', name: '守勢', type: 'support', baseValue: 3 },
  check: { id: 'check', name: 'けん制', type: 'interference', baseValue: 3 },
  disrupt: { id: 'disrupt', name: '崩し', type: 'interference', baseValue: 2 },
  shift: { id: 'shift', name: '変転', type: 'disruption', baseValue: null },
  misdirect: { id: 'misdirect', name: '誘導', type: 'disruption', baseValue: 1 },
});

const CARD_IDS = Object.freeze(Object.keys(CARDS));
const FIELDS = Object.freeze([
  { id: 'skirmish', name: '小競り合い', points: 1 },
  { id: 'negotiation', name: '交渉', points: 2 },
  { id: 'showdown', name: '決戦', points: 3 },
]);
const PRIORITIES = Object.freeze({
  support: { breakthrough: 5, 'all-out': 2, assist: 10, defense: 9, check: 6, disrupt: 4, shift: 1, misdirect: 7 },
  aggressive: { breakthrough: 8, 'all-out': 10, assist: 2, defense: 1, check: 6, disrupt: 7, shift: 5, misdirect: 3 },
  bluff: { breakthrough: 5, 'all-out': 4, assist: 3, defense: 2, check: 7, disrupt: 6, shift: 10, misdirect: 8 },
});

function randomInt(max) {
  return crypto.randomInt(0, max);
}

function randomCardId() {
  return CARD_IDS[randomInt(CARD_IDS.length)];
}

function dealHand() {
  return Array.from({ length: 4 }, randomCardId);
}

function chooseField() {
  return { ...FIELDS[randomInt(FIELDS.length)] };
}

function defaultRandom() { return randomInt(0x1000000) / 0x1000000; }
function randomInteger(min, max, random) { return Math.floor(random() * (max - min + 1)) + min; }
function situationModifier(role, cardId, c) {
  const decisive = c.fieldPoints === 3, negotiation = c.fieldPoints === 2;
  const trailing = c.ownScore < c.opposingScore, trailingTwo = c.opposingScore - c.ownScore >= 2, leading = c.ownScore > c.opposingScore;
  const oneOf = (...ids) => ids.includes(cardId); const enemyRole = id => c.opponentNpcIds.includes(id); let m = 0;
  if (decisive && role === 'support' && oneOf('assist','breakthrough')) m += 2;
  if (decisive && role === 'aggressive' && oneOf('all-out','breakthrough')) m += 4;
  if (decisive && role === 'bluff' && oneOf('shift','all-out','misdirect')) m += 3;
  if (negotiation && role === 'aggressive' && oneOf('all-out','breakthrough','disrupt')) m += 2;
  if (trailing && role === 'support' && oneOf('check','misdirect','breakthrough')) m += 2;
  if (trailing && role === 'aggressive' && oneOf('all-out','breakthrough')) m += 3;
  if (trailingTwo && role === 'aggressive' && cardId === 'all-out') m += 2;
  if (trailing && role === 'bluff' && oneOf('shift','misdirect','check','disrupt')) m += 2;
  if (leading && role === 'support' && cardId === 'defense') m += 3;
  if (leading && role === 'bluff' && oneOf('check','defense')) m += 2;
  if (c.side === 'ally' && role === 'support' && cardId === 'assist') { if ((c.playerTypeCounts.offense || 0) >= 1) m += 3; if ((c.playerTypeCounts.offense || 0) >= 2) m += 2; }
  if (role === 'support' && cardId === 'defense' && enemyRole('aggressive')) m += 2;
  if (role === 'support' && cardId === 'defense' && c.opponentPreviousInterferenceCount >= 2) m += 2;
  if (role === 'aggressive' && oneOf('disrupt','check') && enemyRole('support')) m += 2;
  if (role === 'bluff' && cardId === 'shift' && c.previousCardId === 'shift') m -= 4;
  if (role === 'bluff' && c.previousCardId && cardId === c.previousCardId) m -= 3;
  if (role === 'bluff' && oneOf('check','disrupt') && enemyRole('aggressive')) m += 2;
  if (c.currentPenalty > 0 && role === 'support' && oneOf('assist','defense','check')) m += 1;
  return m;
}
function normalizeNpcContext(context = {}) {
  return { side: context.side === 'ally' ? 'ally' : 'enemy', fieldPoints: Number(context.fieldPoints)||0, ownScore:Number(context.ownScore)||0, opposingScore:Number(context.opposingScore)||0, opponentNpcIds:Array.isArray(context.opponentNpcIds)?context.opponentNpcIds:[], currentPenalty:context.currentPenalty>0?1:0, opponentPreviousInterferenceCount:Math.max(0,Number(context.opponentPreviousInterferenceCount)||0), previousCardId:CARDS[context.previousCardId]?context.previousCardId:null, playerTypeCounts:{offense:0,support:0,interference:0,disruption:0,...context.playerTypeCounts} };
}
function evaluateNpcHand(hand, role, context, random = defaultRandom) {
  const spread = role === 'bluff' ? 2 : 1, c = normalizeNpcContext(context);
  return hand.map((cardId, index) => ({ index, score: Math.max(0, PRIORITIES[role][cardId] + situationModifier(role, cardId, c) + randomInteger(-spread, spread, random)) }));
}
function randomHighest(candidates, random) { const max=Math.max(...candidates.map(x=>x.score)); const tied=candidates.filter(x=>x.score===max); return tied[Math.floor(random()*tied.length)]; }
function chooseNpcCard(hand, role, context = {}, random = defaultRandom) {
  const scored=evaluateNpcHand(hand,role,context,random); const first=randomHighest(scored,random); const second=randomHighest(scored.filter(x=>x.index!==first.index),random); return (random()<0.7?first:second).index;
}

function resolveCard(cardId) {
  const card = CARDS[cardId];
  return {
    cardId,
    name: card.name,
    type: card.type,
    resolvedBaseValue: cardId === 'shift' ? (randomInt(2) === 0 ? 2 : 5) : card.baseValue,
  };
}

function calculateTeam(ownCards, enemyCards, incomingReduction, appliedPenalty) {
  const ownTypes = ownCards.map((card) => card.type);
  const enemyTypes = enemyCards.map((card) => card.type);
  const baseValueTotal = ownCards.reduce((sum, card) => sum + card.resolvedBaseValue, 0);
  const assist = ownCards.reduce((sum, card, index) => (
    card.cardId === 'assist' && ownTypes[1 - index] === 'offense' ? sum + 3 : sum
  ), 0);
  const misdirect = ownCards.reduce((sum, card) => (
    card.cardId === 'misdirect' && enemyTypes.includes('interference') ? sum + 3 : sum
  ), 0);
  const defenseReduction = ownCards.filter((card) => card.cardId === 'defense').length;
  const effectiveReduction = Math.max(0, incomingReduction.total - defenseReduction);
  return {
    baseValueTotal,
    additions: { assist, misdirect, total: assist + misdirect },
    incomingReduction,
    defenseReduction,
    effectiveReduction,
    appliedPenalty,
    finalValue: Math.max(0, baseValueTotal + assist + misdirect - effectiveReduction - appliedPenalty),
  };
}

function reductionsFrom(cards, enemyCards) {
  const enemyHasOffense = enemyCards.some((card) => card.type === 'offense');
  const check = cards.filter((card) => card.cardId === 'check').length;
  const disrupt = cards.reduce((sum, card) => card.cardId === 'disrupt' ? sum + (enemyHasOffense ? 2 : 1) : sum, 0);
  return { check, disrupt, total: check + disrupt };
}

function resolveRound({ hands, choices, penalties, roundNumber, field }) {
  const played = {};
  Object.keys(hands).forEach((seatId) => {
    played[seatId] = resolveCard(hands[seatId][choices[seatId].handIndex]);
  });
  const teamA = [played.seat0, played.seat1];
  const teamB = [played.seat2, played.seat3];
  const reductionToB = reductionsFrom(teamA, teamB);
  const reductionToA = reductionsFrom(teamB, teamA);
  const calculationA = calculateTeam(teamA, teamB, reductionToA, penalties.A || 0);
  const calculationB = calculateTeam(teamB, teamA, reductionToB, penalties.B || 0);
  const outcome = calculationA.finalValue === calculationB.finalValue
    ? 'draw'
    : calculationA.finalValue > calculationB.finalValue ? 'A' : 'B';
  const nextPenalties = { A: 0, B: 0 };
  if (roundNumber < 5 && outcome !== 'draw') {
    const losingCards = outcome === 'A' ? teamB : teamA;
    const losingTeam = outcome === 'A' ? 'B' : 'A';
    if (losingCards.some((card) => card.cardId === 'all-out')) nextPenalties[losingTeam] = 1;
  }
  return { played, calculation: { A: calculationA, B: calculationB }, outcome, field, nextPenalties };
}

module.exports = { CARDS, CARD_IDS, FIELDS, dealHand, chooseField, evaluateNpcHand, chooseNpcCard, resolveRound };

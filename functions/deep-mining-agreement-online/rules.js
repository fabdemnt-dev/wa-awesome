'use strict';

const CONFIG = Object.freeze({ totalRounds: 8, startingDanger: 20, collapseDanger: 100, reinforceReduction: 12, maxAccusations: 2, maxScouts: 2, secretUnlockRound: 3, retreatUnlockRound: 5, collapsePublicLoss: [0.5, 0.4, 0.3, 0.2], secretLossReduction: 0.1 });
const ORES = Object.freeze({ iron: { value: 1, danger: 7 }, azure: { value: 2, danger: 10 }, gold: { value: 3, danger: 13 } });
const ACTIONS = new Set(['mine', 'reinforce', 'secret', 'retreat']);
const emptyBag = () => ({ iron: 0, azure: 0, gold: 0 });
const oreCount = (bag) => Object.values(bag).reduce((sum, count) => sum + count, 0);
const oreValue = (bag) => Object.entries(bag).reduce((sum, [id, count]) => sum + ORES[id].value * count, 0);
const totalValue = (player) => oreValue(player.publicOre) + oreValue(player.secretOre) + oreValue(player.vaultOre) - player.discredit;

function rng(seed) { let value = seed >>> 0; return () => { value += 0x6D2B79F5; let next = value; next = Math.imul(next ^ (next >>> 15), next | 1); next ^= next + Math.imul(next ^ (next >>> 7), next | 61); return ((next ^ (next >>> 14)) >>> 0) / 4294967296; }; }
function oreSequence(seed) {
  const random = rng(seed); const ids = Object.keys(ORES);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const counts = attempt % 3 === 0 ? { iron: 3, azure: 3, gold: 2 } : attempt % 3 === 1 ? { iron: 3, azure: 2, gold: 3 } : { iron: 2, azure: 3, gold: 3 };
    const pool = ids.flatMap((id) => Array(counts[id]).fill(id)); const result = [];
    while (pool.length) { const allowed = pool.map((id, index) => ({ id, index })).filter(({ id }) => result.length < 2 || result.at(-1) !== id || result.at(-2) !== id); if (!allowed.length) break; const pick = allowed[Math.floor(random() * allowed.length)]; result.push(pick.id); pool.splice(pick.index, 1); }
    if (result.length === CONFIG.totalRounds) return result;
  }
  return ['iron', 'azure', 'gold', 'iron', 'azure', 'gold', 'iron', 'azure'];
}
function createPlayer(id, name) { return { id, name, active: true, retreated: false, publicOre: emptyBag(), secretOre: emptyBag(), vaultOre: emptyBag(), reinforcement: 0, accusationsUsed: 0, scoutsUsed: 0, discredit: 0, secretActions: 0, accusationSuccesses: 0, accusationFailures: 0, collapseLoss: 0, scoutedRound: null, scoutedOre: null }; }
function createGame(members, seed = Date.now()) { const players = members.map(({ seatId, displayName }) => createPlayer(seatId, displayName)); return { seed, round: 1, danger: CONFIG.startingDanger, oreSequence: oreSequence(seed), players, vault: [], detectedSecretMining: false, suspicion: Object.fromEntries(players.map(({ id }) => [id, 0])), history: [], submissions: {}, ended: false, endReason: null, collapsed: false, finalised: false }; }
function availability(game, player, action) { return player.active && ACTIONS.has(action) && (action !== 'secret' || game.round >= 3) && (action !== 'retreat' || game.round >= 5); }
function canScout(game, player) { return player.active && game.round < 8 && player.scoutsUsed < 2; }
function canAccuse(game, player) { return player.active && game.round >= 3 && game.detectedSecretMining && player.accusationsUsed < 2; }
function removeSecret(player) { const id = Object.keys(ORES).sort((a, b) => ORES[b].value - ORES[a].value).find((key) => player.secretOre[key] > 0); if (id) player.secretOre[id] -= 1; return id || null; }
function lose(bag, rate) { let remaining = Math.floor(oreCount(bag) * rate + 1e-9); let value = 0; for (const id of Object.keys(ORES).sort((a, b) => ORES[b].value - ORES[a].value)) { const count = Math.min(bag[id], remaining); bag[id] -= count; value += count * ORES[id].value; remaining -= count; } return value; }
function finish(game) { if (game.finalised) return; const eligible = game.players.filter((p) => p.reinforcement > 0); const random = rng((game.seed ^ 0xA5A5A5A5) >>> 0); while (game.vault.length && eligible.length) { const order = [...eligible].sort((a, b) => b.reinforcement - a.reinforcement || random() - 0.5); for (const player of order) { const id = game.vault.shift(); if (!id) break; player.vaultOre[id] += 1; } } const ranked = [...game.players].sort((a, b) => totalValue(b) - totalValue(a)); let rank = 0; let previous = null; ranked.forEach((player, index) => { const value = totalValue(player); if (value !== previous) rank = index + 1; player.rank = rank; previous = value; }); game.ended = true; game.finalised = true; game.submissions = {}; }
function validateSubmission(game, seatId, input) { const player = game.players.find((p) => p.id === seatId); if (!player || !player.active) throw new Error('この席は行動できません。'); if (!availability(game, player, input.action)) throw new Error('この行動は現在選べません。'); if (input.scout && !canScout(game, player)) throw new Error('偵察は現在使えません。'); if (input.accusationTarget) { const target = game.players.find((p) => p.id === input.accusationTarget); if (!canAccuse(game, player) || !target?.active || target.id === seatId) throw new Error('告発対象が不正です。'); } }
function resolveRound(game) {
  const oreId = game.oreSequence[game.round - 1]; const before = game.danger; let added = 0; let reduced = 0; let secretCount = 0; const publicActions = {}; const accusationResults = [];
  for (const player of game.players) { if (!player.active) continue; const input = game.submissions[player.id]; if (!input) throw new Error('全員の行動が揃っていません。'); const action = input.action; publicActions[player.id] = action === 'secret' ? 'mine' : action; if (action === 'mine') { player.publicOre[oreId] += 2; added += ORES[oreId].danger; } else if (action === 'secret') { player.publicOre[oreId] += 1; player.secretOre[oreId] += 1; player.secretActions += 1; game.suspicion[player.id] += 1; added += ORES[oreId].danger; secretCount += 1; } else if (action === 'reinforce') { player.reinforcement += 1; reduced += CONFIG.reinforceReduction; } }
  for (const player of game.players) { const input = game.submissions[player.id]; if (!player.active || !input) continue; if (input.scout) { player.scoutsUsed += 1; player.scoutedRound = game.round + 1; player.scoutedOre = game.oreSequence[game.round] || null; } if (input.accusationTarget) { player.accusationsUsed += 1; const target = game.players.find((p) => p.id === input.accusationTarget); const stolen = removeSecret(target); if (stolen) { game.vault.push(stolen); player.accusationSuccesses += 1; game.suspicion[target.id] = Math.max(0, game.suspicion[target.id] - 2); } else { player.discredit += 1; player.accusationFailures += 1; } accusationResults.push({ accuserId: player.id, targetId: target.id, success: Boolean(stolen) }); } }
  for (const player of game.players) if (player.active && game.submissions[player.id].action === 'retreat') { player.active = false; player.retreated = true; }
  if (secretCount) game.detectedSecretMining = true; game.danger = Math.max(0, game.danger + added - reduced);
  game.history.push({ round: game.round, oreId, publicActions, submittedSeatIds: Object.keys(game.submissions), accusationResults, secretCount, dangerBefore: before, dangerAdded: added, dangerReduced: reduced, dangerAfter: game.danger });
  game.submissions = {};
  if (game.danger >= 100) { game.collapsed = true; game.endReason = 'collapse'; for (const player of game.players.filter((p) => p.active)) player.collapseLoss = lose(player.publicOre, CONFIG.collapsePublicLoss[Math.min(player.reinforcement, 3)]) + lose(player.secretOre, Math.max(0, CONFIG.collapsePublicLoss[Math.min(player.reinforcement, 3)] - 0.1)); }
  else if (game.players.every((p) => !p.active)) game.endReason = 'all-retreated'; else if (game.round >= 8) game.endReason = 'rounds';
  if (game.endReason) finish(game); else game.round += 1;
  return game;
}

module.exports = { CONFIG, ORES, createGame, validateSubmission, resolveRound, totalValue };

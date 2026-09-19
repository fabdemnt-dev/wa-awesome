export const CONFIG = Object.freeze({
  totalRounds: 8,
  startingDanger: 20,
  collapseDanger: 100,
  reinforceReduction: 12,
  maxAccusations: 2,
  maxScouts: 2,
  secretUnlockRound: 3,
  retreatUnlockRound: 5,
  oreSequenceCounts: Object.freeze([2, 3]),
  collapsePublicLoss: Object.freeze([0.5, 0.4, 0.3, 0.2]),
  secretLossReduction: 0.1,
});

export const ORES = Object.freeze({
  iron: Object.freeze({ id: "iron", name: "鉄晶", value: 1, danger: 7, level: "低", icon: "◇" }),
  azure: Object.freeze({ id: "azure", name: "蒼晶", value: 2, danger: 10, level: "中", icon: "◆" }),
  gold: Object.freeze({ id: "gold", name: "金晶", value: 3, danger: 13, level: "高", icon: "✦" }),
});

export const ACTIONS = Object.freeze({
  mine: Object.freeze({ id: "mine", label: "採掘", icon: "⛏️" }),
  reinforce: Object.freeze({ id: "reinforce", label: "補強", icon: "🛠️" }),
  scout: Object.freeze({ id: "scout", label: "偵察", icon: "🔭" }),
  secret: Object.freeze({ id: "secret", label: "隠匿採掘", icon: "🤫" }),
  retreat: Object.freeze({ id: "retreat", label: "撤退", icon: "🚪" }),
});

export const NPC_PROFILES = Object.freeze({
  safety: Object.freeze({ id: "safety", name: "ミナト", role: "坑道整備士" }),
  greedy: Object.freeze({ id: "greedy", name: "ガク", role: "採掘師" }),
  tactician: Object.freeze({ id: "tactician", name: "シオン", role: "鉱脈調査員" }),
});

export function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

export function weightedChoice(weights, rng = Math.random) {
  const entries = Object.entries(weights).filter(([, weight]) => weight > 0);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let cursor = rng() * total;
  for (const [id, weight] of entries) {
    cursor -= weight;
    if (cursor <= 0) return id;
  }
  return entries.at(-1)?.[0] ?? "mine";
}

export function generateOreSequence(rng = Math.random) {
  const ids = Object.keys(ORES);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const counts = attempt % 3 === 0
      ? { iron: 3, azure: 3, gold: 2 }
      : attempt % 3 === 1
        ? { iron: 3, azure: 2, gold: 3 }
        : { iron: 2, azure: 3, gold: 3 };
    const pool = ids.flatMap((id) => Array.from({ length: counts[id] }, () => id));
    const sequence = [];
    while (pool.length) {
      const allowed = pool.map((id, index) => ({ id, index })).filter(({ id }) =>
        sequence.length < 2 || sequence.at(-1) !== id || sequence.at(-2) !== id,
      );
      if (!allowed.length) break;
      const chosen = allowed[Math.floor(rng() * allowed.length)];
      sequence.push(chosen.id);
      pool.splice(chosen.index, 1);
    }
    if (sequence.length === CONFIG.totalRounds) return sequence;
  }
  return ["iron", "azure", "gold", "iron", "azure", "gold", "iron", "azure"];
}

export function emptyOreBag() {
  return { iron: 0, azure: 0, gold: 0 };
}

export function oreCount(bag) {
  return Object.values(bag).reduce((sum, count) => sum + count, 0);
}

export function oreValue(bag) {
  return Object.entries(bag).reduce((sum, [id, count]) => sum + ORES[id].value * count, 0);
}

export function totalValue(player) {
  return oreValue(player.publicOre) + oreValue(player.secretOre) + oreValue(player.vaultOre) - player.discredit;
}

export function createPlayer({ id, name, role = null, isHuman = false, profile = null }) {
  return {
    id,
    name,
    role,
    isHuman,
    profile,
    active: true,
    retreated: false,
    publicOre: emptyOreBag(),
    secretOre: emptyOreBag(),
    vaultOre: emptyOreBag(),
    reinforcement: 0,
    accusationsUsed: 0,
    scoutsUsed: 0,
    discredit: 0,
    secretActions: 0,
    accusationSuccesses: 0,
    accusationFailures: 0,
    collapseLoss: 0,
    scoutedRound: null,
    scoutedOre: null,
  };
}

export function createGame({ seed = Date.now(), oreSequence = null, players = null } = {}) {
  const rng = mulberry32(Number(seed) || 1);
  return {
    seed,
    round: 1,
    danger: CONFIG.startingDanger,
    oreSequence: oreSequence ? [...oreSequence] : generateOreSequence(rng),
    players: players ? players.map((player) => createPlayer(player)) : [
      createPlayer({ id: "human", name: "あなた", isHuman: true }),
      createPlayer({ id: "safety", ...NPC_PROFILES.safety, profile: "safety" }),
      createPlayer({ id: "greedy", ...NPC_PROFILES.greedy, profile: "greedy" }),
      createPlayer({ id: "tactician", ...NPC_PROFILES.tactician, profile: "tactician" }),
    ],
    vault: [],
    detectedSecretMining: false,
    suspicion: Object.fromEntries((players || [
      { id: "human" }, { id: "safety" }, { id: "greedy" }, { id: "tactician" },
    ]).map(({ id }) => [id, 0])),
    history: [],
    ended: false,
    endReason: null,
    collapsed: false,
    finalised: false,
    rng,
  };
}

export function actionAvailability(state, player) {
  return {
    mine: player.active,
    reinforce: player.active,
    secret: player.active && state.round >= CONFIG.secretUnlockRound,
    retreat: player.active && state.round >= CONFIG.retreatUnlockRound,
  };
}

export function canScout(state, player) {
  return player.active && state.round < CONFIG.totalRounds && player.scoutsUsed < CONFIG.maxScouts;
}

export function publicOreBand(player) {
  const count = oreCount(player.publicOre);
  if (count <= 2) return "少なめ";
  if (count <= 5) return "中くらい";
  if (count <= 8) return "多め";
  return "かなり多い";
}

export function dangerLabel(danger) {
  if (danger < 40) return "安全";
  if (danger < 60) return "注意";
  if (danger < 80) return "危険";
  if (danger < 100) return "崩落寸前";
  return "崩落";
}

export function npcWeights(state, player) {
  const oreId = state.oreSequence[state.round - 1];
  const value = totalValue(player);
  const highDanger = state.danger >= 72;
  const weights = { mine: 45, reinforce: 20, secret: state.round >= 3 ? 8 : 0, retreat: state.round >= 5 ? 5 : 0 };

  if (player.profile === "safety") {
    weights.reinforce += state.danger >= 55 ? 55 : 18;
    weights.mine -= highDanger ? 25 : 5;
    weights.secret = state.round >= 3 ? 3 : 0;
    if (state.round >= 5 && (value >= 11 || state.danger >= 83)) weights.retreat += 48;
  }
  if (player.profile === "greedy") {
    weights.mine += oreId === "gold" ? 55 : 22;
    weights.reinforce = highDanger ? 14 : 5;
    weights.secret += state.round >= CONFIG.secretUnlockRound ? (oreId === "gold" ? 15 : 4) : 0;
    if (state.round >= 7 && value >= 16) weights.retreat += 15;
  }
  if (player.profile === "tactician") {
    weights.reinforce += state.round <= 2 ? 28 : 5;
    weights.secret += state.round >= 3 ? 30 : 0;
    if (state.round >= 5 && (state.danger >= 86 || value >= 16)) weights.retreat += 32;
  }
  return Object.fromEntries(Object.entries(weights).map(([id, weight]) => [id, Math.max(0, weight)]));
}

export function chooseNpcAction(state, player, rng = state.rng) {
  if (!player.active) return null;
  const availability = actionAvailability(state, player);
  const availableWeights = Object.fromEntries(
    Object.entries(npcWeights(state, player)).map(([id, weight]) => [id, availability[id] ? weight : 0]),
  );
  return weightedChoice(availableWeights, rng);
}

export function chooseNpcScout(state, player, rng = null) {
  if (!canScout(state, player)) return false;
  const chance = player.profile === "tactician" ? 0.24 : player.profile === "safety" ? 0.12 : 0.08;
  const situationBonus = state.round <= 3 || state.danger < 45 ? 0.04 : 0;
  if (rng) return rng() < chance + situationBonus;
  const playerIndex = state.players.findIndex(({ id }) => id === player.id) + 1;
  const seed = ((Number(state.seed) || 1) ^ (state.round * 0x9E3779B1) ^ (playerIndex * 0x85EBCA6B)) >>> 0;
  return mulberry32(seed)() < chance + situationBonus;
}

export function npcSpeech(state, player, rng = state.rng) {
  const ore = ORES[state.oreSequence[state.round - 1]];
  if (player.profile === "safety") {
    if (state.danger >= 80) return "危険が上がってきたね。無理はしない方がいい。";
    if (state.danger >= 60) return "この辺り、一度補強した方がいい。";
    if (state.danger < 40) return "今なら掘っても大丈夫そうだ。";
    return "足場を見ながら進もう。";
  }
  if (player.profile === "greedy") {
    if (state.danger >= 80) return "さすがにこれは危ないか。";
    if (ore.id === "gold") return "金晶か。これは掘りたいな。";
    if (state.danger >= 60) return "少しくらいなら、まだ行ける。";
    return "ここを見送るのはもったいないな。";
  }
  if (player.profile === "tactician") {
    const next = state.oreSequence[state.round];
    if (next && rng() < 0.55) {
      const truthful = rng() < 0.72;
      const announced = truthful ? next : Object.keys(ORES).find((id) => id !== next);
      return `次は${ORES[announced].name}かもしれないね。`;
    }
    if (state.danger >= 80) return "そろそろ引き際も考えようか。";
    return state.detectedSecretMining ? "採掘の数が少し気になるね。" : "今は協力しておこう。";
  }
  return "";
}

export function canAccuse(state, player) {
  return player.active && state.round >= 3 && state.detectedSecretMining && player.accusationsUsed < CONFIG.maxAccusations;
}

export function chooseNpcAccusation(state, player, rng = state.rng) {
  if (!canAccuse(state, player)) return null;
  const chance = player.profile === "tactician" ? 0.45 : player.profile === "safety" ? 0.12 : 0.18;
  if (rng() >= chance) return null;
  const targets = state.players.filter((target) => target.active && target.id !== player.id);
  if (!targets.length) return null;
  const maxSuspicion = Math.max(...targets.map((target) => state.suspicion[target.id]));
  const likely = targets.filter((target) => state.suspicion[target.id] === maxSuspicion);
  return likely[Math.floor(rng() * likely.length)].id;
}

function removeOneSecretOre(player) {
  const id = Object.keys(ORES).sort((a, b) => ORES[b].value - ORES[a].value).find((oreId) => player.secretOre[oreId] > 0);
  if (!id) return null;
  player.secretOre[id] -= 1;
  return id;
}

export function resolveAccusation(state, accusation) {
  if (!accusation) return null;
  const accuser = state.players.find(({ id }) => id === accusation.accuserId);
  const target = state.players.find(({ id }) => id === accusation.targetId);
  if (!accuser || !target || !canAccuse(state, accuser) || accuser.id === target.id || !target.active) return null;
  accuser.accusationsUsed += 1;
  const oreId = removeOneSecretOre(target);
  if (oreId) {
    state.vault.push(oreId);
    accuser.accusationSuccesses += 1;
    state.suspicion[target.id] = Math.max(0, state.suspicion[target.id] - 2);
    return { accuserId: accuser.id, targetId: target.id, success: true, oreId };
  }
  accuser.discredit += 1;
  accuser.accusationFailures += 1;
  return { accuserId: accuser.id, targetId: target.id, success: false, oreId: null };
}

function loseOre(bag, rate) {
  const total = oreCount(bag);
  let remaining = Math.floor(total * Math.max(0, rate) + 1e-9);
  const lost = emptyOreBag();
  for (const id of Object.keys(ORES).sort((a, b) => ORES[b].value - ORES[a].value)) {
    const count = Math.min(bag[id], remaining);
    bag[id] -= count;
    lost[id] += count;
    remaining -= count;
  }
  return lost;
}

export function collapseLossRate(reinforcement) {
  return CONFIG.collapsePublicLoss[Math.min(reinforcement, 3)];
}

export function applyCollapse(state) {
  state.collapsed = true;
  state.endReason = "collapse";
  for (const player of state.players.filter(({ active }) => active)) {
    const publicRate = collapseLossRate(player.reinforcement);
    const secretRate = Math.max(0, publicRate - CONFIG.secretLossReduction);
    const publicLost = loseOre(player.publicOre, publicRate);
    const secretLost = loseOre(player.secretOre, secretRate);
    player.collapseLoss = oreValue(publicLost) + oreValue(secretLost);
  }
}

function distributeVault(state) {
  const eligible = state.players.filter(({ reinforcement }) => reinforcement > 0);
  while (state.vault.length && eligible.length) {
    const order = [...eligible].sort((a, b) => b.reinforcement - a.reinforcement || state.rng() - 0.5);
    for (const player of order) {
      const oreId = state.vault.shift();
      if (!oreId) break;
      player.vaultOre[oreId] += 1;
    }
  }
}

export function finaliseGame(state) {
  if (state.finalised) return state;
  distributeVault(state);
  state.ended = true;
  state.finalised = true;
  const ranked = [...state.players].sort((a, b) => totalValue(b) - totalValue(a));
  let rank = 0;
  let previousValue = null;
  ranked.forEach((player, index) => {
    const value = totalValue(player);
    if (value !== previousValue) rank = index + 1;
    player.rank = rank;
    previousValue = value;
  });
  return state;
}

export function resolveRound(state, { humanAction, humanScout = false, humanAccusationTarget = null, playerActions = null, playerScouts = null, playerAccusations = null, npcActions = null, npcScouts = null, npcAccusations = null } = {}) {
  if (state.ended) throw new Error("game already ended");
  const human = state.players[0];
  const multiplayer = playerActions !== null;
  const availability = actionAvailability(state, human);
  if (!multiplayer && human.active && !availability[humanAction]) throw new Error(`action unavailable: ${humanAction}`);
  if (!multiplayer && humanScout && !canScout(state, human)) throw new Error("scout unavailable");
  const oreId = state.oreSequence[state.round - 1];
  const actions = {};
  if (multiplayer) {
    for (const player of state.players) {
      const action = playerActions?.[player.id] ?? null;
      if (player.active && !actionAvailability(state, player)[action]) throw new Error(`action unavailable: ${action}`);
      if (player.active) actions[player.id] = action;
    }
  } else {
    if (human.active) actions.human = humanAction;
    for (const player of state.players.slice(1)) actions[player.id] = npcActions?.[player.id] ?? chooseNpcAction(state, player);
  }
  const scouts = {};
  if (multiplayer) {
    for (const player of state.players) {
      scouts[player.id] = Boolean(playerScouts?.[player.id]) && canScout(state, player);
    }
  } else {
    if (human.active) scouts.human = Boolean(humanScout);
    for (const player of state.players.slice(1)) {
      scouts[player.id] = npcScouts && Object.hasOwn(npcScouts, player.id)
        ? Boolean(npcScouts[player.id]) && canScout(state, player)
        : chooseNpcScout(state, player);
    }
  }

  const dangerBefore = state.danger;
  let dangerAdded = 0;
  let dangerReduced = 0;
  let secretCount = 0;
  const retreatingPlayerIds = new Set();
  for (const player of state.players) {
    const action = actions[player.id];
    if (!player.active || !action) continue;
    if (action === "mine") {
      player.publicOre[oreId] += 2;
      dangerAdded += ORES[oreId].danger;
    } else if (action === "secret") {
      player.publicOre[oreId] += 1;
      player.secretOre[oreId] += 1;
      player.secretActions += 1;
      state.suspicion[player.id] += 1;
      dangerAdded += ORES[oreId].danger;
      secretCount += 1;
    } else if (action === "reinforce") {
      player.reinforcement += 1;
      dangerReduced += CONFIG.reinforceReduction;
    } else if (action === "retreat") {
      retreatingPlayerIds.add(player.id);
    }
  }

  for (const player of state.players) {
    if (!scouts[player.id]) continue;
    player.scoutsUsed += 1;
    player.scoutedRound = state.round + 1;
    player.scoutedOre = state.oreSequence[state.round] ?? null;
  }

  const accusations = [];
  if (multiplayer) {
    for (const player of state.players) {
      const targetId = playerAccusations?.[player.id];
      if (targetId) accusations.push({ accuserId: player.id, targetId });
    }
  } else {
    if (humanAccusationTarget) accusations.push({ accuserId: "human", targetId: humanAccusationTarget });
    for (const player of state.players.slice(1)) {
      const targetId = npcAccusations && Object.hasOwn(npcAccusations, player.id)
        ? npcAccusations[player.id]
        : chooseNpcAccusation(state, player);
      if (targetId) accusations.push({ accuserId: player.id, targetId });
    }
  }
  const accusationResults = accusations.map((accusation) => resolveAccusation(state, accusation)).filter(Boolean);

  for (const playerId of retreatingPlayerIds) {
    const player = state.players.find(({ id }) => id === playerId);
    player.active = false;
    player.retreated = true;
  }

  if (secretCount > 0) state.detectedSecretMining = true;
  state.danger = Math.max(0, state.danger + dangerAdded - dangerReduced);
  const publicActions = Object.fromEntries(Object.entries(actions).map(([id, action]) => [id, action === "secret" ? "mine" : action]));
  const record = {
    round: state.round,
    oreId,
    scoutOreId: state.oreSequence[state.round] ?? null,
    actions: { ...actions },
    publicActions,
    scouts: { ...scouts },
    accusationResults,
    secretCount,
    dangerBefore,
    dangerAdded,
    dangerReduced,
    dangerAfter: state.danger,
  };
  state.history.push(record);

  const allRetreated = state.players.every(({ active }) => !active);
  if (state.danger >= CONFIG.collapseDanger) applyCollapse(state);
  else if (allRetreated) state.endReason = "all-retreated";
  else if (state.round >= CONFIG.totalRounds) state.endReason = "rounds";

  if (state.endReason) finaliseGame(state);
  else state.round += 1;
  return record;
}

export function simulateRemaining(state) {
  while (!state.ended) resolveRound(state, { humanAction: state.players[0].active ? "reinforce" : null });
  return state;
}

export function cloneForInspection(state) {
  return JSON.parse(JSON.stringify(state, (key, value) => key === "rng" ? undefined : value));
}

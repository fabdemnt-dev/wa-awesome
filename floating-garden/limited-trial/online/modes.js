export const HUMAN4_RULES_VERSION = 'floating-garden-online-human4-1';
export const HUMAN3_RULES_VERSION = 'floating-garden-online-human3-1';
export const NPC_RULES_VERSION = 'floating-garden-online-npc-1';
export const MATCH_RULES_VERSION = 'floating-garden-match-1';
export const OBJECTIVE_RULES_VERSION = 'floating-garden-match-2';
export const OBJECTIVE_NPC_RULES_VERSION = 'floating-garden-online-npc-2';
export const OBJECTIVE_HUMAN3_RULES_VERSION = 'floating-garden-online-human3-2';
export const OBJECTIVE_HUMAN4_RULES_VERSION = 'floating-garden-online-human4-2';
export const OBJECTIVE_PROTOCOLS = Object.freeze([OBJECTIVE_RULES_VERSION, OBJECTIVE_NPC_RULES_VERSION, OBJECTIVE_HUMAN3_RULES_VERSION, OBJECTIVE_HUMAN4_RULES_VERSION]);
export function isObjectiveProtocol(version) { return OBJECTIVE_PROTOCOLS.includes(version); }
export function modeRulesVersion(humans, npcs, objectives = false) {
  return objectives
    ? humans === 4 ? OBJECTIVE_HUMAN4_RULES_VERSION : humans === 3 ? OBJECTIVE_HUMAN3_RULES_VERSION : npcs ? OBJECTIVE_NPC_RULES_VERSION : OBJECTIVE_RULES_VERSION
    : humans === 4 ? HUMAN4_RULES_VERSION : humans === 3 ? HUMAN3_RULES_VERSION : npcs ? NPC_RULES_VERSION : MATCH_RULES_VERSION;
}
export function roomMatchVersion(room) { return isObjectiveProtocol(room?.rulesVersion) ? OBJECTIVE_RULES_VERSION : MATCH_RULES_VERSION; }
export const ONLINE_MODES = Object.freeze([
  [2, 0], [2, 1], [2, 2], [3, 0], [3, 1], [4, 0],
].map(([humanSeatCount, npcCount]) => Object.freeze({ id: `${humanSeatCount}-${npcCount}`, humanSeatCount, npcCount })));
export function modeLabel(humans, npcs) {
  return `人間${humans}人${npcs ? `＋NPC${npcs}人` : 'のみ'}（${humans + npcs}人戦）`;
}
export function roomMode(room) {
  const humanSeatCount = room?.humanSeatCount === undefined ? 2 : room.humanSeatCount;
  const npcCount = room?.npcCount === undefined ? 0 : room.npcCount;
  if (!ONLINE_MODES.some(mode => mode.humanSeatCount === humanSeatCount && mode.npcCount === npcCount)
    || room.playerCount !== humanSeatCount + npcCount
    || (humanSeatCount > 2 && !Object.hasOwn(room, 'npcCount'))
    || room.rulesVersion !== modeRulesVersion(humanSeatCount, npcCount, isObjectiveProtocol(room.rulesVersion))) return null;
  return { humanSeatCount, npcCount };
}

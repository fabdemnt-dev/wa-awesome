export const HUMAN4_RULES_VERSION = 'floating-garden-online-human4-1';
export const HUMAN3_RULES_VERSION = 'floating-garden-online-human3-1';
export const NPC_RULES_VERSION = 'floating-garden-online-npc-1';
export const MATCH_RULES_VERSION = 'floating-garden-match-1';
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
    || room.rulesVersion !== (humanSeatCount === 4 ? HUMAN4_RULES_VERSION : humanSeatCount === 3 ? HUMAN3_RULES_VERSION : npcCount ? NPC_RULES_VERSION : MATCH_RULES_VERSION)) return null;
  return { humanSeatCount, npcCount };
}

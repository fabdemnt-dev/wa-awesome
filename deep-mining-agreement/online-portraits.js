export const NPC_PORTRAITS_BY_ROLE = Object.freeze({
  '坑道整備士': Object.freeze({ src: 'assets/characters/minato.png', alt: 'ミナト' }),
  '採掘師': Object.freeze({ src: 'assets/characters/gaku.png', alt: 'ガク' }),
  '鉱脈調査員': Object.freeze({ src: 'assets/characters/shion.png', alt: 'シオン' }),
});

export function npcPortrait(player) {
  return player.isHuman === false ? NPC_PORTRAITS_BY_ROLE[player.role] || null : null;
}

import { createGarden, createTile, placeStone, placeTile } from './engine.js?v=20261002-match-save';

/** Fixed public fixtures for layout review, not players, a deck, or a game loop. */
export function createTableDemo() {
  const fixtures = [
    { id: 'moon', seat: 'P2', name: '月の庭', terrain: ['lake', 'lake', 'cloud', 'crystal', 'forest', 'lake', 'cloud', 'magic'], cells: [0, 1, 2, 3, 4, 5, 9, 13], stones: [[1, 'moon'], [9, 'wind']] },
    { id: 'forest', seat: 'P3', name: '森の庭', terrain: ['forest', 'cloud', 'forest', 'crystal', 'magic', 'lake', 'cloud', 'forest', 'lake', 'magic'], cells: [0, 1, 3, 4, 5, 6, 8, 9, 12, 15], stones: [[5, 'color'], [9, 'echo']] },
    { id: 'crystal', seat: 'P4', name: '結晶の庭', terrain: ['crystal', 'cloud', 'lake', 'crystal', 'magic', 'forest'], cells: [2, 3, 6, 7, 10, 11], stones: [[6, 'moon']] },
  ];
  return {
    drawnTile: createTile('lake', 'bend', 1),
    opponents: fixtures.map(({ terrain, cells, stones, ...player }) => {
      let garden = createGarden();
      cells.forEach((cell, index) => { garden = placeTile(garden, cell, createTile(terrain[index], index % 2 ? 'bend' : 'straight', index % 4)); });
      stones.forEach(([cell, stone]) => { garden = placeStone(garden, cell, stone); });
      return { ...player, garden };
    }),
  };
}

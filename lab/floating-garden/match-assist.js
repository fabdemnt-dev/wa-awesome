/** CPU-match counting aid. Uses public inventory only, never the seed or hidden deck. */
import { TERRAIN } from './engine.js?v=20261001-tile-assist';

export function remainingTileCounts({ players, drawn }) {
  // The fixed deck has two copies of every terrain/shape for each participant.
  const kinds = Object.keys(TERRAIN).flatMap((terrain) => ['straight', 'bend'].map((shape) => ({ terrain, shape, count: players.length * 2 })));
  const subtract = (tile) => {
    if (!tile) return;
    kinds.find((kind) => kind.terrain === tile.terrain && kind.shape === tile.shape).count -= 1;
  };
  for (const player of players) {
    player.garden.forEach(subtract);
    subtract(player.storage);
  }
  subtract(drawn?.tile);
  return { total: kinds.reduce((sum, kind) => sum + kind.count, 0), kinds };
}

/** CPU receives only publicMatch + legal actions, never the seed or deck order. */
import { CORNERS, createTile, neighbors, placeTile, placeStone, scoreGarden, tilePorts } from './engine.js?v=20261001-rule-examples';

function potential(garden) {
  const corners = CORNERS.flatMap((index) => garden[index] ? [garden[index].terrain] : []);
  const distinct = new Set(corners).size;
  let value = distinct === corners.length ? distinct * 0.45 : -0.5;
  // Leave connections toward still-empty cells and prepare future stone positions.
  garden.forEach((tile, index) => {
    if (!tile) return;
    const adjacent = [index >= 4 ? index - 4 : null, index % 4 < 3 ? index + 1 : null, index < 12 ? index + 4 : null, index % 4 ? index - 1 : null];
    value += tilePorts(tile).filter((port) => adjacent[port] !== null && !garden[adjacent[port]]).length * 0.12;
    if (tile.terrain === 'lake') value += garden.filter((other, i) => i !== index && Math.floor(i / 4) === Math.floor(index / 4) && other?.terrain === 'lake').length * 0.06;
    value += new Set(neighbors(index).flatMap((i) => garden[i] ? [garden[i].terrain] : [])).size * 0.025;
  });
  return value;
}

export function bestTilePlacement(garden, tile) {
  if (!tile) return null;
  const baseline = scoreGarden(garden).total + potential(garden);
  let best = null;
  garden.forEach((cell, index) => {
    if (cell) return;
    for (let rotation = 0; rotation < 4; rotation += 1) {
      const placed = placeTile(garden, index, createTile(tile.terrain, tile.shape, rotation));
      const gain = scoreGarden(placed).total + potential(placed) - baseline;
      if (!best || gain > best.gain + 1e-9) best = { index, rotation, gain };
    }
  });
  return best;
}

export function chooseCpuAction(visible, legal) {
  if (!legal.length) return null;
  const player = visible.players[legal[0].seat];
  const find = (type) => legal.find((action) => action.type === type);
  if (visible.step === 'source') {
    const stored = player.storage && bestTilePlacement(player.garden, player.storage);
    return stored?.gain >= 1.4 ? find('use-storage') : find('draw');
  }
  if (visible.step === 'choose') {
    const own = bestTilePlacement(player.garden, visible.drawn.tile);
    if (find('offer') && player.power <= 3 && own.gain < 1.6) {
      const recipient = legal.filter((action) => action.type === 'offer').map((action) => ({ action, gain: bestTilePlacement(visible.players[action.target].garden, visible.drawn.tile).gain })).sort((a, b) => b.gain - a.gain || a.action.target - b.action.target)[0];
      if (recipient && recipient.gain >= own.gain) return recipient.action;
    }
    if (find('store') && own.gain < 1.1 && (!player.storage || bestTilePlacement(player.garden, player.storage).gain > own.gain + 0.25)) return find('store');
    return find('self');
  }
  if (visible.step === 'offer-response') return find('accept'); // Free progress cannot remove existing placements.
  if (visible.step === 'invite-response') {
    const gain = bestTilePlacement(player.garden, visible.drawn.tile).gain;
    return gain >= 1.4 && (player.power >= 5 || gain >= 2.5) ? find('request-invite') : find('pass-invite');
  }
  if (visible.step === 'welcome') {
    const gain = bestTilePlacement(player.garden, visible.drawn.tile).gain;
    return find('welcome') && gain >= 1.7 ? find('welcome') : find('yield');
  }
  if (visible.step === 'place') {
    const best = bestTilePlacement(player.garden, visible.drawn.tile);
    return legal.find((action) => action.type === 'place' && action.index === best.index && action.rotation === best.rotation);
  }
  if (['care', 'final-stone'].includes(visible.step)) {
    const current = scoreGarden(player.garden).total;
    let best = null;
    for (const action of legal.filter((item) => item.type === 'stone')) {
      const gain = scoreGarden(placeStone(player.garden, action.index, action.stone)).total - current;
      if (!best || gain > best.gain) best = { action, gain };
    }
    if (best && best.gain >= (visible.step === 'final-stone' ? 1 : player.power === 6 ? 2 : 4)) return best.action;
    return find(visible.step === 'final-stone' ? 'pass-final' : 'meditate');
  }
  return legal[0];
}

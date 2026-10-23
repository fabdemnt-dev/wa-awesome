/** Phase 1 rules only. No DOM, clock, network, random source, or hidden state. */
export const BOARD_SIZE = 4;
export const CELL_COUNT = BOARD_SIZE * BOARD_SIZE;
export const RULES_VERSION = 'floating-garden-prototype-1';
export const TERRAIN = Object.freeze({
  cloud: Object.freeze({ name: '雲海', mark: '雲' }),
  lake: Object.freeze({ name: '月光湖', mark: '月' }),
  crystal: Object.freeze({ name: '結晶原', mark: '晶' }),
  forest: Object.freeze({ name: '精霊林', mark: '林' }),
  magic: Object.freeze({ name: '魔力地', mark: '魔' }),
});
export const STONES = Object.freeze({
  moon: Object.freeze({ name: '月読み', mark: '☾', rule: '同じ横列の月光湖1枚につき2点（自分の足元も含む）' }),
  wind: Object.freeze({ name: '風守', mark: '≋', rule: '上下左右に隣接する雲海1枚につき2点' }),
  color: Object.freeze({ name: '彩り', mark: '✧', rule: '上下左右に隣接する地形1種類につき2点（同じ地形は1種類）' }),
  echo: Object.freeze({ name: '共鳴', mark: '◎', rule: '同じ縦列・横列にある別の石1個につき2点' }),
});
export const STONE_CAP = 6;
export const CORNERS = Object.freeze([0, 3, 12, 15]);

export function createGarden() {
  return Array(CELL_COUNT).fill(null);
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function checkIndex(index) {
  if (!Number.isInteger(index) || index < 0 || index >= CELL_COUNT) {
    fail('invalid-cell', '庭の中のマスを選んでください');
  }
}

export function createTile(terrain, shape = 'straight', rotation = 0) {
  if (!Object.hasOwn(TERRAIN, terrain)) fail('invalid-terrain', '地形を選んでください');
  if (!['straight', 'bend'].includes(shape)) fail('invalid-shape', '流れは直線か曲線を選んでください');
  if (!Number.isInteger(rotation)) fail('invalid-rotation', '回転は90度単位です');
  return { terrain, shape, rotation: ((rotation % 4) + 4) % 4, stone: null };
}

export function validateGarden(garden) {
  if (!Array.isArray(garden) || garden.length !== CELL_COUNT) {
    fail('invalid-garden', '庭は4×4の16マスです');
  }
  const stones = new Set();
  // Indexed iteration also rejects sparse arrays instead of skipping holes.
  for (let index = 0; index < CELL_COUNT; index += 1) {
    const cell = garden[index];
    if (cell === null) continue;
    if (!cell || typeof cell !== 'object') fail('invalid-tile', '地形タイルを確認してください');
    const normalized = createTile(cell.terrain, cell.shape, cell.rotation);
    if (normalized.shape !== cell.shape) fail('invalid-shape', '流れの形が不正です');
    if (normalized.rotation !== cell.rotation) fail('invalid-rotation', '庭の回転値が不正です');
    if (cell.stone !== null) {
      if (!Object.hasOwn(STONES, cell.stone)) fail('invalid-stone', '石を選んでください');
      if (stones.has(cell.stone)) fail('duplicate-stone', '同じ石は1個までです');
      stones.add(cell.stone);
    }
  }
  return garden;
}

export function cellName(index) {
  checkIndex(index);
  return `${String.fromCharCode(65 + index % BOARD_SIZE)}${Math.floor(index / BOARD_SIZE) + 1}`;
}

export function neighbors(index) {
  checkIndex(index);
  const row = Math.floor(index / BOARD_SIZE);
  const col = index % BOARD_SIZE;
  return [
    row > 0 ? index - BOARD_SIZE : null,
    col < BOARD_SIZE - 1 ? index + 1 : null,
    row < BOARD_SIZE - 1 ? index + BOARD_SIZE : null,
    col > 0 ? index - 1 : null,
  ].filter((value) => value !== null);
}

/** Ports N=0, E=1, S=2, W=3; straight NS / bend NE at rotation 0. */
export function tilePorts(tile) {
  const normalized = createTile(tile.terrain, tile.shape, tile.rotation);
  return (normalized.shape === 'straight' ? [0, 2] : [0, 1])
    .map((port) => (port + normalized.rotation) % 4);
}

export function placeTile(garden, index, tile) {
  validateGarden(garden);
  checkIndex(index);
  if (garden[index] !== null) fail('occupied-cell', '地形のあるマスには重ねられません');
  if (!tile || typeof tile !== 'object' || (tile.stone != null)) {
    fail('invalid-tile', '石のない地形タイルを選んでください');
  }
  const next = garden.slice();
  next[index] = createTile(tile.terrain, tile.shape, tile.rotation);
  return next;
}

export function placeStone(garden, index, stone) {
  validateGarden(garden);
  checkIndex(index);
  if (!Object.hasOwn(STONES, stone)) fail('invalid-stone', '石を選んでください');
  if (!garden[index]) fail('empty-cell', '石は地形のあるマスに置きます');
  if (garden[index].stone) fail('occupied-stone', '1マスに置ける石は1個です');
  if (garden.some((cell) => cell?.stone === stone)) fail('used-stone', 'この石はすでに庭にあります');
  const next = garden.slice();
  next[index] = { ...garden[index], stone };
  return next;
}

/** Valid commands cannot move, replace, or rotate an already placed object. */
export function applyPlacement(garden, command) {
  if (command?.type === 'tile') return placeTile(garden, command.index, command.tile);
  if (command?.type === 'stone') return placeStone(garden, command.index, command.stone);
  fail('invalid-command', '地形または石を選んでください');
}

/** Breakdown preserves every match, including matches above a capped award. */
export function scoreGarden(garden) {
  validateGarden(garden);
  const connections = [];
  const stones = [];
  for (let index = 0; index < CELL_COUNT; index += 1) {
    const cell = garden[index];
    if (!cell) continue;
    const row = Math.floor(index / BOARD_SIZE);
    const col = index % BOARD_SIZE;
    const ports = tilePorts(cell);
    // Check east/south only: an undirected connected edge scores exactly once.
    for (const [neighbor, port] of [[col < 3 ? index + 1 : null, 1], [row < 3 ? index + 4 : null, 2]]) {
      if (neighbor === null || !garden[neighbor]) continue;
      if (ports.includes(port) && tilePorts(garden[neighbor]).includes((port + 2) % 4)) {
        connections.push({ from: index, to: neighbor, points: 1 });
      }
    }
    if (!cell.stone) continue;
    let matches = [];
    let count = 0;
    if (cell.stone === 'moon') {
      matches = garden.flatMap((other, i) => other?.terrain === 'lake' && Math.floor(i / 4) === row ? [i] : []);
      count = matches.length;
    } else if (cell.stone === 'wind') {
      matches = neighbors(index).filter((i) => garden[i]?.terrain === 'cloud');
      count = matches.length;
    } else if (cell.stone === 'color') {
      matches = neighbors(index).filter((i) => garden[i] !== null);
      count = new Set(matches.map((i) => garden[i].terrain)).size;
    } else if (cell.stone === 'echo') {
      matches = garden.flatMap((other, i) => i !== index && other?.stone &&
        (Math.floor(i / 4) === row || i % 4 === col) ? [i] : []);
      count = matches.length;
    }
    const rawPoints = count * 2;
    stones.push({ index, stone: cell.stone, matches, count, rawPoints, points: Math.min(STONE_CAP, rawPoints), capped: rawPoints > STONE_CAP });
  }
  const cornerTypes = CORNERS.map((index) => garden[index]?.terrain ?? null);
  const cornerComplete = cornerTypes.every((terrain) => terrain !== null);
  const objective = { name: '四隅異なる地形', corners: [...CORNERS], achieved: cornerComplete && new Set(cornerTypes).size === 4, points: 0 };
  objective.points = objective.achieved ? 4 : 0;
  const connectionPoints = connections.length;
  const stonePoints = stones.reduce((sum, stone) => sum + stone.points, 0);
  return { total: connectionPoints + stonePoints + objective.points, connectionPoints, stonePoints, connections, stones, objective, filled: garden.filter(Boolean).length };
}

/** A reproducible example; no random draws or implicit game progression. */
export function createExampleGarden() {
  const terrain = ['cloud', 'lake', 'lake', 'crystal', 'forest', 'lake', 'magic', 'cloud', 'magic', 'crystal', 'cloud', 'forest', 'lake', 'forest', 'magic', 'magic'];
  const rotations = [1, 1, 2, 2, 0, 3, 1, 0, 1, 0, 3, 0, 0, 1, 1, 3];
  let garden = terrain.map((type, index) => createTile(type, index % 3 === 0 ? 'bend' : 'straight', rotations[index]));
  for (const [index, stone] of [[1, 'moon'], [6, 'wind'], [9, 'color'], [13, 'echo']]) {
    garden = placeStone(garden, index, stone);
  }
  return garden;
}

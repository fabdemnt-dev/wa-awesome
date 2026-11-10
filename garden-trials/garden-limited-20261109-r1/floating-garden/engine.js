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
export const OBJECTIVE_VERSION = 1;
export const OBJECTIVE_IDS = Object.freeze(['corners', 'terrain-cluster', 'flow-chain', 'diverse-line']);
export const OBJECTIVES = Object.freeze({
  corners: Object.freeze({ name: '四隅の彩り', description: '四隅すべてを埋め、4種類の異なる地形にする', target: 4 }),
  'terrain-cluster': Object.freeze({ name: '地形の集い', description: '同じ地形を上下左右につないで4枚以上のまとまりにする（地形はどれでも可）', target: 4 }),
  'flow-chain': Object.freeze({ name: '六枚の流れ', description: '流れをつないで6枚以上のひとつながりにする（輪も可・同じタイルは1枚と数える）', target: 6 }),
  'diverse-line': Object.freeze({ name: '一列の彩り', description: '縦か横の一列をすべて埋め、4種類の異なる地形にする', target: 4 }),
});

/** A versioned public rule, not a per-player choice. Unknown fields fail closed. */
export function validateObjective(objective) {
  if (!objective || typeof objective !== 'object' || Array.isArray(objective)) fail('invalid-objective', 'お題の記録を確認してください');
  const prototype = Object.getPrototypeOf(objective);
  const fields = Object.getOwnPropertyDescriptors(objective);
  if ((prototype !== Object.prototype && prototype !== null) ||
      Reflect.ownKeys(objective).length !== 2 || !Object.hasOwn(fields, 'id') || !Object.hasOwn(fields, 'version') ||
      !Object.hasOwn(fields.id, 'value') || !Object.hasOwn(fields.version, 'value') ||
      !fields.id.enumerable || !fields.version.enumerable ||
      !OBJECTIVE_IDS.includes(fields.id.value) || fields.version.value !== OBJECTIVE_VERSION) {
    fail('invalid-objective', 'お題の種類と版を確認してください');
  }
  return objective;
}

/** A separate random stream: selecting an objective never consumes deck randomness. */
export function selectObjectiveId(seed) {
  if (!['string', 'number'].includes(typeof seed) || (typeof seed === 'number' && !Number.isFinite(seed))) fail('invalid-seed', 'お題の合言葉を確認してください');
  let value = 2166136261;
  for (const char of `floating-garden-shared-objective-${OBJECTIVE_VERSION}:${seed}`) value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0;
  value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
  return OBJECTIVE_IDS[Math.floor(value / 4294967296 * OBJECTIVE_IDS.length)];
}

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

function connectedComponents(garden, adjacent) {
  const seen = new Set();
  const components = [];
  for (let start = 0; start < CELL_COUNT; start += 1) {
    if (!garden[start] || seen.has(start)) continue;
    const cells = [], pending = [start];
    seen.add(start);
    while (pending.length) {
      const index = pending.pop();
      cells.push(index);
      for (const next of adjacent(index)) {
        if (!seen.has(next)) { seen.add(next); pending.push(next); }
      }
    }
    components.push(cells.sort((a, b) => a - b));
  }
  return components;
}

function flowConnections(garden) {
  const connections = [];
  garden.forEach((cell, index) => {
    if (!cell) return;
    const ports = tilePorts(cell);
    // East/south only: reciprocal ports make one undirected edge, never a row wrap.
    for (const [neighbor, port] of [[index % 4 < 3 ? index + 1 : null, 1], [index < 12 ? index + 4 : null, 2]]) {
      if (neighbor !== null && garden[neighbor] && ports.includes(port) && tilePorts(garden[neighbor]).includes((port + 2) % 4)) {
        connections.push({ from: index, to: neighbor, points: 1 });
      }
    }
  });
  return connections;
}

function objectiveResult(garden, objective, connections) {
  const selected = objective === undefined ? { id: 'corners', version: OBJECTIVE_VERSION } : validateObjective(objective);
  const definition = OBJECTIVES[selected.id];
  let progress = 0, cells = [];
  if (selected.id === 'corners') {
    cells = CORNERS.filter((index) => garden[index]);
    progress = new Set(cells.map((index) => garden[index].terrain)).size;
  } else if (selected.id === 'terrain-cluster' || selected.id === 'flow-chain') {
    const edges = Array.from({ length: CELL_COUNT }, () => []);
    if (selected.id === 'flow-chain') for (const { from, to } of connections) { edges[from].push(to); edges[to].push(from); }
    const groups = connectedComponents(garden, selected.id === 'terrain-cluster'
      ? (index) => neighbors(index).filter((next) => garden[next]?.terrain === garden[index].terrain)
      : (index) => edges[index]);
    cells = groups.sort((a, b) => b.length - a.length || a[0] - b[0])[0] ?? [];
    progress = Math.min(cells.length, definition.target);
  } else {
    const lines = Array.from({ length: BOARD_SIZE * 2 }, (_, line) => Array.from({ length: BOARD_SIZE }, (_, offset) =>
      line < BOARD_SIZE ? line * BOARD_SIZE + offset : offset * BOARD_SIZE + line - BOARD_SIZE));
    for (const line of lines) {
      const occupied = line.filter((index) => garden[index]);
      const distinct = new Set(occupied.map((index) => garden[index].terrain)).size;
      if (distinct > progress) { progress = distinct; cells = occupied; }
    }
  }
  const achieved = progress >= definition.target;
  return { id: selected.id, version: selected.version, ...definition, progress, achieved, points: achieved ? 4 : 0, cells,
    ...(selected.id === 'corners' ? { corners: [...CORNERS] } : {}) };
}

/** Evaluate only the shared objective. Missing metadata means the unchanged legacy corner rule. */
export function evaluateObjective(garden, objective) {
  validateGarden(garden);
  return objectiveResult(garden, objective, flowConnections(garden));
}

/** Breakdown preserves every match, including matches above a capped award. */
export function scoreGarden(garden, selectedObjective) {
  validateGarden(garden);
  const connections = flowConnections(garden);
  const stones = [];
  for (let index = 0; index < CELL_COUNT; index += 1) {
    const cell = garden[index];
    if (!cell) continue;
    const row = Math.floor(index / BOARD_SIZE);
    const col = index % BOARD_SIZE;
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
  const objective = objectiveResult(garden, selectedObjective, connections);
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

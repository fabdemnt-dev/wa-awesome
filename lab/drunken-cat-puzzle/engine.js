export const DIRECTIONS = Object.freeze({
  up: Object.freeze({ dx: 0, dy: -1 }),
  right: Object.freeze({ dx: 1, dy: 0 }),
  down: Object.freeze({ dx: 0, dy: 1 }),
  left: Object.freeze({ dx: -1, dy: 0 }),
});

export const STAGES = Object.freeze([
  Object.freeze({
    id: 1,
    name: "まずは一押し",
    hint: "穴を右へ。ネコは穴と反対へ逃げます。",
    map: Object.freeze([
      "######",
      "######",
      "#H.CA#",
      "######",
      "######",
    ]),
    solution: Object.freeze(["right", "right", "right"]),
  }),
  Object.freeze({
    id: 2,
    name: "曲がって追い込め",
    hint: "ネコの左側へ回り込み、お酒の方向へ逃がそう。",
    map: Object.freeze([
      "#######",
      "#.....#",
      "#.H...#",
      "#...C.#",
      "#...A.#",
      "#.....#",
      "#######",
    ]),
    solution: Object.freeze(["right", "right", "down", "down"]),
  }),
  Object.freeze({
    id: 3,
    name: "壁を回り込め",
    hint: "正面がだめなら、通路を回って別の向きから近づこう。",
    map: Object.freeze([
      "########",
      "#..#...#",
      "#H.#.A.#",
      "#..#...#",
      "#....C.#",
      "#..##..#",
      "#......#",
      "########",
    ]),
    solution: Object.freeze([
      "right", "down", "down", "down", "down", "right",
      "right", "right", "up", "up", "up", "up",
    ]),
  }),
]);

function point(x, y) {
  return { x, y };
}

function samePoint(a, b) {
  return Boolean(a && b && a.x === b.x && a.y === b.y);
}

function copyPoint(value) {
  return value ? { ...value } : null;
}


export function createState(stageIndex = 0) {
  const stage = STAGES[stageIndex];
  if (!stage) throw new RangeError("Unknown stage.");

  const walls = [];
  let hole = null;
  let cat = null;
  let alcohol = null;

  stage.map.forEach((row, y) => [...row].forEach((cell, x) => {
    if (cell === "#") walls.push(point(x, y));
    if (cell === "H") hole = point(x, y);
    if (cell === "C") cat = point(x, y);
    if (cell === "A") alcohol = point(x, y);
  }));

  if (!hole || !cat || !alcohol) throw new Error(`Stage ${stage.id} is incomplete.`);

  return {
    stageIndex,
    width: stage.map[0].length,
    height: stage.map.length,
    walls,
    hole,
    cat,
    catState: "sober",
    alcohol,
    moves: 0,
    cleared: false,
    event: "start",
  };
}

export function cloneState(state) {
  return {
    ...state,
    walls: state.walls.map(copyPoint),
    hole: copyPoint(state.hole),
    cat: copyPoint(state.cat),
    alcohol: copyPoint(state.alcohol),
  };
}

function inBounds(state, position) {
  return position.x >= 0 && position.x < state.width
    && position.y >= 0 && position.y < state.height;
}

function isWall(state, position) {
  return state.walls.some((wall) => samePoint(wall, position));
}

function shifted(position, direction) {
  return point(position.x + direction.dx, position.y + direction.dy);
}

function isAdjacent(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
}

export function moveHole(state, directionName) {
  const direction = DIRECTIONS[directionName];
  if (!direction || state.cleared) return { state: cloneState(state), moved: false };

  const target = shifted(state.hole, direction);
  if (!inBounds(state, target) || isWall(state, target) || samePoint(target, state.alcohol)) {
    return { state: cloneState(state), moved: false };
  }
  if (samePoint(target, state.cat) && state.catState === "sober") {
    return { state: cloneState(state), moved: false };
  }

  const next = cloneState(state);
  next.moves += 1;
  next.event = "hole-moved";
  next.hole = target;

  if (samePoint(target, next.cat) && next.catState === "drunk") {
    next.cat = null;
    next.cleared = true;
    next.event = "cat-fell";
    return { state: next, moved: true };
  }

  if (next.catState === "sober" && isAdjacent(next.hole, next.cat)) {
    const escape = point(
      next.cat.x + (next.cat.x - next.hole.x),
      next.cat.y + (next.cat.y - next.hole.y),
    );
    const blocked = !inBounds(next, escape)
      || isWall(next, escape)
      || samePoint(escape, next.hole);

    if (!blocked) {
      next.cat = escape;
      next.event = "cat-fled";
      if (samePoint(next.cat, next.alcohol)) {
        next.catState = "drunk";
        next.alcohol = null;
        next.event = "cat-drank";
      }
    } else {
      next.event = "cat-blocked";
    }
  }

  return { state: next, moved: true };
}

export function playDirections(stageIndex, directions) {
  let state = createState(stageIndex);
  for (const direction of directions) state = moveHole(state, direction).state;
  return state;
}

export function stateKey(state) {
  const cat = state.cat ? `${state.cat.x},${state.cat.y}` : "gone";
  const alcohol = state.alcohol ? `${state.alcohol.x},${state.alcohol.y}` : "gone";
  return `${state.hole.x},${state.hole.y}|${cat}|${state.catState}|${alcohol}|${Number(state.cleared)}`;
}

export function findSolution(stageIndex, maxDepth = 80) {
  const start = createState(stageIndex);
  const queue = [{ state: start, path: [] }];
  const visited = new Set([stateKey(start)]);

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current.state.cleared) return current.path;
    if (current.path.length >= maxDepth) continue;

    for (const direction of Object.keys(DIRECTIONS)) {
      const result = moveHole(current.state, direction);
      if (!result.moved) continue;
      const key = stateKey(result.state);
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push({ state: result.state, path: [...current.path, direction] });
    }
  }
  return null;
}

export function createSession(stageIndex = 0) {
  return { state: createState(stageIndex), history: [] };
}

export function performMove(session, directionName) {
  const result = moveHole(session.state, directionName);
  if (!result.moved) return { state: result.state, history: [...session.history] };
  return {
    state: result.state,
    history: [...session.history, cloneState(session.state)],
  };
}

export function undoMove(session) {
  if (!session.history.length) return {
    state: cloneState(session.state),
    history: [],
  };
  return {
    state: cloneState(session.history.at(-1)),
    history: session.history.slice(0, -1).map(cloneState),
  };
}

export function resetSession(session) {
  return createSession(session.state.stageIndex);
}

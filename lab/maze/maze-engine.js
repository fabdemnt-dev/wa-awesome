export const DIRECTIONS = Object.freeze({
  up: { dx: 0, dy: -1, wall: "top", opposite: "bottom" },
  right: { dx: 1, dy: 0, wall: "right", opposite: "left" },
  down: { dx: 0, dy: 1, wall: "bottom", opposite: "top" },
  left: { dx: -1, dy: 0, wall: "left", opposite: "right" },
});

function hashSeed(seed) {
  let hash = 2166136261;
  for (const character of String(seed)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let state = hashSeed(seed) || 0x6d2b79f5;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function cell(x, y) {
  return { x, y, top: true, right: true, bottom: true, left: true };
}

export function createMaze(width = 13, height = 13, seed = "maze") {
  if (width < 2 || height < 2) throw new RangeError("Maze must be at least 2 × 2.");

  const random = seededRandom(seed);
  const cells = Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => cell(x, y)),
  );
  const visited = Array.from({ length: height }, () => Array(width).fill(false));
  const stack = [cells[0][0]];
  visited[0][0] = true;

  while (stack.length) {
    const current = stack[stack.length - 1];
    const candidates = Object.values(DIRECTIONS)
      .map((direction) => ({
        direction,
        x: current.x + direction.dx,
        y: current.y + direction.dy,
      }))
      .filter(({ x, y }) => x >= 0 && x < width && y >= 0 && y < height && !visited[y][x]);

    if (!candidates.length) {
      stack.pop();
      continue;
    }

    const next = candidates[Math.floor(random() * candidates.length)];
    const target = cells[next.y][next.x];
    current[next.direction.wall] = false;
    target[next.direction.opposite] = false;
    visited[next.y][next.x] = true;
    stack.push(target);
  }

  const start = { x: 0, y: 0 };
  const goal = findFarthest(cells, start);
  return { width, height, seed: String(seed), cells, start, goal };
}

export function canMove(maze, position, directionName) {
  const direction = DIRECTIONS[directionName];
  if (!direction) return false;
  const current = maze.cells[position.y]?.[position.x];
  if (!current || current[direction.wall]) return false;
  const x = position.x + direction.dx;
  const y = position.y + direction.dy;
  return x >= 0 && x < maze.width && y >= 0 && y < maze.height;
}

export function move(maze, position, directionName) {
  if (!canMove(maze, position, directionName)) return { ...position };
  const direction = DIRECTIONS[directionName];
  return { x: position.x + direction.dx, y: position.y + direction.dy };
}

export function reachableCells(maze, start = maze.start) {
  const queue = [{ ...start }];
  const found = new Set([`${start.x},${start.y}`]);
  for (let index = 0; index < queue.length; index += 1) {
    const position = queue[index];
    for (const name of Object.keys(DIRECTIONS)) {
      if (!canMove(maze, position, name)) continue;
      const next = move(maze, position, name);
      const key = `${next.x},${next.y}`;
      if (!found.has(key)) {
        found.add(key);
        queue.push(next);
      }
    }
  }
  return found;
}

function findFarthest(cells, start) {
  const maze = { width: cells[0].length, height: cells.length, cells, start };
  const queue = [{ ...start, distance: 0 }];
  const found = new Set([`${start.x},${start.y}`]);
  let farthest = queue[0];
  for (let index = 0; index < queue.length; index += 1) {
    const position = queue[index];
    if (position.distance > farthest.distance) farthest = position;
    for (const name of Object.keys(DIRECTIONS)) {
      if (!canMove(maze, position, name)) continue;
      const next = move(maze, position, name);
      const key = `${next.x},${next.y}`;
      if (!found.has(key)) {
        found.add(key);
        queue.push({ ...next, distance: position.distance + 1 });
      }
    }
  }
  return { x: farthest.x, y: farthest.y };
}

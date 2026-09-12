import assert from "node:assert/strict";
import test from "node:test";
import { canMove, createMaze, DIRECTIONS, move, reachableCells } from "../lab/maze/maze-engine.js";

test("100個の迷路ですべてのマスとゴールへ到達できる", () => {
  for (let index = 0; index < 100; index += 1) {
    const maze = createMaze(13, 13, `reach-${index}`);
    const reachable = reachableCells(maze);
    assert.equal(reachable.size, 13 * 13);
    assert.ok(reachable.has(`${maze.goal.x},${maze.goal.y}`));
  }
});

test("同じseedは同じ迷路、異なるseedは異なる迷路になる", () => {
  const signature = (maze) => maze.cells.flat().map((cell) =>
    [cell.top, cell.right, cell.bottom, cell.left].map(Number).join(""),
  ).join("|");
  assert.equal(signature(createMaze(13, 13, "hinata")), signature(createMaze(13, 13, "hinata")));
  assert.notEqual(signature(createMaze(13, 13, "hinata")), signature(createMaze(13, 13, "another")));
});

test("外周は閉じ、隣接する壁は必ず一致する", () => {
  for (let index = 0; index < 30; index += 1) {
    const maze = createMaze(13, 13, `walls-${index}`);
    for (const row of maze.cells) for (const cell of row) {
      if (cell.y === 0) assert.equal(cell.top, true);
      if (cell.x === 0) assert.equal(cell.left, true);
      if (cell.y === maze.height - 1) assert.equal(cell.bottom, true);
      if (cell.x === maze.width - 1) assert.equal(cell.right, true);
      if (cell.x + 1 < maze.width) assert.equal(cell.right, maze.cells[cell.y][cell.x + 1].left);
      if (cell.y + 1 < maze.height) assert.equal(cell.bottom, maze.cells[cell.y + 1][cell.x].top);
    }
  }
});

test("移動は通路なら1マス、壁なら同じ位置に留まる", () => {
  const maze = createMaze(13, 13, "movement");
  for (const row of maze.cells) for (const cell of row) {
    const position = { x: cell.x, y: cell.y };
    for (const [name, direction] of Object.entries(DIRECTIONS)) {
      const next = move(maze, position, name);
      if (canMove(maze, position, name)) {
        assert.deepEqual(next, { x: cell.x + direction.dx, y: cell.y + direction.dy });
      } else {
        assert.deepEqual(next, position);
      }
    }
  }
});

test("スタートとゴールは範囲内にあり、別のマスである", () => {
  const maze = createMaze(13, 13, "placement");
  assert.deepEqual(maze.start, { x: 0, y: 0 });
  assert.ok(maze.goal.x >= 0 && maze.goal.x < maze.width);
  assert.ok(maze.goal.y >= 0 && maze.goal.y < maze.height);
  assert.notDeepEqual(maze.goal, maze.start);
});

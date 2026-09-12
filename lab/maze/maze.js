import { canMove, createMaze, DIRECTIONS, move } from "./maze-engine.js";

const SIZE = 13;
const board = document.querySelector("#maze");
const status = document.querySelector("#status");
const seedInput = document.querySelector("#seed");
const finishDialog = document.querySelector("#finish-dialog");
let maze;
let player;
let moves = 0;

function freshSeed() {
  const values = new Uint32Array(2);
  crypto.getRandomValues(values);
  return `${values[0].toString(36)}-${values[1].toString(36)}`;
}

function draw() {
  board.replaceChildren();
  board.style.setProperty("--maze-size", maze.width);
  for (const row of maze.cells) {
    for (const cell of row) {
      const tile = document.createElement("div");
      tile.className = "tile";
      for (const side of ["top", "right", "bottom", "left"]) {
        if (cell[side]) tile.classList.add(`wall-${side}`);
      }
      const isStart = cell.x === maze.start.x && cell.y === maze.start.y;
      const isGoal = cell.x === maze.goal.x && cell.y === maze.goal.y;
      const isPlayer = cell.x === player.x && cell.y === player.y;
      if (isStart) tile.classList.add("start");
      if (isGoal) tile.classList.add("goal");
      if (isStart) tile.setAttribute("aria-label", "スタート");
      if (isGoal) tile.setAttribute("aria-label", "ゴール");
      if (isPlayer) {
        const marker = document.createElement("span");
        marker.className = "player";
        marker.setAttribute("aria-label", "プレイヤー");
        tile.append(marker);
      }
      board.append(tile);
    }
  }
  status.textContent = `移動 ${moves}回`;
}

function start(seed, updateAddress = true) {
  maze = createMaze(SIZE, SIZE, seed);
  player = { ...maze.start };
  moves = 0;
  seedInput.value = maze.seed;
  if (updateAddress) {
    const url = new URL(location.href);
    url.searchParams.set("seed", maze.seed);
    history.replaceState(null, "", url);
  }
  finishDialog.close();
  draw();
}

function walk(direction) {
  if (!canMove(maze, player, direction)) {
    board.classList.remove("blocked");
    requestAnimationFrame(() => board.classList.add("blocked"));
    return;
  }
  player = move(maze, player, direction);
  moves += 1;
  draw();
  if (player.x === maze.goal.x && player.y === maze.goal.y) finishDialog.showModal();
}

document.querySelectorAll("[data-direction]").forEach((button) => {
  button.addEventListener("click", () => walk(button.dataset.direction));
});
document.querySelector("#new-maze").addEventListener("click", () => start(freshSeed()));
document.querySelector("#seed-form").addEventListener("submit", (event) => {
  event.preventDefault();
  start(seedInput.value.trim() || freshSeed());
});
document.querySelector("#restart").addEventListener("click", () => start(maze.seed));
document.querySelector("#dialog-restart").addEventListener("click", () => start(maze.seed));
document.querySelector("#dialog-new").addEventListener("click", () => start(freshSeed()));
document.addEventListener("keydown", (event) => {
  const name = Object.keys(DIRECTIONS).find((key) => `Arrow${key[0].toUpperCase()}${key.slice(1)}` === event.key);
  if (name) {
    event.preventDefault();
    walk(name);
  }
});

const requestedSeed = new URL(location.href).searchParams.get("seed");
start(requestedSeed || freshSeed(), !requestedSeed);

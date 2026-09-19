import {
  createSession,
  DIRECTIONS,
  performMove,
  resetSession,
  STAGES,
  undoMove,
} from "./engine.js";

const board = document.querySelector("#board");
const stageNumber = document.querySelector("#stage-number");
const stageLabel = document.querySelector("#stage-label");
const stageTitle = document.querySelector("#stage-title");
const moveCount = document.querySelector("#move-count");
const catStatus = document.querySelector("#cat-status");
const hint = document.querySelector("#hint");
const message = document.querySelector("#message");
const undoButton = document.querySelector("#undo");
const resetButton = document.querySelector("#reset");
const nextButton = document.querySelector("#next-stage");

let stageIndex = 0;
let session = createSession(stageIndex);
let pointerStart = null;
let suppressClick = false;
let dragHistoryStart = null;
let dragMoved = false;\nlet latestPointer = null;\nlet dragFrame = 0;\nlet dragAxis = null;

const eventMessages = {
  start: "盤面をスワイプして穴を動かそう",
  "hole-moved": "穴が1マス動いた",
  "cat-fled": "ネコが反対方向へ逃げた！",
  "cat-blocked": "逃げ道がない。でも素面では落とせない",
  "cat-drank": "お酒を飲んで、ネコが酔っぱらった！",
  "cat-fell": "クリア！ 酔っぱらいネコを穴へ落とした",
};

function at(position, x, y) {
  return Boolean(position && position.x === x && position.y === y);
}

function render() {
  const { state, history } = session;
  const stage = STAGES[state.stageIndex];
  board.style.setProperty("--columns", state.width);
  board.replaceChildren();

  for (let y = 0; y < state.height; y += 1) {
    for (let x = 0; x < state.width; x += 1) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "cell";
      cell.dataset.x = String(x);
      cell.dataset.y = String(y);
      cell.setAttribute("role", "gridcell");
      cell.setAttribute("aria-label", `横${x + 1}、縦${y + 1}、空きマス`);

      if (state.walls.some((wall) => at(wall, x, y))) {
        cell.classList.add("wall");
        cell.disabled = true;
        cell.setAttribute("aria-label", `横${x + 1}、縦${y + 1}、壁`);
      } else if (at(state.hole, x, y)) {
        cell.classList.add("hole");
        cell.innerHTML = '<span aria-hidden="true"></span>';
        cell.setAttribute("aria-label", `横${x + 1}、縦${y + 1}、穴`);
      } else if (at(state.cat, x, y)) {
        cell.classList.add("cat", state.catState);
        cell.innerHTML = state.catState === "drunk"
          ? '<span aria-hidden="true">🐈</span><b aria-hidden="true">ふら〜</b>'
          : '<span aria-hidden="true">🐈</span>';
        cell.setAttribute("aria-label", `横${x + 1}、縦${y + 1}、${state.catState === "drunk" ? "酔っぱらい" : "素面"}ネコ`);
      } else if (at(state.alcohol, x, y)) {
        cell.classList.add("alcohol");
        cell.innerHTML = '<span aria-hidden="true">🍶</span>';
        cell.setAttribute("aria-label", `横${x + 1}、縦${y + 1}、お酒`);
      }
      board.append(cell);
    }
  }

  board.classList.toggle("celebrate", state.event === "cat-fell");
  board.classList.toggle("tipsy", state.event === "cat-drank");
  stageNumber.textContent = `${stage.id} / ${STAGES.length}`;
  stageLabel.textContent = `STAGE ${stage.id}`;
  stageTitle.textContent = stage.name;
  moveCount.textContent = String(state.moves);
  catStatus.textContent = state.cleared ? "落下！" : state.catState === "drunk" ? "酔っぱらい" : "素面";
  catStatus.dataset.state = state.cleared ? "cleared" : state.catState;
  hint.textContent = stage.hint;
  message.textContent = eventMessages[state.event] ?? eventMessages.start;
  undoButton.disabled = history.length === 0;
  nextButton.hidden = !state.cleared;
  nextButton.textContent = stageIndex === STAGES.length - 1 ? "最初のステージへ ↺" : "次のステージへ →";
}

function act(direction, { groupDrag = false } = {}) {
  if (!DIRECTIONS[direction] || session.state.cleared) return false;
  const previousMoves = session.state.moves;
  const before = structuredClone(session.state);
  session = performMove(session, direction);
  const moved = session.state.moves !== previousMoves;
  if (moved && groupDrag) {
    if (!dragHistoryStart) dragHistoryStart = before;
    session.history = [dragHistoryStart];
  }
  render();
  if (!moved) message.textContent = "その方向へは動かせない";
  return moved;
}

function directionFromDelta(dx, dy) {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 28) return null;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

function dragStep() {
  dragFrame = 0;
  if (!pointerStart || !latestPointer || session.state.cleared) return;

  const cell = board.querySelector(".cell");
  const cellSize = cell?.getBoundingClientRect().width ?? 48;
  const threshold = Math.max(30, cellSize * 0.82);
  const dx = latestPointer.x - pointerStart.x;
  const dy = latestPointer.y - pointerStart.y;

  if (!dragAxis && Math.max(Math.abs(dx), Math.abs(dy)) >= threshold * 0.45) {
    dragAxis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
  }

  const axisDelta = dragAxis === "x" ? dx : dragAxis === "y" ? dy : 0;
  if (Math.abs(axisDelta) >= threshold) {
    const direction = dragAxis === "x"
      ? (axisDelta > 0 ? "right" : "left")
      : (axisDelta > 0 ? "down" : "up");
    const moved = act(direction, { groupDrag: true });
    dragMoved ||= moved;

    if (moved) {
      if (direction === "right") pointerStart.x += threshold;
      if (direction === "left") pointerStart.x -= threshold;
      if (direction === "down") pointerStart.y += threshold;
      if (direction === "up") pointerStart.y -= threshold;
    } else {
      pointerStart.x = latestPointer.x;
      pointerStart.y = latestPointer.y;
    }
  }

  if (pointerStart) dragFrame = requestAnimationFrame(dragStep);
}

function startDragLoop() {
  if (!dragFrame) dragFrame = requestAnimationFrame(dragStep);
}

function stopDragLoop() {
  if (dragFrame) cancelAnimationFrame(dragFrame);
  dragFrame = 0;
}

board.addEventListener("pointerdown", (event) => {
  pointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY };
  latestPointer = { x: event.clientX, y: event.clientY };
  dragHistoryStart = null;
  dragMoved = false;
  board.setPointerCapture?.(event.pointerId);
  startDragLoop();
});

board.addEventListener("pointermove", (event) => {
  if (!pointerStart || pointerStart.id !== event.pointerId) return;
  latestPointer = { x: event.clientX, y: event.clientY };
  startDragLoop();
});

board.addEventListener("pointerup", (event) => {
  if (!pointerStart || pointerStart.id !== event.pointerId) return;
  latestPointer = { x: event.clientX, y: event.clientY };
  if (!dragMoved) {
    const direction = directionFromDelta(event.clientX - pointerStart.x, event.clientY - pointerStart.y);
    if (direction) dragMoved = act(direction, { groupDrag: true });
  }
  suppressClick = dragMoved;
  stopDragLoop();
  pointerStart = null;
  latestPointer = null;
  dragHistoryStart = null;
});

board.addEventListener("pointercancel", () => {
  stopDragLoop();
  pointerStart = null;
  latestPointer = null;
  dragHistoryStart = null;
  dragMoved = false;
});

board.addEventListener("click", (event) => {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  if (event.detail === 0) return;
  const cell = event.target.closest(".cell");
  if (!cell || pointerStart) return;
  const dx = Number(cell.dataset.x) - session.state.hole.x;
  const dy = Number(cell.dataset.y) - session.state.hole.y;
  if (Math.abs(dx) + Math.abs(dy) !== 1) return;
  if (dx === 1) act("right");
  if (dx === -1) act("left");
  if (dy === 1) act("down");
  if (dy === -1) act("up");
});

window.addEventListener("keydown", (event) => {
  const direction = { ArrowUp: "up", ArrowRight: "right", ArrowDown: "down", ArrowLeft: "left" }[event.key];
  if (!direction) return;
  event.preventDefault();
  act(direction);
});

undoButton.addEventListener("click", () => {
  session = undoMove(session);
  session.state.event = "start";
  render();
});

resetButton.addEventListener("click", () => {
  session = resetSession(session);
  render();
});

nextButton.addEventListener("click", () => {
  stageIndex = (stageIndex + 1) % STAGES.length;
  session = createSession(stageIndex);
  render();
  document.querySelector(".stage-card").scrollIntoView({ block: "start", behavior: "smooth" });
});

render();

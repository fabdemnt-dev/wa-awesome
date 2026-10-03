// Build: build-id-366 · PR #366
import {
  cloneState,
  createSession,
  DIRECTIONS,
  performMove,
  resetSession,
  STAGES,
  undoMove,
} from "./engine.js";
import { createGesture, isTapGesture, moveGesture } from "./controls.js?v=build-id-366";

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
const directionButtons = document.querySelectorAll("[data-direction]");

let stageIndex = 0;
let session = createSession(stageIndex);
let gesture = null;
let gestureStart = null;
let gestureHistory = null;
let tapCell = null;

const eventMessages = {
  start: "なぞって移動。1マスずつなら矢印ボタン",
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
  directionButtons.forEach((button) => { button.disabled = state.cleared; });
  nextButton.hidden = !state.cleared;
  nextButton.textContent = stageIndex === STAGES.length - 1 ? "最初のステージへ ↺" : "次のステージへ →";
}

function act(direction, { groupDrag = false } = {}) {
  if (!DIRECTIONS[direction] || session.state.cleared) return false;
  const previousMoves = session.state.moves;
  session = performMove(session, direction);
  const moved = session.state.moves !== previousMoves;
  if (moved && groupDrag) {
    session.history = [...gestureHistory, gestureStart];
  }
  render();
  if (!moved) message.textContent = "その方向へは動かせない";
  return moved;
}

function tapAdjacentCell(cell) {
  if (!cell || session.state.cleared) return;
  const dx = Number(cell.dataset.x) - session.state.hole.x;
  const dy = Number(cell.dataset.y) - session.state.hole.y;
  if (Math.abs(dx) + Math.abs(dy) !== 1) return;
  act(dx === 1 ? "right" : dx === -1 ? "left" : dy === 1 ? "down" : "up");
}

function finishGesture() {
  const pointerId = gesture?.pointerId;
  gesture = null;
  gestureStart = null;
  gestureHistory = null;
  tapCell = null;
  if (pointerId !== undefined && board.hasPointerCapture?.(pointerId)) {
    board.releasePointerCapture(pointerId);
  }
}

function updateGesture(event) {
  moveGesture(gesture, { x: event.clientX, y: event.clientY },
    (direction) => act(direction, { groupDrag: true }));
}

board.addEventListener("pointerdown", (event) => {
  if (gesture || event.isPrimary === false || event.button !== 0 || session.state.cleared) return;
  gesture = createGesture({
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    boardWidth: board.getBoundingClientRect().width,
  });
  gestureStart = cloneState(session.state);
  gestureHistory = [...session.history];
  tapCell = event.target.closest(".cell");
  board.setPointerCapture?.(event.pointerId);
});

board.addEventListener("pointermove", (event) => {
  if (!gesture || gesture.pointerId !== event.pointerId) return;
  updateGesture(event);
});

board.addEventListener("pointerup", (event) => {
  if (!gesture || gesture.pointerId !== event.pointerId) return;
  updateGesture(event);
  const cell = isTapGesture(gesture) ? tapCell : null;
  finishGesture();
  tapAdjacentCell(cell);
});

for (const type of ["pointercancel", "lostpointercapture"]) {
  board.addEventListener(type, (event) => {
    if (gesture?.pointerId === event.pointerId) finishGesture();
  });
}
window.addEventListener("blur", finishGesture);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) finishGesture();
});

// Physical taps are handled at pointerup before capture retargets the click.
// Keep detail=0 clicks for keyboard and assistive-technology activation.
board.addEventListener("click", (event) => {
  if (event.detail !== 0 || gesture) return;
  tapAdjacentCell(event.target.closest(".cell"));
});

directionButtons.forEach((button) => button.addEventListener("click", () => {
  finishGesture();
  act(button.dataset.direction);
}));

window.addEventListener("keydown", (event) => {
  const direction = { ArrowUp: "up", ArrowRight: "right", ArrowDown: "down", ArrowLeft: "left" }[event.key];
  if (!direction) return;
  event.preventDefault();
  if (event.repeat) return;
  finishGesture();
  act(direction);
});

undoButton.addEventListener("click", () => {
  finishGesture();
  session = undoMove(session);
  session.state.event = "start";
  render();
});

resetButton.addEventListener("click", () => {
  finishGesture();
  session = resetSession(session);
  render();
});

nextButton.addEventListener("click", () => {
  finishGesture();
  stageIndex = (stageIndex + 1) % STAGES.length;
  session = createSession(stageIndex);
  render();
  document.querySelector(".stage-card").scrollIntoView({ block: "start", behavior: "smooth" });
});

render();

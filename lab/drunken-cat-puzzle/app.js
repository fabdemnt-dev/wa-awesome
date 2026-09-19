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

function act(direction) {
  if (!DIRECTIONS[direction] || session.state.cleared) return;
  const previousMoves = session.state.moves;
  session = performMove(session, direction);
  render();
  if (session.state.moves === previousMoves) message.textContent = "その方向へは動かせない";
}

function directionFromDelta(dx, dy) {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 28) return null;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

board.addEventListener("pointerdown", (event) => {
  pointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY };
  board.setPointerCapture?.(event.pointerId);
});

board.addEventListener("pointerup", (event) => {
  if (!pointerStart || pointerStart.id !== event.pointerId) return;
  const direction = directionFromDelta(event.clientX - pointerStart.x, event.clientY - pointerStart.y);
  pointerStart = null;
  suppressClick = Boolean(direction);
  if (direction) act(direction);
});

board.addEventListener("pointercancel", () => { pointerStart = null; });

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

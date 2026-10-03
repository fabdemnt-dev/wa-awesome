// This harness executes the real app/controller/engine with a small DOM stub.
// It verifies event integration, not browser layout or Android hardware feel.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import * as engine from "../lab/drunken-cat-puzzle/engine.js";
import * as controls from "../lab/drunken-cat-puzzle/controls.js";

const source = (await readFile(new URL("../lab/drunken-cat-puzzle/app.js", import.meta.url), "utf8"))
  .replace(/^import[\s\S]*?from "[^"\n]+";\n/gm, "");

class Element {
  constructor() {
    this.dataset = {};
    this.children = [];
    this.listeners = new Map();
    this.classes = new Set();
    this.classList = { add: (...names) => names.forEach((name) => this.classes.add(name)), toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) };
    this.style = { setProperty() {} };
    this.capture = null;
  }
  setAttribute(name, value) { this[name] = value; }
  replaceChildren() { this.children = []; }
  append(child) { this.children.push(child); }
  closest(selector) { return selector === ".cell" && this.className === "cell" ? this : null; }
  addEventListener(type, handler) { const handlers = this.listeners.get(type) ?? []; handlers.push(handler); this.listeners.set(type, handlers); }
  emit(type, event = {}) { for (const handler of this.listeners.get(type) ?? []) handler({ target: this, ...event }); }
  getBoundingClientRect() { return { width: this.width ?? 300 }; }
  setPointerCapture(id) { this.capture = id; }
  hasPointerCapture(id) { return this.capture === id; }
  releasePointerCapture(id) { if (this.capture === id) { this.capture = null; this.emit("lostpointercapture", { pointerId: id }); } }
  scrollIntoView() {}
}

function harness(stage = 1) {
  const selectors = ["board", "stage-number", "stage-label", "stage-title", "move-count", "cat-status", "hint", "message", "undo", "reset", "next-stage", "stage-card"];
  const elements = Object.fromEntries(selectors.map((id) => [`#${id}`, new Element()]));
  elements[".stage-card"] = elements["#stage-card"];
  const directions = Object.fromEntries(Object.keys(engine.DIRECTIONS).map((direction) => {
    const element = new Element(); element.dataset.direction = direction; return [direction, element];
  }));
  const document = new Element();
  document.querySelector = (selector) => elements[selector];
  document.querySelectorAll = () => Object.values(directions);
  document.createElement = () => new Element();
  const window = new Element();
  const context = vm.createContext({ ...engine, ...controls, document, window });
  vm.runInContext(source, context);
  vm.runInContext(`stageIndex = ${stage}; session = createSession(stageIndex); render();`, context);
  const board = elements["#board"];
  const state = () => JSON.parse(vm.runInContext("JSON.stringify(session)", context));
  const cell = (x, y) => board.children.find((item) => item.dataset.x === String(x) && item.dataset.y === String(y));
  const pointer = (type, x, y, options = {}) => board.emit(type, { clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0, ...options });
  const drag = (points) => {
    pointer("pointerdown", ...points[0]);
    points.slice(1).forEach((point) => pointer("pointermove", ...point));
    pointer("pointerup", ...points.at(-1));
  };
  return { board, elements, directions, document, window, state, cell, pointer, drag };
}

test("ドラッグ後に別方向へ続けて操作でき、イベント後に追加移動しない", () => {
  const h = harness();
  h.drag([[0, 0], [42, 0]]);
  assert.deepEqual(h.state().state.hole, { x: 3, y: 2 });
  h.drag([[0, 0], [0, 42]]);
  assert.deepEqual(h.state().state.hole, { x: 3, y: 3 });
  assert.equal(h.state().state.moves, 2);
  h.pointer("pointermove", 200, 200);
  assert.equal(h.state().state.moves, 2);
});

test("pointermoveのない素早いスワイプも離した同じ閾値で処理する", () => {
  const h = harness();
  h.pointer("pointerdown", 0, 0);
  h.pointer("pointerup", 28, 0);
  assert.equal(h.state().state.moves, 0);
  h.pointer("pointerdown", 0, 0);
  h.pointer("pointerup", 84, 0);
  assert.equal(h.state().state.moves, 2);
});

test("長いドラッグは1回のundoで戻り、さらにその前の操作も戻せる", () => {
  const h = harness();
  h.directions.down.emit("click");
  const beforeDrag = h.state().state;
  h.drag([[0, 0], [84, 0]]);
  assert.equal(h.state().state.moves, 3);
  assert.equal(h.state().history.length, 2);
  h.elements["#undo"].emit("click");
  assert.deepEqual(h.state().state, { ...beforeDrag, event: "start" });
  h.elements["#undo"].emit("click");
  assert.equal(h.state().state.moves, 0);
  assert.deepEqual(h.state().state.hole, { x: 2, y: 2 });
});

test("タップはpointer capture下でも1マス動き、生成clickで二重移動しない", () => {
  const h = harness();
  const target = h.cell(3, 2);
  h.pointer("pointerdown", 20, 20, { target });
  h.pointer("pointerup", 20, 20);
  assert.equal(h.state().state.moves, 1);
  h.board.emit("click", { detail: 1, target: h.cell(4, 2) });
  assert.equal(h.state().state.moves, 1);
});

test("短いドラッグ・壁へのドラッグを隣のマスのタップに変換しない", () => {
  const h = harness();
  h.pointer("pointerdown", 20, 20, { target: h.cell(3, 2) });
  h.pointer("pointerup", 40, 20);
  assert.equal(h.state().state.moves, 0);
  const wall = harness(0);
  wall.pointer("pointerdown", 100, 0, { target: wall.cell(2, 2) });
  wall.pointer("pointerup", 0, 0);
  assert.equal(wall.state().state.moves, 0);
  wall.board.emit("click", { detail: 1, target: wall.cell(2, 2) });
  assert.equal(wall.state().state.moves, 0);
});

test("キャンセル・キャプチャ消失・画面切替後は古い指イベントを無視する", () => {
  for (const stop of ["pointercancel", "lostpointercapture", "blur", "hidden"]) {
    const h = harness();
    h.pointer("pointerdown", 0, 0);
    if (stop === "blur") h.window.emit("blur");
    else if (stop === "hidden") { h.document.hidden = true; h.document.emit("visibilitychange"); }
    else h.pointer(stop, 0, 0);
    h.pointer("pointermove", 100, 0);
    h.pointer("pointerup", 100, 0);
    assert.equal(h.state().state.moves, 0, stop);
    h.drag([[0, 0], [0, 42]]);
    assert.equal(h.state().state.moves, 1, stop);
  }
});

test("2本目の指・別pointerのcancel・右クリックは操作を奪わない", () => {
  const h = harness();
  h.pointer("pointerdown", 0, 0);
  h.pointer("pointerdown", 100, 100, { pointerId: 2, isPrimary: false });
  h.pointer("pointercancel", 100, 100, { pointerId: 2 });
  h.pointer("pointermove", 0, 100, { pointerId: 2 });
  h.pointer("pointerup", 42, 0);
  assert.equal(h.state().state.moves, 1);
  h.pointer("pointerdown", 0, 0, { button: 2 });
  h.pointer("pointerup", 100, 0, { button: 2 });
  assert.equal(h.state().state.moves, 1);
});

test("リセット・undo・方向ボタンは進行中ドラッグを終了する", () => {
  for (const action of ["reset", "undo", "direction"]) {
    const h = harness();
    h.pointer("pointerdown", 0, 0);
    h.pointer("pointermove", 42, 0);
    if (action === "direction") h.directions.down.emit("click");
    else h.elements[`#${action}`].emit("click");
    const before = h.state();
    h.pointer("pointerup", 200, 0);
    assert.deepEqual(h.state(), before, action);
  }
});

test("方向ボタンは各clickで1マス、長押しのkeydown repeatでは追加移動しない", () => {
  const h = harness();
  h.directions.right.emit("click");
  assert.equal(h.state().state.moves, 1);
  h.window.emit("keydown", { key: "ArrowDown", repeat: false, preventDefault() {} });
  assert.equal(h.state().state.moves, 2);
  h.window.emit("keydown", { key: "ArrowDown", repeat: true, preventDefault() {} });
  assert.equal(h.state().state.moves, 2);
});

test("キーボード/支援技術の隣接セルclickも動く", () => {
  const h = harness();
  h.board.emit("click", { detail: 0, target: h.cell(3, 2) });
  assert.equal(h.state().state.moves, 1);
});

test("3ステージの実アプリを方向ボタンでクリアし、次ステージで再開できる", () => {
  for (let index = 0; index < engine.STAGES.length; index += 1) {
    const h = harness(index);
    engine.STAGES[index].solution.forEach((direction) => h.directions[direction].emit("click"));
    assert.equal(h.state().state.cleared, true);
    assert.equal(h.elements["#next-stage"].hidden, false);
    assert.ok(Object.values(h.directions).every((button) => button.disabled));
    const completed = h.state();
    h.drag([[0, 0], [200, 0]]);
    h.board.emit("click", { detail: 0, target: h.cell(2, 2) });
    assert.deepEqual(h.state(), completed);
    h.elements["#next-stage"].emit("click");
    assert.equal(h.state().state.stageIndex, (index + 1) % 3);
    assert.equal(h.state().state.moves, 0);
    assert.ok(Object.values(h.directions).every((button) => !button.disabled));
  }
});

test("STAGE 2は指を離さず右から下へ曲がってクリアできる", () => {
  const h = harness();
  h.drag([[0, 0], [82, 0], [82, 82]]);
  assert.equal(h.state().state.cleared, true);
  assert.equal(h.state().state.moves, 4);
});


test("全ステージの実アプリでAndroid相当の盤面幅ごとに同じ距離を使う", () => {
  for (const width of [242, 282, 312, 342, 522]) {
    for (let index = 0; index < engine.STAGES.length; index += 1) {
      const h = harness(index);
      h.board.width = width;
      const threshold = controls.dragThreshold(width);
      h.pointer("pointerdown", 0, 0);
      h.pointer("pointermove", threshold - 0.001, 0);
      assert.equal(h.state().state.moves, 0, `幅${width}・STAGE ${index + 1}`);
      h.pointer("pointermove", threshold, 0);
      assert.equal(h.state().state.moves, 1, `幅${width}・STAGE ${index + 1}`);
      h.pointer("pointerup", threshold, 0);
      assert.equal(h.state().state.moves, 1);
    }
  }
});

test("STAGE 2の壁へ押して1区切り戻ると、分割数に関係なく同じ穴位置になる", () => {
  for (const positions of [[184.5, 143.5], [41, 82, 123, 164, 184.5, 143.5]]) {
    const h = harness(1);
    h.drag([[0, 0], ...positions.map((x) => [x, 0])]);
    assert.deepEqual(h.state().state.hole, { x: 4, y: 2 });
    assert.equal(h.state().state.moves, 4);
  }
});

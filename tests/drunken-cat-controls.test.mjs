import assert from "node:assert/strict";
import test from "node:test";
import { createGesture, dragThreshold, isTapGesture, moveGesture } from "../lab/drunken-cat-puzzle/controls.js";

const start = (boardWidth = 300) => createGesture({ pointerId: 1, x: 0, y: 0, boardWidth });
function collect(gesture, positions) {
  const moves = [];
  for (const point of positions) moveGesture(gesture, point, (direction) => { moves.push(direction); return true; });
  return moves;
}

test("Android幅でも列数で感度が変わらず、Build 267のSTAGE 1基準を保つ", () => {
  for (const boardWidth of [242, 282, 312, 342, 522]) {
    const expected = Math.max(30, boardWidth / 6 * 0.82);
    assert.equal(dragThreshold(boardWidth), expected);
    for (const columns of [6, 7, 8]) {
      const gesture = start(boardWidth);
      assert.equal(collect(gesture, [{ x: expected - 0.001, y: 0 }]).length, 0, `${columns}列`);
      assert.deepEqual(collect(gesture, [{ x: expected, y: 0 }]), ["right"]);
    }
  }
});

test("28pxで離しても移動せず、移動中と指を離す時に同じ閾値を使う", () => {
  const gesture = start();
  assert.deepEqual(collect(gesture, [{ x: 28, y: 0 }, { x: 28, y: 0 }]), []);
  assert.equal(isTapGesture(gesture), false);
});

test("長いドラッグは距離分だけ連続移動し、停止後には追いかけ移動しない", () => {
  const gesture = start();
  const threshold = gesture.threshold;
  assert.deepEqual(collect(gesture, [{ x: threshold * 3.2, y: 0 }]), ["right", "right", "right"]);
  assert.deepEqual(collect(gesture, Array(120).fill({ x: threshold * 3.2, y: 0 })), []);
});

test("同じ直線距離ならpointermoveの分割数や速さで手数は変わらない", () => {
  const threshold = dragThreshold(300);
  for (const count of [1, 2, 3, 30, 120]) {
    const positions = Array.from({ length: count }, (_, index) => ({ x: threshold * 3.2 * (index + 1) / count, y: 0 }));
    assert.deepEqual(collect(start(), positions), ["right", "right", "right"]);
  }
});

test("新しい操作へ前の方向が残らず、水平の次に垂直へ移動できる", () => {
  assert.deepEqual(collect(start(), [{ x: 50, y: 0 }]), ["right"]);
  assert.deepEqual(collect(start(), [{ x: 0, y: 50 }]), ["down"]);
});

test("指を離さず直角に曲がれる", () => {
  const gesture = start();
  const t = gesture.threshold;
  assert.deepEqual(collect(gesture, [{ x: t * 2, y: 0 }, { x: t * 2, y: t * 2 }]), ["right", "right", "down", "down"]);
});

test("小さな斜めぶれは直進後の意図しない縦移動にならない", () => {
  const gesture = start();
  const t = gesture.threshold;
  assert.deepEqual(collect(gesture, [{ x: t, y: 12 }, { x: t * 2, y: 25 }, { x: t * 3, y: 38 }]), ["right", "right", "right"]);
  assert.deepEqual(collect(gesture, [{ x: t * 3, y: 40 }]), []);
});

test("壁にぶつかった余剰距離は溜めず、逆向きへ1区切り動かせば戻れる", () => {
  const gesture = start();
  let attempts = 0;
  moveGesture(gesture, { x: 300, y: 0 }, () => { attempts += 1; return false; });
  assert.equal(attempts, 1);
  assert.deepEqual(collect(gesture, [{ x: 300 - gesture.threshold, y: 0 }]), ["left"]);
});

test("タップ・小さな手ぶれ・ドラッグ後に元の位置へ戻る操作を区別する", () => {
  const gesture = start();
  collect(gesture, [{ x: 4, y: 3 }]);
  assert.equal(isTapGesture(gesture), true);
  collect(gesture, [{ x: 15, y: 0 }, { x: 0, y: 0 }]);
  assert.equal(isTapGesture(gesture), false);
});

test("各方向の端数は1区切り未満では移動にならない", () => {
  for (const [axis, sign, direction] of [["x", 1, "right"], ["x", -1, "left"], ["y", 1, "down"], ["y", -1, "up"]]) {
    const gesture = start();
    const point = { x: 0, y: 0, [axis]: gesture.threshold * sign * 2.99 };
    assert.deepEqual(collect(gesture, [point]), [direction, direction]);
    assert.deepEqual(collect(gesture, [point]), []);
  }
});

test("壁への閾値未満の余剰移動も捨て、イベント分割に関係なく同距離で折り返す", () => {
  for (const sign of [1, -1]) {
    for (const axis of ["x", "y"]) {
      for (const factors of [[3.5, 2.5], [1, 2, 3, 3.5, 2.5]]) {
        const gesture = start();
        let position = 0;
        const moves = [];
        for (const factor of factors) {
          moveGesture(gesture, { x: 0, y: 0, [axis]: factor * sign * gesture.threshold }, (direction) => {
            const delta = ["right", "down"].includes(direction) ? 1 : -1;
            if ((position + delta) * sign > 1) return false;
            position += delta;
            moves.push(direction);
            return true;
          });
        }
        assert.equal(position, 0, `${axis}/${sign}/${factors}`);
        assert.equal(moves.length, 2);
      }
    }
  }
});

test("壁へ押したまま垂直に曲がっても移動できる", () => {
  const gesture = start();
  const moves = [];
  const attempt = (direction) => { if (direction === "right") return false; moves.push(direction); return true; };
  moveGesture(gesture, { x: 82, y: 0 }, attempt);
  moveGesture(gesture, { x: 90, y: 20 }, attempt);
  moveGesture(gesture, { x: 100, y: 41 }, attempt);
  assert.deepEqual(moves, ["down"]);
});

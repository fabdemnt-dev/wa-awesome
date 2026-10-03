import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createState,
  createSession,
  findSolution,
  moveHole,
  performMove,
  playDirections,
  resetSession,
  STAGES,
  undoMove,
} from "../lab/drunken-cat-puzzle/engine.js";

function withState(state, changes) {
  return { ...state, ...changes };
}

test("穴は上下左右へ1マスだけ動く", () => {
  const base = createState(1);
  for (const [direction, expected] of [
    ["up", { x: 2, y: 1 }],
    ["right", { x: 3, y: 2 }],
    ["down", { x: 2, y: 3 }],
    ["left", { x: 1, y: 2 }],
  ]) {
    const state = withState(base, { hole: { x: 2, y: 2 }, cat: { x: 5, y: 5 } });
    assert.deepEqual(moveHole(state, direction).state.hole, expected);
  }
});

test("壁と盤面外へは移動できない", () => {
  const state = createState(0);
  assert.equal(moveHole(state, "left").moved, false);
  const boundary = withState(state, { hole: { x: 0, y: 0 }, walls: [] });
  assert.equal(moveHole(boundary, "up").moved, false);
});

test("素面ネコは穴と反対方向へ1マスだけ逃げ、ランダム性も連鎖もない", () => {
  const start = createState(0);
  const result = moveHole(start, "right");
  assert.equal(result.moved, true);
  assert.deepEqual(result.state.hole, { x: 2, y: 2 });
  assert.deepEqual(result.state.cat, { x: 4, y: 2 });
  assert.equal(result.state.catState, "drunk");
  assert.equal(result.state.moves, 1);
});

test("逃げ先が塞がると素面ネコは動かず、穴にも落ちない", () => {
  const base = createState(1);
  const state = withState(base, {
    hole: { x: 2, y: 3 },
    cat: { x: 3, y: 3 },
    walls: [...base.walls, { x: 4, y: 3 }],
  });
  const blocked = moveHole(state, "up");
  assert.deepEqual(blocked.state.cat, { x: 3, y: 3 });
  assert.equal(blocked.state.catState, "sober");
  const intoSoberCat = withState(blocked.state, { hole: { x: 2, y: 3 } });
  assert.equal(moveHole(intoSoberCat, "right").moved, false);
});

test("お酒で酔い、消費後は逃げず、穴へ落ちるとクリアする", () => {
  const drank = moveHole(createState(0), "right").state;
  assert.equal(drank.catState, "drunk");
  assert.equal(drank.alcohol, null);
  const approached = moveHole(drank, "right").state;
  assert.deepEqual(approached.cat, { x: 4, y: 2 });
  const cleared = moveHole(approached, "right").state;
  assert.equal(cleared.cat, null);
  assert.equal(cleared.cleared, true);
  assert.equal(cleared.event, "cat-fell");
});

test("3ステージすべてに実際にクリアできる解法がある", () => {
  assert.equal(STAGES.length, 3);
  STAGES.forEach((stage, index) => {
    const solution = stage.solution.length ? stage.solution : findSolution(index);
    assert.ok(solution, `STAGE ${stage.id} has no solution`);
    assert.equal(playDirections(index, solution).cleared, true, `STAGE ${stage.id} solution failed`);
  });
});

test("一手戻すは穴・ネコ状態・お酒・手数を復元し、リセットは初期状態へ戻す", () => {
  let session = createSession(0);
  session = performMove(session, "right");
  assert.equal(session.state.catState, "drunk");
  assert.equal(session.state.alcohol, null);
  assert.equal(session.state.moves, 1);

  session = undoMove(session);
  assert.deepEqual(session.state, createState(0));

  session = performMove(session, "right");
  session = performMove(session, "right");
  session = resetSession(session);
  assert.deepEqual(session.state, createState(0));
  assert.deepEqual(session.history, []);
});

test("試作ページは必要な操作UIとスマホ向け設定を持ち、認証には依存しない", async () => {
  const folder = new URL("../lab/drunken-cat-puzzle/", import.meta.url);
  const [html, script, css, controls, engine] = await Promise.all(
    ["index.html", "app.js", "style.css", "controls.js", "engine.js"].map((name) => readFile(new URL(name, folder), "utf8")),
  );
  for (const id of ["stage-number", "move-count", "board", "reset", "undo", "next-stage"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  for (const direction of ["up", "right", "down", "left"]) {
    assert.match(html, new RegExp(`data-direction="${direction}"`));
  }
  assert.match(html, /遊び方/);
  assert.match(html, /noindex, nofollow/);
  for (const source of [html, script, css, controls, engine]) {
    assert.ok(!source.includes(String.fromCharCode(92) + "n"), "公開ファイルに文字列の改行記号を混入させない");
    assert.doesNotMatch(source, /firebase|google.*auth|signInWith/i);
  }
  assert.match(script, /pointerdown/);
  assert.match(script, /pointerup/);
  assert.match(script, /pointermove/);
  assert.match(script, /pointercancel/);
  assert.match(script, /lostpointercapture/);
  assert.doesNotMatch(script + controls, /requestAnimationFrame|setInterval|setTimeout/);
  assert.match(css, /touch-action:\s*none/);
  assert.match(css, /min-height:\s*48px/);
  for (const source of [html, script, css, controls]) {
    assert.match(source, /Build: build-id-366 · PR #366/);
    assert.doesNotMatch(source, /controls-preview|未公開検証版/);
  }
  assert.match(html, /style\.css\?v=build-id-366/);
  assert.match(html, /app\.js\?v=build-id-366/);
  assert.match(script, /controls\.js\?v=build-id-366/);
});

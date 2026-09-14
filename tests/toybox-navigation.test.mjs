import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const home = await readFile(new URL("../index.html", import.meta.url), "utf8");
const toybox = await readFile(new URL("../toybox/index.html", import.meta.url), "utf8");
const moonScaleSelect = await readFile(new URL("../moon-scale-duel-select.html", import.meta.url), "utf8");

test("トップページからおもちゃ箱へ移動できる", () => {
  assert.match(home, /href="toybox\/"[^>]*class="card-panel"/);
  assert.match(home, /🎪 おもちゃ箱/);
  assert.doesNotMatch(home, /href="shadow-card\.html"/);
});

test("おもちゃ箱から影札の交渉へ移動できる", () => {
  assert.match(toybox, /href="\.\.\/shadow-card\.html"[^>]*class="card-panel"/);
  assert.match(toybox, /🃏 影札の交渉/);
});

test("おもちゃ箱から月秤の決闘のモード選択へ移動できる", () => {
  assert.match(toybox, /href="\.\.\/moon-scale-duel-select\.html"[^>]*class="card-panel"/);
  assert.doesNotMatch(toybox, /href="\.\.\/moon-scale-duel\/"[^>]*class="card-panel"/);
});

test("月秤の決闘で既存の1人用と2人用を選べる", () => {
  assert.match(moonScaleSelect, /href="moon-scale-duel\/"/);
  assert.match(moonScaleSelect, />1人で遊ぶ</);
  assert.match(moonScaleSelect, /href="moon-scale-duel-online\.html"/);
  assert.match(moonScaleSelect, />2人で遊ぶ</);
  assert.match(moonScaleSelect, /href="toybox\/"/);
  assert.match(moonScaleSelect, /🎪 おもちゃ箱へ戻る/);
});

test("迷路試作への公開導線を含めない", () => {
  assert.doesNotMatch(home, /lab\/maze/i);
  assert.doesNotMatch(toybox, /lab\/maze/i);
});

test("既存の創作系導線を維持する", () => {
  assert.match(home, /href="poem\.html"/);
  assert.match(home, /href="haiku\.html"/);
  assert.match(home, /href="wordset\.html"/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const home = await readFile(new URL("../index.html", import.meta.url), "utf8");
const toybox = await readFile(new URL("../toybox/index.html", import.meta.url), "utf8");
const moonScaleSelect = await readFile(new URL("../moon-scale-duel-select.html", import.meta.url), "utf8");
const moonScaleCpu = await readFile(new URL("../moon-scale-duel/index.html", import.meta.url), "utf8");
const moonScaleRules = await readFile(new URL("../functions/moon-scale-duel-online/rules.js", import.meta.url), "utf8");

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

test("月秤の決闘の入口から遊び方を開いてタイトルへ戻れる", () => {
  assert.match(moonScaleSelect, /id="title-screen"[^>]*aria-labelledby="mode-heading"/);
  assert.match(moonScaleSelect, /id="show-rules-button"[^>]*type="button"[^>]*aria-controls="rules-screen"[^>]*aria-expanded="false"/);
  assert.match(moonScaleSelect, />遊び方</);
  assert.match(moonScaleSelect, /id="rules-screen"[^>]*aria-labelledby="rules-heading"[^>]*hidden/);
  assert.match(moonScaleSelect, /id="back-to-title-button"[^>]*type="button"[^>]*aria-controls="title-screen"/);
  assert.match(moonScaleSelect, />タイトルへ戻る</);
  assert.match(moonScaleSelect, /titleScreen\.hidden = showingRules/);
  assert.match(moonScaleSelect, /rulesScreen\.hidden = !showingRules/);
  assert.match(moonScaleSelect, /setAttribute\('aria-expanded', String\(showingRules\)\)/);
  assert.match(moonScaleSelect, /rulesHeading : modeHeading\)\.focus/);
});

test("月秤の遊び方表示中はモード選択を隠し、戻ると再び操作できる", () => {
  const listeners = new Map();
  const makeElement = (id) => ({
    id,
    hidden: id === "rules-screen",
    attributes: {},
    focusCount: 0,
    addEventListener(type, listener) { listeners.set(`${id}:${type}`, listener); },
    setAttribute(name, value) { this.attributes[name] = value; },
    focus() { this.focusCount += 1; },
  });
  const elements = Object.fromEntries([
    "title-screen", "rules-screen", "show-rules-button", "back-to-title-button", "mode-heading", "rules-heading",
  ].map((id) => [id, makeElement(id)]));
  const script = moonScaleSelect.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  vm.runInNewContext(script, {
    document: { getElementById: (id) => elements[id] },
    window: { scrollTo() {} },
  });

  listeners.get("show-rules-button:click")();
  assert.equal(elements["title-screen"].hidden, true);
  assert.equal(elements["rules-screen"].hidden, false);
  assert.equal(elements["show-rules-button"].attributes["aria-expanded"], "true");
  assert.equal(elements["rules-heading"].focusCount, 1);

  listeners.get("back-to-title-button:click")();
  assert.equal(elements["title-screen"].hidden, false);
  assert.equal(elements["rules-screen"].hidden, true);
  assert.equal(elements["show-rules-button"].attributes["aria-expanded"], "false");
  assert.equal(elements["mode-heading"].focusCount, 1);
});

test("月秤の遊び方は実装済みの月影と月札ルールを案内する", () => {
  for (const cardName of ["満ちる月", "欠ける月", "返照の月", "静止の月", "新月の誓い", "偽りの月"]) {
    assert.match(moonScaleSelect, new RegExp(cardName));
  }
  assert.match(moonScaleSelect, /月影10から始まり/);
  assert.match(moonScaleSelect, /0〜15/);
  assert.match(moonScaleSelect, /全6ラウンド/);
  assert.match(moonScaleSelect, /自分の月影を3増やします/);
  assert.match(moonScaleSelect, /相手の月影を3減らします/);
  assert.match(moonScaleSelect, /双方の返照の月が有効なら相殺/);
  assert.match(moonScaleSelect, /双方が静止の月を出した場合は互いに無効化/);
  assert.match(moonScaleSelect, /双方の月影を7にします/);
  assert.match(moonScaleSelect, /模倣できるのは「満ちる月」「欠ける月」「返照の月」/);
  assert.match(moonScaleSelect, /片方だけ月影0/);
  assert.match(moonScaleSelect, /双方とも月影0/);
  assert.match(moonScaleSelect, /第6ラウンド終了時/);

  assert.match(moonScaleCpu, /const START_MOON = 10/);
  assert.match(moonScaleCpu, /const MAX_MOON = 15/);
  assert.match(moonScaleCpu, /const MAX_ROUNDS = 6/);
  assert.match(moonScaleCpu, /const COPYABLE = \['waxing', 'waning', 'reflection', 'oath'\]/);
  assert.match(moonScaleRules, /const MAX_MOON = 15/);
  assert.match(moonScaleRules, /COPYABLE = Object\.freeze\(\['waxing', 'waning', 'reflection', 'oath'\]\)/);
  assert.match(moonScaleRules, /if \(after\.seat1 === 0 && after\.seat2 === 0\) outcome = 'draw'/);
  assert.match(moonScaleRules, /else if \(round === 6\)/);
});

test("月秤の遊び方は既存の6枚の月札画像を使う", () => {
  for (const image of ["moon-full", "moon-waning", "moon-reflection", "moon-still", "moon-new-oath", "moon-false"]) {
    assert.match(moonScaleSelect, new RegExp(`moon-scale-duel/assets/images/cards/${image}\\.webp`));
  }
  assert.equal((moonScaleSelect.match(/src="moon-scale-duel\/assets\/images\/cards\//g) || []).length, 6);
});

test("月秤の遊び方は月札画像をスマホ向けの固定範囲へ収める", () => {
  assert.match(moonScaleSelect, /\.card-guide\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(moonScaleSelect, /\.card-guide img\s*\{[^}]*width:\s*100%[^}]*height:\s*clamp\(8\.5rem,\s*42vw,\s*10\.5rem\)[^}]*object-fit:\s*cover/s);
  assert.match(moonScaleSelect, /@media \(max-width:\s*350px\)\s*\{\s*\.card-guide\s*\{\s*grid-template-columns:\s*1fr/s);
  assert.equal((moonScaleSelect.match(/class="card-guide-image"/g) || []).length, 6);
  assert.equal((moonScaleSelect.match(/aria-label="[^"]+の札を大きく見る"/g) || []).length, 6);
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

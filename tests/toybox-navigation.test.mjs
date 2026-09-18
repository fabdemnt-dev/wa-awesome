import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const home = await readFile(new URL("../index.html", import.meta.url), "utf8");
const toybox = await readFile(new URL("../toybox/index.html", import.meta.url), "utf8");
const shadowCard = await readFile(new URL("../shadow-card.html", import.meta.url), "utf8");
const shadowCardCss = await readFile(new URL("../shadow-card.css", import.meta.url), "utf8");
const shadowCardUi = await readFile(new URL("../shadow-card-ui.js", import.meta.url), "utf8");
const moonScaleSelect = await readFile(new URL("../moon-scale-duel-select.html", import.meta.url), "utf8");
const moonScaleCpu = await readFile(new URL("../moon-scale-duel/index.html", import.meta.url), "utf8");
const moonScaleOnlineState = await readFile(new URL("../moon-scale-duel-online-state.js", import.meta.url), "utf8");
const moonScaleRules = await readFile(new URL("../functions/moon-scale-duel-online/rules.js", import.meta.url), "utf8");
const twinShadowCaskets = await readFile(new URL("../twin-shadow-caskets/index.html", import.meta.url), "utf8");
const birdcageObserver = await readFile(new URL("../birdcage-observer/index.html", import.meta.url), "utf8");
const deepMiningAgreement = await readFile(new URL("../deep-mining-agreement/index.html", import.meta.url), "utf8");

test("トップページからおもちゃ箱へ移動できる", () => {
  assert.match(home, /href="toybox\/"[^>]*class="card-panel"/);
  assert.match(home, /🎪 おもちゃ箱/);
  assert.doesNotMatch(home, /href="shadow-card\.html"/);
});

test("おもちゃ箱から影札の交渉へ移動できる", () => {
  assert.match(toybox, /href="\.\.\/shadow-card\.html"[^>]*class="card-panel"/);
  assert.match(toybox, /🃏 影札の交渉/);
});

test("影札はmain全体の巨大なフォーカス枠だけを除外する", () => {
  assert.match(shadowCard, /<main id="app" class="app" tabindex="-1">/);
  assert.match(shadowCardCss, /:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--color-focus\)[^}]*outline-offset:\s*3px/s);
  assert.match(shadowCardCss, /#app:focus-visible\s*\{[^}]*outline:\s*none/s);
  assert.match(shadowCardUi, /element\("app"\)\.focus\(\{ preventScroll: true \}\)/);
});

test("おもちゃ箱から月秤の決闘のモード選択へ移動できる", () => {
  assert.match(toybox, /href="\.\.\/moon-scale-duel-select\.html"[^>]*class="card-panel"/);
  assert.doesNotMatch(toybox, /href="\.\.\/moon-scale-duel\/"[^>]*class="card-panel"/);
});

test("おもちゃ箱から双影の宝匣へ移動して戻れる", () => {
  assert.match(toybox, /href="\.\.\/twin-shadow-caskets\/"[^>]*class="card-panel"/);
  assert.match(toybox, /🗝️ 双影の宝匣/);
  assert.doesNotMatch(toybox, /Twin Shadow Caskets/);
  assert.match(twinShadowCaskets, /Twin Shadow Caskets/);
  assert.match(twinShadowCaskets, /href="\.\.\/toybox\/"/);
  assert.match(twinShadowCaskets, /🎪 おもちゃ箱へ戻る/);
  assert.match(toybox, /href="\.\.\/shadow-card\.html"[^>]*class="card-panel"/);
  assert.match(toybox, /href="\.\.\/moon-scale-duel-select\.html"[^>]*class="card-panel"/);
});

test("おもちゃ箱から鳥籠の観測者へ移動して戻れる", () => {
  assert.match(toybox, /href="\.\.\/birdcage-observer\/"[^>]*class="card-panel"/);
  assert.match(toybox, /鳥籠の観測者/);
  assert.match(birdcageObserver, /Birdcage Observer/);
  assert.match(birdcageObserver, /href="\.\.\/toybox\/"/);
  assert.match(birdcageObserver, /🎪 おもちゃ箱へ戻る/);
  assert.match(toybox, /href="\.\.\/shadow-card\.html"[^>]*class="card-panel"/);
  assert.match(toybox, /href="\.\.\/moon-scale-duel-select\.html"[^>]*class="card-panel"/);
  assert.match(toybox, /href="\.\.\/twin-shadow-caskets\/"[^>]*class="card-panel"/);
});

test("おもちゃ箱から1人用の深層採掘協定へ移動して戻れる", () => {
  assert.match(toybox, /href="\.\.\/deep-mining-agreement\/"[^>]*class="card-panel"/);
  assert.match(toybox, /⛏️ 深層採掘協定/);
  assert.match(toybox, /<p class="game-desc">崩落と駆け引きをくぐり抜け、最も高い価値を持ち帰ろう。<\/p>/);
  assert.match(deepMiningAgreement, /<title>深層採掘協定｜初版プロトタイプ<\/title>/);
  assert.match(toybox, /href="\.\.\/shadow-card\.html"[^>]*class="card-panel"/);
  assert.match(toybox, /href="\.\.\/moon-scale-duel-select\.html"[^>]*class="card-panel"/);
  assert.match(toybox, /href="\.\.\/twin-shadow-caskets\/"[^>]*class="card-panel"/);
  assert.match(toybox, /href="\.\.\/birdcage-observer\/"[^>]*class="card-panel"/);
});

test("全5ゲームの現在対応人数を文字入りピルで表示する", () => {
  const cards = [
    ["影札の交渉", "1〜4人用", "player-count--1-4"],
    ["月秤の決闘", "1〜2人用", "player-count--1-2"],
    ["双影の宝匣", "1人用", "player-count--1"],
    ["鳥籠の観測者", "1人用", "player-count--1"],
    ["深層採掘協定", "1人用", "player-count--1"],
  ];

  for (const [title, count, colorClass] of cards) {
    const pattern = new RegExp(`<div class="game-heading"><div class="game-title">[^<]*${title}</div><span class="player-count ${colorClass}">${count}</span></div>`);
    assert.match(toybox, pattern);
  }

  assert.equal((toybox.match(/class="player-count /g) || []).length, 5);
  assert.equal((toybox.match(/player-count--1-4">1〜4人用/g) || []).length, 1);
  assert.equal((toybox.match(/player-count--1-2">1〜2人用/g) || []).length, 1);
  assert.equal((toybox.match(/player-count--1">1人用/g) || []).length, 3);
  assert.match(toybox, /\.player-count--1\s*\{[^}]*background:\s*#ecfdf5[^}]*color:\s*#166534/s);
  assert.match(toybox, /\.player-count--1-2\s*\{[^}]*background:\s*#f5f3ff[^}]*color:\s*#5b21b6/s);
  assert.match(toybox, /\.player-count--1-4\s*\{[^}]*background:\s*#fff7ed[^}]*color:\s*#9a3412/s);
  assert.doesNotMatch(toybox, /👤|👥/);
  assert.match(toybox, /\.card-panel\s*\{[^}]*position:\s*relative/s);
  assert.match(toybox, /\.player-count\s*\{[^}]*position:\s*absolute[^}]*top:\s*12px[^}]*right:\s*12px/s);
  assert.match(toybox, /\.player-count\s*\{[^}]*padding:\s*2px 8px[^}]*font-size:\s*10px/s);
  assert.match(toybox, /\.game-heading\s*\{[^}]*display:\s*flex[^}]*justify-content:\s*center[^}]*box-sizing:\s*border-box[^}]*min-height:\s*32px/s);
  assert.doesNotMatch(toybox, /\.game-heading\s*\{[^}]*(?:padding-right|padding-inline-end):/s);
  assert.match(toybox, /@media \(max-width:\s*360px\)\s*\{\s*\.game-heading\s*\{[^}]*padding-top:\s*32px/s);
  assert.match(toybox, /\.game-title\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(toybox, /\.player-count\s*\{[^}]*border-radius:\s*999px[^}]*white-space:\s*nowrap/s);
  assert.doesNotMatch(toybox, /\.game-heading\s*\{[^}]*position:\s*absolute/s);
  assert.doesNotMatch(toybox, /\.player-count\s*\{[^}]*min-width:/s);
  assert.doesNotMatch(toybox, /1人｜|NPCたちと|4人で深層を採掘/);
});

test("月秤の決闘で既存の1人用と2人用を選べる", () => {
  assert.match(moonScaleSelect, /class="mode-link mode-link--primary" href="moon-scale-duel\/">1人で遊ぶ<\/a>/);
  assert.match(moonScaleSelect, /class="mode-link mode-link--secondary" href="moon-scale-duel-online\.html">2人で遊ぶ<\/a>/);
  assert.match(moonScaleSelect, /href="toybox\/"/);
  assert.match(moonScaleSelect, /🎪 おもちゃ箱へ戻る/);
});

test("月秤の決闘はheader・main・footerを持つページ外枠を表示する", () => {
  assert.match(moonScaleSelect, /<div class="page-shell">\s*<header class="site-header">\s*<nav class="site-navigation"[^>]*>\s*<a class="top-link" href="toybox\/">← 🎪 おもちゃ箱へ戻る<\/a>\s*<\/nav>\s*<\/header>\s*<main class="page">/s);
  assert.match(moonScaleSelect, /<\/main>\s*<footer class="site-footer">\s*<small>月秤の決闘 — Original Web Card Game<\/small>\s*<\/footer>\s*<\/div>/s);
  assert.match(moonScaleSelect, /\.page-shell\s*\{[^}]*min-height:\s*100vh[^}]*flex-direction:\s*column/s);
  assert.match(moonScaleSelect, /\.top-link\s*\{[^}]*min-height:\s*44px[^}]*padding:\s*\.45rem 0[^}]*font-size:\s*\.82rem[^}]*font-weight:\s*700/s);
  assert.match(moonScaleSelect, /\.page\s*\{[^}]*flex:\s*1/s);
  assert.match(moonScaleSelect, /\.site-footer\s*\{[^}]*padding-top:\s*1rem[^}]*padding-bottom:\s*max\(1rem, env\(safe-area-inset-bottom\)\)[^}]*font-size:\s*\.72rem[^}]*text-align:\s*center/s);
  assert.doesNotMatch(moonScaleSelect, /\.site-footer\s*\{[^}]*(?:border|box-shadow|background)/s);
  assert.match(moonScaleSelect, /<main class="page">[\s\S]*id="title-screen"[\s\S]*id="rules-screen"[\s\S]*<\/main>/);
});

test("月秤の決闘の入口をオリジナルカードゲームのタイトル画面として表示する", () => {
  assert.match(moonScaleSelect, /<div class="moon-art"[^>]*>[\s\S]*?<p class="eyebrow">ORIGINAL CARD GAME<\/p>[\s\S]*?<h1 id="mode-heading"/);
  assert.doesNotMatch(moonScaleSelect, /CHOOSE A MODE/);
  assert.match(moonScaleSelect, /月影を賭ける、1対1の伏せ札決闘。残る札と相手の思惑を読み、月秤をこちらへ傾けよう。/);
  assert.match(moonScaleSelect, /\.moon-art\s*\{[^}]*width:\s*100%[^}]*aspect-ratio:\s*3\s*\/\s*2/s);
  assert.match(moonScaleSelect, /\.moon-art img\s*\{[^}]*width:\s*100%[^}]*height:\s*100%[^}]*object-fit:\s*cover[^}]*object-position:\s*7%\s+50%/s);
  assert.match(moonScaleSelect, /duel-scene-background\.webp" alt="" width="1536" height="480"/);
  assert.match(moonScaleSelect, /\.mode-list\s*\{[^}]*width:\s*min\(100%,\s*340px\)/s);
  assert.match(moonScaleSelect, /\.mode-link\s*\{[^}]*min-height:\s*50px/s);
  assert.match(moonScaleSelect, /\.mode-link--primary\s*\{[^}]*background:\s*linear-gradient/s);
  assert.match(moonScaleSelect, /id="show-rules-button" class="mode-link mode-link--secondary"/);
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
  const cards = [
    ["moon-full", "満ちる月"],
    ["moon-waning", "欠ける月"],
    ["moon-reflection", "返照の月"],
    ["moon-still", "静止の月"],
    ["moon-new-oath", "新月の誓い"],
    ["moon-false", "偽りの月"],
  ];
  for (const [image, name] of cards) {
    const path = `moon-scale-duel/assets/images/cards/${image}\\.webp`;
    assert.match(moonScaleSelect, new RegExp(`<a class="gallery-card card-guide-image" href="${path}"[^>]*aria-label="${name}の札を大きく見る"[^>]*><img src="${path}"[^>]*><span class="gallery-caption">${name}</span></a>`));
  }
  assert.equal((moonScaleSelect.match(/src="moon-scale-duel\/assets\/images\/cards\//g) || []).length, 6);
});

test("月秤の遊び方は月札画像をスマホ向けの固定範囲へ収める", () => {
  assert.match(moonScaleSelect, /\.card-guide,\s*\.result-guide\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(moonScaleSelect, /\.gallery-card img\s*\{[^}]*width:\s*100%[^}]*height:\s*clamp\(8\.5rem,\s*42vw,\s*10\.5rem\)[^}]*object-fit:\s*cover/s);
  assert.match(moonScaleSelect, /\.gallery-card::after\s*\{[^}]*content:\s*"拡大"/s);
  assert.match(moonScaleSelect, /@media \(max-width:\s*350px\)\s*\{\s*\.card-guide\s*\{\s*grid-template-columns:\s*1fr/s);
  assert.doesNotMatch(moonScaleSelect, /@media \(max-width:\s*350px\)[\s\S]*?\.result-guide\s*\{\s*grid-template-columns:\s*1fr/);
  assert.equal((moonScaleSelect.match(/card-guide-image/g) || []).length, 6);
  assert.equal((moonScaleSelect.match(/aria-label="[^"]+の札を大きく見る"/g) || []).length, 6);
});

test("月秤の遊び方は基本6効果を画像カードと分けて案内する", () => {
  assert.match(moonScaleSelect, /<h3>基本の効果<\/h3>\s*<dl class="card-effect-list">/);
  for (const description of [
    "自分の月影を3増やします。",
    "相手の月影を3減らします。",
    "このラウンドの「＋3」「−3」を逆向きにします。",
    "相手が出した月札の効果を無効にします。",
    "公開時に劣勢なら、双方の月影を7にします。",
    "公開後、未使用で模倣可能な月札の効果を選びます。",
  ]) {
    assert.ok(moonScaleSelect.includes(description));
  }
  assert.doesNotMatch(moonScaleSelect, /<span class="gallery-caption">[^<]+<\/span>\s*<p>/);
});

test("月秤の遊び方は既存の最終結果3画像を2列の拡大ギャラリーで案内する", () => {
  const results = [
    ["result-victory", "勝利", "雲が左右へ開き、中央の大きな月から月光が広がる夜空"],
    ["result-defeat", "敗北", "丸い月が雲に部分的に覆われ、月光が静かに退く夜空"],
    ["result-draw", "引き分け", "小さな月と左右に均衡した雲、水平の銀色の光が広がる夜空"],
  ];
  for (const [image, name, alt] of results) {
    const path = `moon-scale-duel/assets/images/results/${image}\\.webp`;
    assert.match(moonScaleSelect, new RegExp(`<a class="gallery-card result-guide-image" href="${path}"[^>]*aria-label="${name}結果の画像を大きく見る"[^>]*><img src="${path}" alt="${alt}"[^>]*><span class="gallery-caption">${name}</span></a>`));
    assert.match(moonScaleCpu, new RegExp(`src: 'assets/images/results/${image}\\.webp'`));
    assert.match(moonScaleOnlineState, new RegExp(`src: 'moon-scale-duel/assets/images/results/${image}\\.webp'`));
  }
  assert.equal((moonScaleSelect.match(/class="gallery-card result-guide-image"/g) || []).length, 3);
  assert.match(moonScaleSelect, /使用済み札と決着[\s\S]*id="result-guide-heading">最終結果<[\s\S]*<h2>1人用・2人用<\/h2>/);
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

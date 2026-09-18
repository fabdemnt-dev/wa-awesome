import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const html = await readFile(new URL("../birdcage-observer/index.html", import.meta.url), "utf8");

function loadGame(saved = null) {
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "https://example.test/birdcage-observer/",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.scrollTo = () => {};
      if (saved !== null) window.localStorage.setItem("birdcageObserver.completedScenarioIds.v1", saved);
    },
  });
  return dom;
}

function buttonByText(document, text) {
  const buttons = [...document.querySelectorAll("button")].filter((button) => !button.closest("[hidden]") && !button.disabled);
  return buttons.filter((button) => button.textContent.trim() === text).at(-1)
    ?? buttons.find((button) => button.textContent.includes(text));
}

function clickText(document, text) {
  const button = buttonByText(document, text);
  assert.ok(button, `button not found: ${text}`);
  button.click();
  return button;
}

function startFirstScenario(document) {
  clickText(document, "観測を始める");
  clickText(document, "閉じた鍵");
  clickText(document, "観測を開始する");
  clickText(document, "観測を始める");
}

function finishScenario(document, scenarioId, truthSigilId) {
  for (let round = 1; round <= 4; round += 1) {
    clickText(document, "次の観測記録を受け取る");
    if (scenarioId === 2 && round === 2) clickText(document, "記録を受け取る");
  }
  clickText(document, "最終宣言へ進む");
  if (scenarioId === 3) clickText(document, "最終宣言へ進む");
  document.querySelector(`[data-action="select-declaration"][data-sigil-id="${truthSigilId}"]`).click();
  clickText(document, "この印を宣言する");
  clickText(document, `${document.querySelector(`[data-sigil-id="${truthSigilId}"] .sigil-name`).textContent}を宣言する`);
}

function legalCandidate(api, scenario, truthSigilId) {
  let invertCount = 0;
  let obscureCount = 0;
  let previousDisturbed = false;
  for (const item of scenario.rounds) {
    const actual = api.actualResultFor(truthSigilId, item.observation);
    let disturbance = "none";
    if (item.displayedResult === "obscured") disturbance = "obscure";
    else if (item.displayedResult !== actual) disturbance = "invert";
    if (item.number === 1 || item.number === 5) {
      if (disturbance !== "none") return false;
    }
    if (disturbance !== "none" && previousDisturbed) return false;
    if (disturbance === "invert") invertCount += 1;
    if (disturbance === "obscure") obscureCount += 1;
    if (invertCount > 1 || obscureCount > 1) return false;
    previousDisturbed = disturbance !== "none";
  }
  return true;
}

test("タイトル画面は論理ゲーム表記と左上のおもちゃ箱ナビを1つだけ持つ", () => {
  const dom = loadGame();
  const { document } = dom.window;
  assert.equal(document.querySelector(".eyebrow").textContent, "ORIGINAL LOGIC GAME");
  assert.equal(document.querySelector(".english-title"), null);
  const links = [...document.querySelectorAll('a[href="../toybox/"]')];
  assert.equal(links.length, 1);
  assert.equal(links[0].textContent, "← 🎪 おもちゃ箱へ戻る");
  assert.ok(links[0].closest("nav.title-navigation"));
  assert.equal(links[0].closest(".title-frame"), null);
  clickText(document, "観測を始める");
  assert.equal(document.querySelector(".title-navigation"), null, "開始画面後へタイトルナビを持ち込まない");
  dom.window.close();
});

test("固定4局のデータ、観測結果、撹乱位置が確定仕様と一致する", () => {
  const dom = loadGame();
  const { SCENARIOS, SIGILS, actualResultFor, displayedResultFor, recordTextFor } = dom.window.__birdcageObserver;
  assert.deepEqual([...SCENARIOS].map(({ id, truthSigilId }) => [id, truthSigilId]), [[1, "key"], [2, "feather"], [3, "bell"], [4, "glass"]]);
  assert.equal(new Set(SCENARIOS.map(({ id }) => id)).size, 4);
  for (const scenario of SCENARIOS) {
    assert.equal(scenario.rounds.length, 5);
    assert.deepEqual([...scenario.rounds].map(({ number }) => number), [1, 2, 3, 4, 5]);
    assert.equal(scenario.rounds[0].disturbance, "none");
    assert.equal(scenario.rounds[4].disturbance, "none");
    assert.ok(SIGILS[scenario.truthSigilId]);
    const disturbed = scenario.rounds.filter(({ disturbance }) => disturbance !== "none");
    assert.ok(disturbed.length <= 2);
    assert.ok(scenario.rounds.filter(({ disturbance }) => disturbance === "invert").length <= 1);
    assert.ok(scenario.rounds.filter(({ disturbance }) => disturbance === "obscure").length <= 1);
    for (let index = 1; index < disturbed.length; index += 1) assert.notEqual(disturbed[index].number - disturbed[index - 1].number, 1);
    for (const item of scenario.rounds) {
      assert.equal(item.actualResult, actualResultFor(scenario.truthSigilId, item.observation));
      assert.equal(item.displayedResult, displayedResultFor(item.actualResult, item.disturbance));
      assert.equal(item.recordText, recordTextFor(item.observation, item.displayedResult));
      assert.notEqual(item.actualResult, "obscured");
    }
  }
  assert.deepEqual([...SCENARIOS].map(({ rounds }) => Array.from(rounds, ({ disturbance }) => disturbance)), [
    ["none", "none", "none", "none", "none"],
    ["none", "obscure", "none", "none", "none"],
    ["none", "invert", "none", "none", "none"],
    ["none", "invert", "none", "obscure", "none"],
  ]);
  dom.window.close();
});

test("固定4局は合法な撹乱履歴を考慮しても一意解になる", () => {
  const dom = loadGame();
  const api = dom.window.__birdcageObserver;
  for (const scenario of api.SCENARIOS) {
    const candidates = Object.keys(api.SIGILS).filter((id) => legalCandidate(api, scenario, id));
    assert.deepEqual(candidates, [scenario.truthSigilId]);
    const finalRound = scenario.rounds[4];
    const finalCandidates = Object.keys(api.SIGILS).filter((id) => api.actualResultFor(id, finalRound.observation) === finalRound.actualResult);
    assert.ok(finalCandidates.length > 1, `scenario ${scenario.id} final round must not reveal one sigil alone`);
  }
  dom.window.close();
});

test("保存値はクリア済みIDだけを正規化し、壊れたJSONを安全に扱う", () => {
  const dom = loadGame();
  const api = dom.window.__birdcageObserver;
  assert.deepEqual([...api.normalizeCompleted([3, 1, 3, 9, "2", 2])], [1, 2, 3]);
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  values.set(api.STORAGE_KEY, "broken");
  assert.deepEqual([...api.readCompleted(storage)], []);
  assert.deepEqual([...api.writeCompleted([4, 2, 2, 7], storage)], [2, 4]);
  assert.equal(values.size, 1);
  assert.equal(values.get(api.STORAGE_KEY), "[2,4]");
  dom.window.close();
});

test("初期状態は第1局だけ解放され、初回説明後に第1観測へ進む", () => {
  const dom = loadGame();
  const { document } = dom.window;
  clickText(document, "観測を始める");
  const cards = [...document.querySelectorAll(".scenario-card")];
  assert.equal(cards.length, 4);
  assert.equal(cards[0].disabled, false);
  assert.equal(cards.slice(1).every(({ disabled }) => disabled), true);
  clickText(document, "閉じた鍵");
  clickText(document, "観測を開始する");
  assert.equal(document.getElementById("dialog-title").textContent, "観測の基本");
  clickText(document, "観測を始める");
  assert.match(document.body.textContent, /第1観測 \/ 全5観測/);
  assert.equal(document.querySelectorAll(".memo-grid .sigil-card").length, 4);
  assert.equal(document.querySelectorAll('.memo-grid .sigil-card[data-memo="hold"]').length, 4);
  dom.window.close();
});

test("推理メモは即時変更、除外確認、4秒取り消し導線を持つ", () => {
  const dom = loadGame();
  const { document } = dom.window;
  startFirstScenario(document);
  clickText(document, "有力にする");
  assert.equal(document.querySelector('[data-sigil-id="key"]').dataset.memo, "strong");
  clickText(document, "除外にする");
  assert.match(document.getElementById("dialog-body").textContent, /鍵を「除外」にしますか/);
  clickText(document, "除外にする");
  assert.equal(document.querySelector('[data-sigil-id="key"]').dataset.memo, "excluded");
  assert.ok(buttonByText(document, "取り消す"));
  clickText(document, "取り消す");
  assert.equal(document.querySelector('[data-sigil-id="key"]').dataset.memo, "strong");
  dom.window.close();
});

test("5観測後だけ宣言へ進み、除外した印も宣言できる", () => {
  const dom = loadGame();
  const { document } = dom.window;
  startFirstScenario(document);
  clickText(document, "除外にする");
  clickText(document, "除外にする");
  for (let round = 1; round <= 4; round += 1) clickText(document, "次の観測記録を受け取る");
  assert.match(document.body.textContent, /第5観測 \/ 全5観測/);
  clickText(document, "最終宣言へ進む");
  const declarations = [...document.querySelectorAll('[data-action="select-declaration"]')];
  assert.equal(declarations.length, 4);
  assert.equal(declarations.every((button) => !button.disabled), true);
  declarations.find(({ dataset }) => dataset.sigilId === "key").click();
  assert.equal(buttonByText(document, "この印を宣言する").disabled, false);
  clickText(document, "この印を宣言する");
  assert.match(document.getElementById("dialog-body").textContent, /「鍵」を、鳥籠の真実として宣言/);
  dom.window.close();
});

test("正解だけが進行を保存し、不正解でも既存クリアは消えない", () => {
  const dom = loadGame("[1]");
  const { document, localStorage } = dom.window;
  clickText(document, "観測を始める");
  clickText(document, "閉じた鍵");
  clickText(document, "観測を開始する");
  clickText(document, "観測を始める");
  for (let round = 1; round <= 4; round += 1) clickText(document, "次の観測記録を受け取る");
  clickText(document, "最終宣言へ進む");
  document.querySelector('[data-action="select-declaration"][data-sigil-id="feather"]').click();
  clickText(document, "この印を宣言する");
  clickText(document, "羽を宣言する");
  assert.match(document.body.textContent, /あと一歩だけあなたを惑わせた/);
  assert.equal(localStorage.getItem("birdcageObserver.completedScenarioIds.v1"), "[1]");
  assert.equal(buttonByText(document, "次の記録へ：霞んだ羽"), undefined);
  dom.window.close();
});

test("固定4局を順にクリアし、第4局の通常結果から観測完了へ進める", () => {
  const scenarios = [[1, "閉じた鍵", "key"], [2, "霞んだ羽", "feather"], [3, "逆さの鈴音", "bell"], [4, "砕けた硝子", "glass"]];
  for (const [id, title, truth] of scenarios) {
    const saved = JSON.stringify(Array.from({ length: id - 1 }, (_, index) => index + 1));
    const dom = loadGame(saved);
    const { document, localStorage } = dom.window;
    clickText(document, "観測を始める");
    clickText(document, title);
    clickText(document, "観測を開始する");
    if (id === 1) clickText(document, "観測を始める");
    finishScenario(document, id, truth);
    assert.match(document.body.textContent, /観測は正しかった/);
    assert.equal(localStorage.getItem("birdcageObserver.completedScenarioIds.v1"), JSON.stringify(Array.from({ length: id }, (_, index) => index + 1)));
    if (id === 4) {
      assert.ok(buttonByText(document, "観測完了を見る"));
      clickText(document, "観測完了を見る");
      assert.match(document.body.textContent, /観測済み：4 \/ 4/);
    }
    dom.window.close();
  }
});

test("進行リセットは鳥籠の保存キーだけを削除する", () => {
  const dom = loadGame("[1,2,3,4]");
  const { document, localStorage } = dom.window;
  localStorage.setItem("unrelated.key", "keep");
  clickText(document, "観測を始める");
  clickText(document, "進行状況をリセット");
  clickText(document, "リセットする");
  assert.equal(localStorage.getItem("birdcageObserver.completedScenarioIds.v1"), null);
  assert.equal(localStorage.getItem("unrelated.key"), "keep");
  assert.equal([...document.querySelectorAll(".scenario-card")].slice(1).every(({ disabled }) => disabled), true);
  dom.window.close();
});

test("記録帳と確認ダイアログはdialog、Escape、フォーカス制御を備える", () => {
  const dom = loadGame();
  const { document, KeyboardEvent } = dom.window;
  startFirstScenario(document);
  clickText(document, "記録帳を開く");
  const modal = document.querySelector("#record-modal [role=dialog]");
  assert.equal(document.getElementById("record-modal").hidden, false);
  assert.equal(modal.getAttribute("aria-modal"), "true");
  assert.match(modal.textContent, /4印の属性表/);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(document.getElementById("record-modal").hidden, true);
  clickText(document, "除外にする");
  assert.equal(document.getElementById("dialog-modal").hidden, false);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(document.getElementById("dialog-modal").hidden, true);
  dom.window.close();
});

test("レスポンシブ、SVG、途中離脱、reduced-motion要件を静的に保持する", () => {
  assert.match(html, /@media \(min-width:\s*768px\)[\s\S]*\.play-layout\s*\{[^}]*grid-template-columns:/);
  assert.match(html, /\.memo-grid,\s*\.declaration-grid[^{]*\{[^}]*grid-template-columns:\s*repeat\(2/);
  assert.match(html, /\.modal--record\s*\{[^}]*height:\s*min\(94vh,\s*820px\)/);
  assert.match(html, /@media \(prefers-reduced-motion:\s*reduce\)/);
  assert.match(html, /window\.addEventListener\('beforeunload'/);
  assert.match(html, /data-action="open-menu"/);
  assert.equal((html.match(/<svg class="sigil-icon"/g) || []).length, 1);
  assert.doesNotMatch(html, /https?:\/\/(?:fonts|cdn|api)\./i);
  assert.doesNotMatch(html, /firebase/i);
});

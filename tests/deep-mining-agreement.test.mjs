import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  CONFIG,
  ORES,
  actionAvailability,
  applyCollapse,
  canAccuse,
  canScout,
  chooseNpcAction,
  chooseNpcScout,
  collapseLossRate,
  createGame,
  dangerLabel,
  generateOreSequence,
  mulberry32,
  npcSpeech,
  npcWeights,
  oreCount,
  resolveAccusation,
  resolveRound,
  simulateRemaining,
  totalValue,
} from "../deep-mining-agreement/engine.js";

const html = await readFile(new URL("../deep-mining-agreement/index.html", import.meta.url), "utf8");
const css = await readFile(new URL("../deep-mining-agreement/style.css", import.meta.url), "utf8");
const app = await readFile(new URL("../deep-mining-agreement/app.js", import.meta.url), "utf8");
const engineSource = await readFile(new URL("../deep-mining-agreement/engine.js", import.meta.url), "utf8");
const toybox = await readFile(new URL("../toybox/index.html", import.meta.url), "utf8");
const portraits = Object.fromEntries(await Promise.all(["minato", "gaku", "shion"].map(async (name) => [
  name,
  await readFile(new URL(`../deep-mining-agreement/assets/characters/${name}.png`, import.meta.url)),
])));

const npcActions = (action) => ({ safety: action, greedy: action, tactician: action });
const noNpcAccusations = { safety: null, greedy: null, tactician: null };

test("鉱脈は8R、各種2〜3回で同種3連続を避ける", () => {
  for (let seed = 1; seed <= 100; seed += 1) {
    const sequence = generateOreSequence(mulberry32(seed));
    assert.equal(sequence.length, 8);
    for (const id of Object.keys(ORES)) {
      const count = sequence.filter((entry) => entry === id).length;
      assert.ok(count >= 2 && count <= 3, `${id}: ${count}`);
    }
    for (let index = 2; index < sequence.length; index += 1) {
      assert.equal(sequence[index] === sequence[index - 1] && sequence[index] === sequence[index - 2], false);
    }
  }
});

test("8ラウンドを完走し、採掘・補強・偵察・隠匿が機能する", () => {
  const state = createGame({ seed: 10, oreSequence: ["iron", "azure", "gold", "iron", "azure", "gold", "iron", "azure"] });
  const actions = ["mine", "reinforce", "mine", "secret", "reinforce", "mine", "reinforce", "mine"];
  actions.forEach((action, index) => resolveRound(state, { humanAction: action, humanScout: index === 2, npcActions: npcActions("reinforce"), npcScouts: noNpcAccusations, npcAccusations: noNpcAccusations }));
  assert.equal(state.ended, true);
  assert.equal(state.endReason, "rounds");
  assert.equal(state.history.length, 8);
  assert.equal(state.players[0].publicOre.iron, 3);
  assert.equal(state.players[0].publicOre.azure, 2);
  assert.equal(state.players[0].secretOre.iron, 1);
  assert.equal(state.players[0].reinforcement, 3);
  assert.equal(state.history[2].actions.human, "mine");
  assert.equal(state.history[2].scouts.human, true);
  assert.equal(state.players[0].scoutsUsed, 1);
});

test("未解禁行動と第8R偵察を禁止する", () => {
  const state = createGame({ seed: 2 });
  const human = state.players[0];
  assert.deepEqual(actionAvailability(state, human), { mine: true, reinforce: true, secret: false, retreat: false });
  assert.equal(canScout(state, human), true);
  assert.equal(Object.hasOwn(actionAvailability(state, human), "scout"), false);
  assert.throws(() => resolveRound(state, { humanAction: "secret", npcActions: npcActions("reinforce") }), /unavailable/);
  assert.throws(() => resolveRound(state, { humanAction: "scout", npcActions: npcActions("reinforce") }), /unavailable/);
  state.round = 8;
  assert.equal(canScout(state, human), false);
  assert.throws(() => resolveRound(state, { humanAction: "reinforce", humanScout: true, npcActions: npcActions("reinforce") }), /scout unavailable/);
});

test("NPCは共通解禁条件に従い、未解禁の隠匿採掘と撤退を選ばない", () => {
  const profiles = ["safety", "greedy", "tactician"];
  for (const round of [1, 2]) {
    const state = createGame({ seed: 101, oreSequence: ["gold", "gold", "gold", "gold", "gold", "gold", "gold", "gold"] });
    state.round = round;
    for (const profile of profiles) {
      const player = state.players.find(({ id }) => id === profile);
      assert.equal(npcWeights(state, player).secret, 0, `${profile} R${round} secret weight`);
      for (let index = 0; index < 100; index += 1) {
        assert.notEqual(chooseNpcAction(state, player, () => index / 100), "secret", `${profile} R${round}`);
      }
    }
  }

  for (const round of [1, 2, 3, 4]) {
    const state = createGame({ seed: 102 });
    state.round = round;
    for (const player of state.players.slice(1)) {
      for (let index = 0; index < 100; index += 1) {
        assert.notEqual(chooseNpcAction(state, player, () => index / 100), "retreat", `${player.id} R${round}`);
      }
    }
  }

  const unlocked = createGame({ seed: 103, oreSequence: ["iron", "iron", "gold", "iron", "iron", "iron", "iron", "iron"] });
  unlocked.round = 3;
  const greedy = unlocked.players.find(({ id }) => id === "greedy");
  assert.equal(npcWeights(unlocked, greedy).secret, 23, "第3R金晶の従来重み8+15を維持する");
  assert.equal(chooseNpcAction(unlocked, greedy, () => 0.99), "secret", "第3R以降は隠匿採掘を選択可能");
  unlocked.round = 5;
  assert.equal(chooseNpcAction(unlocked, greedy, () => 0.999999), "retreat", "第5R以降は撤退を選択可能");
});

test("既知の再現seedでも第2Rにガクは隠匿採掘しない", () => {
  for (const seed of [1, 10, 20, 33, 51]) {
    const state = createGame({ seed });
    state.round = 2;
    const record = resolveRound(state, {
      humanAction: "reinforce",
      npcScouts: noNpcAccusations,
      npcAccusations: noNpcAccusations,
    });
    assert.notEqual(record.actions.greedy, "secret", `seed ${seed}`);
    assert.equal(record.secretCount, 0, `seed ${seed}`);
  }
});

test("偵察は通常行動と同時に使え、本人だけが次の鉱脈を知り、2回で上限になる", () => {
  const state = createGame({ seed: 12, oreSequence: ["iron", "gold", "azure", "iron", "gold", "azure", "iron", "gold"] });
  const first = resolveRound(state, { humanAction: "reinforce", humanScout: true, npcActions: npcActions("reinforce"), npcScouts: noNpcAccusations, npcAccusations: noNpcAccusations });
  assert.equal(first.actions.human, "reinforce");
  assert.equal(first.scouts.human, true);
  assert.equal(state.players[0].reinforcement, 1);
  assert.equal(state.players[0].scoutsUsed, 1);
  assert.equal(state.players[0].scoutedRound, 2);
  assert.equal(state.players[0].scoutedOre, "gold");
  assert.ok(state.players.slice(1).every((player) => player.scoutedOre === null));
  resolveRound(state, { humanAction: "mine", humanScout: true, npcActions: npcActions("reinforce"), npcScouts: noNpcAccusations, npcAccusations: noNpcAccusations });
  assert.equal(state.players[0].scoutsUsed, 2);
  assert.equal(canScout(state, state.players[0]), false);
  assert.throws(() => resolveRound(state, { humanAction: "reinforce", humanScout: true, npcActions: npcActions("reinforce") }), /scout unavailable/);
});

test("NPC偵察は通常行動と独立し、2回制限され、人間の未確定選択を参照しない", () => {
  const state = createGame({ seed: 13 });
  const safety = state.players[1];
  const firstDecision = chooseNpcScout(state, safety);
  state.pendingHumanAction = "mine";
  const secondDecision = chooseNpcScout(state, safety);
  assert.equal(firstDecision, secondDecision);
  const first = resolveRound(state, { humanAction: "reinforce", npcActions: npcActions("reinforce"), npcScouts: { safety: true, greedy: false, tactician: false }, npcAccusations: noNpcAccusations });
  assert.equal(first.actions.safety, "reinforce");
  assert.equal(first.scouts.safety, true);
  assert.equal(safety.reinforcement, 1);
  assert.equal(safety.scoutsUsed, 1);
  resolveRound(state, { humanAction: "reinforce", npcActions: npcActions("reinforce"), npcScouts: { safety: true, greedy: false, tactician: false }, npcAccusations: noNpcAccusations });
  const third = resolveRound(state, { humanAction: "reinforce", npcActions: npcActions("reinforce"), npcScouts: { safety: true, greedy: false, tactician: false }, npcAccusations: noNpcAccusations });
  assert.equal(safety.scoutsUsed, 2);
  assert.equal(third.scouts.safety, false);
  assert.equal(canScout(state, safety), false);
});

test("隠匿採掘は本人履歴だけsecret、公開結果では採掘として表示し件数のみ出す", () => {
  const state = createGame({ seed: 3 });
  state.round = 3;
  const record = resolveRound(state, { humanAction: "secret", npcActions: { safety: "secret", greedy: "reinforce", tactician: "mine" }, npcAccusations: noNpcAccusations });
  const oreId = state.oreSequence[2];
  assert.equal(record.actions.human, "secret");
  assert.equal(record.actions.safety, "secret");
  assert.equal(record.publicActions.human, "mine");
  assert.equal(record.publicActions.safety, "mine");
  assert.equal(record.secretCount, 2);
  assert.equal(state.players[0].publicOre[oreId], 1);
  assert.equal(state.players[0].secretOre[oreId], 1);
  assert.equal(state.players[1].publicOre[oreId], 1);
  assert.equal(state.players[1].secretOre[oreId], 1);
  assert.equal(state.detectedSecretMining, true);
});

test("通常採掘は公開2個、隠匿採掘は公開1個＋秘密1個で危険度上昇は同じ", () => {
  const mined = createGame({ seed: 30, oreSequence: ["azure", "iron", "gold", "azure", "iron", "gold", "azure", "iron"] });
  const hidden = createGame({ seed: 31, oreSequence: [...mined.oreSequence] });
  hidden.round = 3;
  mined.round = 3;
  const mineRecord = resolveRound(mined, { humanAction: "mine", npcActions: npcActions("reinforce"), npcScouts: noNpcAccusations, npcAccusations: noNpcAccusations });
  const hiddenRecord = resolveRound(hidden, { humanAction: "secret", npcActions: npcActions("reinforce"), npcScouts: noNpcAccusations, npcAccusations: noNpcAccusations });
  const oreId = mined.oreSequence[2];
  assert.equal(mined.players[0].publicOre[oreId], 2);
  assert.equal(mined.players[0].secretOre[oreId], 0);
  assert.equal(hidden.players[0].publicOre[oreId], 1);
  assert.equal(hidden.players[0].secretOre[oreId], 1);
  assert.equal(mineRecord.dangerAdded, hiddenRecord.dangerAdded);
  assert.equal(hiddenRecord.publicActions.human, "mine");
  assert.equal(hiddenRecord.secretCount, 1);
});

test("危険度は5段階の境界値を正しい文字で返す", () => {
  assert.equal(dangerLabel(0), "安全");
  assert.equal(dangerLabel(39), "安全");
  assert.equal(dangerLabel(40), "注意");
  assert.equal(dangerLabel(59), "注意");
  assert.equal(dangerLabel(60), "危険");
  assert.equal(dangerLabel(79), "危険");
  assert.equal(dangerLabel(80), "崩落寸前");
  assert.equal(dangerLabel(99), "崩落寸前");
  assert.equal(dangerLabel(100), "崩落");
  assert.equal(dangerLabel(140), "崩落");
});

test("告発は成功時に秘密鉱石1個を共同保管庫へ、失敗時に信用失墜を付ける", () => {
  const state = createGame({ seed: 4 });
  state.round = 3;
  state.detectedSecretMining = true;
  state.players[2].secretOre.gold = 2;
  const success = resolveAccusation(state, { accuserId: "human", targetId: "greedy" });
  assert.equal(success.success, true);
  assert.equal(success.oreId, "gold");
  assert.equal(state.players[2].secretOre.gold, 1);
  assert.deepEqual(state.vault, ["gold"]);
  const failure = resolveAccusation(state, { accuserId: "human", targetId: "safety" });
  assert.equal(failure.success, false);
  assert.equal(state.players[0].discredit, 1);
  assert.equal(state.players[0].accusationsUsed, 2);
  assert.equal(canAccuse(state, state.players[0]), false);
  assert.equal(resolveAccusation(state, { accuserId: "human", targetId: "tactician" }), null);
});

test("同一ラウンドの撤退者へ告発を解決してから撤退を確定する", () => {
  const successState = createGame({ seed: 41 });
  successState.round = 5;
  successState.detectedSecretMining = true;
  const safety = successState.players[1];
  const greedy = successState.players[2];
  safety.secretOre.gold = 1;
  safety.publicOre.azure = 3;
  const successRecord = resolveRound(successState, {
    humanAction: "mine",
    humanAccusationTarget: "safety",
    npcActions: { safety: "retreat", greedy: "reinforce", tactician: "reinforce" },
    npcScouts: noNpcAccusations,
    npcAccusations: { safety: null, greedy: "safety", tactician: null },
  });
  assert.equal(successRecord.accusationResults.length, 2, "同じ対象への告発を既存順で両方解決する");
  assert.deepEqual(successRecord.accusationResults.map(({ accuserId, success }) => [accuserId, success]), [["human", true], ["greedy", false]]);
  assert.equal(safety.secretOre.gold, 0);
  assert.equal(safety.publicOre.azure, 3, "告発後も残り鉱石を保持する");
  assert.deepEqual(successState.vault, ["gold"]);
  assert.equal(successState.players[0].accusationsUsed, 1);
  assert.equal(greedy.accusationsUsed, 1);
  assert.equal(greedy.discredit, 1, "先行告発で秘密鉱石がなくなった後続告発は失敗する");
  assert.equal(safety.active, false);
  assert.equal(safety.retreated, true);
  assert.equal(successRecord.actions.safety, "retreat");
  assert.equal(successRecord.publicActions.safety, "retreat");

  const failureState = createGame({ seed: 42 });
  failureState.round = 5;
  failureState.detectedSecretMining = true;
  const failureRecord = resolveRound(failureState, {
    humanAction: "reinforce",
    humanAccusationTarget: "tactician",
    npcActions: { safety: "reinforce", greedy: "reinforce", tactician: "retreat" },
    npcScouts: noNpcAccusations,
    npcAccusations: noNpcAccusations,
  });
  assert.equal(failureRecord.accusationResults[0].success, false);
  assert.equal(failureState.players[0].discredit, 1);
  assert.equal(failureState.players[0].accusationsUsed, 1);
  assert.equal(failureState.players[3].active, false);
  assert.equal(failureState.players[3].retreated, true);
});

test("前ラウンド以前に撤退済みの相手への告発は無効のまま", () => {
  const state = createGame({ seed: 43 });
  state.round = 5;
  state.detectedSecretMining = true;
  state.players[1].active = false;
  state.players[1].retreated = true;
  state.players[1].secretOre.gold = 1;
  const record = resolveRound(state, {
    humanAction: "reinforce",
    humanAccusationTarget: "safety",
    npcActions: npcActions("reinforce"),
    npcScouts: noNpcAccusations,
    npcAccusations: noNpcAccusations,
  });
  assert.equal(record.accusationResults.length, 0);
  assert.equal(state.players[0].accusationsUsed, 0);
  assert.equal(state.players[1].secretOre.gold, 1);
});

test("採掘人数・鉱石・補強人数から危険度を正しく更新する", () => {
  const state = createGame({ seed: 5, oreSequence: ["gold", "iron", "azure", "gold", "iron", "azure", "gold", "iron"] });
  const record = resolveRound(state, { humanAction: "mine", npcActions: { safety: "reinforce", greedy: "mine", tactician: "reinforce" }, npcAccusations: noNpcAccusations });
  assert.equal(record.dangerAdded, 26);
  assert.equal(record.dangerReduced, 24);
  assert.equal(record.dangerAfter, 22);
});

test("崩落は補強貢献で損失率が下がり、撤退者は無傷", () => {
  const state = createGame({ seed: 6 });
  state.players.forEach((player, index) => {
    player.publicOre.gold = 10;
    player.secretOre.gold = 10;
    player.reinforcement = index;
  });
  state.players[3].active = false;
  state.players[3].retreated = true;
  applyCollapse(state);
  assert.deepEqual([0, 1, 2, 3].map(collapseLossRate), [0.5, 0.4, 0.3, 0.2]);
  assert.equal(state.players[0].collapseLoss, 27);
  assert.equal(state.players[1].collapseLoss, 21);
  assert.equal(state.players[2].collapseLoss, 15);
  assert.equal(state.players[3].collapseLoss, 0);
  assert.equal(state.players[3].publicOre.gold, 10);
});

test("第5Rから撤退でき、人間撤退後は結果まで高速処理できる", () => {
  const state = createGame({ seed: 7 });
  state.round = 5;
  resolveRound(state, { humanAction: "retreat", npcActions: npcActions("reinforce"), npcAccusations: noNpcAccusations });
  assert.equal(state.players[0].retreated, true);
  assert.equal(state.players[0].active, false);
  simulateRemaining(state);
  assert.equal(state.ended, true);
  assert.equal(state.history.at(-1).round, 8);
  assert.equal(state.players[0].collapseLoss, 0);
});

test("共同保管庫は補強貢献者へ分配され、信用失墜を最終価値から引く", () => {
  const state = createGame({ seed: 8 });
  state.round = 8;
  state.vault.push("gold", "azure", "iron");
  state.players[0].reinforcement = 2;
  state.players[1].reinforcement = 1;
  state.players[0].discredit = 1;
  resolveRound(state, { humanAction: "reinforce", npcActions: npcActions("reinforce"), npcAccusations: noNpcAccusations });
  assert.equal(oreCount(state.players[0].vaultOre), 1);
  assert.equal(state.players.reduce((sum, player) => sum + oreCount(player.vaultOre), 0), 3);
  assert.equal(totalValue(state.players[0]), 2);
});

test("NPC3性格は安全・強欲・策士の傾向差を持つ", () => {
  const state = createGame({ seed: 9, oreSequence: ["gold", "iron", "azure", "gold", "iron", "azure", "gold", "iron"] });
  state.round = 5;
  state.danger = 82;
  const safety = npcWeights(state, state.players[1]);
  const greedy = npcWeights(state, state.players[2]);
  const tactician = npcWeights(state, state.players[3]);
  assert.deepEqual(state.players.slice(1).map(({ name, role, profile }) => ({ name, role, profile })), [
    { name: "ミナト", role: "坑道整備士", profile: "safety" },
    { name: "ガク", role: "採掘師", profile: "greedy" },
    { name: "シオン", role: "鉱脈調査員", profile: "tactician" },
  ]);
  assert.deepEqual(safety, { mine: 20, reinforce: 75, secret: 3, retreat: 5 });
  assert.deepEqual(greedy, { mine: 67, reinforce: 14, secret: 12, retreat: 5 });
  assert.deepEqual(tactician, { mine: 45, reinforce: 25, secret: 38, retreat: 5 });
  assert.equal("scout" in safety, false);
  assert.equal("scout" in greedy, false);
  assert.equal("scout" in tactician, false);
  assert.ok(safety.reinforce > safety.mine);
  assert.ok(greedy.mine > greedy.reinforce);
  assert.ok(tactician.secret > safety.secret);
  const snapshot = JSON.stringify(state.players[0]);
  for (let index = 0; index < 20; index += 1) chooseNpcAction(state, state.players[2], mulberry32(index + 1));
  assert.equal(JSON.stringify(state.players[0]), snapshot, "NPC決定は人間状態を書き換えない");
});

test("NPC台詞は新キャラクター像を保ち、現在の危険度と鉱脈に矛盾しない", () => {
  const state = createGame({ seed: 44, oreSequence: ["gold", "iron", "azure", "gold", "iron", "azure", "gold", "iron"] });
  const [minato, gaku, shion] = state.players.slice(1);
  state.danger = 20;
  assert.equal(npcSpeech(state, minato), "今なら掘っても大丈夫そうだ。");
  assert.equal(npcSpeech(state, gaku), "金晶か。これは掘りたいな。");
  assert.equal(npcSpeech(state, shion, () => 0.9), "今は協力しておこう。");
  assert.equal(npcSpeech(state, shion, (() => { const values = [0.1, 0.1]; return () => values.shift(); })()), "次は鉄晶かもしれないね。");
  state.danger = 85;
  assert.equal(npcSpeech(state, minato), "危険が上がってきたね。無理はしない方がいい。");
  assert.equal(npcSpeech(state, gaku), "さすがにこれは危ないか。");
  assert.equal(npcSpeech(state, shion, () => 0.9), "そろそろ引き際も考えようか。");
});

test("結果は順位・全所持・崩落損失・分配・信用・隠匿・告発を保持する", () => {
  const state = createGame({ seed: 11 });
  state.round = 8;
  state.players[0].publicOre.gold = 2;
  state.players[1].secretOre.iron = 1;
  state.players[1].secretActions = 1;
  state.players[2].accusationSuccesses = 1;
  resolveRound(state, { humanAction: "reinforce", npcActions: npcActions("reinforce"), npcAccusations: noNpcAccusations });
  assert.equal(state.finalised, true);
  assert.ok(state.players.every((player) => Number.isInteger(player.rank)));
  assert.ok(state.players.every((player) => "collapseLoss" in player && "vaultOre" in player));
  assert.equal(state.players[1].secretActions, 1);
  assert.equal(state.players[2].accusationSuccesses, 1);
});

test("独立ページは外部依存・保存・オンライン導線を持たず、おもちゃ箱から未導線", () => {
  assert.match(html, /<script type="module" src="app\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="style\.css">/);
  assert.doesNotMatch(html + app, /firebase|localStorage|sessionStorage|https?:\/\//i);
  assert.doesNotMatch(html + app, /ログイン|ランキング|オンライン対戦/);
  assert.doesNotMatch(toybox, /deep-mining-agreement|深層採掘協定/);
  assert.doesNotMatch(app, /秘密採掘/);
  assert.match(app, /隠匿採掘/);
  assert.doesNotMatch(app + engineSource, /セーフ|ゴウ|サク/);
  assert.match(app + engineSource, /ミナト/);
  assert.match(app + engineSource, /ガク/);
  assert.match(app + engineSource, /シオン/);
});

test("スマホ幅向けの最小幅固定がなく、タップ領域と横あふれ対策を持つ", () => {
  assert.match(html, /width=device-width/);
  assert.match(css, /\*\s*\{\s*box-sizing:\s*border-box/);
  assert.match(css, /html\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /#app\s*\{[^}]*width:\s*min\(100%,\s*760px\)/);
  assert.match(css, /\.button,\s*\.action-button[\s\S]*min-height:\s*48px/);
  assert.match(css, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.doesNotMatch(css, /(?:html|body|#app|\.screen)\s*\{[^}]*min-width:\s*[4-9]\d\dpx/);
  assert.doesNotMatch(css, /\.confirm-bar\s*\{[^}]*position:\s*(?:fixed|sticky)/, "確定ボタンを画面へ追従させない");
});

test("ゲーム主画面は判断情報へ絞り、詳細を遊び方へ収納する", async () => {
  const dom = new JSDOM(html, { url: "https://example.test/deep-mining-agreement/", pretendToBeVisual: true });
  dom.window.scrollTo = () => {};
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    await import(`../deep-mining-agreement/app.js?compact-ui=${Date.now()}`);
    const document = dom.window.document;
    document.querySelector('[data-action="new-game"]').click();
    document.querySelector('[data-action="close-notice"]').click();
    assert.match(document.querySelector(".danger-panel").textContent, /崩落危険度[\s\S]*20[\s\S]*安全/);
    assert.doesNotMatch(document.querySelector(".danger-panel").textContent, /100以上/);
    assert.doesNotMatch(document.querySelector(".ore-panel").textContent, /CURRENT VEIN|採掘1人につき/);
    assert.match(document.querySelector(".ore-panel").textContent, /価値\s*[123][\s\S]*危険\s*(低|中|高)/);
    assert.doesNotMatch(document.querySelector(".seat-grid").textContent, /告発残り/);
    assert.match(document.querySelector(".seat-grid").textContent, /ミナト[\s\S]*坑道整備士/);
    assert.match(document.querySelector(".seat-grid").textContent, /ガク[\s\S]*採掘師/);
    assert.match(document.querySelector(".seat-grid").textContent, /シオン[\s\S]*鉱脈調査員/);
    assert.match(document.querySelector('[data-action-id="mine"]').textContent, /公開で2個/);
    assert.match(document.querySelector('[data-action-id="secret"]').textContent, /第3Rから/);
    document.querySelector('[data-action="show-rules"]').click();
    assert.match(document.body.textContent, /危険度が100以上になると崩落/);
    assert.match(document.body.textContent, /金晶：価値3／採掘危険＋13（高）/);
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    dom.window.close();
  }
});

test("NPC3席だけに正しい透過PNGポートレートを表示する", async () => {
  for (const [name, bytes] of Object.entries(portraits)) {
    assert.ok(bytes.length > 0, `${name}.png is empty`);
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${name}.png is not PNG`);
  }
  const dom = new JSDOM(html, { url: "https://example.test/deep-mining-agreement/", pretendToBeVisual: true });
  dom.window.scrollTo = () => {};
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    await import(`../deep-mining-agreement/app.js?portrait-test=${Date.now()}`);
    const document = dom.window.document;
    document.querySelector('[data-action="new-game"]').click();
    const expected = {
      safety: ["ミナト", "assets/characters/minato.png"],
      greedy: ["ガク", "assets/characters/gaku.png"],
      tactician: ["シオン", "assets/characters/shion.png"],
    };
    assert.equal(document.querySelector('[data-player-id="human"] img'), null);
    assert.ok(document.querySelector('[data-player-id="human"] > .seat-info'));
    for (const [id, [name, src]] of Object.entries(expected)) {
      const seat = document.querySelector(`[data-player-id="${id}"]`);
      const image = seat.querySelector(".seat-portrait");
      assert.ok(image, `${name} portrait missing`);
      assert.equal(image.getAttribute("src"), src);
      assert.equal(image.getAttribute("alt"), name);
      assert.equal(image.getAttribute("width"), "64");
      assert.ok(seat.classList.contains("seat--portrait"));
      assert.ok(seat.querySelector(":scope > .seat-info"));
    }
    assert.match(document.querySelector('[data-player-id="human"]').textContent, /あなた[\s\S]*公開 0個／秘密 0個[\s\S]*補強貢献 0/);
    assert.match(document.querySelector('[data-player-id="safety"]').textContent, /ミナト[\s\S]*坑道整備士[\s\S]*公開所持[\s\S]*補強貢献/);
    assert.match(document.querySelector('[data-player-id="greedy"]').textContent, /ガク[\s\S]*採掘師[\s\S]*公開所持[\s\S]*補強貢献/);
    assert.match(document.querySelector('[data-player-id="tactician"]').textContent, /シオン[\s\S]*鉱脈調査員[\s\S]*公開所持[\s\S]*補強貢献/);
    assert.match(css, /\.seat-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    assert.match(css, /\.seat--portrait\s*\{[^}]*grid-template-columns:\s*64px\s+minmax\(0,\s*1fr\)/);
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    dom.window.close();
  }
});

test("遊び方に4人の協定・補強・隠匿・思惑を伝える短い導入がある", () => {
  assert.match(app, /地下深くの鉱脈を掘る4人組/);
  assert.match(app, /危険が高まれば坑道を補強/);
  assert.match(app, /誰かがこっそり隠したり/);
  assert.match(app, /ほかの3人の思惑/);
  assert.match(app, /偵察：[\s\S]*通常行動とは別に使えます/);
  assert.match(app, /次の鉱脈を一足先に確認できます。1ゲーム2回まで/);
});

test("通常行動・偵察・告発を独立保持し、明示取消と確定処理でも正しい組み合わせを使う", async () => {
  const dom = new JSDOM(html, { url: "https://example.test/deep-mining-agreement/", pretendToBeVisual: true });
  let scrollCalls = 0;
  dom.window.scrollTo = () => { scrollCalls += 1; };
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    await import(`../deep-mining-agreement/app.js?selection-test=${Date.now()}`);
    const document = dom.window.document;
    const click = (selector) => {
      const control = document.querySelector(selector);
      assert.ok(control, `missing control: ${selector}`);
      control.click();
    };
    click('[data-action="new-game"]');
    click('[data-action="close-notice"]');
    const state = dom.window.__deepMiningAgreement.getState();
    state.round = 3;
    state.danger = 0;
    state.detectedSecretMining = true;
    state.players[2].secretOre.gold = 1;
    dom.window.__deepMiningAgreement.renderGame();
    scrollCalls = 0;
    assert.equal(document.querySelector('[data-action="choose-action"][data-action-id="scout"]'), null, "偵察は通常行動一覧に含めない");
    assert.equal(document.querySelectorAll('[data-action="confirm-action"]').length, 1, "通常配置の確定ボタンだけを表示する");
    assert.ok(document.querySelector('.current-selection + .confirm-bar > [data-action="confirm-action"]'), "今回の選択の直後に確定ボタンを置く");

    click('[data-action="choose-action"][data-action-id="mine"]');
    assert.equal(document.querySelector('[data-action-id="mine"]').getAttribute("aria-pressed"), "true");
    click('[data-action="choose-action"][data-action-id="reinforce"]');
    assert.equal(document.querySelector('[data-action-id="mine"]').getAttribute("aria-pressed"), "false");
    assert.equal(document.querySelector('[data-action-id="reinforce"]').getAttribute("aria-pressed"), "true");
    assert.equal(scrollCalls, 0, "通常行動の選択・変更ではページ上部へ移動しない");

    assert.match(document.querySelector('[data-action="select-scout"]').textContent, /偵察（残り2）/);
    click('[data-action="select-scout"]');
    assert.equal(state.players[0].scoutsUsed, 0, "選択だけでは偵察回数を消費しない");
    assert.equal(document.querySelector('[data-action="select-scout"]').getAttribute("aria-pressed"), "true");
    assert.match(document.querySelector("#current-selection").textContent, /🔭 偵察/);
    click('[data-action="choose-action"][data-action-id="mine"]');
    click('[data-action="choose-action"][data-action-id="reinforce"]');
    assert.equal(document.querySelector('[data-action="select-scout"]').getAttribute("aria-pressed"), "true", "通常行動を変更しても偵察を維持する");
    click('[data-action="cancel-scout"]');
    assert.equal(document.querySelector('[data-action="select-scout"]').getAttribute("aria-pressed"), "false");
    assert.doesNotMatch(document.querySelector("#current-selection").textContent, /🔭 偵察/);
    click('[data-action="select-scout"]');

    const accusation = document.querySelector("#accusation-target");
    accusation.value = "greedy";
    accusation.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    assert.match(document.querySelector("#current-selection").textContent, /補強/);
    assert.match(document.querySelector("#current-selection").textContent, /ガクを告発/);
    assert.equal(document.querySelector('[data-action="cancel-accusation"]').hidden, false);

    click('[data-action="choose-action"][data-action-id="mine"]');
    click('[data-action="choose-action"][data-action-id="reinforce"]');
    assert.equal(document.querySelector("#accusation-target").value, "greedy");
    assert.match(document.querySelector("#current-selection").textContent, /補強[\s\S]*偵察[\s\S]*ガクを告発/);
    assert.equal(scrollCalls, 0, "告発選択後の通常行動変更でもページ上部へ移動しない");

    document.querySelector("#accusation-target").value = "";
    document.querySelector("#accusation-target").dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    assert.equal(document.querySelector("#accusation-target").value, "greedy", "空の選択では告発を解除しない");
    click('[data-action="cancel-accusation"]');
    assert.equal(document.querySelector("#accusation-target").value, "");
    assert.doesNotMatch(document.querySelector("#current-selection").textContent, /告発なし/);

    document.querySelector("#accusation-target").value = "greedy";
    document.querySelector("#accusation-target").dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    click('[data-action="confirm-action"]');
    const record = state.history.at(-1);
    assert.equal(record.actions.human, "reinforce");
    assert.equal(record.scouts.human, true);
    assert.equal(record.accusationResults[0].targetId, "greedy");
    assert.equal(state.players[0].scoutsUsed, 1);
    assert.equal(state.players[0].accusationsUsed, 1);
    assert.match(document.querySelector("#notice-title").textContent, /告発成功/);
    assert.match(document.querySelector(".notice").textContent, /ガクから秘密鉱石を1個押収しました/);
    const scoutedOre = ORES[record.scoutOreId];
    const secretAfterAccusation = oreCount(state.players[2].secretOre);
    click('[data-action="close-notice"]');
    assert.equal(state.players[0].accusationsUsed, 1, "通知確認で告発を再実行しない");
    assert.equal(oreCount(state.players[2].secretOre), secretAfterAccusation, "通知確認で押収を二重実行しない");
    assert.match(document.querySelector("#notice-title").textContent, /偵察結果/);
    assert.match(document.querySelector(".notice").textContent, new RegExp(`「${scoutedOre.name}」`));
    assert.match(document.querySelector(".notice").textContent, new RegExp(`価値：${scoutedOre.value}`));
    assert.match(document.querySelector(".notice").textContent, new RegExp(`採掘危険：${scoutedOre.level}`));
    assert.equal(state.oreSequence[state.round - 1], record.scoutOreId, "即時表示した鉱脈が実際の次ラウンドと一致する");
    assert.match(document.querySelector(".scout-prior-note").textContent, /前ラウンドで偵察済み/);
    assert.match(document.querySelector(".history-list").textContent, new RegExp(`偵察結果：次は${scoutedOre.name}`));
    click('[data-action="close-notice"]');
    while (document.querySelector('[data-action="close-notice"]')) click('[data-action="close-notice"]');
    assert.equal(document.querySelector("#notice"), null, "告発・偵察などの通知をすべて確認すると閉じる");
    assert.doesNotMatch(document.querySelector(".result-card").textContent, /告発成功|偵察結果|隠匿採掘を検知/, "一時通知を通常画面へ残さない");
    assert.equal(state.players[0].accusationsUsed, 1, "偵察通知確認でも告発を再実行しない");
    assert.equal(state.players[0].scoutsUsed, 1, "偵察通知確認で回数を二重消費しない");
    assert.match(document.body.textContent, /偵察（残り1）/);
    assert.match(document.body.textContent, new RegExp(`偵察結果：次は${scoutedOre.name}`));
    assert.match(document.body.textContent, /告発（残り1）/);
    state.round = 8;
    dom.window.__deepMiningAgreement.renderGame();
    assert.equal(document.querySelector('[data-action="select-scout"]').disabled, true);
    assert.match(document.querySelector('[data-action="select-scout"]').textContent, /第8Rは使用不可/);
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    dom.window.close();
  }
});

test("告発失敗を即時表示し、通知確認で信用失墜を二重加算しない", async () => {
  const dom = new JSDOM(html, { url: "https://example.test/deep-mining-agreement/", pretendToBeVisual: true });
  dom.window.scrollTo = () => {};
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    await import(`../deep-mining-agreement/app.js?accusation-failure=${Date.now()}`);
    const document = dom.window.document;
    const click = (selector) => document.querySelector(selector).click();
    click('[data-action="new-game"]');
    click('[data-action="close-notice"]');
    const state = dom.window.__deepMiningAgreement.getState();
    state.round = 3;
    state.detectedSecretMining = true;
    state.rng = () => 0;
    state.players[1].secretOre = { iron: 0, azure: 0, gold: 0 };
    dom.window.__deepMiningAgreement.renderGame();
    click('[data-action-id="reinforce"]');
    const accusation = document.querySelector("#accusation-target");
    accusation.value = "safety";
    accusation.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    click('[data-action="confirm-action"]');
    assert.match(document.querySelector("#notice-title").textContent, /告発失敗/);
    assert.equal(document.querySelector(".scout-prior-note"), null, "偵察していない次ラウンドには補助表示を出さない");
    assert.match(document.querySelector(".notice").textContent, /ミナトは秘密鉱石を持っていませんでした/);
    assert.match(document.querySelector(".notice").textContent, /最終価値 −1/);
    assert.equal(state.players[0].discredit, 1);
    click('[data-action="close-notice"]');
    assert.equal(state.players[0].discredit, 1);
    assert.equal(state.players[0].accusationsUsed, 1);
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    dom.window.close();
  }
});

test("同一ラウンドに撤退するNPCへの告発結果を即時表示し、履歴と結果へ反映する", async () => {
  const dom = new JSDOM(html, { url: "https://example.test/deep-mining-agreement/", pretendToBeVisual: true });
  dom.window.scrollTo = () => {};
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    await import(`../deep-mining-agreement/app.js?retreat-accusation=${Date.now()}`);
    const document = dom.window.document;
    const click = (selector) => document.querySelector(selector).click();
    click('[data-action="new-game"]');
    click('[data-action="close-notice"]');
    const state = dom.window.__deepMiningAgreement.getState();
    state.round = 5;
    state.detectedSecretMining = true;
    state.players[2].secretOre.gold = 2;
    state.players[2].publicOre.azure = 2;
    state.rng = () => 0.999999;
    dom.window.__deepMiningAgreement.renderGame();
    click('[data-action-id="mine"]');
    const accusation = document.querySelector("#accusation-target");
    accusation.value = "greedy";
    accusation.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    click('[data-action="confirm-action"]');
    const record = state.history.at(-1);
    assert.equal(record.actions.greedy, "retreat");
    assert.equal(record.accusationResults[0].targetId, "greedy");
    assert.equal(record.accusationResults[0].success, true);
    assert.equal(state.players[2].secretOre.gold, 1);
    assert.equal(state.players[2].publicOre.azure, 2);
    assert.equal(state.players[2].retreated, true);
    assert.equal(state.players[2].active, false);
    assert.equal(state.players[0].accusationsUsed, 1);
    assert.match(document.querySelector("#notice-title").textContent, /告発成功/);
    assert.match(document.querySelector(".notice").textContent, /ガクから秘密鉱石を1個押収しました/);
    assert.match(document.querySelector(".history-list").textContent, /ガク：🚪 撤退/);
    assert.match(document.querySelector(".history-list").textContent, /あなた→ガク 成功/);
    while (document.querySelector('[data-action="close-notice"]')) click('[data-action="close-notice"]');
    simulateRemaining(state);
    dom.window.__deepMiningAgreement.renderGame();
    assert.match(document.querySelector('[data-player-id="human"]').textContent, /告発 成功1／失敗0/);
    assert.match(document.querySelector('[data-player-id="greedy"]').textContent, /金晶 1 × 3 ＝ 3/);
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    dom.window.close();
  }
});

test("危険度の5段階を色クラスと文字の両方で表示する", async () => {
  const dom = new JSDOM(html, { url: "https://example.test/deep-mining-agreement/", pretendToBeVisual: true });
  dom.window.scrollTo = () => {};
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    await import(`../deep-mining-agreement/app.js?danger-level=${Date.now()}`);
    dom.window.document.querySelector('[data-action="new-game"]').click();
    dom.window.document.querySelector('[data-action="close-notice"]').click();
    const state = dom.window.__deepMiningAgreement.getState();
    for (const [danger, key, label] of [[39, "safe", "安全"], [40, "caution", "注意"], [60, "danger", "危険"], [80, "critical", "崩落寸前"], [100, "collapse", "崩落"]]) {
      state.danger = danger;
      dom.window.__deepMiningAgreement.renderGame();
      const panel = dom.window.document.querySelector(".danger-panel");
      assert.equal(panel.dataset.danger, key);
      assert.equal(panel.querySelector(".danger-status").textContent, label);
      assert.match(panel.querySelector(".danger-track").getAttribute("aria-label"), new RegExp(label));
    }
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    dom.window.close();
  }
});

test("結果画面は鉱石の掛け算・崩落損失・分配・信用失墜から最終価値を説明する", async () => {
  const dom = new JSDOM(html, { url: "https://example.test/deep-mining-agreement/", pretendToBeVisual: true });
  dom.window.scrollTo = () => {};
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    await import(`../deep-mining-agreement/app.js?result-breakdown=${Date.now()}`);
    const document = dom.window.document;
    document.querySelector('[data-action="new-game"]').click();
    document.querySelector('[data-action="close-notice"]').click();
    const state = dom.window.__deepMiningAgreement.getState();
    const human = state.players[0];
    state.round = 8;
    state.danger = 0;
    state.collapsed = true;
    human.publicOre = { iron: 2, azure: 1, gold: 1 };
    human.secretOre = { iron: 0, azure: 0, gold: 1 };
    human.collapseLoss = 4;
    human.reinforcement = 1;
    human.discredit = 1;
    state.vault = ["azure"];
    dom.window.__deepMiningAgreement.renderGame();
    document.querySelector('[data-action-id="reinforce"]').click();
    document.querySelector('[data-action="confirm-action"]').click();
    const card = document.querySelector('[data-player-id="human"]');
    const humanDetails = card.querySelector(".rank-details");
    assert.equal(humanDetails.open, true, "自分の内訳は初期表示する");
    assert.match(card.textContent, /鉄晶 2 × 1 ＝ 2/);
    assert.match(card.textContent, /蒼晶 1 × 2 ＝ 2/);
    assert.match(card.textContent, /金晶 1 × 3 ＝ 3/);
    assert.match(card.textContent, /持ち帰った公開鉱石価値7/);
    assert.match(card.textContent, /持ち帰った秘密鉱石価値3/);
    assert.match(card.textContent, /持ち帰った鉱石：価値10/);
    assert.match(card.textContent, /崩落前鉱石価値：14/);
    assert.match(card.textContent, /補強貢献：2回/);
    assert.match(card.textContent, /公開鉱石30%／秘密鉱石20%/);
    assert.match(card.textContent, /共同保管庫分配：＋2/);
    assert.match(card.textContent, /信用失墜：−1/);
    assert.match(card.textContent, /崩落損失：−4/);
    assert.match(card.textContent, /14 − 4 ＋ 2 − 1 ＝ 最終価値 11/);
    assert.equal(totalValue(human), 11);
    const npcDetails = [...document.querySelectorAll('.rank-card:not([data-player-id="human"]) .rank-details')];
    assert.equal(npcDetails.length, 3);
    assert.ok(npcDetails.every((details) => !details.open), "NPC3人の内訳は初期状態で閉じる");
    npcDetails[0].querySelector("summary").click();
    assert.equal(npcDetails[0].open, true, "NPCの内訳を開ける");
    npcDetails[0].querySelector("summary").click();
    assert.equal(npcDetails[0].open, false, "NPCの内訳を閉じられる");
    const history = document.querySelector("details.history");
    assert.equal(history.open, false, "全履歴は初期状態で閉じる");
    assert.equal(document.querySelectorAll(".answer-group").length, 2);
    assert.equal(document.querySelectorAll(".answer-group p").length, 8, "答え合わせは4人分を短い行で表示する");
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    dom.window.close();
  }
});

test("隠匿採掘検知後の初回だけ告発解禁説明を表示する", async () => {
  const dom = new JSDOM(html, { url: "https://example.test/deep-mining-agreement/", pretendToBeVisual: true });
  dom.window.scrollTo = () => {};
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    await import(`../deep-mining-agreement/app.js?notice-test=${Date.now()}`);
    const document = dom.window.document;
    const click = (selector) => document.querySelector(selector).click();
    click('[data-action="new-game"]');
    click('[data-action="close-notice"]');
    const state = dom.window.__deepMiningAgreement.getState();
    state.round = 2;
    state.detectedSecretMining = true;
    state.rng = () => 0;
    dom.window.__deepMiningAgreement.renderGame();
    click('[data-action="choose-action"][data-action-id="reinforce"]');
    click('[data-action="confirm-action"]');
    assert.match(document.querySelector("#notice-title").textContent, /隠匿採掘が解禁/);
    click('[data-action="close-notice"]');
    assert.match(document.querySelector("#notice-title").textContent, /告発が解禁されました/);
    assert.match(document.querySelector(".notice").textContent, /当たれば秘密鉱石を1個押収/);
    assert.match(document.querySelector(".notice").textContent, /1ゲーム2回まで/);
    click('[data-action="close-notice"]');
    assert.equal(document.querySelector(".notice"), null);
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    dom.window.close();
  }
});

test("画面操作で遊び方を開き、8Rを完走して結果画面へ進める", async () => {
  const dom = new JSDOM(html, { url: "https://example.test/deep-mining-agreement/", pretendToBeVisual: true });
  dom.window.scrollTo = () => {};
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    await import(`../deep-mining-agreement/app.js?test=${Date.now()}`);
    const click = (selector) => {
      const control = dom.window.document.querySelector(selector);
      assert.ok(control, `missing control: ${selector}`);
      control.click();
    };
    click('[data-action="show-rules"]');
    assert.match(dom.window.document.body.textContent, /まず覚える3つ/);
    click('[data-action="back-from-rules"]');
    click('[data-action="new-game"]');
    click('[data-action="close-notice"]');
    while (!dom.window.__deepMiningAgreement.getState().ended) {
      const reinforce = dom.window.document.querySelector('[data-action="choose-action"][data-action-id="reinforce"]');
      assert.ok(reinforce);
      reinforce.click();
      click('[data-action="confirm-action"]');
      while (dom.window.document.querySelector('[data-action="close-notice"]')) click('[data-action="close-notice"]');
    }
    const finalState = dom.window.__deepMiningAgreement.getState();
    assert.equal(finalState.history.length, 8);
    assert.match(dom.window.document.body.textContent, /最終価値/);
    assert.match(dom.window.document.body.textContent, /答え合わせ/);
    assert.deepEqual([...dom.window.document.querySelectorAll(".rank-card .rank-head strong")].map((node) => node.textContent.replace(/^\d+位　/, "")).sort(), ["あなた", "ガク", "シオン", "ミナト"].sort());
    assert.match(dom.window.document.querySelector(".answer-panel").textContent, /ミナト[\s\S]*ガク[\s\S]*シオン/);
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    dom.window.close();
  }
});

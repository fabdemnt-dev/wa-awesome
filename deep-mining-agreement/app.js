import {
  ACTIONS,
  CONFIG,
  ORES,
  actionAvailability,
  canAccuse,
  canScout,
  collapseLossRate,
  createGame,
  dangerLabel,
  npcSpeech,
  oreCount,
  oreValue,
  publicOreBand,
  resolveRound,
  simulateRemaining,
  totalValue,
} from "./engine.js";

const app = document.querySelector("#app");
let state = null;
let selectedAction = null;
let selectedScout = false;
let selectedAccusationTarget = null;
let latestRecord = null;
let speeches = [];
let humanRetreatMode = null;
let noticeKey = null;
let noticeData = null;
let resultNoticeQueue = [];
let pendingNoticeKeys = [];
let accusationNoticeShown = false;

const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const playerById = (id) => state.players.find((player) => player.id === id);
const actionText = (id) => id ? `${ACTIONS[id].icon} ${ACTIONS[id].label}` : "—";
const bagText = (bag) => Object.values(ORES).map((ore) => `${ore.name}${bag[ore.id]}`).join("／");
const NPC_PORTRAITS = Object.freeze({
  safety: Object.freeze({ src: "assets/characters/minato.png", alt: "ミナト" }),
  greedy: Object.freeze({ src: "assets/characters/gaku.png", alt: "ガク" }),
  tactician: Object.freeze({ src: "assets/characters/shion.png", alt: "シオン" }),
});

function focusApp() {
  app.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderTitle() {
  app.innerHTML = `<nav class="title-navigation" aria-label="ゲーム外への移動"><a class="title-return-link" href="../toybox/">← 🎪 おもちゃ箱へ戻る</a></nav><section class="screen title-screen" aria-labelledby="title-heading">
    <div class="title-panel">
      <div class="mine-mark" aria-hidden="true"><img class="mine-cover" src="assets/cover.png" alt="" width="1586" height="992"></div>
      <p class="eyebrow">ORIGINAL STRATEGY GAME</p>
      <h1 id="title-heading">深層採掘協定</h1>
      <p class="subtitle">掘るほど稼げる。だが、深層は全員まとめて崩れる。</p>
      <div class="button-stack">
        <button class="button button--primary" type="button" data-action="new-game">1人で遊ぶ（CPU対戦）</button>
        <a class="button online-link" href="online.html?players=2">2人で遊ぶ</a>
        <a class="button online-link" href="online.html?players=3">3人で遊ぶ</a>
        <a class="button online-link" href="online.html?players=4">4人で遊ぶ</a>
        <button class="button" type="button" data-action="show-rules" data-return="title">遊び方</button>
      </div>
    </div>
  </section><footer class="title-site-footer"><small>深層採掘協定 — Original Web Card Game</small></footer>`;
  focusApp();
}

function renderRules(returnTo = "title") {
  app.innerHTML = `<section class="screen" aria-labelledby="rules-heading">
    <header class="topbar"><div><p class="eyebrow">HOW TO MINE</p><h1 id="rules-heading">遊び方</h1></div></header>
    <div class="panel rules">
      <article class="rule-card story-card"><h2>深層で結ばれた協定</h2><p>あなたは、地下深くの鉱脈を掘る4人組の一人です。</p><p>協定では、危険が高まれば坑道を補強し、鉱石を正しく申告することになっています。しかし鉱石は高価。誰かがこっそり隠したり、補強を他人に任せて稼ごうとするかもしれません。</p><p>坑道を崩さず、ほかの3人の思惑を読み、できるだけ多くの鉱石を持ち帰りましょう。</p></article>
      <article class="rule-card"><h2>まず覚える3つ</h2><ol><li>採掘すると鉱石を得ますが、全員共通の崩落危険度が上がります。</li><li>補強すると鉱石は得ませんが、危険度を下げ、崩落時の損失も軽くできます。</li><li>8ラウンド終了時、持ち帰った鉱石価値が最も高い人の勝ちです。</li></ol></article>
      <article class="rule-card"><h2>通常行動</h2><ul><li><strong>採掘：</strong>今回の鉱石を公開鉱石として2個獲得。</li><li><strong>補強：</strong>危険度を12下げ、補強貢献を1増やす。</li><li><strong>隠匿採掘：</strong>3Rから。1個を公開鉱石、1個を秘密鉱石として獲得。他人には採掘に見えます。</li><li><strong>撤退：</strong>5Rから。所持品を確定し、崩落を免れます。</li></ul></article>
      <article class="rule-card"><h2>鉱脈</h2><ul><li>鉄晶：価値1／採掘危険＋7（低）</li><li>蒼晶：価値2／採掘危険＋10（中）</li><li>金晶：価値3／採掘危険＋13（高）</li></ul></article>
      <article class="rule-card"><h2>補助行動</h2><p><strong>🔭 偵察：</strong>通常行動とは別に使えます。次の鉱脈を一足先に確認できます。1ゲーム2回までです。</p><p><strong>⚖️ 告発：</strong>隠匿採掘を検知した後、通常行動とは別に相手を指名できます。</p></article>
      <article class="rule-card"><h2>告発と崩落</h2><p>隠匿採掘を検知した後は、通常行動とは別に相手を告発できます。成功すると秘密鉱石1個を共同保管庫へ、失敗すると最終価値が1下がります。</p><p>危険度が100以上になると崩落。在坑者は鉱石を失いますが、補強貢献が多いほど損失が小さくなります。</p></article>
      <article class="rule-card"><h2>坑道の仲間</h2><ul><li><strong>ミナト：</strong>坑道整備士。安全や足場をよく見ています。</li><li><strong>ガク：</strong>採掘師。価値の高い鉱脈を見逃しません。</li><li><strong>シオン：</strong>鉱脈調査員。周囲を観察しながら動きます。</li></ul></article>
    </div>
    <button class="button" type="button" data-action="back-from-rules" data-return="${escapeHtml(returnTo)}">戻る</button>
  </section>`;
  focusApp();
}

function beginGame() {
  state = createGame();
  selectedAction = null;
  selectedScout = false;
  selectedAccusationTarget = null;
  latestRecord = null;
  humanRetreatMode = null;
  noticeData = null;
  resultNoticeQueue = [];
  pendingNoticeKeys = [];
  accusationNoticeShown = false;
  prepareRound();
  noticeKey = "basics";
  renderGame();
}

function prepareRound() {
  speeches = state.players.slice(1).filter(({ active }) => active).map((player) => ({ player, text: npcSpeech(state, player) }));
  selectedAction = null;
  selectedScout = false;
  selectedAccusationTarget = null;
}

function seatMarkup(player) {
  const isYou = player.isHuman;
  const portrait = isYou ? null : NPC_PORTRAITS[player.id];
  return `<article class="seat ${portrait ? "seat--portrait" : "seat--you"} ${player.active ? "" : "seat--out"}" data-player-id="${escapeHtml(player.id)}">
    ${portrait ? `<div class="seat-portrait-frame"><img class="seat-portrait" src="${portrait.src}" alt="${escapeHtml(portrait.alt)}" width="64" height="64"></div>` : ""}
    <div class="seat-info">
      <div class="seat-head"><span class="seat-name">${escapeHtml(player.name)}${player.role ? `<small>${escapeHtml(player.role)}</small>` : ""}</span><span class="badge ${player.active ? "" : "badge--out"}">${player.active ? "在坑" : "撤退"}</span></div>
      <p>${isYou ? `公開 ${oreCount(player.publicOre)}個／秘密 ${oreCount(player.secretOre)}個` : `公開所持 ${publicOreBand(player)}`}</p>
      <p>補強貢献 ${player.reinforcement}</p>
      ${isYou && player.discredit ? `<p>信用失墜 ${player.discredit}</p>` : ""}
    </div>
  </article>`;
}

function actionMarkup(id, enabled, reason = "") {
  const action = ACTIONS[id];
  const descriptions = {
    mine: "公開で2個",
    reinforce: "危険度−12",
    secret: "1公開＋1秘密",
    retreat: "利益を確定",
  };
  return `<button class="action-button ${id === "retreat" ? "action-button--wide" : ""}" type="button" data-action="choose-action" data-action-id="${id}" aria-pressed="${selectedAction === id}" ${enabled ? "" : "disabled"}>
    <span class="action-icon" aria-hidden="true">${action.icon}</span><span class="action-copy">${action.label}<small>${enabled ? descriptions[id] : reason}</small></span>
  </button>`;
}

function selectedChoiceMarkup(human) {
  if (!selectedAction) return "<p class=\"selection-action muted\">通常行動を選んでください</p>";
  const target = selectedAccusationTarget ? playerById(selectedAccusationTarget) : null;
  return `<p class="selection-action">${actionText(selectedAction)}</p>${selectedScout ? "<p class=\"selection-scout\">🔭 偵察</p>" : ""}${target ? `<p class="selection-accusation">⚖️ ${escapeHtml(target.name)}を告発</p>` : ""}`;
}

function updateCurrentSelection() {
  document.querySelectorAll('[data-action="choose-action"]').forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.actionId === selectedAction));
  });
  const human = state?.players[0];
  const summary = document.querySelector("#current-selection");
  if (summary && human) summary.innerHTML = selectedChoiceMarkup(human);
  const confirm = document.querySelector('[data-action="confirm-action"]');
  if (confirm) confirm.disabled = !selectedAction;
}

function updateAccusationSelection() {
  const select = document.querySelector("#accusation-target");
  if (select) select.value = selectedAccusationTarget || "";
  const cancel = document.querySelector('[data-action="cancel-accusation"]');
  if (cancel) cancel.hidden = !selectedAccusationTarget;
  const human = state?.players[0];
  const summary = document.querySelector("#current-selection");
  if (summary && human) summary.innerHTML = selectedChoiceMarkup(human);
}

function updateScoutSelection() {
  const scout = document.querySelector('[data-action="select-scout"]');
  if (scout) scout.setAttribute("aria-pressed", String(selectedScout));
  const cancel = document.querySelector('[data-action="cancel-scout"]');
  if (cancel) cancel.hidden = !selectedScout;
  const human = state?.players[0];
  const summary = document.querySelector("#current-selection");
  if (summary && human) summary.innerHTML = selectedChoiceMarkup(human);
}

function historyMarkup() {
  if (!state.history.length) return "<p class=\"muted\">まだ結果はありません。</p>";
  return state.history.slice().reverse().map((record) => {
    const ore = ORES[record.oreId];
    const actions = state.players.map((player) => `${escapeHtml(player.name)}：${actionText(record.publicActions[player.id])}`).join("／");
    const accusations = record.accusationResults.map((item) => `${escapeHtml(playerById(item.accuserId).name)}→${escapeHtml(playerById(item.targetId).name)} ${item.success ? "成功" : "失敗"}`).join("／");
    const scout = record.scouts?.human && record.scoutOreId ? `🔭 偵察結果：次は${ORES[record.scoutOreId].name}` : "";
    return `<div class="history-item"><strong>第${record.round}R ${ore.name}</strong><br>${actions}<br>危険度 ${record.dangerBefore} → ${record.dangerAfter}、隠匿採掘 ${record.secretCount}件${accusations ? `<br>告発：${accusations}` : ""}${scout ? `<br>${scout}` : ""}</div>`;
  }).join("");
}

function latestResultMarkup() {
  if (!latestRecord) return "";
  return `<section class="panel result-card" aria-live="polite">
    <h2>第${latestRecord.round}R 結果</h2>
    <div class="reveal-grid">${state.players.map((player) => `<div class="reveal"><span>${escapeHtml(player.name)}</span>${actionText(latestRecord.publicActions[player.id])}</div>`).join("")}</div>
    <p>危険度：${latestRecord.dangerBefore} ＋${latestRecord.dangerAdded} −${latestRecord.dangerReduced} → <strong>${latestRecord.dangerAfter}</strong></p>
  </section>`;
}

function retreatControls() {
  const human = state.players[0];
  if (human.active || state.ended) return "";
  if (!humanRetreatMode) return `<section class="panel"><h2>撤退しました</h2><p>鉱石は持ち帰り済みです。残るNPCの採掘を観戦できます。</p><div class="button-stack"><button class="button button--primary" data-action="watch-next">残りを観戦</button><button class="button" data-action="fast-forward">結果まで進める</button></div></section>`;
  return `<button class="button button--primary" data-action="watch-next">NPCの次ラウンドを見る</button>`;
}

function renderNotice() {
  if (!noticeKey && !noticeData) return "";
  const notices = {
    basics: ["採掘協定の基本", "掘ると稼げますが、危険度は全員共通です。補強も交え、8R終了までに最も高い価値を持ち帰りましょう。"],
    secret: ["隠匿採掘が解禁", "鉱石を2個獲得し、1個を公開鉱石、1個を秘密鉱石にします。他人には採掘と表示され、件数だけが検知されます。"],
    accusation: ["⚖️ 告発が解禁されました", "隠匿採掘をしたと思う相手を指名できます。当たれば秘密鉱石を1個押収、外れると最終価値が1下がります。通常行動とは別に、1ゲーム2回まで使えます。"],
    retreat: ["撤退が解禁", "今の鉱石を確定して坑道を離れられます。撤退後は崩落の被害を受けません。"],
  };
  const [title, body] = noticeData ? [noticeData.title, noticeData.body] : notices[noticeKey];
  return `<aside class="notice" role="dialog" aria-modal="true" aria-labelledby="notice-title"><h2 id="notice-title">${title}</h2><p>${body}</p><button class="button button--primary" data-action="close-notice">わかった</button></aside>`;
}

function queueRoundResultNotices(record) {
  const notices = [];
  const result = record.accusationResults.find(({ accuserId }) => accuserId === "human");
  if (result) {
    const target = playerById(result.targetId);
    notices.push(result.success
      ? { title: "⚖️ 告発成功！", body: `${escapeHtml(target.name)}から秘密鉱石を1個押収しました。` }
      : { title: "⚖️ 告発失敗", body: `${escapeHtml(target.name)}は秘密鉱石を持っていませんでした。信用失墜：最終価値 −1` });
  }
  if (record.scouts?.human && record.scoutOreId) {
    const ore = ORES[record.scoutOreId];
    notices.push({ title: "🔭 偵察結果", body: `次の鉱脈は<br><strong class="notice-ore">「${ore.name}」</strong><br>価値：${ore.value}<br>採掘危険：${ore.level}` });
  }
  if (record.secretCount) notices.push({ title: "⚠️ 隠匿採掘を検知", body: `このラウンドで隠匿採掘を${record.secretCount}件検知しました。` });
  noticeData = notices.shift() || null;
  resultNoticeQueue = notices;
}

function dangerClass(danger) {
  if (danger < 40) return "safe";
  if (danger < 60) return "caution";
  if (danger < 80) return "danger";
  if (danger < 100) return "critical";
  return "collapse";
}

function renderGame() {
  if (state.ended) return renderResult();
  const human = state.players[0];
  const ore = ORES[state.oreSequence[state.round - 1]];
  const availability = actionAvailability(state, human);
  const canHumanAct = human.active;
  const scoutInfo = human.scoutedRound === state.round && human.scoutedOre ? `🔭 前ラウンドで偵察済み` : "";
  const scoutAvailable = canScout(state, human);
  const scoutsRemaining = CONFIG.maxScouts - human.scoutsUsed;
  const accusationAvailable = canAccuse(state, human);
  const accusationTargets = state.players.filter((player) => !player.isHuman && player.active);
  app.innerHTML = `<section class="screen" aria-labelledby="game-heading">
    <header class="topbar"><div><p class="round-label">第${state.round} / ${CONFIG.totalRounds}ラウンド</p><h1 class="game-title" id="game-heading">深層採掘協定</h1></div><button class="button button--quiet help-button" type="button" data-action="show-rules" data-return="game" aria-label="遊び方">？</button></header>
    <section class="panel danger-panel" data-danger="${dangerClass(state.danger)}"><div class="danger-head"><h2>崩落危険度</h2><strong>${state.danger}　<span class="danger-status">${dangerLabel(state.danger)}</span></strong></div><div class="danger-track" role="progressbar" aria-label="崩落危険度：${dangerLabel(state.danger)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(state.danger, 100)}"><div class="danger-fill" style="width:${Math.min(state.danger, 100)}%"></div></div></section>
    <section class="panel ore-panel"><div class="ore-icon" aria-hidden="true">${ore.icon}</div><div><h2>${ore.name}</h2><p>価値 ${ore.value}　危険 ${ore.level}</p>${scoutInfo ? `<p class="scout-note scout-prior-note">${scoutInfo}</p>` : ""}</div></section>
    <section class="panel seat-panel"><h2>4つの採掘席</h2><div class="seat-grid">${state.players.map(seatMarkup).join("")}</div></section>
    <section class="panel"><h2>坑道の声</h2><div class="speech-list">${speeches.map(({ player, text }) => `<p class="speech"><strong>${escapeHtml(player.name)}：</strong>${escapeHtml(text)}</p>`).join("") || "<p class=\"muted\">坑道は静かだ。</p>"}</div></section>
    ${canHumanAct ? `<section class="panel"><h2>今回の行動</h2><div class="action-grid">
      ${actionMarkup("mine", availability.mine)}${actionMarkup("reinforce", availability.reinforce)}${actionMarkup("secret", availability.secret, "第3Rから")}${actionMarkup("retreat", availability.retreat, "第5Rから")}
    </div><div class="support-actions"><h3>補助行動</h3><div class="scout-control"><button class="button button--quiet" type="button" data-action="select-scout" aria-pressed="${selectedScout}" ${scoutAvailable && !selectedScout ? "" : "disabled"}>🔭 偵察（残り${scoutsRemaining}）<small>${state.round >= CONFIG.totalRounds ? "第8Rは使用不可" : "次の鉱脈を見る"}</small></button><button class="button button--quiet scout-cancel" type="button" data-action="cancel-scout" ${selectedScout ? "" : "hidden"}>偵察を取り消す</button></div>${accusationAvailable ? `<div class="accusation"><label><span>⚖️ 告発（残り${CONFIG.maxAccusations - human.accusationsUsed}）</span><small>隠匿した相手を指名</small><select id="accusation-target"><option value="">相手を選ぶ</option>${accusationTargets.map((player) => `<option value="${player.id}" ${selectedAccusationTarget === player.id ? "selected" : ""}>${escapeHtml(player.name)}を告発</option>`).join("")}</select></label><button class="button button--quiet accusation-cancel" type="button" data-action="cancel-accusation" ${selectedAccusationTarget ? "" : "hidden"}>告発を取り消す</button></div>` : ""}</div><div class="current-selection"><h3>今回の選択</h3><div id="current-selection" aria-live="polite">${selectedChoiceMarkup(human)}</div></div><div class="confirm-bar"><button class="button button--primary" type="button" data-action="confirm-action" ${selectedAction ? "" : "disabled"}>行動を確定する</button></div></section>` : retreatControls()}
    ${latestResultMarkup()}
    <details class="panel history"><summary>全履歴を見る</summary><div class="history-list">${historyMarkup()}</div></details>
    ${renderNotice()}
  </section>`;
  focusApp();
}

function resolveHumanRound() {
  if (!selectedAction) return;
  const resolvedAction = selectedAction;
  const resolvedScout = selectedScout;
  latestRecord = resolveRound(state, { humanAction: resolvedAction, humanScout: resolvedScout, humanAccusationTarget: selectedAccusationTarget });
  queueRoundResultNotices(latestRecord);
  if (state.ended) return renderResult();
  if (resolvedAction === "retreat") humanRetreatMode = null;
  prepareRound();
  const nextNotices = [];
  if (state.round === CONFIG.secretUnlockRound) nextNotices.push("secret");
  if (state.round === CONFIG.retreatUnlockRound) nextNotices.push("retreat");
  if (!accusationNoticeShown && canAccuse(state, state.players[0])) {
    nextNotices.push("accusation");
    accusationNoticeShown = true;
  }
  noticeKey = nextNotices.shift() || null;
  pendingNoticeKeys = nextNotices;
  renderGame();
}

function watchNext() {
  humanRetreatMode = "watch";
  latestRecord = resolveRound(state, { humanAction: null });
  if (state.ended) return renderResult();
  prepareRound();
  renderGame();
}

function fastForward() {
  simulateRemaining(state);
  renderResult();
}

function oreValueBreakdownMarkup(title, bag) {
  const value = oreValue(bag);
  const rows = Object.values(ORES).map((ore) => `<span>${ore.name} ${bag[ore.id]} × ${ore.value} ＝ ${bag[ore.id] * ore.value}</span>`).join("");
  return `<div class="value-block"><div class="value-block-head"><strong>${title}</strong><span>価値${value}</span></div><div class="value-rows">${rows}</div></div>`;
}

function resultCardMarkup(player) {
  const publicValue = oreValue(player.publicOre);
  const secretValue = oreValue(player.secretOre);
  const vaultValue = oreValue(player.vaultOre);
  const carriedValue = publicValue + secretValue;
  const beforeCollapseValue = carriedValue + player.collapseLoss;
  const finalValue = totalValue(player);
  const publicLossPercent = Math.round(collapseLossRate(player.reinforcement) * 100);
  const secretLossPercent = Math.max(0, publicLossPercent - Math.round(CONFIG.secretLossReduction * 100));
  const collapseNote = state.collapsed
    ? player.retreated ? "撤退済みのため損失なし" : "崩落時に適用"
    : "崩落なし・損失軽減は未発動";
  const summaryParts = [`鉱石${beforeCollapseValue}`];
  if (player.collapseLoss) summaryParts.push(`− 損失${player.collapseLoss}`);
  if (vaultValue) summaryParts.push(`＋ 分配${vaultValue}`);
  if (player.discredit) summaryParts.push(`− 信用${player.discredit}`);
  const details = `${oreValueBreakdownMarkup("持ち帰った公開鉱石", player.publicOre)}
      ${oreValueBreakdownMarkup("持ち帰った秘密鉱石", player.secretOre)}
      <div class="score-details"><p>持ち帰った鉱石：価値${carriedValue}</p><p>崩落前鉱石価値：${beforeCollapseValue}</p><p>補強貢献：<strong>${player.reinforcement}回</strong></p><p>崩落時損失率：公開鉱石${publicLossPercent}%／秘密鉱石${secretLossPercent}%<small>${collapseNote}</small></p><p>共同保管庫分配：＋${vaultValue}</p><p>信用失墜：−${player.discredit}</p><p>崩落損失：−${player.collapseLoss}</p></div>
      <p class="score-equation">${beforeCollapseValue} − ${player.collapseLoss} ＋ ${vaultValue} − ${player.discredit} ＝ 最終価値 ${finalValue}</p>
      <p class="answer">隠匿採掘 ${player.secretActions}回　・　告発 成功${player.accusationSuccesses}／失敗${player.accusationFailures}</p>`;
  return `<article class="rank-card ${player.rank === 1 ? "rank-card--winner" : ""}" data-player-id="${player.id}">
    <div class="rank-head"><strong>${player.rank}位　${escapeHtml(player.name)}</strong><span class="rank-value">最終価値 ${finalValue}</span></div>
    <p class="rank-summary">${summaryParts.join(" ")}</p>
    <details class="rank-details" ${player.isHuman ? "open" : ""}><summary>${player.isHuman ? "自分の内訳" : "内訳を見る"}</summary><div class="rank-details-body">${details}</div></details>
  </article>`;
}

function answerRowsMarkup(title, valueForPlayer) {
  return `<div class="answer-group"><h3>${title}</h3>${state.players.map((player) => `<p><span>${escapeHtml(player.name)}</span><strong>${valueForPlayer(player)}</strong></p>`).join("")}</div>`;
}

function renderResult() {
  const reason = state.endReason === "collapse" ? "坑道が崩落した" : state.endReason === "all-retreated" ? "全員が撤退した" : "8ラウンドが終了した";
  const winners = state.players.filter((player) => player.rank === 1);
  const humanWon = winners.some(({ isHuman }) => isHuman);
  const headline = winners.length > 1 ? `引き分け：${winners.map(({ name }) => name).join("・")}` : humanWon ? "あなたの勝利" : `${winners[0].name}の勝利`;
  app.innerHTML = `<section class="screen" aria-labelledby="result-heading">
    <header><p class="eyebrow">MINING COMPLETE</p><h1 id="result-heading">${headline}</h1><p class="subtitle">${reason}ため、持ち帰った鉱石を精算しました。</p></header>
    <section class="panel ranking">${[...state.players].sort((a,b)=>a.rank-b.rank).map(resultCardMarkup).join("")}</section>
    <section class="panel answer-panel"><h2>答え合わせ</h2>${answerRowsMarkup("隠匿採掘", (player) => `${player.secretActions}回`)}${answerRowsMarkup("共同保管庫分配", (player) => `${oreCount(player.vaultOre)}個`)}</section>
    <details class="panel history"><summary>全8ラウンドの履歴</summary><div class="history-list">${historyMarkup()}</div></details>
    <div class="button-stack"><button class="button button--primary" data-action="new-game">もう一度</button><a class="text-link" href="../toybox/">🎪 おもちゃ箱へ戻る</a></div>
    ${renderNotice()}
  </section>`;
  focusApp();
}

app.addEventListener("click", (event) => {
  const control = event.target.closest("[data-action]");
  if (!control) return;
  const action = control.dataset.action;
  if (action === "new-game") beginGame();
  if (action === "show-rules") renderRules(control.dataset.return);
  if (action === "back-from-rules") control.dataset.return === "game" ? renderGame() : renderTitle();
  if (action === "choose-action") { selectedAction = control.dataset.actionId; updateCurrentSelection(); }
  if (action === "select-scout") { selectedScout = true; updateScoutSelection(); }
  if (action === "cancel-scout") { selectedScout = false; updateScoutSelection(); }
  if (action === "cancel-accusation") { selectedAccusationTarget = null; updateAccusationSelection(); }
  if (action === "confirm-action") resolveHumanRound();
  if (action === "watch-next") watchNext();
  if (action === "fast-forward") fastForward();
  if (action === "close-notice") {
    if (noticeData) noticeData = resultNoticeQueue.shift() || null;
    else noticeKey = pendingNoticeKeys.shift() || null;
    renderGame();
  }
});

app.addEventListener("change", (event) => {
  if (event.target.id !== "accusation-target") return;
  if (!event.target.value) {
    event.target.value = selectedAccusationTarget || "";
    return;
  }
  selectedAccusationTarget = event.target.value;
  updateAccusationSelection();
});

renderTitle();

window.__deepMiningAgreement = { beginGame, getState: () => state, renderGame };

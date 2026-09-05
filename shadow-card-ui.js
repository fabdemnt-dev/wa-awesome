"use strict";

(function initializeShadowCardUI(global) {
  const data = global.ShadowCardData;
  const stateApi = global.ShadowCardState;
  const logic = global.ShadowCardLogic;

  if (!data || !stateApi || !logic) {
    throw new Error(
      "ShadowCardData, ShadowCardState, and ShadowCardLogic must be loaded before ShadowCardUI."
    );
  }

  const { PARTICIPANT_KEYS, SCREENS } = stateApi;

  const SCREEN_IDS = Object.freeze({
    [SCREENS.TITLE]: "title-screen",
    [SCREENS.PARTNER]: "partner-screen",
    [SCREENS.RULES]: "rules-screen",
    [SCREENS.GAME]: "game-screen",
    [SCREENS.ROUND_RESULT]: "round-result-screen",
    [SCREENS.FINAL_RESULT]: "final-result-screen"
  });

  const FINAL_RESULT_IMAGES = Object.freeze({
    win: "assets/shadow-card/result-win.webp",
    lose: "assets/shadow-card/result-lose.webp",
    draw: "assets/shadow-card/result-draw.webp"
  });

  function element(id) {
    const found = document.getElementById(id);

    if (!found) {
      throw new Error(`Required UI element was not found: ${id}`);
    }

    return found;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function signedNumber(value) {
    if (value > 0) {
      return `＋${value}`;
    }

    if (value < 0) {
      return `−${Math.abs(value)}`;
    }

    return "0";
  }

  function artMarkup(source, alt, modifier) {
    return `
      <span class="shadow-art ${modifier || ""}">
        <img class="shadow-art__image" src="${escapeHtml(source)}" alt="${escapeHtml(alt || "")}" loading="lazy" width="768" height="1024">
      </span>
    `;
  }

  function activateImageFallbacks(root) {
    root.querySelectorAll(".shadow-art__image").forEach((image) => {
      const hideFailedImage = () => {
        image.hidden = true;
      };

      image.addEventListener("error", hideFailedImage, { once: true });
      if (image.complete && image.naturalWidth === 0) {
        hideFailedImage();
      }
    });
  }

  function showCurrentScreen(currentScreen) {
    Object.entries(SCREEN_IDS).forEach(([screenName, screenId]) => {
      element(screenId).hidden = screenName !== currentScreen;
    });

    window.scrollTo({ top: 0, behavior: "auto" });
    element("app").focus({ preventScroll: true });
  }

  function renderPartnerSelection() {
    const state = stateApi.getGameState();
    const selectionList = element("npc-selection-list");

    selectionList.innerHTML = data.NPCS.map((npc) => {
      const selected = state.selectedPartnerId === npc.id;

      return `
        <button
          class="npc-choice${selected ? " is-selected" : ""}"
          type="button"
          role="radio"
          aria-checked="${selected}"
          data-npc-id="${escapeHtml(npc.id)}"
        >
          ${artMarkup(npc.image, npc.imageAlt, "shadow-art--npc-choice")}
          <span class="npc-choice__name">${escapeHtml(npc.name)}</span>
          <span class="npc-choice__mark" aria-hidden="true">✓</span>
          <p class="npc-choice__summary"><strong>役割：</strong>${escapeHtml(npc.role)}</p>
          <p class="npc-choice__summary"><strong>得意：</strong>${escapeHtml(npc.strength)}</p>
          <p class="npc-choice__summary"><strong>注意点：</strong>${escapeHtml(npc.caution)}</p>
        </button>
      `;
    }).join("");

    element("confirm-partner-button").disabled = state.selectedPartnerId === null;
  }

  function participantName(state, participantKey) {
    if (participantKey === PARTICIPANT_KEYS.PLAYER) {
      return "あなた";
    }

    if (participantKey === PARTICIPANT_KEYS.ALLY) {
      return data.NPC_BY_ID[state.allyNpcId].name;
    }

    if (participantKey === PARTICIPANT_KEYS.ENEMY_ONE) {
      return data.NPC_BY_ID[state.enemyNpcIds[0]].name;
    }

    return data.NPC_BY_ID[state.enemyNpcIds[1]].name;
  }

  function participantSide(participantKey) {
    return participantKey === PARTICIPANT_KEYS.PLAYER ||
      participantKey === PARTICIPANT_KEYS.ALLY
      ? "ally"
      : "enemy";
  }

  function renderForecasts(state) {
    const entries = [
      [PARTICIPANT_KEYS.ALLY, "味方"],
      [PARTICIPANT_KEYS.ENEMY_ONE, "敵"],
      [PARTICIPANT_KEYS.ENEMY_TWO, "敵"]
    ];

    element("npc-forecasts").innerHTML = entries.map(([participantKey, sideLabel]) => {
      const side = participantSide(participantKey);
      const npcId = participantKey === PARTICIPANT_KEYS.ALLY
        ? state.allyNpcId
        : state.enemyNpcIds[participantKey === PARTICIPANT_KEYS.ENEMY_ONE ? 0 : 1];
      const npc = data.NPC_BY_ID[npcId];

      return `
        <article class="forecast-item forecast-item--${side}">
          ${artMarkup(npc.image, npc.imageAlt, "shadow-art--forecast")}
          <span class="forecast-item__side">${sideLabel}</span>
          <span class="forecast-item__name">${escapeHtml(participantName(state, participantKey))}</span>
          <p class="forecast-item__text">「${escapeHtml(state.npcForecasts[participantKey])}」</p>
        </article>
      `;
    }).join("");
  }

  function renderNpcRoleDetails(state) {
    const entries = [
      [state.allyNpcId, "味方"],
      [state.enemyNpcIds[0], "敵"],
      [state.enemyNpcIds[1], "敵"]
    ];

    element("npc-role-details").innerHTML = entries.map(([npcId, sideLabel]) => {
      const npc = data.NPC_BY_ID[npcId];

      return `
        <section>
          <h3>${sideLabel}・${escapeHtml(npc.name)}</h3>
          <p><strong>役割：</strong>${escapeHtml(npc.role)}</p>
          <p><strong>得意：</strong>${escapeHtml(npc.strength)}</p>
          <p><strong>注意点：</strong>${escapeHtml(npc.caution)}</p>
        </section>
      `;
    }).join("");
  }

  function baseValueLabel(card) {
    return card.id === "shift" ? "2 または 5" : String(card.baseValue);
  }

  function renderPlayerHand(state) {
    const playerHand = state.hands[PARTICIPANT_KEYS.PLAYER];

    element("player-hand").innerHTML = playerHand.map((handItem, handIndex) => {
      const card = data.CARD_BY_ID[handItem.cardId];
      const selected = state.selectedPlayerCardIndex === handIndex;
      const disabled = state.isResolvingRound || state.isRoundResolved;

      return `
        <button
          class="hand-card${selected ? " is-selected" : ""}"
          type="button"
          role="radio"
          aria-checked="${selected}"
          aria-label="${escapeHtml(card.name)}、${escapeHtml(data.CARD_TYPE_LABELS[card.type])}、基本値${escapeHtml(baseValueLabel(card))}"
          data-hand-index="${handIndex}"
          ${disabled ? "disabled" : ""}
        >
          <span class="hand-card__selected-mark" aria-hidden="true">選択中</span>
          ${artMarkup(card.image, "", "shadow-art--card")}
          <span class="hand-card__type">${escapeHtml(data.CARD_TYPE_LABELS[card.type])}</span>
          <span class="hand-card__name">${escapeHtml(card.name)}</span>
          <span class="hand-card__value">基本値 ${escapeHtml(baseValueLabel(card))}</span>
          <span class="hand-card__effect">${escapeHtml(card.description)}</span>
        </button>
      `;
    }).join("");
  }

  function renderSelectedCard(state) {
    const status = element("hand-selection-status");
    const description = element("selected-card-description");

    if (state.selectedPlayerCardIndex === null) {
      status.textContent = "未選択";
      status.classList.remove("is-selected");
      description.innerHTML = "<p>カードを選ぶと詳細が表示されます。</p>";
      return;
    }

    const handItem = state.hands[PARTICIPANT_KEYS.PLAYER][
      state.selectedPlayerCardIndex
    ];
    const card = data.CARD_BY_ID[handItem.cardId];

    status.textContent = `選択中：${card.name}`;
    status.classList.add("is-selected");
    description.innerHTML = `
      <h3>${escapeHtml(card.name)}</h3>
      <p><strong>種別：</strong>${escapeHtml(data.CARD_TYPE_LABELS[card.type])}</p>
      <p><strong>基本値：</strong>${escapeHtml(baseValueLabel(card))}</p>
      <p>${escapeHtml(card.description)}</p>
    `;
  }

  function outcomeLabel(outcome) {
    if (outcome === "ally") {
      return "自チームの勝利";
    }

    if (outcome === "enemy") {
      return "敵チームの勝利";
    }

    return "引き分け";
  }

  function renderHistoryList(history, includeCards) {
    if (history.length === 0) {
      return "<p>まだ履歴はありません。</p>";
    }

    return `
      <ol class="history-list">
        ${history.map((round) => {
          const cardDetail = includeCards
            ? `あなた：${round.playedCards[PARTICIPANT_KEYS.PLAYER].name}／味方：${round.playedCards[PARTICIPANT_KEYS.ALLY].name}`
            : `最終値 ${round.calculation.ally.finalValue} 対 ${round.calculation.enemy.finalValue}`;

          return `
            <li class="history-item">
              <span class="history-item__round">ROUND ${round.roundNumber}</span>
              <span class="history-item__result">${escapeHtml(outcomeLabel(round.outcome))}</span>
              <span class="history-item__detail">${escapeHtml(round.fieldCard.name)}・${round.fieldCard.points}点／${escapeHtml(cardDetail)}</span>
            </li>
          `;
        }).join("")}
      </ol>
    `;
  }

  function calculationSummary(teamName, calculation) {
    return `
      <section class="calculation-team">
        <h3>${escapeHtml(teamName)}</h3>
        <dl class="calculation-list">
          <div><dt>基本値合計</dt><dd>${calculation.baseValueTotal}</dd></div>
          <div><dt>援護の加算</dt><dd>${signedNumber(calculation.additions.assist)}</dd></div>
          <div><dt>誘導の加算</dt><dd>${signedNumber(calculation.additions.misdirect)}</dd></div>
          <div><dt>自チーム加算</dt><dd>${signedNumber(calculation.additions.total)}</dd></div>
          <div><dt>けん制による減算</dt><dd>−${calculation.incomingReduction.check}</dd></div>
          <div><dt>崩しによる減算</dt><dd>−${calculation.incomingReduction.disrupt}</dd></div>
          <div><dt>相手からの減算</dt><dd>−${calculation.incomingReduction.total}</dd></div>
          <div><dt>守勢による軽減</dt><dd>${signedNumber(calculation.defenseReduction)}</dd></div>
          <div><dt>有効減算</dt><dd>−${calculation.effectiveReduction}</dd></div>
          <div><dt>全力ペナルティ</dt><dd>−${calculation.appliedPenalty}</dd></div>
          <div><dt>最終値</dt><dd>${calculation.finalValue}</dd></div>
        </dl>
      </section>
    `;
  }

  function renderCalculationHistory(state) {
    const historyContainer = element("calculation-history");

    if (state.roundHistory.length === 0) {
      historyContainer.innerHTML = "<p>まだ計算履歴はありません。</p>";
      return;
    }

    historyContainer.innerHTML = state.roundHistory.map((round) => `
      <section>
        <h3>ROUND ${round.roundNumber}・${escapeHtml(round.fieldCard.name)}</h3>
        <div class="calculation-comparison">
          ${calculationSummary("自チーム", round.calculation.ally)}
          ${calculationSummary("敵チーム", round.calculation.enemy)}
        </div>
      </section>
    `).join("");
  }

  function renderGameScreen() {
    const state = stateApi.getGameState();

    element("round-number").textContent = String(state.roundNumber);
    element("ally-score").textContent = String(state.scores.ally);
    element("enemy-score").textContent = String(state.scores.enemy);
    element("field-card-name").textContent = state.fieldCard.name;
    element("field-card-points").textContent = String(state.fieldCard.points);
    element("ally-penalty").textContent = state.currentPenalties.ally > 0
      ? "自チーム：最終値−1"
      : "自チーム：なし";
    element("enemy-penalty").textContent = state.currentPenalties.enemy > 0
      ? "敵チーム：最終値−1"
      : "敵チーム：なし";

    renderForecasts(state);
    renderNpcRoleDetails(state);
    renderPlayerHand(state);
    renderSelectedCard(state);
    element("round-history").innerHTML = renderHistoryList(
      state.roundHistory,
      false
    );
    renderCalculationHistory(state);

    const confirmButton = element("confirm-card-button");
    confirmButton.disabled = state.selectedPlayerCardIndex === null ||
      state.isResolvingRound ||
      state.isRoundResolved;
    confirmButton.textContent = state.isResolvingRound
      ? "計算中…"
      : "このカードで決定";
  }

  function resolvedValueText(playedCard) {
    return playedCard.cardId === "shift"
      ? `変転の確定値：${playedCard.resolvedBaseValue}`
      : `基本値：${playedCard.resolvedBaseValue}`;
  }

  function renderRevealedCards(state, roundResult) {
    const order = [
      PARTICIPANT_KEYS.PLAYER,
      PARTICIPANT_KEYS.ALLY,
      PARTICIPANT_KEYS.ENEMY_ONE,
      PARTICIPANT_KEYS.ENEMY_TWO
    ];

    element("revealed-cards").innerHTML = order.map((participantKey) => {
      const playedCard = roundResult.playedCards[participantKey];
      const side = participantSide(participantKey);
      const sideLabel = side === "ally" ? "自チーム" : "敵チーム";
      const card = data.CARD_BY_ID[playedCard.cardId];

      return `
        <article class="revealed-card revealed-card--${side}">
          ${artMarkup(card.image, "", "shadow-art--revealed")}
          <p>${sideLabel}・${escapeHtml(participantName(state, participantKey))}</p>
          <p class="revealed-card__name">${escapeHtml(playedCard.name)}</p>
          <p>${escapeHtml(data.CARD_TYPE_LABELS[playedCard.type])}</p>
          <p>${escapeHtml(resolvedValueText(playedCard))}</p>
        </article>
      `;
    }).join("");
  }

  function renderRoundResult() {
    const state = stateApi.getGameState();
    const result = state.lastRoundResult;

    if (!result) {
      return;
    }

    element("round-result-label").textContent = `ROUND ${result.roundNumber} RESULT`;
    element("round-outcome").textContent = outcomeLabel(result.outcome);
    renderRevealedCards(state, result);
    element("round-calculation").innerHTML = `
      ${calculationSummary("自チーム", result.calculation.ally)}
      ${calculationSummary("敵チーム", result.calculation.enemy)}
    `;

    if (result.outcome === "draw") {
      element("round-points-earned").textContent = "獲得点：なし";
    } else {
      const winner = result.outcome === "ally" ? "自チーム" : "敵チーム";
      element("round-points-earned").textContent = `獲得点：${winner} ＋${result.fieldCard.points}`;
    }

    element("cumulative-score").textContent = `累計点：自チーム ${result.scoresAfter.ally} ／ 敵チーム ${result.scoresAfter.enemy}`;
    element("next-round-button").textContent = result.roundNumber >= data.GAME_RULES.totalRounds
      ? "最終結果へ"
      : "次のラウンドへ";
  }

  function renderFinalResult() {
    const state = stateApi.getGameState();
    const finalOutcome = logic.getFinalOutcome();
    const outcomeText = {
      win: "勝利",
      lose: "敗北",
      draw: "引き分け"
    }[finalOutcome];

    element("final-result-image").src = FINAL_RESULT_IMAGES[finalOutcome];

    element("final-outcome").textContent = outcomeText;
    element("final-score").textContent = `自チーム ${state.scores.ally} ／ 敵チーム ${state.scores.enemy}`;

    const ally = data.NPC_BY_ID[state.allyNpcId];
    const enemyOne = data.NPC_BY_ID[state.enemyNpcIds[0]];
    const enemyTwo = data.NPC_BY_ID[state.enemyNpcIds[1]];
    element("final-formation").innerHTML = `
      <p><strong>自チーム：</strong>あなた ＋ ${escapeHtml(ally.name)}</p>
      <p><strong>敵チーム：</strong>${escapeHtml(enemyOne.name)} ＋ ${escapeHtml(enemyTwo.name)}</p>
    `;
    element("final-round-history").innerHTML = renderHistoryList(
      state.roundHistory,
      true
    );
  }

  function render() {
    const state = stateApi.getGameState();

    showCurrentScreen(state.currentScreen);

    if (state.currentScreen === SCREENS.PARTNER) {
      renderPartnerSelection();
    } else if (state.currentScreen === SCREENS.GAME) {
      renderGameScreen();
    } else if (state.currentScreen === SCREENS.ROUND_RESULT) {
      renderRoundResult();
    } else if (state.currentScreen === SCREENS.FINAL_RESULT) {
      renderFinalResult();
    }

    activateImageFallbacks(element("app"));
  }

  global.ShadowCardUI = Object.freeze({
    render,
    renderPartnerSelection,
    renderGameScreen,
    renderRoundResult,
    renderFinalResult
  });
})(window);

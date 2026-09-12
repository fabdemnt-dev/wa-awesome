"use strict";

(function initializeShadowCardMain(global) {
  function startApplication() {
    const data = global.ShadowCardData;
    const stateApi = global.ShadowCardState;
    const ai = global.ShadowCardAI;
    const logic = global.ShadowCardLogic;
    const ui = global.ShadowCardUI;

    if (!data || !stateApi || !ai || !logic || !ui) {
      throw new Error("The Shadow Card game scripts were not loaded in the required order.");
    }

    const app = document.getElementById("app");
    const toyboxReturnLink = document.getElementById("toybox-return-link");
    const toyboxExitDialog = document.getElementById("toybox-exit-dialog");
    const cancelToyboxExitButton = document.getElementById("cancel-toybox-exit");

    if (!app || !toyboxReturnLink || !toyboxExitDialog || !cancelToyboxExitButton) {
      throw new Error("A required game application element was not found.");
    }

    function renderAndFocus(selector) {
      ui.render();

      if (!selector) {
        return;
      }

      const target = document.querySelector(selector);

      if (target) {
        target.focus({ preventScroll: true });
      }
    }

    function handleGoToTitle() {
      stateApi.resetToTitle();
      ui.render();
    }

    function handlePartnerSelection(button) {
      const npcId = button.dataset.npcId;

      stateApi.selectPartner(npcId);
      renderAndFocus(`[data-npc-id="${npcId}"]`);
    }

    function handlePlayerCardSelection(button) {
      const handIndex = Number(button.dataset.handIndex);

      if (!logic.selectPlayerCard(handIndex)) {
        return;
      }

      ui.renderGameScreen();
      const selectedCard = document.querySelector(
        `[data-hand-index="${handIndex}"]`
      );

      if (selectedCard) {
        selectedCard.focus({ preventScroll: true });
      }
    }

    function handleConfirmPartner() {
      const state = stateApi.getGameState();

      if (!state.selectedPartnerId) {
        return;
      }

      logic.beginGame(state.selectedPartnerId);
      ui.render();
    }

    function handleConfirmCard(button) {
      const state = stateApi.getGameState();

      if (
        state.selectedPlayerCardIndex === null ||
        state.isResolvingRound ||
        state.isRoundResolved
      ) {
        return;
      }

      button.disabled = true;
      button.textContent = "計算中…";

      const result = logic.resolveRound();

      if (result) {
        ui.render();
      } else {
        ui.renderGameScreen();
      }
    }

    function handleNextRound() {
      if (logic.advanceFromRoundResult()) {
        ui.render();
      }
    }

    function handleRematch() {
      logic.beginRematch();
      ui.render();
    }

    function handleReselectPartner() {
      stateApi.resetForPartnerSelection();
      ui.render();
    }

    function handleToyboxReturn(event) {
      const state = stateApi.getGameState();
      const isActiveMatch =
        state.currentScreen === stateApi.SCREENS.GAME ||
        state.currentScreen === stateApi.SCREENS.ROUND_RESULT;

      if (!isActiveMatch) {
        return;
      }

      event.preventDefault();
      toyboxExitDialog.showModal();
    }

    function handleApplicationClick(event) {
      const button = event.target.closest("button");

      if (!button || button.disabled || !app.contains(button)) {
        return;
      }

      if (button.dataset.action === "go-title") {
        handleGoToTitle();
        return;
      }

      if (button.dataset.npcId) {
        handlePartnerSelection(button);
        return;
      }

      if (button.dataset.handIndex !== undefined) {
        handlePlayerCardSelection(button);
        return;
      }

      switch (button.id) {
        case "start-game-button":
          stateApi.resetForPartnerSelection();
          ui.render();
          break;
        case "show-rules-button":
          stateApi.showRules();
          ui.render();
          break;
        case "confirm-partner-button":
          handleConfirmPartner();
          break;
        case "confirm-card-button":
          handleConfirmCard(button);
          break;
        case "next-round-button":
          handleNextRound();
          break;
        case "rematch-button":
          handleRematch();
          break;
        case "reselect-partner-button":
          handleReselectPartner();
          break;
        default:
          break;
      }
    }

    app.addEventListener("click", handleApplicationClick);
    toyboxReturnLink.addEventListener("click", handleToyboxReturn);
    cancelToyboxExitButton.addEventListener("click", () => {
      toyboxExitDialog.close();
      toyboxReturnLink.focus();
    });
    stateApi.resetToTitle();
    ui.render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startApplication, { once: true });
  } else {
    startApplication();
  }
})(window);

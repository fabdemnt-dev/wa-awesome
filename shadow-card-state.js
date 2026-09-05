"use strict";

(function initializeShadowCardState(global) {
  const data = global.ShadowCardData;

  if (!data) {
    throw new Error("ShadowCardData must be loaded before ShadowCardState.");
  }

  const SCREENS = Object.freeze({
    TITLE: "title",
    PARTNER: "partner",
    RULES: "rules",
    GAME: "game",
    ROUND_RESULT: "round-result",
    FINAL_RESULT: "final-result"
  });

  const PARTICIPANT_KEYS = Object.freeze({
    PLAYER: "player",
    ALLY: "ally",
    ENEMY_ONE: "enemyOne",
    ENEMY_TWO: "enemyTwo"
  });

  function createEmptyHands() {
    return {
      [PARTICIPANT_KEYS.PLAYER]: [],
      [PARTICIPANT_KEYS.ALLY]: [],
      [PARTICIPANT_KEYS.ENEMY_ONE]: [],
      [PARTICIPANT_KEYS.ENEMY_TWO]: []
    };
  }

  function createEmptyNpcSelections() {
    return {
      [PARTICIPANT_KEYS.ALLY]: null,
      [PARTICIPANT_KEYS.ENEMY_ONE]: null,
      [PARTICIPANT_KEYS.ENEMY_TWO]: null
    };
  }

  function createEmptyNpcForecasts() {
    return {
      [PARTICIPANT_KEYS.ALLY]: "",
      [PARTICIPANT_KEYS.ENEMY_ONE]: "",
      [PARTICIPANT_KEYS.ENEMY_TWO]: ""
    };
  }

  function createEmptyPenalties() {
    return {
      ally: 0,
      enemy: 0
    };
  }

  function createEmptyPreviousNpcCards() {
    return {
      [data.NPC_ROLES.SUPPORT]: null,
      [data.NPC_ROLES.AGGRESSIVE]: null,
      [data.NPC_ROLES.BLUFF]: null
    };
  }

  function createInitialGameState() {
    return {
      currentScreen: SCREENS.TITLE,
      selectedPartnerId: null,
      allyNpcId: null,
      enemyNpcIds: [],
      roundNumber: 0,
      scores: {
        ally: 0,
        enemy: 0
      },
      fieldCard: null,
      hands: createEmptyHands(),
      npcSelections: createEmptyNpcSelections(),
      npcForecasts: createEmptyNpcForecasts(),
      selectedPlayerCardIndex: null,
      currentPenalties: createEmptyPenalties(),
      nextPenalties: createEmptyPenalties(),
      previousNpcCards: createEmptyPreviousNpcCards(),
      roundHistory: [],
      lastRoundResult: null,
      isResolvingRound: false,
      isRoundResolved: false
    };
  }

  function validatePartnerId(partnerId) {
    if (!data.NPC_BY_ID[partnerId]) {
      throw new Error(`Unknown partner NPC: ${String(partnerId)}`);
    }
  }

  function createConfiguredGameState(partnerId) {
    validatePartnerId(partnerId);

    const state = createInitialGameState();
    state.currentScreen = SCREENS.GAME;
    state.selectedPartnerId = partnerId;
    state.allyNpcId = partnerId;
    state.enemyNpcIds = data.NPCS
      .filter((npc) => npc.id !== partnerId)
      .map((npc) => npc.id);
    state.roundNumber = 1;

    return state;
  }

  let gameState = createInitialGameState();

  function getGameState() {
    return gameState;
  }

  function replaceGameState(nextState) {
    if (!nextState || typeof nextState !== "object") {
      throw new TypeError("The next game state must be an object.");
    }

    gameState = nextState;
    return gameState;
  }

  function resetToTitle() {
    gameState = createInitialGameState();
    return gameState;
  }

  function resetForPartnerSelection() {
    gameState = createInitialGameState();
    gameState.currentScreen = SCREENS.PARTNER;
    return gameState;
  }

  function showRules() {
    gameState = createInitialGameState();
    gameState.currentScreen = SCREENS.RULES;
    return gameState;
  }

  function selectPartner(partnerId) {
    validatePartnerId(partnerId);
    gameState.selectedPartnerId = partnerId;
    return gameState;
  }

  function startNewGame(partnerId) {
    gameState = createConfiguredGameState(partnerId);
    return gameState;
  }

  function startRematch() {
    if (!gameState.allyNpcId) {
      throw new Error("A rematch requires an existing team formation.");
    }

    gameState = createConfiguredGameState(gameState.allyNpcId);
    return gameState;
  }

  function clearRoundTransientState() {
    gameState.fieldCard = null;
    gameState.hands = createEmptyHands();
    gameState.npcSelections = createEmptyNpcSelections();
    gameState.npcForecasts = createEmptyNpcForecasts();
    gameState.selectedPlayerCardIndex = null;
    gameState.lastRoundResult = null;
    gameState.isResolvingRound = false;
    gameState.isRoundResolved = false;
    return gameState;
  }

  global.ShadowCardState = Object.freeze({
    SCREENS,
    PARTICIPANT_KEYS,
    createEmptyHands,
    createEmptyNpcSelections,
    createEmptyNpcForecasts,
    createEmptyPenalties,
    createEmptyPreviousNpcCards,
    createInitialGameState,
    createConfiguredGameState,
    getGameState,
    replaceGameState,
    resetToTitle,
    resetForPartnerSelection,
    showRules,
    selectPartner,
    startNewGame,
    startRematch,
    clearRoundTransientState
  });
})(window);

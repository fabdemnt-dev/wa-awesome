"use strict";

(function initializeShadowCardLogic(global) {
  const data = global.ShadowCardData;
  const stateApi = global.ShadowCardState;
  const ai = global.ShadowCardAI;

  if (!data || !stateApi || !ai) {
    throw new Error(
      "ShadowCardData, ShadowCardState, and ShadowCardAI must be loaded before ShadowCardLogic."
    );
  }

  const { CARD_TYPES, GAME_RULES } = data;
  const { PARTICIPANT_KEYS, SCREENS } = stateApi;

  function randomItem(items, random = Math.random) {
    return items[Math.floor(random() * items.length)];
  }

  function createHandItem(participantKey, roundNumber, handIndex, cardId) {
    return {
      instanceId: `${participantKey}-${roundNumber}-${handIndex}`,
      cardId
    };
  }

  function dealHand(participantKey, roundNumber, random = Math.random) {
    return Array.from({ length: GAME_RULES.handSize }, (_, handIndex) => {
      const card = randomItem(data.CARDS, random);
      return createHandItem(participantKey, roundNumber, handIndex, card.id);
    });
  }

  function getLastRound() {
    const state = stateApi.getGameState();
    return state.roundHistory.length > 0
      ? state.roundHistory[state.roundHistory.length - 1]
      : null;
  }

  function countPreviousInterference(team) {
    const previousRound = getLastRound();

    if (!previousRound) {
      return 0;
    }

    const participantKeys = team === "ally"
      ? [PARTICIPANT_KEYS.PLAYER, PARTICIPANT_KEYS.ALLY]
      : [PARTICIPANT_KEYS.ENEMY_ONE, PARTICIPANT_KEYS.ENEMY_TWO];

    return participantKeys.reduce((count, participantKey) => {
      const playedCard = previousRound.playedCards[participantKey];
      return count + (playedCard.type === CARD_TYPES.INTERFERENCE ? 1 : 0);
    }, 0);
  }

  function createNpcSelection(handIndex, hand) {
    const handItem = hand[handIndex];
    return {
      handIndex,
      instanceId: handItem.instanceId,
      cardId: handItem.cardId
    };
  }

  function buildAllyNpcContext(state) {
    return {
      side: "ally",
      fieldPoints: state.fieldCard.points,
      ownScore: state.scores.ally,
      opposingScore: state.scores.enemy,
      opponentNpcIds: [...state.enemyNpcIds],
      currentPenalty: state.currentPenalties.ally,
      opponentPreviousInterferenceCount: countPreviousInterference("enemy"),
      previousCardId: state.previousNpcCards[state.allyNpcId],
      playerTypeCounts: ai.countCardTypes(state.hands[PARTICIPANT_KEYS.PLAYER])
    };
  }

  function buildEnemyNpcContext(state, enemyNpcId) {
    return {
      side: "enemy",
      fieldPoints: state.fieldCard.points,
      ownScore: state.scores.enemy,
      opposingScore: state.scores.ally,
      opponentNpcIds: [state.allyNpcId],
      currentPenalty: state.currentPenalties.enemy,
      opponentPreviousInterferenceCount: countPreviousInterference("ally"),
      previousCardId: state.previousNpcCards[enemyNpcId]
    };
  }

  function chooseNpcSelections(state, random = Math.random) {
    const allyHand = state.hands[PARTICIPANT_KEYS.ALLY];
    const allyHandIndex = ai.chooseNpcCard(
      state.allyNpcId,
      allyHand,
      buildAllyNpcContext(state),
      random
    );
    state.npcSelections[PARTICIPANT_KEYS.ALLY] = createNpcSelection(
      allyHandIndex,
      allyHand
    );

    const enemyEntries = [
      [PARTICIPANT_KEYS.ENEMY_ONE, state.enemyNpcIds[0]],
      [PARTICIPANT_KEYS.ENEMY_TWO, state.enemyNpcIds[1]]
    ];

    enemyEntries.forEach(([participantKey, enemyNpcId]) => {
      const enemyHand = state.hands[participantKey];
      const handIndex = ai.chooseNpcCard(
        enemyNpcId,
        enemyHand,
        buildEnemyNpcContext(state, enemyNpcId),
        random
      );
      state.npcSelections[participantKey] = createNpcSelection(handIndex, enemyHand);
    });
  }

  function chooseNpcForecasts(state, random = Math.random) {
    const npcEntries = [
      [PARTICIPANT_KEYS.ALLY, state.allyNpcId, "ally"],
      [PARTICIPANT_KEYS.ENEMY_ONE, state.enemyNpcIds[0], "enemy"],
      [PARTICIPANT_KEYS.ENEMY_TWO, state.enemyNpcIds[1], "enemy"]
    ];

    npcEntries.forEach(([participantKey, npcId, side]) => {
      const selection = state.npcSelections[participantKey];
      state.npcForecasts[participantKey] = ai.chooseForecast(
        npcId,
        state.hands[participantKey][selection.handIndex],
        side,
        random
      );
    });
  }

  function prepareRound(random = Math.random) {
    const state = stateApi.getGameState();

    if (!state.allyNpcId || state.enemyNpcIds.length !== 2) {
      throw new Error("A complete team formation is required before preparing a round.");
    }

    if (state.roundNumber < 1 || state.roundNumber > GAME_RULES.totalRounds) {
      throw new Error("The round number is outside the playable range.");
    }

    state.currentScreen = SCREENS.GAME;
    state.fieldCard = randomItem(data.FIELD_CARDS, random);
    state.hands = {
      [PARTICIPANT_KEYS.PLAYER]: dealHand(
        PARTICIPANT_KEYS.PLAYER,
        state.roundNumber,
        random
      ),
      [PARTICIPANT_KEYS.ALLY]: dealHand(
        PARTICIPANT_KEYS.ALLY,
        state.roundNumber,
        random
      ),
      [PARTICIPANT_KEYS.ENEMY_ONE]: dealHand(
        PARTICIPANT_KEYS.ENEMY_ONE,
        state.roundNumber,
        random
      ),
      [PARTICIPANT_KEYS.ENEMY_TWO]: dealHand(
        PARTICIPANT_KEYS.ENEMY_TWO,
        state.roundNumber,
        random
      )
    };
    state.npcSelections = stateApi.createEmptyNpcSelections();
    state.npcForecasts = stateApi.createEmptyNpcForecasts();
    state.selectedPlayerCardIndex = null;
    state.lastRoundResult = null;
    state.isResolvingRound = false;
    state.isRoundResolved = false;

    chooseNpcSelections(state, random);
    chooseNpcForecasts(state, random);

    return state;
  }

  function beginGame(partnerId, random = Math.random) {
    stateApi.startNewGame(partnerId);
    return prepareRound(random);
  }

  function beginRematch(random = Math.random) {
    stateApi.startRematch();
    return prepareRound(random);
  }

  function selectPlayerCard(handIndex) {
    const state = stateApi.getGameState();

    if (
      state.currentScreen !== SCREENS.GAME ||
      state.isResolvingRound ||
      state.isRoundResolved
    ) {
      return false;
    }

    if (
      !Number.isInteger(handIndex) ||
      handIndex < 0 ||
      handIndex >= state.hands[PARTICIPANT_KEYS.PLAYER].length
    ) {
      return false;
    }

    state.selectedPlayerCardIndex = handIndex;
    return true;
  }

  function resolvePlayedCard(handItem, random = Math.random) {
    const card = data.CARD_BY_ID[handItem.cardId];

    if (!card) {
      throw new Error(`Unknown played card: ${String(handItem.cardId)}`);
    }

    const resolvedBaseValue = card.id === "shift"
      ? randomItem(GAME_RULES.shiftValues, random)
      : card.baseValue;

    return {
      instanceId: handItem.instanceId,
      cardId: card.id,
      name: card.name,
      type: card.type,
      baseValue: card.baseValue,
      resolvedBaseValue
    };
  }

  function calculateOwnAdditions(teamCards, opponentCards) {
    let assistAddition = 0;
    let misdirectAddition = 0;

    teamCards.forEach((card, index) => {
      const teammateCard = teamCards[index === 0 ? 1 : 0];

      if (card.cardId === "assist" && teammateCard.type === CARD_TYPES.OFFENSE) {
        assistAddition += 3;
      }

      if (
        card.cardId === "misdirect" &&
        opponentCards.some((opponentCard) => (
          opponentCard.type === CARD_TYPES.INTERFERENCE
        ))
      ) {
        misdirectAddition += 3;
      }
    });

    return {
      assist: assistAddition,
      misdirect: misdirectAddition,
      total: assistAddition + misdirectAddition
    };
  }

  function calculateReductionAgainstTarget(sourceCards, targetCards) {
    const targetHasOffense = targetCards.some(
      (card) => card.type === CARD_TYPES.OFFENSE
    );
    let checkReduction = 0;
    let disruptReduction = 0;

    sourceCards.forEach((card) => {
      if (card.cardId === "check") {
        checkReduction += 1;
      }

      if (card.cardId === "disrupt") {
        disruptReduction += targetHasOffense ? 2 : 1;
      }
    });

    return {
      check: checkReduction,
      disrupt: disruptReduction,
      total: checkReduction + disruptReduction
    };
  }

  function calculateTeamResult(teamCards, opponentCards, penalty) {
    const baseValueTotal = teamCards.reduce(
      (total, card) => total + card.resolvedBaseValue,
      0
    );
    const additions = calculateOwnAdditions(teamCards, opponentCards);
    const incomingReduction = calculateReductionAgainstTarget(
      opponentCards,
      teamCards
    );
    const defenseReduction = teamCards.reduce(
      (total, card) => total + (card.cardId === "defense" ? 1 : 0),
      0
    );
    const effectiveReduction = Math.max(
      0,
      incomingReduction.total - defenseReduction
    );
    const appliedPenalty = penalty > 0 ? 1 : 0;
    const finalValue = Math.max(
      0,
      baseValueTotal + additions.total - effectiveReduction - appliedPenalty
    );

    return {
      baseValueTotal,
      additions,
      incomingReduction,
      defenseReduction,
      effectiveReduction,
      appliedPenalty,
      finalValue
    };
  }

  function calculateRoundOutcome({ allyCards, enemyCards, penalties }) {
    if (
      !Array.isArray(allyCards) ||
      allyCards.length !== 2 ||
      !Array.isArray(enemyCards) ||
      enemyCards.length !== 2
    ) {
      throw new Error("Each team must play exactly two resolved cards.");
    }

    const ally = calculateTeamResult(
      allyCards,
      enemyCards,
      penalties && penalties.ally
    );
    const enemy = calculateTeamResult(
      enemyCards,
      allyCards,
      penalties && penalties.enemy
    );
    let outcome = "draw";

    if (ally.finalValue > enemy.finalValue) {
      outcome = "ally";
    } else if (enemy.finalValue > ally.finalValue) {
      outcome = "enemy";
    }

    return {
      ally,
      enemy,
      outcome
    };
  }

  function getPlayedCards(state, random = Math.random) {
    const playerHandItem = state.hands[PARTICIPANT_KEYS.PLAYER][
      state.selectedPlayerCardIndex
    ];
    const allySelection = state.npcSelections[PARTICIPANT_KEYS.ALLY];
    const enemyOneSelection = state.npcSelections[PARTICIPANT_KEYS.ENEMY_ONE];
    const enemyTwoSelection = state.npcSelections[PARTICIPANT_KEYS.ENEMY_TWO];

    return {
      [PARTICIPANT_KEYS.PLAYER]: resolvePlayedCard(playerHandItem, random),
      [PARTICIPANT_KEYS.ALLY]: resolvePlayedCard(
        state.hands[PARTICIPANT_KEYS.ALLY][allySelection.handIndex],
        random
      ),
      [PARTICIPANT_KEYS.ENEMY_ONE]: resolvePlayedCard(
        state.hands[PARTICIPANT_KEYS.ENEMY_ONE][enemyOneSelection.handIndex],
        random
      ),
      [PARTICIPANT_KEYS.ENEMY_TWO]: resolvePlayedCard(
        state.hands[PARTICIPANT_KEYS.ENEMY_TWO][enemyTwoSelection.handIndex],
        random
      )
    };
  }

  function calculateNextPenalties(state, playedCards, outcome) {
    const nextPenalties = stateApi.createEmptyPenalties();

    if (state.roundNumber >= GAME_RULES.totalRounds || outcome === "draw") {
      return nextPenalties;
    }

    const allyUsedAllOut = [
      playedCards[PARTICIPANT_KEYS.PLAYER],
      playedCards[PARTICIPANT_KEYS.ALLY]
    ].some((card) => card.cardId === "all-out");
    const enemyUsedAllOut = [
      playedCards[PARTICIPANT_KEYS.ENEMY_ONE],
      playedCards[PARTICIPANT_KEYS.ENEMY_TWO]
    ].some((card) => card.cardId === "all-out");

    if (outcome === "enemy" && allyUsedAllOut) {
      nextPenalties.ally = GAME_RULES.allOutPenalty;
    }

    if (outcome === "ally" && enemyUsedAllOut) {
      nextPenalties.enemy = GAME_RULES.allOutPenalty;
    }

    return nextPenalties;
  }

  function updatePreviousNpcCards(state, playedCards) {
    state.previousNpcCards[state.allyNpcId] = playedCards[
      PARTICIPANT_KEYS.ALLY
    ].cardId;
    state.previousNpcCards[state.enemyNpcIds[0]] = playedCards[
      PARTICIPANT_KEYS.ENEMY_ONE
    ].cardId;
    state.previousNpcCards[state.enemyNpcIds[1]] = playedCards[
      PARTICIPANT_KEYS.ENEMY_TWO
    ].cardId;
  }

  function resolveRound(random = Math.random) {
    const state = stateApi.getGameState();

    if (
      state.currentScreen !== SCREENS.GAME ||
      state.isResolvingRound ||
      state.isRoundResolved ||
      state.selectedPlayerCardIndex === null
    ) {
      return null;
    }

    state.isResolvingRound = true;

    try {
      const playedCards = getPlayedCards(state, random);
      const calculation = calculateRoundOutcome({
        allyCards: [
          playedCards[PARTICIPANT_KEYS.PLAYER],
          playedCards[PARTICIPANT_KEYS.ALLY]
        ],
        enemyCards: [
          playedCards[PARTICIPANT_KEYS.ENEMY_ONE],
          playedCards[PARTICIPANT_KEYS.ENEMY_TWO]
        ],
        penalties: state.currentPenalties
      });
      const pointsAwarded = {
        ally: calculation.outcome === "ally" ? state.fieldCard.points : 0,
        enemy: calculation.outcome === "enemy" ? state.fieldCard.points : 0
      };

      state.scores.ally += pointsAwarded.ally;
      state.scores.enemy += pointsAwarded.enemy;
      state.nextPenalties = calculateNextPenalties(
        state,
        playedCards,
        calculation.outcome
      );
      updatePreviousNpcCards(state, playedCards);

      const roundResult = {
        roundNumber: state.roundNumber,
        fieldCard: {
          id: state.fieldCard.id,
          name: state.fieldCard.name,
          points: state.fieldCard.points
        },
        playedCards,
        calculation: {
          ally: calculation.ally,
          enemy: calculation.enemy
        },
        outcome: calculation.outcome,
        pointsAwarded,
        scoresAfter: {
          ally: state.scores.ally,
          enemy: state.scores.enemy
        },
        appliedPenalties: {
          ally: state.currentPenalties.ally,
          enemy: state.currentPenalties.enemy
        },
        nextPenalties: {
          ally: state.nextPenalties.ally,
          enemy: state.nextPenalties.enemy
        }
      };

      state.roundHistory.push(roundResult);
      state.lastRoundResult = roundResult;
      state.isRoundResolved = true;
      state.currentScreen = SCREENS.ROUND_RESULT;

      return roundResult;
    } finally {
      state.isResolvingRound = false;
    }
  }

  function advanceFromRoundResult(random = Math.random) {
    const state = stateApi.getGameState();

    if (
      state.currentScreen !== SCREENS.ROUND_RESULT ||
      !state.isRoundResolved
    ) {
      return false;
    }

    if (state.roundNumber >= GAME_RULES.totalRounds) {
      state.currentScreen = SCREENS.FINAL_RESULT;
      return true;
    }

    state.roundNumber += 1;
    state.currentPenalties = {
      ally: state.nextPenalties.ally,
      enemy: state.nextPenalties.enemy
    };
    state.nextPenalties = stateApi.createEmptyPenalties();
    stateApi.clearRoundTransientState();
    prepareRound(random);

    return true;
  }

  function getFinalOutcome() {
    const state = stateApi.getGameState();

    if (state.scores.ally > state.scores.enemy) {
      return "win";
    }

    if (state.scores.enemy > state.scores.ally) {
      return "lose";
    }

    return "draw";
  }

  global.ShadowCardLogic = Object.freeze({
    dealHand,
    beginGame,
    beginRematch,
    prepareRound,
    selectPlayerCard,
    resolvePlayedCard,
    calculateRoundOutcome,
    resolveRound,
    advanceFromRoundResult,
    getFinalOutcome
  });
})(window);

"use strict";

(function initializeShadowCardAI(global) {
  const data = global.ShadowCardData;

  if (!data) {
    throw new Error("ShadowCardData must be loaded before ShadowCardAI.");
  }

  const { CARD_TYPES, NPC_ROLES } = data;

  function randomInteger(min, max, random = Math.random) {
    return Math.floor(random() * (max - min + 1)) + min;
  }

  function randomItem(items, random = Math.random) {
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error("Cannot choose from an empty list.");
    }

    return items[Math.floor(random() * items.length)];
  }

  function resolveCardFromHandItem(handItem) {
    const cardId = typeof handItem === "string" ? handItem : handItem && handItem.cardId;
    const card = data.CARD_BY_ID[cardId];

    if (!card) {
      throw new Error(`Unknown card in NPC hand: ${String(cardId)}`);
    }

    return card;
  }

  function countCardTypes(hand) {
    const counts = {
      [CARD_TYPES.OFFENSE]: 0,
      [CARD_TYPES.SUPPORT]: 0,
      [CARD_TYPES.INTERFERENCE]: 0,
      [CARD_TYPES.DISRUPTION]: 0
    };

    hand.forEach((handItem) => {
      const card = resolveCardFromHandItem(handItem);
      counts[card.type] += 1;
    });

    return counts;
  }

  function includesCard(cardId, cardIds) {
    return cardIds.includes(cardId);
  }

  function hasOpponentRole(context, roleId) {
    return context.opponentNpcIds.includes(roleId);
  }

  function calculateSituationModifier(npcId, card, context) {
    const values = data.NPC_MODIFIER_VALUES;
    const isDecisiveField = context.fieldPoints === 3;
    const isNegotiationField = context.fieldPoints === 2;
    const isTrailing = context.ownScore < context.opposingScore;
    const isTrailingByTwo = context.opposingScore - context.ownScore >= 2;
    const isLeading = context.ownScore > context.opposingScore;
    let modifier = 0;

    if (
      isDecisiveField &&
      npcId === NPC_ROLES.SUPPORT &&
      includesCard(card.id, ["assist", "breakthrough"])
    ) {
      modifier += values.decisiveFieldSupportAssistOrBreakthrough;
    }

    if (
      isDecisiveField &&
      npcId === NPC_ROLES.AGGRESSIVE &&
      includesCard(card.id, ["all-out", "breakthrough"])
    ) {
      modifier += values.decisiveFieldAggressiveAllOutOrBreakthrough;
    }

    if (
      isDecisiveField &&
      npcId === NPC_ROLES.BLUFF &&
      includesCard(card.id, ["shift", "all-out", "misdirect"])
    ) {
      modifier += values.decisiveFieldBluffShiftAllOutOrMisdirect;
    }

    if (
      isNegotiationField &&
      npcId === NPC_ROLES.AGGRESSIVE &&
      includesCard(card.id, ["all-out", "breakthrough", "disrupt"])
    ) {
      modifier += values.negotiationFieldAggressiveAllOutBreakthroughOrDisrupt;
    }

    if (
      isTrailing &&
      npcId === NPC_ROLES.SUPPORT &&
      includesCard(card.id, ["check", "misdirect", "breakthrough"])
    ) {
      modifier += values.trailingSupportCheckMisdirectOrBreakthrough;
    }

    if (
      isTrailing &&
      npcId === NPC_ROLES.AGGRESSIVE &&
      includesCard(card.id, ["all-out", "breakthrough"])
    ) {
      modifier += values.trailingAggressiveAllOutOrBreakthrough;
    }

    if (
      isTrailingByTwo &&
      npcId === NPC_ROLES.AGGRESSIVE &&
      card.id === "all-out"
    ) {
      modifier += values.trailingByTwoAggressiveAllOutExtra;
    }

    if (
      isTrailing &&
      npcId === NPC_ROLES.BLUFF &&
      includesCard(card.id, ["shift", "misdirect", "check", "disrupt"])
    ) {
      modifier += values.trailingBluffShiftMisdirectCheckOrDisrupt;
    }

    if (isLeading && npcId === NPC_ROLES.SUPPORT && card.id === "defense") {
      modifier += values.leadingSupportDefense;
    }

    if (
      isLeading &&
      npcId === NPC_ROLES.BLUFF &&
      includesCard(card.id, ["check", "defense"])
    ) {
      modifier += values.leadingBluffCheckOrDefense;
    }

    if (
      context.side === "ally" &&
      npcId === NPC_ROLES.SUPPORT &&
      card.id === "assist"
    ) {
      const offenseCount = context.playerTypeCounts[CARD_TYPES.OFFENSE];

      if (offenseCount >= 1) {
        modifier += values.playerHasOneOffenseSupportAssist;
      }

      if (offenseCount >= 2) {
        modifier += values.playerHasTwoOffenseSupportAssistExtra;
      }
    }

    if (
      npcId === NPC_ROLES.SUPPORT &&
      card.id === "defense" &&
      hasOpponentRole(context, NPC_ROLES.AGGRESSIVE)
    ) {
      modifier += values.enemyHasAggressiveSupportDefense;
    }

    if (
      npcId === NPC_ROLES.SUPPORT &&
      card.id === "defense" &&
      context.opponentPreviousInterferenceCount >= 2
    ) {
      modifier += values.enemyPreviousRoundTwoInterferenceSupportDefense;
    }

    if (
      npcId === NPC_ROLES.AGGRESSIVE &&
      includesCard(card.id, ["disrupt", "check"]) &&
      hasOpponentRole(context, NPC_ROLES.SUPPORT)
    ) {
      modifier += values.enemyHasSupportAggressiveDisruptOrCheck;
    }

    if (
      npcId === NPC_ROLES.BLUFF &&
      card.id === "shift" &&
      context.previousCardId === "shift"
    ) {
      modifier += values.bluffUsedShiftPreviousRound;
    }

    if (
      npcId === NPC_ROLES.BLUFF &&
      context.previousCardId !== null &&
      card.id === context.previousCardId
    ) {
      modifier += values.bluffUsedSameCardPreviousRound;
    }

    if (
      npcId === NPC_ROLES.BLUFF &&
      includesCard(card.id, ["check", "disrupt"]) &&
      hasOpponentRole(context, NPC_ROLES.AGGRESSIVE)
    ) {
      modifier += values.enemyHasAggressiveBluffCheckOrDisrupt;
    }

    if (
      context.currentPenalty > 0 &&
      npcId === NPC_ROLES.SUPPORT &&
      includesCard(card.id, ["assist", "defense", "check"])
    ) {
      modifier += values.currentPenaltySupportAssistDefenseOrCheck;
    }

    return modifier;
  }

  function normalizeContext(npcId, context) {
    if (!data.NPC_BY_ID[npcId]) {
      throw new Error(`Unknown NPC: ${String(npcId)}`);
    }

    if (!context || (context.side !== "ally" && context.side !== "enemy")) {
      throw new Error("NPC context must identify the ally or enemy side.");
    }

    const normalized = {
      side: context.side,
      fieldPoints: Number(context.fieldPoints) || 0,
      ownScore: Number(context.ownScore) || 0,
      opposingScore: Number(context.opposingScore) || 0,
      opponentNpcIds: Array.isArray(context.opponentNpcIds)
        ? context.opponentNpcIds.filter((id) => Boolean(data.NPC_BY_ID[id]))
        : [],
      currentPenalty: context.currentPenalty > 0 ? 1 : 0,
      opponentPreviousInterferenceCount: Math.max(
        0,
        Number(context.opponentPreviousInterferenceCount) || 0
      ),
      previousCardId: data.CARD_BY_ID[context.previousCardId]
        ? context.previousCardId
        : null,
      playerTypeCounts: {
        [CARD_TYPES.OFFENSE]: 0,
        [CARD_TYPES.SUPPORT]: 0,
        [CARD_TYPES.INTERFERENCE]: 0,
        [CARD_TYPES.DISRUPTION]: 0
      }
    };

    if (context.side === "ally" && context.playerTypeCounts) {
      Object.keys(normalized.playerTypeCounts).forEach((type) => {
        normalized.playerTypeCounts[type] = Math.max(
          0,
          Number(context.playerTypeCounts[type]) || 0
        );
      });
    }

    return normalized;
  }

  function evaluateHand(npcId, hand, context, random = Math.random) {
    if (!Array.isArray(hand) || hand.length !== data.GAME_RULES.handSize) {
      throw new Error(`An NPC hand must contain exactly ${data.GAME_RULES.handSize} cards.`);
    }

    const npc = data.NPC_BY_ID[npcId];
    const priorities = data.NPC_BASE_PRIORITIES[npcId];
    const safeContext = normalizeContext(npcId, context);

    return hand.map((handItem, handIndex) => {
      const card = resolveCardFromHandItem(handItem);
      const basePriority = priorities[card.id];
      const situationModifier = calculateSituationModifier(npcId, card, safeContext);
      const randomModifier = randomInteger(npc.randomMin, npc.randomMax, random);
      const score = Math.max(0, basePriority + situationModifier + randomModifier);

      return {
        handIndex,
        score
      };
    });
  }

  function takeRandomHighestCandidate(candidates, random) {
    const highestScore = Math.max(...candidates.map((candidate) => candidate.score));
    const highestCandidates = candidates.filter(
      (candidate) => candidate.score === highestScore
    );

    return randomItem(highestCandidates, random);
  }

  function chooseNpcCard(npcId, hand, context, random = Math.random) {
    const candidates = evaluateHand(npcId, hand, context, random);
    const firstRanked = takeRandomHighestCandidate(candidates, random);
    const remainingCandidates = candidates.filter(
      (candidate) => candidate.handIndex !== firstRanked.handIndex
    );
    const secondRanked = takeRandomHighestCandidate(remainingCandidates, random);
    const selected = random() < data.GAME_RULES.npcFirstChoiceProbability
      ? firstRanked
      : secondRanked;

    return selected.handIndex;
  }

  function chooseForecast(npcId, selectedCard, side, random = Math.random) {
    const card = resolveCardFromHandItem(selectedCard);
    const forecastSet = data.NPC_FORECASTS[npcId];

    if (!forecastSet) {
      throw new Error(`Unknown NPC forecast set: ${String(npcId)}`);
    }

    if (side !== "ally" && side !== "enemy") {
      throw new Error("Forecast side must be ally or enemy.");
    }

    const possibleForecasts = [
      ...forecastSet.common,
      ...forecastSet.byType[card.type],
      ...forecastSet.bySide[side]
    ];

    return randomItem(possibleForecasts, random);
  }

  global.ShadowCardAI = Object.freeze({
    countCardTypes,
    chooseNpcCard,
    chooseForecast
  });
})(window);

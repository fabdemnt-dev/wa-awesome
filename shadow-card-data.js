"use strict";

(function initializeShadowCardData(global) {
  const CARD_TYPES = {
    OFFENSE: "offense",
    SUPPORT: "support",
    INTERFERENCE: "interference",
    DISRUPTION: "disruption"
  };

  const CARD_TYPE_LABELS = {
    [CARD_TYPES.OFFENSE]: "攻勢",
    [CARD_TYPES.SUPPORT]: "支援",
    [CARD_TYPES.INTERFERENCE]: "妨害",
    [CARD_TYPES.DISRUPTION]: "撹乱"
  };

  const CARDS = [
    {
      id: "breakthrough",
      name: "突破",
      type: CARD_TYPES.OFFENSE,
      baseValue: 4,
      effect: "none",
      image: "assets/shadow-card/card-breakthrough.webp",
      description: "効果はありません。基本値4で正面から勝負します。"
    },
    {
      id: "all-out",
      name: "全力",
      type: CARD_TYPES.OFFENSE,
      baseValue: 6,
      effect: "allOut",
      image: "assets/shadow-card/card-all-out.webp",
      description: "このラウンドで自チームが敗北した場合、次のラウンドだけ自チーム最終値が−1されます。複数枚でも−1までで、引き分けと最終ラウンドでは発生しません。"
    },
    {
      id: "assist",
      name: "援護",
      type: CARD_TYPES.SUPPORT,
      baseValue: 2,
      effect: "assist",
      image: "assets/shadow-card/card-assist.webp",
      description: "同じチームのもう1枚が攻勢なら、自チーム最終値を＋3します。"
    },
    {
      id: "defense",
      name: "守勢",
      type: CARD_TYPES.SUPPORT,
      baseValue: 3,
      effect: "defense",
      image: "assets/shadow-card/card-defense.webp",
      description: "敵チームから受ける減算を1軽減します。複数枚なら1枚ごとに累積し、軽減後の減算は0未満になりません。"
    },
    {
      id: "check",
      name: "けん制",
      type: CARD_TYPES.INTERFERENCE,
      baseValue: 3,
      effect: "check",
      image: "assets/shadow-card/card-check.webp",
      description: "敵チーム最終値を−1します。"
    },
    {
      id: "disrupt",
      name: "崩し",
      type: CARD_TYPES.INTERFERENCE,
      baseValue: 2,
      effect: "disrupt",
      image: "assets/shadow-card/card-disrupt.webp",
      description: "敵チーム最終値を−1します。敵チームに攻勢が1枚以上あれば、合計−2します。"
    },
    {
      id: "shift",
      name: "変転",
      type: CARD_TYPES.DISRUPTION,
      baseValue: null,
      effect: "shift",
      image: "assets/shadow-card/card-shift.webp",
      description: "公開時に基本値が2または5へ等確率で変わり、確定した値をチーム基本値へ加算します。"
    },
    {
      id: "misdirect",
      name: "誘導",
      type: CARD_TYPES.DISRUPTION,
      baseValue: 1,
      effect: "misdirect",
      image: "assets/shadow-card/card-misdirect.webp",
      description: "敵チームに妨害が1枚以上あれば、自チーム最終値を＋3します。"
    }
  ];

  const CARD_BY_ID = Object.fromEntries(CARDS.map((card) => [card.id, card]));

  const FIELD_CARDS = [
    {
      id: "skirmish",
      name: "小競り合い",
      points: 1
    },
    {
      id: "negotiation",
      name: "交渉",
      points: 2
    },
    {
      id: "showdown",
      name: "決戦",
      points: 3
    }
  ];

  const NPC_ROLES = {
    SUPPORT: "support",
    AGGRESSIVE: "aggressive",
    BLUFF: "bluff"
  };

  const NPCS = [
    {
      id: NPC_ROLES.SUPPORT,
      name: "支援型",
      role: "連携と守りを重視する相手",
      strength: "援護と守勢を選びやすい",
      caution: "単独で高い基本値を出す判断は控えめ",
      image: "assets/shadow-card/npc-support.webp",
      imageAlt: "扇を手に周囲を見守る支援型の交渉人",
      randomMin: -1,
      randomMax: 1
    },
    {
      id: NPC_ROLES.AGGRESSIVE,
      name: "強気型",
      role: "高い基本値で押し切る相手",
      strength: "突破と全力を選びやすい",
      caution: "守りを固める判断は控えめ",
      image: "assets/shadow-card/npc-aggressive.webp",
      imageAlt: "札を差し出し強い視線を向ける強気型の交渉人",
      randomMin: -1,
      randomMax: 1
    },
    {
      id: NPC_ROLES.BLUFF,
      name: "ブラフ型",
      role: "変化と読み合いを重視する相手",
      strength: "変転と誘導を選びやすい",
      caution: "判断の振れ幅が大きい",
      image: "assets/shadow-card/npc-bluff.webp",
      imageAlt: "扇で口元を隠し静かに微笑むブラフ型の交渉人",
      randomMin: -2,
      randomMax: 2
    }
  ];

  const NPC_BY_ID = Object.fromEntries(NPCS.map((npc) => [npc.id, npc]));

  const NPC_BASE_PRIORITIES = {
    [NPC_ROLES.SUPPORT]: {
      breakthrough: 5,
      "all-out": 2,
      assist: 10,
      defense: 9,
      check: 6,
      disrupt: 4,
      shift: 1,
      misdirect: 7
    },
    [NPC_ROLES.AGGRESSIVE]: {
      breakthrough: 8,
      "all-out": 10,
      assist: 2,
      defense: 1,
      check: 6,
      disrupt: 7,
      shift: 5,
      misdirect: 3
    },
    [NPC_ROLES.BLUFF]: {
      breakthrough: 5,
      "all-out": 4,
      assist: 3,
      defense: 2,
      check: 7,
      disrupt: 6,
      shift: 10,
      misdirect: 8
    }
  };

  const NPC_MODIFIER_VALUES = {
    decisiveFieldSupportAssistOrBreakthrough: 2,
    decisiveFieldAggressiveAllOutOrBreakthrough: 4,
    decisiveFieldBluffShiftAllOutOrMisdirect: 3,
    negotiationFieldAggressiveAllOutBreakthroughOrDisrupt: 2,
    trailingSupportCheckMisdirectOrBreakthrough: 2,
    trailingAggressiveAllOutOrBreakthrough: 3,
    trailingByTwoAggressiveAllOutExtra: 2,
    trailingBluffShiftMisdirectCheckOrDisrupt: 2,
    leadingSupportDefense: 3,
    leadingBluffCheckOrDefense: 2,
    playerHasOneOffenseSupportAssist: 3,
    playerHasTwoOffenseSupportAssistExtra: 2,
    enemyHasAggressiveSupportDefense: 2,
    enemyPreviousRoundTwoInterferenceSupportDefense: 2,
    enemyHasSupportAggressiveDisruptOrCheck: 2,
    bluffUsedShiftPreviousRound: -4,
    bluffUsedSameCardPreviousRound: -3,
    enemyHasAggressiveBluffCheckOrDisrupt: 2,
    currentPenaltySupportAssistDefenseOrCheck: 1
  };

  const NPC_FORECASTS = {
    [NPC_ROLES.SUPPORT]: {
      common: [
        "周囲を見ている",
        "慎重に準備している"
      ],
      byType: {
        [CARD_TYPES.OFFENSE]: [
          "味方との間合いを測っている",
          "次の動きを静かに考えている"
        ],
        [CARD_TYPES.SUPPORT]: [
          "味方との間合いを測っている",
          "場全体を見渡している"
        ],
        [CARD_TYPES.INTERFERENCE]: [
          "流れの変化を確かめている",
          "場全体を見渡している"
        ],
        [CARD_TYPES.DISRUPTION]: [
          "流れの変化を確かめている",
          "次の動きを静かに考えている"
        ]
      },
      bySide: {
        ally: ["こちらの様子にも気を配っている"],
        enemy: ["こちらの出方を注意深く見ている"]
      }
    },
    [NPC_ROLES.AGGRESSIVE]: {
      common: [
        "引かない構えを見せている",
        "強い意志が感じられる"
      ],
      byType: {
        [CARD_TYPES.OFFENSE]: [
          "迷いなく前を見ている",
          "勝負どころを探っている"
        ],
        [CARD_TYPES.SUPPORT]: [
          "姿勢を崩さず前を見ている",
          "勝負どころを探っている"
        ],
        [CARD_TYPES.INTERFERENCE]: [
          "相手の隙をうかがっている",
          "姿勢を崩さず前を見ている"
        ],
        [CARD_TYPES.DISRUPTION]: [
          "相手の隙をうかがっている",
          "迷いなく前を見ている"
        ]
      },
      bySide: {
        ally: ["こちらと歩調を合わせようとしている"],
        enemy: ["こちらへ鋭い視線を向けている"]
      }
    },
    [NPC_ROLES.BLUFF]: {
      common: [
        "本心が見えない",
        "静かに様子をうかがっている"
      ],
      byType: {
        [CARD_TYPES.OFFENSE]: [
          "表情を変えず機会を待っている",
          "何かを隠しているように見える"
        ],
        [CARD_TYPES.SUPPORT]: [
          "視線だけで場を追っている",
          "何かを隠しているように見える"
        ],
        [CARD_TYPES.INTERFERENCE]: [
          "わずかに笑みを浮かべている",
          "視線だけで場を追っている"
        ],
        [CARD_TYPES.DISRUPTION]: [
          "わずかに笑みを浮かべている",
          "表情を変えず機会を待っている"
        ]
      },
      bySide: {
        ally: ["こちらにも意図を明かしていない"],
        enemy: ["こちらを試すように見つめている"]
      }
    }
  };

  const GAME_RULES = {
    totalRounds: 5,
    handSize: 4,
    shiftValues: [2, 5],
    allOutPenalty: 1,
    npcFirstChoiceProbability: 0.7,
    npcSecondChoiceProbability: 0.3
  };

  function deepFreeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      Object.freeze(value);
      Object.values(value).forEach(deepFreeze);
    }

    return value;
  }

  global.ShadowCardData = deepFreeze({
    CARD_TYPES,
    CARD_TYPE_LABELS,
    CARDS,
    CARD_BY_ID,
    FIELD_CARDS,
    NPC_ROLES,
    NPCS,
    NPC_BY_ID,
    NPC_BASE_PRIORITIES,
    NPC_MODIFIER_VALUES,
    NPC_FORECASTS,
    GAME_RULES
  });
})(window);

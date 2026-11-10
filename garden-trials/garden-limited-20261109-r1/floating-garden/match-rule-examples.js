import { cellName, createGarden, createTile, placeStone, placeTile, scoreGarden, OBJECTIVE_IDS, OBJECTIVES, OBJECTIVE_VERSION, STONE_CAP, STONES, TERRAIN, tilePorts } from './engine.js?v=20261023-solo-objectives-1';
import { tileArt } from './view.js?v=20261023-solo-objectives-1';

const escape = (text) => String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function gardenOf(tiles, stones = []) {
  let garden = createGarden();
  for (const [index, terrain, rotation = 0, shape = 'straight'] of tiles) {
    garden = placeTile(garden, index, createTile(terrain, shape, rotation));
  }
  for (const [index, stone] of stones) garden = placeStone(garden, index, stone);
  return garden;
}

/** Independent, reproducible teaching boards. Never receive the live match/session. */
function createLegacyRuleExamples() {
  return [
    {
      id: 'flow', title: '流れをつなぐ', scope: '流れの点数',
      garden: gardenOf([[5, 'lake', 1], [6, 'crystal', 1], [7, 'forest'], [10, 'cloud', 1]]),
      ignored: [7, 10],
      explanation: 'B2とC2の流れが向かい合う1辺を数えます。地形が違ってもつながります。',
      caution: 'C2とD2は流れの向きが合わず0点。B2とC3は斜めなので0点。盤外へ伸びた流れも数えません。',
    },
    {
      id: 'moon', title: '☾ 月読み', scope: 'この月読みの点数',
      garden: gardenOf([[0, 'lake', 1], [4, 'lake'], [5, 'lake'], [6, 'lake'], [7, 'lake']], [[5, 'moon']]),
      ignored: [0],
      explanation: 'B2の石と同じ横列、A2・B2・C2・D2の月光湖4枚。石の足元のB2も含めます。',
      caution: 'A1の月光湖は別の横列なので数えません。4枚なら本来8点ですが、石1個の上限は6点です。',
    },
    {
      id: 'wind', title: '≋ 風守', scope: 'この風守の点数',
      garden: gardenOf([[0, 'cloud', 1], [1, 'cloud', 1], [4, 'cloud', 1], [5, 'cloud'], [6, 'forest'], [9, 'lake', 1]], [[5, 'wind']]),
      ignored: [0, 6, 9],
      explanation: 'B2の石の上にあるB1と、左にあるA2。上下左右の雲海2枚を数えます。',
      caution: '斜めのA1と、石の足元のB2は対象外。C2・B3は隣でも雲海ではないので数えません。',
    },
    {
      id: 'color', title: '✧ 彩り', scope: 'この彩りの点数',
      garden: gardenOf([[0, 'magic', 1], [1, 'lake', 1], [4, 'forest', 1], [5, 'magic'], [6, 'lake'], [9, 'crystal', 1]], [[5, 'color']]),
      ignored: [0],
      explanation: 'B2の上下左右は、月光湖2枚・精霊林1枚・結晶原1枚。4枚でも地形は3種類です。',
      caution: '月光湖が2枚あっても1種類。斜めのA1や足元の魔力地は数えません。4種類そろっても上限6点です。',
    },
    {
      id: 'echo', title: '◎ 共鳴', scope: 'この共鳴の点数',
      garden: gardenOf([[1, 'lake', 1], [5, 'forest'], [7, 'cloud'], [10, 'crystal', 1]], [[1, 'moon'], [5, 'echo'], [7, 'wind'], [10, 'color']]),
      ignored: [10],
      explanation: 'B2と同じ縦列のB1（月読み）、同じ横列のD2（風守）にある別の石2個を数えます。間に空きマスがあっても届きます。',
      caution: '自分自身の共鳴と、斜めのC3の彩りは数えません。図のほかの石の点数は、それぞれ別に採点します。',
    },
    {
      id: 'corners', title: '四隅のお題', scope: 'お題の点数',
      garden: gardenOf([[0, 'cloud'], [3, 'lake'], [5, 'magic'], [12, 'forest'], [15, 'crystal']]),
      ignored: [5],
      explanation: 'A1・D1・A4・D4が、雲海・月光湖・精霊林・結晶原の4種類。四隅がすべて違うので達成です。',
      caution: '中央のB2はお題に関係しません。D4も雲海なら3種類で0点。四隅に1マスでも空きがあれば0点です。',
    },
  ];
}

/** Each case names its selected objective; no live garden or save is read. */
function createSharedObjectiveExamples(corners) {
  const objectiveCase = (id, objectiveId, title, tiles, explanation, caution, ignored = []) => ({
    id, title, scope: 'このお題の点数',
    objective: { id: objectiveId, version: OBJECTIVE_VERSION },
    garden: gardenOf(tiles), ignored, explanation, caution,
  });
  const cornerTiles = [[0, 'cloud'], [3, 'lake'], [5, 'magic'], [12, 'forest']];
  const flowTiles = [[4, 'lake', 1], [5, 'cloud', 1], [6, 'crystal', 2, 'bend'], [10, 'forest', 3, 'bend'], [9, 'magic', 1]];
  return [
    { ...corners, objective: { id: 'corners', version: OBJECTIVE_VERSION }, caseLabel: '四隅がすべて違う地形' },
    objectiveCase('corners-repeat', 'corners', '四隅は埋まっても同じ地形がある', [...cornerTiles, [15, 'cloud']],
      'A1とD4がどちらも雲海。四隅は4枚ありますが、地形は3種類なので未達成です。',
      '中央のB2が別の地形でも、四隅の不足は補えません。確定した地形は動かせません。', [5]),
    objectiveCase('corners-gap', 'corners', '四隅に1マス空きがある', cornerTiles,
      'D4が空いているため、四隅の地形は3種類。3か所がすべて違っていても未達成です。',
      '四隅以外に4種類目があっても数えません。A1・D1・A4・D4のすべてが必要です。', [5]),
    objectiveCase('terrain-cluster', 'terrain-cluster', '同じ地形が上下左右で4枚つながる', [[0, 'lake', 1], [1, 'lake'], [5, 'lake', 1], [9, 'lake']],
      'A1・B1・B2・B3の月光湖4枚が、上下左右でひとつのまとまりになっています。曲がった形でも達成です。',
      '流れの向きが合わなくてもかまいません。月光湖だけでなく、どの地形でも同じ条件です。4枚以上に増えても、お題は4点のままです。'),
    objectiveCase('terrain-cluster-diagonal', 'terrain-cluster', '4枚あっても斜めの1枚は別のまとまり', [[0, 'lake', 1], [1, 'lake'], [5, 'lake', 1], [10, 'lake']],
      'A1・B1・B2は3枚のまとまり。C3はB2の斜めにあるので、同じ月光湖でもつながりません。',
      '庭全体の同じ地形を合計するのではなく、上下左右でつながったひとつのまとまりを数えます。', [10]),
    objectiveCase('flow-chain', 'flow-chain', '向かい合う流れで6枚がひとつながり', [...flowTiles, [8, 'lake', 1]],
      'A2→B2→C2→C3→B3→A3の6枚が、向かい合う流れでつながっています。地形が違っていても達成です。',
      'このお題は辺ではなくタイルを数えます。図の接続は5辺ですが6枚なので達成。通常の流れの5点は、お題の4点と別に足します。'),
    objectiveCase('flow-chain-loop', 'flow-chain', '輪になった6枚の流れも達成', [[4, 'lake', 1, 'bend'], ...flowTiles.slice(1), [8, 'lake', 0, 'bend']],
      'A2→B2→C2→C3→B3→A3→A2と一周する輪です。違う6枚のタイルがつながっているので達成です。',
      'A2へ戻っても7枚目には数えません。同じタイルは1枚だけ。輪や長い流れを増やしても、お題の加点は1人1回です。'),
    objectiveCase('flow-chain-mismatch', 'flow-chain', '6枚置いても流れが合うのは5枚', [...flowTiles, [8, 'lake']],
      'A2・B2・C2・C3・B3までは5枚。A3は隣にありますが、B3と流れが向かい合わないため加えられません。',
      '片方だけが相手を向いていても接続しません。別々の流れを足した枚数や、斜めのタイルでも達成にはなりません。', [8]),
    objectiveCase('diverse-line', 'diverse-line', '横の一列が4種類で埋まる', [[4, 'cloud'], [5, 'lake'], [6, 'forest'], [7, 'crystal']],
      'A2・B2・C2・D2の横一列が、雲海・月光湖・精霊林・結晶原の4種類で埋まり、達成です。',
      '4種類の組み合わせは自由。魔力地が入ってもかまいません。流れの向きや石の有無は関係しません。'),
    objectiveCase('diverse-line-column', 'diverse-line', '縦の一列でも達成', [[1, 'cloud'], [5, 'lake'], [9, 'forest'], [13, 'magic']],
      'B1・B2・B3・B4の縦一列が、4種類の地形で埋まっています。横だけでなく縦でも達成です。',
      '縦と横の両方や複数の列をそろえても、このお題は1人につき4点だけです。'),
    objectiveCase('diverse-line-repeat', 'diverse-line', '一列が埋まっても地形は3種類', [[4, 'cloud'], [5, 'lake'], [6, 'forest'], [7, 'cloud']],
      'A2とD2がどちらも雲海なので、この一列は4枚あっても3種類。ほかにも達成する列がなく、未達成です。',
      '4マスすべてが別々の地形であることが必要です。'),
    objectiveCase('diverse-line-gap', 'diverse-line', '一列に空きがある', [[4, 'cloud'], [5, 'lake'], [7, 'crystal']],
      'A2・B2・D2は違う地形でも、C2が空きマス。横一列の4マスをすべて埋める条件を満たしません。',
      '3枚だけでは達成しません。離れた別の列にある地形も、この列へ足すことはできません。'),
    objectiveCase('diverse-line-diagonal', 'diverse-line', '斜めの4種類は一列に数えない', [[0, 'cloud'], [5, 'lake'], [10, 'forest'], [15, 'crystal']],
      'A1・B2・C3・D4には4種類ありますが、斜めは対象外。どの縦列・横列も1枚だけです。',
      '光る枠は、判定が選んだ最多の列です。別々の縦列・横列にある地形を合計しません。', [5, 10, 15]),
  ];
}

/** Legacy callers keep six boards. Only the solo rules opt in to shared objectives. */
export function createRuleExamples({ includeSharedObjectives = false } = {}) {
  const examples = createLegacyRuleExamples();
  return includeSharedObjectives
    ? [...examples.slice(0, -1), ...createSharedObjectiveExamples(examples.at(-1))]
    : examples;
}

/** All displayed awards and highlights are derived from the actual scoring engine. */
export function scoreRuleExample(example) {
  const score = scoreGarden(example.garden, example.objective);
  if (example.objective) {
    const objective = score.objective;
    const unit = ['corners', 'diverse-line'].includes(objective.id) ? '種類' : '枚';
    return {
      points: objective.points,
      matches: [...objective.cells],
      objective,
      ...(objective.id === 'flow-chain' ? { connections: score.connections.filter(({ from, to }) => objective.cells.includes(from) && objective.cells.includes(to)) } : {}),
      formula: `${objective.progress} / ${objective.target}${unit}${['terrain-cluster', 'flow-chain'].includes(objective.id) ? '（達成に必要な分）' : ''} · ${objective.achieved ? '達成' : '未達成'} = ${objective.points}点`,
    };
  }
  if (example.id === 'flow') return {
    points: score.connectionPoints,
    matches: [...new Set(score.connections.flatMap(({ from, to }) => [from, to]))],
    connections: score.connections,
    formula: `${score.connections.length}辺 × 1点 = ${score.connectionPoints}点`,
  };
  if (example.id === 'corners') return {
    points: score.objective.points,
    matches: score.objective.achieved ? score.objective.corners : [],
    formula: `四隅が4種類そろうと ${score.objective.points}点`,
  };
  const stone = score.stones.find(({ stone }) => stone === example.id);
  const unit = example.id === 'color' ? '種類' : example.id === 'echo' ? '個' : '枚';
  return {
    ...stone,
    formula: `${stone.count}${unit} × 2点 = ${stone.rawPoints}点${stone.capped ? ` → 上限${STONE_CAP}点` : ''}`,
  };
}

function renderExampleBoard(example, result) {
  return `<div class="rule-example-board" role="group" aria-label="${escape(example.title)}のお手本。4行4列、列AからD、行1から4">${example.garden.map((tile, index) => {
    const counted = result.matches.includes(index);
    const focus = result.index === index;
    const ignored = example.ignored.includes(index);
    const status = [focus ? '採点する石' : '', counted ? '数えるマス' : '', ignored ? '数えない例' : ''].filter(Boolean).join('、');
    const ports = tile && (example.id === 'flow' || example.objective?.id === 'flow-chain') ? `、流れは${tilePorts(tile).map((port) => ['上', '右', '下', '左'][port]).join('と')}` : '';
    const label = `${cellName(index)}、${tile ? `${TERRAIN[tile.terrain].name}${tile.stone ? `、${STONES[tile.stone].name}の石` : ''}${ports}` : '空きマス'}${status ? `、${status}` : ''}`;
    const connections = (result.connections || []).flatMap(({ from, to }) => from === index ? [to === index + 1 ? 'right' : 'bottom'] : to === index ? [from === index - 1 ? 'left' : 'top'] : []);
    return `<span class="rule-example-cell ${tile ? `terrain-${tile.terrain}` : 'is-empty'}${counted ? ' is-counted' : ''}${focus ? ' is-focus' : ''}${ignored ? ' is-ignored' : ''}" role="img" aria-label="${escape(label)}"><span class="rule-example-coordinate" aria-hidden="true">${cellName(index)}</span>${tile ? `${tileArt(tile)}<span class="rule-example-terrain" aria-hidden="true">${TERRAIN[tile.terrain].mark}</span>${tile.stone ? `<span class="rule-example-stone${focus ? ' is-focus-stone' : ''}" aria-hidden="true">${STONES[tile.stone].mark}</span>` : ''}` : ''}${ignored ? '<span class="rule-example-excluded" aria-hidden="true">×</span>' : ''}${connections.map((direction) => `<span class="connection connection-${direction}" aria-hidden="true"></span>`).join('')}</span>`;
  }).join('')}</div>`;
}

/** Render a single read-only fixture, also used by the grouped solo examples. */
export function renderRuleExample(example) {
  const result = scoreRuleExample(example);
  const content = `<div class="rule-example-content"><figure class="rule-example-figure${example.id === 'flow' || example.objective?.id === 'flow-chain' ? ' is-flow-example' : ''}">${renderExampleBoard(example, result)}<figcaption><strong>${escape(example.scope)}: ${result.points}点</strong><span class="rule-example-formula">${escape(result.formula)}</span></figcaption></figure><div class="rule-example-copy"><p>${escape(example.explanation)}</p><p class="rule-example-caution">${escape(example.caution)}</p></div></div>`;
  if (example.objective) return `<section id="rule-example-${escape(example.id)}-case" class="rule-objective-example-case" aria-labelledby="rule-example-${escape(example.id)}-label"><h4 id="rule-example-${escape(example.id)}-label" class="rule-objective-example-label">${result.objective.achieved ? '達成' : '未達成'}：${escape(example.caseLabel || example.title)}</h4>${content}</section>`;
  return `<details id="rule-example-${escape(example.id)}" class="rule-example"><summary>${escape(example.title)}<span class="rule-example-summary-score">${result.points}点の例</span></summary>${content}</details>`;
}

export function renderRuleExamples({ includeSharedObjectives = false } = {}) {
  const examples = createRuleExamples({ includeSharedObjectives });
  const regular = examples.filter((example) => !example.objective).map(renderRuleExample).join('');
  const shared = includeSharedObjectives ? `<p class="rule-objective-examples-intro">共通のお題は、新しい試合ごとに4種類から選ばれた1題だけが採点対象です。以下の4題を全部足すわけではありません。達成した人それぞれに1回だけ4点。先着ではなく、全員が達成できます。複数のまとまりや列を作っても追加点はありません。</p><p>旧ルールで保存した試合は、これまでどおり四隅のお題のままです。</p>${OBJECTIVE_IDS.map((id) => `<details id="rule-example-${id}" class="rule-example rule-objective-examples"><summary>${escape(OBJECTIVES[id].name)}<span class="rule-example-summary-score">達成・未達成の例</span></summary>${examples.filter((example) => example.objective?.id === id).map(renderRuleExample).join('')}</details>`).join('')}` : '';
  return `<section class="rule-examples" aria-labelledby="rule-examples-title"><h3 id="rule-examples-title">図でわかる採点のお手本</h3><p>気になる項目を開いて見比べられます。点数は見出しの項目だけ。ほかの流れや石の点数は別に足します。</p><p class="rule-example-legend"><span>光る枠＝数えるマス${includeSharedObjectives ? '（未達成でも表示）' : ''}</span><span>金色の石＝採点する石</span><span>×と点線＝数えない例</span></p>${regular}${shared}<p class="rule-example-terrain-legend">${Object.values(TERRAIN).map(({ mark, name }) => `${mark}＝${name}`).join(' / ')}</p></section>`;
}

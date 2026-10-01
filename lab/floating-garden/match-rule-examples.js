import { cellName, createGarden, createTile, placeStone, placeTile, scoreGarden, STONE_CAP, STONES, TERRAIN, tilePorts } from './engine.js?v=20261001-rule-examples';
import { tileArt } from './view.js?v=20261001-rule-examples';

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
export function createRuleExamples() {
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

/** All displayed awards and highlights are derived from the actual scoring engine. */
export function scoreRuleExample(example) {
  const score = scoreGarden(example.garden);
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
    const ports = tile && example.id === 'flow' ? `、流れは${tilePorts(tile).map((port) => ['上', '右', '下', '左'][port]).join('と')}` : '';
    const label = `${cellName(index)}、${tile ? `${TERRAIN[tile.terrain].name}${tile.stone ? `、${STONES[tile.stone].name}の石` : ''}${ports}` : '空きマス'}${status ? `、${status}` : ''}`;
    const connections = (result.connections || []).flatMap(({ from, to }) => from === index ? [to === index + 1 ? 'right' : 'bottom'] : to === index ? [from === index - 1 ? 'left' : 'top'] : []);
    return `<span class="rule-example-cell ${tile ? `terrain-${tile.terrain}` : 'is-empty'}${counted ? ' is-counted' : ''}${focus ? ' is-focus' : ''}${ignored ? ' is-ignored' : ''}" role="img" aria-label="${escape(label)}"><span class="rule-example-coordinate" aria-hidden="true">${cellName(index)}</span>${tile ? `${tileArt(tile)}<span class="rule-example-terrain" aria-hidden="true">${TERRAIN[tile.terrain].mark}</span>${tile.stone ? `<span class="rule-example-stone${focus ? ' is-focus-stone' : ''}" aria-hidden="true">${STONES[tile.stone].mark}</span>` : ''}` : ''}${ignored ? '<span class="rule-example-excluded" aria-hidden="true">×</span>' : ''}${connections.map((direction) => `<span class="connection connection-${direction}" aria-hidden="true"></span>`).join('')}</span>`;
  }).join('')}</div>`;
}

export function renderRuleExamples() {
  return `<section class="rule-examples" aria-labelledby="rule-examples-title"><h3 id="rule-examples-title">図でわかる採点のお手本</h3><p>気になる項目を開いて見比べられます。点数は見出しの項目だけ。ほかの流れや石の点数は別に足します。</p><p class="rule-example-legend"><span>光る枠＝数えるマス</span><span>金色の石＝採点する石</span><span>×と点線＝数えない例</span></p>${createRuleExamples().map((example) => {
    const result = scoreRuleExample(example);
    return `<details id="rule-example-${example.id}" class="rule-example"><summary>${escape(example.title)}<span class="rule-example-summary-score">${result.points}点の例</span></summary><div class="rule-example-content"><figure class="rule-example-figure${example.id === 'flow' ? ' is-flow-example' : ''}">${renderExampleBoard(example, result)}<figcaption><strong>${escape(example.scope)}: ${result.points}点</strong><span class="rule-example-formula">${escape(result.formula)}</span></figcaption></figure><div class="rule-example-copy"><p>${escape(example.explanation)}</p><p class="rule-example-caution">${escape(example.caution)}</p></div></div></details>`;
  }).join('')}<p class="rule-example-terrain-legend">${Object.values(TERRAIN).map(({ mark, name }) => `${mark}＝${name}`).join(' / ')}</p></section>`;
}

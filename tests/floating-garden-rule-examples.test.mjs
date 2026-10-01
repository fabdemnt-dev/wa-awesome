import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTile, placeStone, placeTile, scoreGarden, validateGarden } from '../lab/floating-garden/engine.js';
import { createRuleExamples, renderRuleExamples, scoreRuleExample } from '../lab/floating-garden/match-rule-examples.js';
import { renderMatchRules, renderMatchSetup } from '../lab/floating-garden/match-view.js';
import { tileArt } from '../lab/floating-garden/view.js';

const example = (id) => createRuleExamples().find((item) => item.id === id);
const expected = {
  flow: { points: 1, matches: [5, 6] },
  moon: { points: 6, matches: [4, 5, 6, 7], count: 4, rawPoints: 8 },
  wind: { points: 4, matches: [1, 4], count: 2, rawPoints: 4 },
  color: { points: 6, matches: [1, 4, 6, 9], count: 3, rawPoints: 6 },
  echo: { points: 4, matches: [1, 7], count: 2, rawPoints: 4 },
  corners: { points: 4, matches: [0, 3, 12, 15] },
};

for (const [id, award] of Object.entries(expected)) {
  test(`${id} teaching board agrees with the unchanged scoring engine and excludes its counterexamples`, () => {
    const fixture = example(id);
    validateGarden(fixture.garden);
    const before = structuredClone(fixture);
    const result = scoreRuleExample(fixture);
    const score = scoreGarden(fixture.garden);
    assert.deepEqual(fixture, before);
    assert.equal(result.points, award.points);
    assert.deepEqual(result.matches.slice().sort((a, b) => a - b), award.matches);
    for (const index of fixture.ignored) {
      assert.ok(fixture.garden[index], `${id} excluded example is visible`);
      assert.ok(!result.matches.includes(index), `${id} ${index} is not scored`);
    }
    if (award.count) {
      assert.equal(result.count, award.count);
      assert.equal(result.rawPoints, award.rawPoints);
      assert.equal(result.points, score.stones.find((stone) => stone.stone === id).points);
    } else assert.equal(result.points, id === 'flow' ? score.connectionPoints : score.objective.points);
  });
}

test('flow counts one shared edge once, not both cells, mismatched ports, a diagonal or the outer boundary', () => {
  const fixture = example('flow');
  const result = scoreRuleExample(fixture);
  assert.deepEqual(result.connections, [{ from: 5, to: 6, points: 1 }]);
  fixture.garden[6] = createTile('crystal', 'straight', 0);
  assert.equal(scoreRuleExample(fixture).points, 0);
});

test('moon includes its own lake and horizontal lakes, excludes another row and caps four lakes at six', () => {
  const fixture = example('moon');
  assert.ok(scoreRuleExample(fixture).matches.includes(5));
  assert.equal(scoreRuleExample(fixture).capped, true);
  fixture.garden[5].terrain = 'forest';
  const result = scoreRuleExample(fixture);
  assert.equal(result.count, 3); assert.equal(result.rawPoints, 6); assert.equal(result.capped, false);
  assert.ok(!result.matches.includes(0));
});

test('wind counts orthogonal clouds only and retains the six-point cap', () => {
  const fixture = example('wind');
  assert.ok(!scoreRuleExample(fixture).matches.includes(5), 'cloud under the wind is not adjacent');
  fixture.garden[6].terrain = 'cloud'; fixture.garden[9].terrain = 'cloud';
  const result = scoreRuleExample(fixture);
  assert.equal(result.count, 4); assert.equal(result.rawPoints, 8); assert.equal(result.points, 6);
  assert.ok(!result.matches.includes(0), 'diagonal cloud stays excluded');
});

test('color counts two lakes as one type, ignores diagonal/own terrain, and caps four different neighbors', () => {
  const fixture = example('color');
  const result = scoreRuleExample(fixture);
  assert.equal(result.matches.length, 4); assert.equal(result.count, 3);
  assert.ok(!result.matches.includes(0)); assert.ok(!result.matches.includes(5));
  fixture.garden[6].terrain = 'cloud';
  const varied = scoreRuleExample(fixture);
  assert.equal(varied.count, 4); assert.equal(varied.rawPoints, 8); assert.equal(varied.points, 6);
});

test('echo counts other stones across a gap and never itself or a diagonal stone', () => {
  const fixture = example('echo');
  assert.equal(fixture.garden[6], null, 'a gap exists between B2 and D2');
  assert.ok(scoreRuleExample(fixture).matches.includes(7));
  assert.ok(!scoreRuleExample(fixture).matches.includes(5));
  fixture.garden[10].stone = null;
  fixture.garden = placeStone(placeTile(fixture.garden, 13, createTile('crystal')), 13, 'color');
  assert.equal(scoreRuleExample(fixture).points, 6);
});

test('corners require four occupied, distinct corners; center terrain cannot complete the objective', () => {
  const fixture = example('corners');
  fixture.garden[15].terrain = 'cloud';
  assert.equal(scoreRuleExample(fixture).points, 0);
  assert.equal(new Set(fixture.garden.filter(Boolean).map((tile) => tile.terrain)).size, 4);
  fixture.garden[15] = null;
  assert.equal(scoreRuleExample(fixture).points, 0);
});

test('examples are six independent deterministic boards, with no shared live state', () => {
  const first = createRuleExamples(); const second = createRuleExamples();
  assert.deepEqual(first, second); assert.equal(first.length, 6);
  assert.deepEqual(first.map(({ id }) => id), Object.keys(expected));
  first[0].garden[5].terrain = 'magic';
  assert.notDeepEqual(first, second); assert.deepEqual(second, createRuleExamples());
});

test('illustrations reuse tile SVG, expose coordinates/score/legend, and have no game controls or live-board selectors', () => {
  const html = renderRuleExamples();
  assert.equal((html.match(/<details /g) || []).length, 6);
  assert.equal((html.match(/<figure /g) || []).length, 6);
  assert.equal((html.match(/class="rule-example-cell /g) || []).length, 96);
  assert.doesNotMatch(html, /<button|data-action=|data-index=|data-focus=|\bopen(?:[ =>])|aria-live=|class="cell |class="board /);
  for (const fixture of createRuleExamples()) {
    const fragment = html.match(new RegExp(`<details id="rule-example-${fixture.id}"[\\s\\S]*?<\\/details>`))[0];
    const result = scoreRuleExample(fixture);
    assert.ok(fragment.includes(tileArt(fixture.garden.find(Boolean))));
    assert.ok(fragment.includes(`${fixture.scope}: ${result.points}点`));
    assert.ok(fragment.includes(result.formula));
    assert.equal((fragment.match(/ is-counted/g) || []).length, result.matches.length);
    assert.equal((fragment.match(/ is-ignored/g) || []).length, fixture.ignored.length);
    assert.match(fragment, /role="group" aria-label="[^"]*4行4列/);
    assert.match(fragment, /aria-label="A1、/); assert.match(fragment, /aria-label="D4、/);
  }
  assert.match(html, /金色の石＝採点する石/); assert.match(html, /×と点線＝数えない例/);
  assert.match(html, /同じ横列/); assert.match(html, /月光湖が2枚あっても1種類/);
  assert.match(html, /魔＝魔力地/);
});

test('examples live inside existing match rules, on setup and in play, with scoped responsive styles', () => {
  const rules = renderMatchRules();
  assert.match(rules, /id="match-rules"/); assert.ok(rules.includes(renderRuleExamples()));
  assert.ok(renderMatchSetup().includes(rules));
  const css = readFileSync(new URL('../lab/floating-garden/match-style.css', import.meta.url), 'utf8');
  assert.match(css, /\.rule-example-board[^}]*repeat\(4, minmax\(0, 1fr\)\)[^}]*width: 100%[^}]*max-width: 280px/);
  assert.match(css, /\.rule-example > summary[^}]*overflow-wrap: anywhere/);
  const module = readFileSync(new URL('../lab/floating-garden/match-rule-examples.js', import.meta.url), 'utf8');
  assert.doesNotMatch(module, /addEventListener|setTimeout|setInterval|localStorage|fetch\(|Math\.random|Date\./);
});

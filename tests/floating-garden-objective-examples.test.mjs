/** Solo-only illustrated shared objectives; fixtures never touch a match or save. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGarden, createTile, evaluateObjective, OBJECTIVE_IDS, OBJECTIVE_VERSION, scoreGarden, TERRAIN, validateGarden } from '../floating-garden/engine.js';
import { createRuleExamples, renderRuleExample, renderRuleExamples, scoreRuleExample } from '../floating-garden/match-rule-examples.js';
import * as legacy from '../lab/floating-garden/match-rule-examples.js';
import { renderMatchRules, renderMatchSetup } from '../floating-garden/match-view.js';
import { renderRules as renderOnlineRules } from '../floating-garden/online/view.js';

const options = { includeSharedObjectives: true };
const examples = () => createRuleExamples(options);
const example = (id) => examples().find((item) => item.id === id);
const objective = (id) => ({ id, version: OBJECTIVE_VERSION });
const expected = {
  corners: { objective: 'corners', points: 4, progress: 4, cells: [0, 3, 12, 15] },
  'corners-repeat': { objective: 'corners', points: 0, progress: 3, cells: [0, 3, 12, 15] },
  'corners-gap': { objective: 'corners', points: 0, progress: 3, cells: [0, 3, 12] },
  'terrain-cluster': { objective: 'terrain-cluster', points: 4, progress: 4, cells: [0, 1, 5, 9] },
  'terrain-cluster-diagonal': { objective: 'terrain-cluster', points: 0, progress: 3, cells: [0, 1, 5] },
  'flow-chain': { objective: 'flow-chain', points: 4, progress: 6, cells: [4, 5, 6, 8, 9, 10] },
  'flow-chain-loop': { objective: 'flow-chain', points: 4, progress: 6, cells: [4, 5, 6, 8, 9, 10] },
  'flow-chain-mismatch': { objective: 'flow-chain', points: 0, progress: 5, cells: [4, 5, 6, 9, 10] },
  'diverse-line': { objective: 'diverse-line', points: 4, progress: 4, cells: [4, 5, 6, 7] },
  'diverse-line-column': { objective: 'diverse-line', points: 4, progress: 4, cells: [1, 5, 9, 13] },
  'diverse-line-repeat': { objective: 'diverse-line', points: 0, progress: 3, cells: [4, 5, 6, 7] },
  'diverse-line-gap': { objective: 'diverse-line', points: 0, progress: 3, cells: [4, 5, 7] },
  'diverse-line-diagonal': { objective: 'diverse-line', points: 0, progress: 1, cells: [0] },
};
const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

test('legacy default preserves all six existing boards, scores, IDs and rendered output exactly', () => {
  assert.deepEqual(createRuleExamples(), legacy.createRuleExamples());
  assert.equal(renderRuleExamples(), legacy.renderRuleExamples());
  assert.equal(renderRuleExamples({ includeSharedObjectives: false }), legacy.renderRuleExamples());
  assert.deepEqual(createRuleExamples().map(({ id }) => id), ['flow', 'moon', 'wind', 'color', 'echo', 'corners']);
  for (const fixture of createRuleExamples()) assert.deepEqual(scoreRuleExample(fixture), legacy.scoreRuleExample(fixture));
  assert.deepEqual(examples().slice(0, 5), createRuleExamples().slice(0, 5));
});

test('solo has deterministic independent cases, unique IDs and both outcomes for every current objective', () => {
  const first = examples(), second = examples();
  assert.deepEqual(first, second);
  assert.equal(first.length, 18);
  assert.equal(new Set(first.map(({ id }) => id)).size, first.length);
  assert.deepEqual(first.filter(({ objective }) => objective).map(({ id }) => id), Object.keys(expected));
  for (const id of OBJECTIVE_IDS) {
    const cases = first.filter((item) => item.objective?.id === id);
    assert.ok(cases.some((item) => scoreRuleExample(item).objective.achieved));
    assert.ok(cases.some((item) => !scoreRuleExample(item).objective.achieved));
  }
  first.find((item) => item.id === 'corners').garden[0].terrain = 'magic';
  first.find((item) => item.id === 'flow-chain').objective.id = 'corners';
  assert.deepEqual(second, examples());
  assert.notDeepEqual(first, second);
});

for (const [id, award] of Object.entries(expected)) {
  test(`${id}: displayed award, progress and highlights come from the selected objective scorer`, () => {
    const fixture = deepFreeze(example(id));
    const before = structuredClone(fixture);
    validateGarden(fixture.garden);
    const result = scoreRuleExample(fixture);
    const actual = evaluateObjective(fixture.garden, fixture.objective);
    assert.deepEqual(fixture.objective, objective(award.objective));
    assert.deepEqual(result.objective, actual);
    assert.equal(result.points, award.points);
    assert.equal(result.objective.progress, award.progress);
    assert.equal(result.objective.achieved, award.points === 4);
    assert.deepEqual(result.matches, award.cells);
    assert.deepEqual(result.matches, actual.cells);
    assert.ok(result.formula.includes(`${actual.progress} / ${actual.target}`));
    assert.ok(result.formula.endsWith(` = ${actual.points}点`));
    for (const index of fixture.ignored) {
      assert.ok(fixture.garden[index]);
      assert.ok(!result.matches.includes(index));
    }
    if (fixture.objective.id === 'flow-chain') {
      const connections = scoreGarden(fixture.garden, fixture.objective).connections
        .filter(({ from, to }) => actual.cells.includes(from) && actual.cells.includes(to));
      assert.deepEqual(result.connections, connections);
    }
    renderRuleExample(fixture);
    assert.deepEqual(fixture, before, 'scoring and rendering cannot mutate even a frozen fixture');
  });
}

test('corners reject each missing or duplicated corner while old metadata-free saves keep the same rule', () => {
  const fixture = example('corners');
  assert.equal(scoreGarden(fixture.garden).objective.points, 4);
  for (const index of [0, 3, 12, 15]) {
    const missing = structuredClone(fixture);
    missing.garden[index] = null;
    assert.equal(scoreRuleExample(missing).points, 0);
    const duplicate = structuredClone(fixture);
    duplicate.garden[index].terrain = duplicate.garden[index === 0 ? 3 : 0].terrain;
    assert.equal(scoreRuleExample(duplicate).points, 0);
  }
  assert.equal(scoreGarden(example('terrain-cluster').garden).objective.points, 0);
  assert.equal(scoreRuleExample(example('terrain-cluster')).points, 4);
});

test('terrain cluster is any same terrain in an orthogonal group, independent of flow and never a total of separate groups', () => {
  for (const terrain of Object.keys(TERRAIN)) {
    const fixture = example('terrain-cluster');
    fixture.garden.filter(Boolean).forEach((tile) => { tile.terrain = terrain; tile.rotation = (tile.rotation + 1) % 4; });
    assert.equal(scoreRuleExample(fixture).points, 4);
    fixture.garden[9] = null;
    assert.equal(scoreRuleExample(fixture).points, 0);
  }
  for (const cells of [[0, 5, 10, 15], [2, 3, 4, 5], [0, 1, 10, 11]]) {
    const fixture = example('terrain-cluster');
    fixture.garden = createGarden();
    cells.forEach((index) => { fixture.garden[index] = createTile('lake'); });
    assert.equal(scoreRuleExample(fixture).points, 0);
  }
  const more = example('terrain-cluster');
  more.garden[13] = createTile('lake');
  assert.equal(scoreRuleExample(more).points, 4);
  assert.equal(scoreRuleExample(more).objective.progress, 4);
  assert.equal(scoreRuleExample(more).matches.length, 5);
});

test('flow examples count distinct tiles through reciprocal ports: five edges make six tiles, loops also work', () => {
  const path = example('flow-chain'), loop = example('flow-chain-loop'), mismatch = example('flow-chain-mismatch');
  assert.equal(scoreRuleExample(path).connections.length, 5);
  assert.equal(scoreRuleExample(loop).connections.length, 6);
  assert.equal(scoreRuleExample(path).points, 4);
  assert.equal(scoreRuleExample(loop).points, 4);
  assert.equal(mismatch.garden.filter(Boolean).length, 6);
  assert.equal(scoreRuleExample(mismatch).matches.length, 5);
  assert.equal(scoreRuleExample(mismatch).points, 0);
  assert.equal(scoreGarden(path.garden, path.objective).total, 9, 'normal five flow points and four objective points are separate');
  assert.equal(scoreGarden(loop.garden, loop.objective).total, 10);
  mismatch.garden[8].rotation = 1;
  assert.equal(scoreRuleExample(mismatch).points, 4, 'score is recalculated, not stored in the fixture');
  const shortLoop = example('flow-chain');
  shortLoop.garden = createGarden();
  for (const [index, rotation] of [[0, 1], [1, 2], [4, 0], [5, 3]]) shortLoop.garden[index] = createTile('lake', 'bend', rotation);
  assert.equal(scoreRuleExample(shortLoop).objective.progress, 4);
  assert.equal(scoreRuleExample(shortLoop).points, 0, 'revisiting a short loop never creates a sixth tile');
  const split = example('flow-chain');
  split.garden = createGarden();
  [0, 1, 2, 12, 13, 14].forEach((index) => { split.garden[index] = createTile('lake', 'straight', 1); });
  assert.equal(scoreRuleExample(split).objective.progress, 3);
  assert.equal(scoreRuleExample(split).points, 0, 'two three-tile streams do not add to six');
});

test('full rows and columns qualify; repeated terrain, gaps and diagonals do not', () => {
  for (const id of ['diverse-line', 'diverse-line-column']) {
    const fixture = example(id);
    assert.equal(scoreRuleExample(fixture).points, 4);
    const cells = scoreRuleExample(fixture).matches;
    for (const index of cells) {
      const missing = structuredClone(fixture);
      missing.garden[index] = null;
      assert.equal(scoreRuleExample(missing).points, 0);
    }
    fixture.garden[cells[0]].terrain = fixture.garden[cells[1]].terrain;
    assert.equal(scoreRuleExample(fixture).points, 0);
  }
  for (const id of ['diverse-line-repeat', 'diverse-line-gap', 'diverse-line-diagonal']) assert.equal(scoreRuleExample(example(id)).points, 0);
});

test('multiple qualifying groups or lines still award only four, and only the selected objective counts', () => {
  const cluster = example('terrain-cluster');
  cluster.garden = createGarden();
  [0, 1, 4, 5, 10, 11, 14, 15].forEach((index) => { cluster.garden[index] = createTile('lake'); });
  assert.equal(scoreRuleExample(cluster).points, 4);
  const lines = example('diverse-line');
  ['cloud', 'lake', 'forest', 'crystal'].forEach((terrain, offset) => { lines.garden[12 + offset] = createTile(terrain); });
  assert.equal(scoreRuleExample(lines).points, 4);
  const selected = example('terrain-cluster');
  selected.objective = objective('corners');
  const result = scoreRuleExample(selected);
  assert.equal(result.points, 0);
  assert.equal(result.objective.id, 'corners', 'metadata, rather than the fixture ID, selects the scoring rule');
  assert.match(result.formula, /未達成 = 0点/);
});

test('solo rendering groups the cases accessibly with unique IDs and preserves read-only board/flow markup', () => {
  const html = renderRuleExamples(options);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const [, labelledBy] of html.matchAll(/aria-labelledby="([^"]+)"/g)) assert.ok(ids.includes(labelledBy));
  assert.equal((html.match(/<details /g) || []).length, 9);
  assert.equal((html.match(/<figure /g) || []).length, 18);
  assert.equal((html.match(/class="rule-example-cell /g) || []).length, 18 * 16);
  assert.equal((html.match(/class="rule-objective-example-case"/g) || []).length, 13);
  assert.doesNotMatch(html, /<button|<script|data-action=|data-index=|data-focus=|\bopen(?:[ =>])|aria-live=|class="cell |class="board /);
  for (const fixture of examples()) {
    const fragment = renderRuleExample(fixture), result = scoreRuleExample(fixture);
    assert.match(fragment, /role="group" aria-label="[^"]*4行4列/);
    assert.match(fragment, /aria-label="A1、/);
    assert.match(fragment, /aria-label="D4、/);
    assert.equal((fragment.match(/ is-counted/g) || []).length, result.matches.length);
    assert.equal((fragment.match(/ is-ignored/g) || []).length, fixture.ignored.length);
    assert.ok(fragment.includes(`${fixture.scope}: ${result.points}点`));
    if (fixture.objective?.id === 'flow-chain') {
      assert.match(fragment, /is-flow-example/);
      assert.match(fragment, /aria-label="[^"]*流れは/);
      assert.equal((fragment.match(/class="connection connection-/g) || []).length, result.connections.length * 2);
    }
  }
  for (const id of ['flow', 'moon', 'wind', 'color', 'echo', ...OBJECTIVE_IDS]) assert.ok(ids.includes(`rule-example-${id}`));
  assert.match(html, /未達成でも表示/);
  assert.match(html, /選ばれた1題だけ/);
  assert.match(html, /1回だけ4点/);
  assert.match(html, /全員が達成できます/);
  assert.match(html, /旧ルールで保存した試合は、これまでどおり四隅のお題/);
});

test('fixture text and attribute values are escaped, including headings and IDs', () => {
  const hostile = `<img src=x onerror="oops"> & 'quoted'`;
  for (const id of ['flow', 'flow-chain']) {
    const fixture = example(id);
    // Non-objective scoring is keyed by ID, so exercise arbitrary ID escaping on an objective fixture.
    if (fixture.objective) fixture.id = hostile;
    fixture.title = fixture.scope = fixture.explanation = fixture.caution = fixture.caseLabel = hostile;
    const html = renderRuleExample(fixture);
    assert.doesNotMatch(html, /<img|onerror="oops"/);
    assert.ok(html.includes('&lt;img src=x onerror=&quot;oops&quot;&gt; &amp; &#39;quoted&#39;'));
    assert.match(html, /role="group" aria-label="&lt;img/);
  }
});

test('only setup and current solo matches opt in; resumed legacy solo and online keep six old examples', () => {
  const shared = renderRuleExamples(options), old = renderRuleExamples();
  assert.ok(renderMatchSetup().includes(shared));
  assert.ok(renderMatchRules().includes(shared));
  for (const id of OBJECTIVE_IDS) assert.ok(renderMatchRules(objective(id), true).includes(shared));
  const resumed = renderMatchRules(undefined, true), online = renderOnlineRules();
  for (const html of [resumed, online]) {
    assert.ok(html.includes(old));
    assert.doesNotMatch(html, /class="rule-objective-example-case"/);
    assert.doesNotMatch(html, /id="rule-example-(?:terrain-cluster|flow-chain|diverse-line)"/);
  }
});

test('fixtures/rendering have no live state, storage, network, randomness or timers', () => {
  const source = readFileSync(new URL('../floating-garden/match-rule-examples.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /addEventListener|setTimeout|setInterval|localStorage|sessionStorage|indexedDB|fetch\(|Math\.random|Date\.|document\.|window\./);
  assert.doesNotMatch(source, /from ['"][^'"]*(?:match-engine|match-save|match-app|session)\.js/);
  const before = examples();
  assert.equal(renderRuleExamples(options), renderRuleExamples(options));
  assert.deepEqual(examples(), before);
});

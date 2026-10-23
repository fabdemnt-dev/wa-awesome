import test from 'node:test';
import assert from 'node:assert/strict';
import { createGarden, createTile, OBJECTIVES, OBJECTIVE_IDS, OBJECTIVE_VERSION, scoreGarden } from '../floating-garden/engine.js';
import { createMatch, publicMatch, rankMatch } from '../floating-garden/match-engine.js';
import { displayedGarden } from '../floating-garden/session.js';
import { renderObjective, renderScore, renderSharedObjective } from '../floating-garden/view.js';
import { renderMatch, renderMatchComparison, renderMatchRules } from '../floating-garden/match-view.js';

const SECRET_SEED = 'private-seed-never-render-this-20261023';
const objectiveOf = (id) => ({ id, version: OBJECTIVE_VERSION });
const fixtureTiles = {
  corners: [[0, 'cloud'], [3, 'lake'], [12, 'forest'], [15, 'crystal']],
  'terrain-cluster': [[5, 'cloud'], [6, 'cloud'], [9, 'cloud'], [10, 'cloud']],
  'flow-chain': [[0, 'cloud', 'bend', 1], [1, 'lake', 'straight', 1], [2, 'forest', 'bend', 2], [6, 'crystal', 'bend', 3], [5, 'magic', 'straight', 1], [4, 'forest', 'bend', 0]],
  'diverse-line': [[4, 'cloud'], [5, 'lake'], [6, 'forest'], [7, 'crystal']],
};
function fixtures(id) {
  const complete = createGarden();
  for (const [index, terrain, shape = 'straight', rotation = 0] of fixtureTiles[id]) complete[index] = createTile(terrain, shape, rotation);
  const index = fixtureTiles[id].at(-1)[0];
  const pending = { type: 'tile', index, tile: complete[index] };
  const before = complete.slice();
  before[index] = null;
  return { complete, before, pending };
}
function makeState(id, { preview = true, legacy = false, playerCount = 2 } = {}) {
  const { complete, before, pending } = fixtures(id);
  const match = createMatch({ playerCount, seed: SECRET_SEED, ...(legacy ? { legacy: true } : { objectiveId: id }) });
  match.players.forEach((player, index) => { player.garden = index === 0 && preview ? before.slice() : complete.slice(); });
  match.step = 'place';
  match.placementSeat = 0;
  match.drawn = { tile: pending.tile, ownerSeat: 0, protected: true };
  const ui = { rotation: pending.tile.rotation, pending: preview ? pending : null, comparison: { seat: 1, pair: true } };
  return { match, ui };
}
function objectiveCards(html) {
  return [...html.matchAll(/<div class="objective [^"]*" data-objective-id="([^"]+)" data-objective-progress="(\d+)" data-objective-points="(\d+)" data-objective-preview="(true|false)">/g)]
    .map(([, id, progress, points, preview]) => ({ id, progress: Number(progress), points: Number(points), preview: preview === 'true' }));
}
function scoreTotal(html) {
  return Number(html.match(/<div class="total"><strong>(\d+)<\/strong>/)?.[1]);
}

for (const id of OBJECTIVE_IDS) {
  test(`${id}: shared banner and score display the actual name, condition, target, and four-point award`, () => {
    const objective = objectiveOf(id), { complete, before } = fixtures(id);
    const name = OBJECTIVES[id].name, target = OBJECTIVES[id].target;
    const banner = renderSharedObjective(objective);
    assert.ok(banner.includes(name));
    assert.ok(banner.includes(OBJECTIVES[id].description));
    assert.match(banner, /達成した人それぞれに1回だけ4点/);
    assert.match(banner, new RegExp(`data-shared-objective="${id}"`));
    const completed = renderScore(complete, scoreGarden(before, objective).total, true, { objective, committedGarden: before, immutable: true });
    assert.ok(completed.includes(name));
    assert.match(completed, new RegExp(`${target} / ${target}`));
    assert.match(completed, /仮置きでは達成。確定すると4点です/);
    assert.match(completed, /確定済み: .* · 0点/);
    assert.deepEqual(objectiveCards(completed), [{ id, progress: target, points: 4, preview: true }]);
    assert.equal(scoreTotal(completed), scoreGarden(complete, objective).total);
    const incomplete = renderScore(before, scoreGarden(before, objective).total, false, { objective, immutable: true });
    assert.deepEqual(objectiveCards(incomplete), [{ id, progress: target - 1, points: 0, preview: false }]);
    assert.match(incomplete, /未達成/);
  });

  test(`${id}: solo board, opponent, preview, and side-by-side comparison share the same goal`, () => {
    const { match, ui } = makeState(id);
    const snapshot = JSON.stringify({ match, ui });
    const html = renderMatch(match, ui), comparison = renderMatchComparison(match, ui);
    const target = OBJECTIVES[id].target;
    assert.match(html, new RegExp(`data-shared-objective="${id}"`));
    assert.match(html, new RegExp(`<span class="opponent-objective" data-objective-id="${id}">`));
    assert.deepEqual(objectiveCards(html), [
      { id, progress: target, points: 4, preview: true },
      { id, progress: target, points: 4, preview: true },
      { id, progress: target, points: 4, preview: false },
    ]);
    assert.deepEqual(objectiveCards(comparison), objectiveCards(html).slice(1));
    const committed = scoreGarden(match.players[0].garden, match.objective);
    const preview = scoreGarden(displayedGarden({ garden: match.players[0].garden, pending: ui.pending }), match.objective);
    assert.equal(scoreTotal(html), preview.total);
    assert.match(html, new RegExp(`確定済み ${committed.total}点`));
    assert.match(comparison, /data-focus="comparison-close" autofocus/);
    assert.match(comparison, /閉じると仮置きや選択を保って戻ります/);
    assert.equal(JSON.stringify({ match, ui }), snapshot, 'rendering must not commit or mutate a preview');
    assert.ok(!html.includes(SECRET_SEED));
    assert.ok(!comparison.includes(SECRET_SEED));
  });

  test(`${id}: finished results, own score, and opponent card agree without a preview`, () => {
    const { match, ui } = makeState(id, { preview: false });
    match.phase = 'finished';
    match.step = 'finished';
    ui.comparison = null;
    const score = scoreGarden(match.players[0].garden, match.objective).total;
    for (const html of [renderMatch(match, ui)]) {
      assert.equal(scoreTotal(html), score);
      assert.match(html, new RegExp(`<span>${score}点</span></li>`));
      assert.match(html, new RegExp(`<b>${score}点</b>`));
      assert.match(html, /確定済み/);
      assert.doesNotMatch(html, /仮置きでは達成/);
      assert.deepEqual(objectiveCards(html), [{ id, progress: OBJECTIVES[id].target, points: 4, preview: false }]);
    }
  });
}

test('absent objective remains the legacy corner rule in score, solo and comparison', () => {
  const { match, ui } = makeState('corners', { legacy: true });
  assert.equal(Object.hasOwn(match, 'objective'), false);
  const htmls = [renderMatch(match, ui), renderMatchComparison(match, ui)];
  for (const html of htmls) {
    assert.ok(objectiveCards(html).every((item) => item.id === 'corners' && item.points === 4));
    assert.match(html, /四隅の彩り/);
  }
  assert.match(htmls[0], /旧ルールで保存した試合/);
  assert.equal(scoreTotal(renderScore(fixtures('corners').complete, 0, false)), scoreGarden(fixtures('corners').complete).total);
});

test('confirmed duplicate corners are not shown as reparable; only a pending duplicate may be changed', () => {
  const objective = objectiveOf('corners');
  const locked = createGarden();
  locked[0] = createTile('cloud');
  locked[3] = createTile('cloud');
  const html = renderScore(locked, 0, false, { objective, immutable: true });
  assert.match(html, /確定済みの四隅に同じ地形があるため、この試合では達成できません/);
  assert.doesNotMatch(html, /あと\d|残り\d|変えられます/);
  const pending = { type: 'tile', index: 12, tile: createTile('lake') };
  const preview = renderObjective(displayedGarden({ garden: locked, pending }), objective, { isPreview: true, committedGarden: locked, immutable: true });
  assert.match(preview, /この試合では達成できません/);
  assert.doesNotMatch(preview, /確定前なら置き場所を変えられます/);
  const before = createGarden();
  before[0] = createTile('cloud');
  const duplicatePreview = renderObjective(locked, objective, { isPreview: true, committedGarden: before, immutable: true });
  assert.match(duplicatePreview, /この仮置きでは四隅に同じ地形/);
  assert.match(duplicatePreview, /確定前なら置き場所を変えられます/);
  assert.doesNotMatch(duplicatePreview, /この試合では達成できません/);
});

test('the solo rule panel describe all four objectives and mark corners as an example, not a universal rule', () => {
  for (const html of [renderMatchRules(objectiveOf('flow-chain'), true)]) {
    for (const definition of Object.values(OBJECTIVES)) assert.ok(html.includes(definition.name));
    assert.match(html, /輪になった流れも含みます/);
    assert.match(html, /1人につき1回だけ/);
    assert.match(html, /お題の一例として四隅を示します/);
    assert.match(html, /この試合: <strong>六枚の流れ/);
    assert.doesNotMatch(html, /隣り合う流れの接続1辺につき1点。四隅を4種類/);
  }
});

test('objective helpers reject unknown objectives rather than displaying a different fallback', () => {
  assert.throws(() => renderSharedObjective(objectiveOf('unknown')), /お題/);
  assert.throws(() => renderScore(createGarden(), 0, false, { objective: { id: 'corners', version: 99 } }), /お題/);
});

test('opponent buttons expose goal progress and score in their accessible names', () => {
  for (const id of OBJECTIVE_IDS) {
    const { match, ui } = makeState(id);
    for (const html of [renderMatch(match, ui)]) {
      const names = [...html.matchAll(/<button[^>]*class="opponent-card"[^>]*aria-label="([^"]+)"/g)].map(([, name]) => name);
      assert.ok(names.length > 0);
      for (const name of names) {
        assert.ok(name.includes(OBJECTIVES[id].name));
        assert.match(name, new RegExp(`${OBJECTIVES[id].target} / ${OBJECTIVES[id].target}`));
        assert.match(name, /達成、4点/);
      }
    }
  }
});

test('a preview after achievement does not promise a second four-point award', () => {
  for (const id of OBJECTIVE_IDS) {
    const { complete } = fixtures(id), objective = objectiveOf(id);
    const pending = { type: 'tile', index: 14, tile: createTile('magic') };
    const preview = displayedGarden({ garden: complete, pending });
    const html = renderScore(preview, scoreGarden(complete, objective).total, true, { objective, committedGarden: complete, immutable: true });
    assert.match(html, /仮置き後も4点のままです（追加点はありません）/);
    assert.doesNotMatch(html, /確定すると4点です/);
    assert.equal(objectiveCards(html)[0].points, 4);
  }
});

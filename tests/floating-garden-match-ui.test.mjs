import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as engine from '../lab/floating-garden/engine.js';
import * as match from '../lab/floating-garden/match-engine.js';
import * as cpu from '../lab/floating-garden/cpu.js';
import * as view from '../lab/floating-garden/match-view.js';
import * as save from '../lab/floating-garden/match-save.js';
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function mount({ seed = 'garden-1', chooseAction = cpu.chooseCpuAction, saveStore = null, now = () => 1790870400000 } = {}) {
  const listeners = new Map(); let buttons = []; let details = []; let dialog = null; let html = '';
  const pageListeners = new Map();
  const page = { addEventListener(type, handler) { pageListeners.set(type, handler); }, removeEventListener(type) { pageListeners.delete(type); }, scrollX: 0, scrollY: 250, scrollTo(x, y) { this.scrollX = x; this.scrollY = y; } };
  const root = {
    ownerDocument: { activeElement: null, body: { style: { overflow: 'auto' } }, defaultView: page },
    set innerHTML(value) {
      html = value;
      dialog = value.includes('<dialog ') ? { id: 'match-comparison', open: false, showModal() { this.open = true; }, close() { this.open = false; } } : null;
      buttons = [...value.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attributes]) => ({
        dataset: Object.fromEntries([...attributes.matchAll(/data-([\w-]+)="([^"]*)"/g)].map(([, key, text]) => [key, text])),
        disabled: /\bdisabled\b/.test(attributes), focus() { root.ownerDocument.activeElement = this; },
      }));
      details = [...value.matchAll(/<details\b([^>]*)>/g)].map(([, attributes]) => ({ id: attributes.match(/id="([^"]+)"/)[1], open: /\bopen\b/.test(attributes) }));
    },
    get innerHTML() { return html; },
    querySelectorAll(selector) { return selector === 'details' ? details : selector === 'button[data-action]' ? buttons : []; },
    querySelector(selector) {
      if (selector === '#match-comparison') return dialog;
      if (selector.startsWith('#')) return details.find((item) => `#${item.id}` === selector) || null;
      const focus = selector.match(/^\[data-focus="([^"]+)"\]$/)?.[1];
      return buttons.find((button) => button.dataset.focus === focus) || null;
    },
    contains(button) { return buttons.includes(button); },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
  };
  const source = read('lab/floating-garden/match-app.js').replace(/^import[^\n]*\n/gm, '').replace('export function mountMatch', 'function mountMatch').replace(/const root = document\.querySelector[\s\S]*$/, '');
  const api = runInNewContext(`${source}\nmountMatch(root, { seed, saveStore, now });`, { ...engine, ...match, ...cpu, ...save, chooseCpuAction: chooseAction, ...view, root, seed, saveStore, now, structuredClone });
  const clickButton = (button) => { root.ownerDocument.activeElement = button; return listeners.get('click')?.({ target: { closest: () => button } }); };
  return { api, root, page, listeners, pageListeners, button: (key) => root.querySelector(`[data-focus="${key}"]`), clickButton,
    click(key) { const button = this.button(key); assert.ok(button, `${key} exists`); return clickButton(button); },
    escape() { listeners.get('keydown')?.({ key: 'Escape', preventDefault() {} }); },
    cancel() { listeners.get('cancel')?.({ target: dialog, preventDefault() {} }); },
  };
}
function start(count = 4, options) { const app = mount(options); app.click(`count-${count}`); app.click('start'); return app; }
function applyHuman(app, command) {
  if (command.type === 'place') {
    for (let n = 0; n < command.rotation; n += 1) app.click('rotate');
    app.click(`cell-${command.index}`); app.click('commit');
  } else if (command.type === 'stone') { app.click(`stone-${command.stone}`); app.click(`cell-${command.index}`); app.click('commit'); }
  else if (command.type === 'offer') app.click(`offer-${command.target}`);
  else app.click(`command-${command.type}`);
}
function toHumanPlace(app) {
  app.click('command-draw'); app.click('command-self');
  if (app.button('cpu-next')) app.click('cpu-next');
  if (app.button('command-welcome')) app.click('command-welcome');
  else if (app.button('command-yield')) { app.click('command-yield'); if (app.button('cpu-next')) app.click('cpu-next'); }
  assert.equal(app.api.getState().step, 'place');
}

// Native details toggle themselves; clicks/Enter bubble without a game button.
function toggleExample(app, id) {
  const detail = app.root.querySelector(`#rule-example-${id}`);
  assert.ok(detail);
  detail.open = !detail.open;
  const target = { closest: () => null };
  app.listeners.get('click')?.({ target });
  app.listeners.get('keydown')?.({ key: 'Enter', target, preventDefault() {} });
}

test('CPU entry is separate and preserves free placement/demo with versioned module assets', () => {
  assert.match(read('lab/floating-garden/index.html'), /href="\.\/match.html"/);
  assert.match(read('lab/floating-garden/match.html'), /href="\.\/index.html"/);
  for (const filename of ['match.html', 'match-app.js', 'match-view.js']) assert.match(read(`lab/floating-garden/${filename}`), /v=20261002-match-save/);
  const app = mount(); assert.equal(app.api.getState(), null); assert.match(app.root.innerHTML, /CPUは山札の順番を見ません/);
  app.click('count-2'); app.click('start'); assert.equal(app.api.getState().players.length, 2);
  assert.equal((app.root.innerHTML.match(/class="opponent-card"/g) || []).length, 1);
  assert.doesNotMatch(app.root.innerHTML, /data-action="undo"/);
});

test('human tile preview/rotation/cancel is separate from match, commit advances once', () => {
  const app = start(); toHumanPlace(app);
  const before = app.api.getState(); app.click('cell-5'); app.click('rotate');
  assert.deepEqual(app.api.getState(), before); assert.equal(app.api.getUi().pending.tile.rotation, 1);
  assert.match(app.root.innerHTML, /仮置きした庭の得点/);
  app.click('cancel'); assert.equal(app.api.getUi().pending, null); assert.deepEqual(app.api.getState(), before);
  app.click('cell-5'); const oldCommit = app.button('commit'); app.click('commit');
  const after = app.api.getState(); assert.equal(after.players[0].garden[5].rotation, 1); assert.equal(after.revision, before.revision + 1);
  assert.equal(app.root.ownerDocument.activeElement.dataset.focus, 'command-meditate');
  app.clickButton(oldCommit); assert.deepEqual(app.api.getState(), after);
  app.click('command-meditate'); assert.equal(app.api.getState().players[0].careCount, 1);
});

test('comparison is read-only, preserves pending rotation/score/detail, restores focus and scroll with Escape/native cancel', () => {
  const app = start(); toHumanPlace(app); app.click('cell-4'); app.click('rotate');
  const before = app.api.getState(); const pending = app.api.getUi().pending;
  app.root.querySelector('#score-details').open = false;
  app.click('inspect-1'); assert.equal(app.root.ownerDocument.body.style.overflow, 'hidden');
  assert.equal(app.root.querySelector('#match-comparison').open, true);
  app.click('compare-pair'); app.click('compare-2');
  assert.match(app.root.innerHTML, /comparison-boards is-pair/);
  // Even a still-rendered background control must not execute while modal is open.
  app.click('commit'); assert.deepEqual(app.api.getState(), before);
  assert.deepEqual(app.api.getUi().pending, pending);
  app.page.scrollY = 999; app.escape();
  assert.equal(app.root.ownerDocument.body.style.overflow, 'auto'); assert.equal(app.page.scrollY, 250);
  assert.equal(app.root.ownerDocument.activeElement.dataset.focus, 'inspect-1');
  assert.equal(app.root.querySelector('#score-details').open, false);
  app.click('inspect-3'); app.cancel(); assert.equal(app.api.getUi().comparison, null);
  assert.equal(app.root.ownerDocument.activeElement.dataset.focus, 'inspect-3');
});

test('restart/settings confirmation cancels safely, blocks background work and rejects old generation clicks', () => {
  const app = start(); app.click('command-draw');
  const before = app.api.getState(); const stale = app.button('command-self');
  app.click('restart'); app.click('command-self'); assert.deepEqual(app.api.getState(), before);
  app.click('cancel-reset'); assert.deepEqual(app.api.getState(), before);
  app.click('restart'); app.escape(); assert.deepEqual(app.api.getState(), before);
  app.click('restart'); app.click('confirm-reset');
  assert.equal(app.api.getState().revision, 0); assert.notEqual(app.api.getState().seed, before.seed);
  app.clickButton(stale); assert.equal(app.api.getState().revision, 0);
  app.click('setup'); app.click('confirm-reset'); assert.equal(app.api.getState(), null);
  app.click('count-3'); app.click('start'); assert.equal(app.api.getState().players.length, 3);
});

test('CPU never progresses without explicit next, while inspecting, after unmount, or during human decisions', () => {
  const app = start(); app.click('command-draw'); app.click('command-self');
  const before = app.api.getState(); assert.ok(app.button('cpu-next'));
  app.click('inspect-1'); app.click('cpu-next'); assert.deepEqual(app.api.getState(), before);
  app.click('comparison-close'); app.click('cpu-next'); const after = app.api.getState();
  assert.ok(after.revision > before.revision); assert.equal(after.players[match.getDecision(after).seat].isHuman, true);
  app.click('inspect-1'); app.api.unmount(); assert.equal(app.root.ownerDocument.body.style.overflow, 'auto');
  assert.equal(app.listeners.size, 0); assert.deepEqual(app.api.getState(), after);
});

test('low power defense is explained and unavailable rather than silently waived', () => {
  let state = match.applyMatchAction(match.createMatch(), match.legalActions(match.createMatch())[0]);
  state.players[0].power = 1;
  const action = (type) => { state = match.applyMatchAction(state, match.legalActions(state).find((item) => item.type === type)); };
  action('self'); while (state.step === 'invite-response') action('request-invite');
  const html = view.renderMatch(state, { pending: null, rotation: 0, stone: null });
  assert.match(html, /力が2未満のため「庭に迎える」は選べません/);
  assert.doesNotMatch(html, /data-action="command-welcome"/); assert.match(html, /data-action="command-yield"/);
});

test('real UI listeners complete 2/3/4 player matches including gift responses, care, final stones, results and rematch', () => {
  const seen = new Set();
  for (const count of [2, 3, 4]) {
    const app = start(count); let iterations = 0;
    while (app.api.getState().phase !== 'finished') {
      assert.ok(++iterations < 500);
      const state = app.api.getState(); const decision = match.getDecision(state);
      seen.add(state.step);
      if (!state.players[decision.seat].isHuman) app.click('cpu-next');
      else {
        const action = cpu.chooseCpuAction(match.publicMatch(state), match.legalActions(state));
        applyHuman(app, action);
      }
      assert.equal(app.api.getUi().error, false, app.api.getUi().message);
    }
    assert.match(app.root.innerHTML, /庭の得点/); assert.match(app.root.innerHTML, /同点は同じ順位/);
    assert.ok(app.api.getState().players.every((player) => player.garden.every(Boolean)));
    app.click('restart'); app.click('confirm-reset'); assert.equal(app.api.getState().revision, 0);
  }
  for (const step of ['source', 'choose', 'place', 'care', 'final-stone']) assert.ok(seen.has(step));
});


test('all browser module edges and entry assets use one release key and resolve to existing files', () => {
  const directory = new URL('../lab/floating-garden/', import.meta.url);
  const version = '20261002-match-save';
  for (const name of readdirSync(directory).filter((name) => name.endsWith('.js'))) {
    const source = read(`lab/floating-garden/${name}`);
    for (const [, path, key] of source.matchAll(/from '(\.\/[^'?]+)(?:\?v=([^']+))?'/g)) {
      assert.equal(key, version, `${name} imports ${path} with the current release`);
      assert.ok(existsSync(new URL(path, directory)), `${name} import ${path} exists`);
    }
  }
  for (const name of ['index.html', 'match.html']) {
    for (const [, path, key] of read(`lab/floating-garden/${name}`).matchAll(/(?:src|href)="(\.\/[^"?]+\.(?:js|css))\?v=([^"\s]+)"/g)) {
      assert.equal(key, version); assert.ok(existsSync(new URL(path, directory)));
    }
  }
});


test('public tile and flow are visible beside the choices, with an upper-page action jump', () => {
  const app = start();
  assert.match(app.root.innerHTML, /href="#match-controls"/);
  app.click('command-draw');
  const controls = app.root.innerHTML.match(/<section id="match-controls"[\s\S]*?<\/section>/)[0];
  assert.match(controls, /class="decision-tile"/);
  assert.match(controls, /公開の1枚:/);
  assert.match(controls, /流れ: (上|右|下|左)/);
  assert.match(controls, /data-action="command-self"/);
});

test('native rule examples do not start a match or change tile preview, rotation or progress', () => {
  const app = mount();
  app.root.querySelector('#match-rules').open = true;
  for (const id of ['flow', 'moon', 'wind', 'color', 'echo', 'corners']) toggleExample(app, id);
  assert.equal(app.api.getState(), null);
  app.click('count-2'); app.click('start');
  assert.equal(app.root.querySelector('#match-rules').open, true);
  assert.equal(app.root.querySelector('#rule-example-moon').open, true);
  toHumanPlace(app); app.click('cell-5'); app.click('rotate');
  const before = app.api.getState(); const ui = app.api.getUi();
  for (const id of ['flow', 'moon', 'wind', 'color', 'echo', 'corners']) {
    toggleExample(app, id); toggleExample(app, id);
  }
  assert.deepEqual(app.api.getState(), before); assert.deepEqual(app.api.getUi(), ui);
  app.click('rotate');
  assert.equal(app.root.querySelector('#rule-example-moon').open, true, 'open examples survive game rerenders');
});

test('rule examples preserve stone selection/preview and comparison through repeated open/close', () => {
  const app = start(2); app.click('command-draw'); app.click('command-store');
  app.click('cell-5'); app.click('commit'); app.click('stone-wind'); app.click('cell-5');
  const before = app.api.getState(); const ui = app.api.getUi();
  toggleExample(app, 'wind'); toggleExample(app, 'wind');
  assert.deepEqual(app.api.getState(), before); assert.deepEqual(app.api.getUi(), ui);
  toggleExample(app, 'color');
  app.click('inspect-1'); app.click('compare-pair');
  const comparing = app.api.getUi();
  toggleExample(app, 'echo'); toggleExample(app, 'echo');
  assert.deepEqual(app.api.getState(), before); assert.deepEqual(app.api.getUi(), comparing);
  app.click('comparison-close');
  assert.deepEqual(app.api.getState(), before); assert.deepEqual(app.api.getUi(), ui);
  assert.equal(app.root.querySelector('#rule-example-color').open, true);
});

test('opening or closing scoring examples cannot advance a waiting CPU', () => {
  const app = start(); app.click('command-draw'); app.click('command-self');
  assert.ok(app.button('cpu-next'));
  const before = app.api.getState(); const ui = app.api.getUi();
  for (let repeat = 0; repeat < 3; repeat += 1) {
    for (const id of ['flow', 'moon', 'wind', 'color', 'echo', 'corners']) toggleExample(app, id);
  }
  assert.deepEqual(app.api.getState(), before); assert.deepEqual(app.api.getUi(), ui);
  app.click('cpu-next'); assert.ok(app.api.getState().revision > before.revision);
  assert.equal(app.root.querySelector('#rule-example-echo').open, true);
});

test('draw choices separate self/storage from equally styled recipients for 2/3/4 players', () => {
  for (const count of [2, 3, 4]) {
    const app = start(count); app.click('command-draw');
    const controls = app.root.innerHTML.match(/<section id="match-controls"[\s\S]*?<\/section>/)[0];
    const own = controls.match(/<fieldset class="match-choice-group match-own-choices">([\s\S]*?)<\/fieldset>/)?.[1];
    const offers = controls.match(/<fieldset class="match-choice-group match-offer-choices">([\s\S]*?)<\/fieldset>/)?.[1];
    assert.ok(own); assert.ok(offers);
    assert.match(own, /<legend>自分で使う・保管<\/legend>/);
    assert.match(own, /data-action="command-self"/); assert.match(own, /data-action="command-store"/);
    assert.doesNotMatch(own, /data-action="offer-/);
    assert.match(offers, /<legend>相手に譲る<\/legend>/);
    assert.doesNotMatch(offers, /data-action="command-/);
    const buttons = [...offers.matchAll(/<button\b([^>]*)>([^<]+)<\/button>/g)];
    assert.equal(buttons.length, count - 1);
    for (let i = 0; i < buttons.length; i += 1) {
      assert.match(buttons[i][1], new RegExp(`data-action="offer-${i + 1}"`));
      assert.doesNotMatch(buttons[i][1], /class=|style=|aria-pressed=/, 'no recipient gets special emphasis');
      assert.equal(buttons[i][2], `${app.api.getState().players[i + 1].name}に譲る`);
    }
  }
});

test('each grouped recipient still offers to that exact seat once and comparison preserves the choice', () => {
  for (const count of [2, 3, 4]) {
    for (let target = 1; target < count; target += 1) {
      const app = start(count); app.click('command-draw');
      const before = app.api.getState();
      app.click(`inspect-${target}`); app.click('compare-pair'); app.click('comparison-close');
      assert.deepEqual(app.api.getState(), before);
      const stale = app.button(`offer-${target}`);
      app.click(`offer-${target}`);
      const after = app.api.getState();
      assert.equal(after.step, 'offer-response'); assert.equal(after.offerTarget, target);
      assert.equal(after.revision, before.revision + 1);
      assert.equal(app.api.getUi().error, false);
      app.clickButton(stale); assert.deepEqual(app.api.getState(), after);
    }
  }
});

test('recipient groups shrink to eligible choices and disappear when no offer is allowed', () => {
  const initial = match.createMatch();
  const state = match.applyMatchAction(initial, match.legalActions(initial)[0]);
  const ui = { pending: null, rotation: 0, stone: null };
  const offerCount = () => (view.renderMatch(state, ui).match(/data-action="offer-/g) || []).length;
  assert.equal(offerCount(), 3);
  state.players[1].garden = Array.from({ length: 16 }, () => engine.createTile('lake', 'straight', 0));
  assert.equal(offerCount(), 2);
  state.players[2].garden = [...state.players[1].garden];
  assert.equal(offerCount(), 1);
  state.players[3].garden = [...state.players[1].garden];
  assert.equal(offerCount(), 0);
  assert.doesNotMatch(view.renderMatch(state, ui), /match-offer-choices/);
  state.drawn.canOffer = false;
  state.drawn.canStore = false;
  const controls = view.renderMatch(state, ui).match(/<section id="match-controls"[\s\S]*?<\/section>/)[0];
  assert.match(controls, /<legend>自分で使う<\/legend>/);
  assert.doesNotMatch(controls, /match-offer-choices|command-store/);
});

test('recipient buttons use one full-width grid column rather than last-row flex growth', () => {
  const css = read('lab/floating-garden/match-style.css');
  assert.match(css, /\.match-choice-buttons\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /\.match-choice-buttons\s*>\s*button\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /\.match-own-choices \.match-choice-buttons\s*\{[^}]*repeat\(auto-fit, minmax\(min\(100%, 140px\), 1fr\)\)/);
  assert.doesNotMatch(css, /\.match-offer-choices[^}]*:(?:last|nth)-child/);
});

function comparisonScore(html, seat) {
  return html.match(new RegExp(`<section class="score-panel panel compact-score" aria-labelledby="comparison-score-${seat}-title">([\\s\\S]*?)<\\/section>`))?.[1];
}
function assertBreakdown(html, garden) {
  const score = engine.scoreGarden(garden);
  assert.match(html, new RegExp(`<strong>${score.total}</strong><span>点</span>`));
  for (const [label, points] of [['つながる流れ', score.connectionPoints], ['星の石', score.stonePoints], ['共通のお題', score.objective.points]]) {
    assert.ok(html.includes(`<dt>${label}</dt><dd>${points}<small>点</small>`));
  }
  for (const stone of score.stones) {
    assert.ok(html.includes(`${engine.STONES[stone.stone].name} <small>${engine.cellName(stone.index)}</small></strong><b>${stone.points}点</b>`));
    assert.ok(html.includes(engine.STONES[stone.stone].rule));
    if (stone.matches.length) assert.ok(html.includes(`対象: ${stone.matches.map(engine.cellName).join('・')}`));
  }
  for (const edge of score.connections) assert.ok(html.includes(`${engine.cellName(edge.from)}–${engine.cellName(edge.to)}`));
}

// Reconstruct the reported 36-point moon garden: the score must stay unchanged.
function reportedMoonGarden() {
  const terrain = ['cloud', 'cloud', 'lake', 'magic', 'forest', 'lake', 'lake', 'lake', 'crystal', 'forest', 'cloud', 'forest', 'lake', 'lake', 'magic', 'crystal'];
  const bends = new Map([[1, 1], [5, 0], [6, 2], [8, 0], [9, 2], [10, 0], [11, 3], [14, 0]]);
  let garden = terrain.map((type, index) => engine.createTile(type, bends.has(index) ? 'bend' : 'straight', bends.get(index) ?? ([2, 15].includes(index) ? 1 : 0)));
  for (const [index, stone] of [[2, 'wind'], [4, 'color'], [5, 'moon'], [6, 'echo']]) garden = engine.placeStone(garden, index, stone);
  return garden;
}

test('reported 36-point opponent shows flow edges, each stone formula, and corner reasons without changing scoring', () => {
  const state = match.createMatch(); state.players[1].garden = reportedMoonGarden();
  const score = engine.scoreGarden(state.players[1].garden);
  assert.deepEqual([score.total, score.connectionPoints, score.stonePoints, score.objective.points], [36, 12, 20, 4]);
  assert.deepEqual(score.stones.map(({ stone, points }) => [stone, points]), [['wind', 2], ['color', 6], ['moon', 6], ['echo', 6]]);
  const before = structuredClone(state);
  const html = view.renderMatchComparison(state, { comparison: { seat: 1, pair: false }, pending: null });
  const panel = comparisonScore(html, 1); assert.ok(panel);
  assertBreakdown(panel, state.players[1].garden);
  assert.match(panel, /接続: A1–A2/); assert.match(panel, /向かい合う辺の流れが合うと1点/);
  assert.match(panel, /3枚 × 2 = 6点/); assert.match(panel, /3種類 × 2 = 6点/); assert.match(panel, /3個 × 2 = 6点/);
  assert.match(panel, /A1: 雲海 \/ D1: 魔力地 \/ A4: 月光湖 \/ D4: 結晶原/);
  assert.match(panel, /達成！ 四隅がすべて別の地形です/);
  assert.match(panel, /<details id="comparison-score-1-details">/);
  assert.doesNotMatch(html, /data-action="cell"|PREVIEW|score-delta/);
  assert.deepEqual(state, before);
});

test('every single and paired opponent gets an independent, current score panel with unique IDs', () => {
  for (const count of [2, 3, 4]) {
    const state = match.createMatch({ playerCount: count });
    state.players[1].garden = reportedMoonGarden();
    if (count > 2) state.players[2].garden = engine.createExampleGarden();
    for (let seat = 1; seat < count; seat += 1) for (const pair of [false, true]) {
      const ui = { pending: null, rotation: 0, stone: null, comparison: { seat, pair } };
      const html = view.renderMatch(state, ui);
      const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => id);
      assert.equal(new Set(ids).size, ids.length, `no duplicate IDs at ${count}/${seat}/${pair}`);
      assert.equal((html.match(/class="score-panel panel compact-score"/g) || []).length, pair ? 2 : 1);
      assertBreakdown(comparisonScore(html, seat), state.players[seat].garden);
      if (pair) assertBreakdown(comparisonScore(html, 0), state.players[0].garden);
      else assert.equal(comparisonScore(html, 0), undefined);
      for (const other of state.players.filter((player) => !player.isHuman && player.seat !== seat)) assert.equal(comparisonScore(html, other.seat), undefined);
    }
  }
});

test('comparison distinguishes tile and stone preview from committed opponent and human totals', () => {
  const state = match.createMatch();
  state.players[0].garden = engine.createExampleGarden();
  state.players[0].garden[9] = null;
  state.players[1].garden = reportedMoonGarden();
  const tile = engine.createTile('lake', 'straight', 1);
  const previews = [{ type: 'tile', index: 9, tile }, { type: 'stone', index: 10, stone: 'color' }];
  for (const pending of previews) {
    const before = structuredClone({ state, pending });
    const html = view.renderMatchComparison(state, { comparison: { seat: 1, pair: true }, pending });
    const human = comparisonScore(html, 0); const opponent = comparisonScore(html, 1);
    const committed = engine.scoreGarden(state.players[0].garden);
    const preview = engine.applyPlacement(state.players[0].garden, pending);
    assertBreakdown(human, preview); assertBreakdown(opponent, state.players[1].garden);
    assert.match(human, /仮置きした庭の得点/); assert.match(human, new RegExp(`確定済み ${committed.total}点 →`));
    assert.ok(html.includes(`${engine.cellName(pending.index)}の仮置きを含む`));
    assert.match(opponent, /確定した庭の得点/); assert.doesNotMatch(opponent, /PREVIEW|score-delta|仮置き/);
    assert.deepEqual({ state, pending }, before);
  }
});

test('score reasons explain empty stones, missing or repeated corners, and capped stones', () => {
  const state = match.createMatch();
  let panel = comparisonScore(view.renderMatchComparison(state, { comparison: { seat: 1, pair: false } }), 1);
  assert.match(panel, /まだ石は置かれていません。星の石は0点です/);
  assert.match(panel, /いまはつながる辺がありません/); assert.match(panel, /四隅にまだ空きマスがあります/);
  state.players[1].garden = engine.createExampleGarden();
  panel = comparisonScore(view.renderMatchComparison(state, { comparison: { seat: 1, pair: false } }), 1);
  assert.match(panel, /4種類 × 2 = 8点 → 上限6点/);
  state.players[1].garden[0] = engine.createTile('magic');
  panel = comparisonScore(view.renderMatchComparison(state, { comparison: { seat: 1, pair: false } }), 1);
  assert.match(panel, /四隅に同じ地形があります/);
  assert.match(panel, /<dt>共通のお題<\/dt><dd>0<small>点/);
});

function toggleScore(app, seat) {
  const detail = app.root.querySelector(`#comparison-score-${seat}-details`); assert.ok(detail);
  detail.open = !detail.open;
  const target = { closest: () => null };
  app.listeners.get('click')?.({ target });
  app.listeners.get('keydown')?.({ key: 'Enter', target, preventDefault() {} });
}

test('comparison details remain independent of sidebar and preserve tile/stone preview, dismissal and focus', () => {
  for (const preview of ['tile', 'stone']) {
    const app = start(2);
    app.click('command-draw'); app.click('command-store'); app.click('cell-5');
    if (preview === 'stone') { app.click('commit'); app.click('stone-wind'); app.click('cell-5'); }
    else app.click('rotate');
    const before = app.api.getState(); const ui = app.api.getUi();
    app.root.querySelector('#score-details').open = false;
    app.click('inspect-1');
    assert.equal(app.root.querySelector('#comparison-score-1-details').open, false);
    toggleScore(app, 1); app.click('compare-pair');
    assert.equal(app.root.querySelector('#comparison-score-1-details').open, true);
    assert.equal(app.root.querySelector('#comparison-score-0-details').open, false);
    toggleScore(app, 0); toggleScore(app, 1); app.click('compare-single');
    assert.equal(app.root.querySelector('#comparison-score-1-details').open, false);
    assert.equal(app.root.querySelector('#score-details').open, false);
    assert.deepEqual(app.api.getState(), before); assert.deepEqual(app.api.getUi().pending, ui.pending);
    for (const close of ['comparison-close', 'escape', 'cancel']) {
      if (!app.api.getUi().comparison) app.click('inspect-1');
      toggleScore(app, 1);
      if (close === 'comparison-close') app.click(close); else app[close]();
      assert.deepEqual(app.api.getState(), before); assert.deepEqual(app.api.getUi(), ui);
      assert.equal(app.root.ownerDocument.activeElement.dataset.focus, 'inspect-1');
      assert.equal(app.root.querySelector('#score-details').open, false);
    }
  }
});

test('opponent switches refresh details and cannot advance a waiting CPU', () => {
  const app = start(); app.click('command-draw'); app.click('command-self');
  assert.ok(app.button('cpu-next')); const before = app.api.getState();
  app.click('inspect-1'); toggleScore(app, 1); app.click('compare-pair');
  for (const seat of [2, 3, 1]) {
    app.click(`compare-${seat}`);
    assertBreakdown(comparisonScore(app.root.innerHTML, seat), before.players[seat].garden);
    assert.equal(app.root.querySelector(`#comparison-score-${seat}-details`).open, false);
    toggleScore(app, seat); app.click('cpu-next');
    assert.deepEqual(app.api.getState(), before);
    assert.equal(app.root.querySelector(`#comparison-score-${seat}-details`).open, true);
  }
  app.click('comparison-close'); app.click('cpu-next'); assert.ok(app.api.getState().revision > before.revision);
});

test('CPU-only assist starts OFF, renders no inventory until ON, and keeps hidden order out of its markup', () => {
  const app = start();
  assert.equal(app.api.getUi().assist, false);
  assert.match(app.root.innerHTML, /data-action="toggle-assist"[^>]*aria-pressed="false"/);
  assert.doesNotMatch(app.root.innerHTML, /class="assist-content"|class="assist-inventory"/);
  app.click('toggle-assist'); assert.equal(app.api.getUi().assist, true);
  const state = app.api.getState();
  const html = view.renderMatchAssist(state, app.api.getUi());
  assert.match(html, /山札全体: 残り80枚/);
  assert.equal((html.match(/<td>8<small>枚<\/small><\/td>/g) || []).length, 10);
  assert.match(html, /公開中の1枚・保管中・各庭のタイルは含めません/);
  assert.match(html, /回転した向きは区別しません/); assert.match(html, /CPUの考え方は変わりません/);
  assert.equal(app.root.querySelector('#match-assist-details').open, false);
  const alternate = structuredClone(state); alternate.seed = 'never-serialize-this-secret';
  alternate.deck = alternate.deck.slice().reverse();
  assert.equal(view.renderMatchAssist(alternate, app.api.getUi()), html, 'hidden order and seed do not affect assistance');
  assert.doesNotMatch(html, /tile-\d|rotation|seed|deckCursor|nextTile|never-serialize/);
  app.click('toggle-assist'); assert.doesNotMatch(app.root.innerHTML, /class="assist-content"|class="assist-inventory"/);
  for (const path of ['index.html', 'app.js', 'view.js', 'cpu.js', 'match-engine.js']) assert.doesNotMatch(read(`lab/floating-garden/${path}`), /match-assist|toggle-assist|remainingTileCounts/);
});

test('assist follows the current public tile including storage and protected replacements, with zero shown explicitly', () => {
  const app = start(2); app.click('toggle-assist'); app.click('command-draw');
  let state = app.api.getState();
  const expectedText = (current) => {
    const tile = current.drawn.tile;
    const count = current.deck.slice(current.deckCursor).filter((other) => other.terrain === tile.terrain && other.shape === tile.shape).length;
    return `${engine.TERRAIN[tile.terrain].name}・${tile.shape === 'bend' ? '曲線' : '直線'} · 山札にあと${count}枚`;
  };
  assert.ok(app.root.innerHTML.includes(expectedText(state))); assert.match(app.root.innerHTML, /山札全体: 残り39枚/);
  app.click('command-store'); state = app.api.getState();
  assert.equal(state.drawn.source, 'replacement'); assert.ok(app.root.innerHTML.includes(expectedText(state))); assert.match(app.root.innerHTML, /山札全体: 残り38枚/);
  const stored = match.createMatch({ playerCount: 2 }); stored.players[0].storage = stored.deck[stored.deckCursor++];
  const fromStorage = match.applyMatchAction(stored, match.legalActions(stored).find((action) => action.type === 'use-storage'));
  const storedHtml = view.renderMatchAssist(fromStorage, { assist: true });
  assert.ok(storedHtml.includes(expectedText(fromStorage))); assert.match(storedHtml, /山札全体: 残り39枚/);
  const depleted = match.createMatch({ playerCount: 2 });
  const candidates = depleted.deck.filter((tile) => tile.terrain === 'cloud' && tile.shape === 'straight');
  depleted.players[0].garden[0] = candidates[0]; depleted.players[0].garden[1] = candidates[1];
  depleted.players[1].storage = candidates[2]; depleted.drawn = { tile: candidates[3] };
  const zero = view.renderMatchAssist(depleted, { assist: true });
  assert.match(zero, /雲海・直線 · 山札にあと0枚/);
  assert.match(zero, /<th scope="row">雲海<\/th><td>0<small>枚/);
});

test('assist toggles preserve pending tiles and stones, selected rotation, score details and comparison', () => {
  for (const preview of ['tile', 'stone']) {
    const app = start(2); app.click('command-draw'); app.click('command-store'); app.click('cell-5');
    if (preview === 'stone') { app.click('commit'); app.click('stone-wind'); app.click('cell-5'); }
    else app.click('rotate');
    const state = app.api.getState(); const ui = app.api.getUi();
    app.root.querySelector('#score-details').open = false;
    app.click('toggle-assist'); app.click('toggle-assist');
    assert.deepEqual(app.api.getState(), state); assert.deepEqual(app.api.getUi(), ui);
    assert.equal(app.root.querySelector('#score-details').open, false);
    app.click('toggle-assist'); app.root.querySelector('#match-assist-details').open = true;
    app.click('inspect-1'); app.click('compare-pair');
    const comparing = app.api.getUi();
    app.click('toggle-assist'); // A queued background toggle must not affect the modal.
    assert.deepEqual(app.api.getUi(), comparing); assert.deepEqual(app.api.getState(), state);
    app.escape(); assert.equal(app.api.getUi().assist, true);
    assert.deepEqual(app.api.getUi().pending, ui.pending); assert.equal(app.api.getUi().rotation, ui.rotation);
    assert.equal(app.root.querySelector('#match-assist-details').open, true);
    assert.equal(app.root.ownerDocument.activeElement.dataset.focus, 'inspect-1');
  }
});

test('assist expansion and repeated toggles do not advance CPU or clear status, and restart resets it OFF', () => {
  const app = start(); app.click('command-draw'); app.click('command-self');
  const state = app.api.getState(); assert.ok(app.button('cpu-next'));
  app.click('toggle-assist');
  const ui = app.api.getUi(); const detail = app.root.querySelector('#match-assist-details'); detail.open = true;
  app.listeners.get('click')({ target: { closest: () => null } });
  assert.deepEqual(app.api.getState(), state); assert.deepEqual(app.api.getUi(), ui);
  for (let count = 0; count < 6; count += 1) app.click('toggle-assist');
  assert.deepEqual(app.api.getState(), state); assert.deepEqual(app.api.getUi(), ui);
  app.click('restart'); app.click('cancel-reset'); assert.deepEqual(app.api.getUi(), ui);
  const stale = app.button('toggle-assist'); app.click('restart'); app.click('confirm-reset');
  assert.equal(app.api.getUi().assist, false); assert.notEqual(app.api.getState().seed, state.seed);
  app.clickButton(stale); assert.equal(app.api.getUi().assist, false);
  app.click('toggle-assist'); app.click('setup'); app.click('confirm-reset');
  assert.equal(app.api.getState(), null); assert.equal(app.api.getUi().assist, false); assert.equal(app.button('toggle-assist'), null);
  app.click('count-3'); app.click('start'); assert.equal(app.api.getUi().assist, false);
  app.click('toggle-assist'); assert.match(app.root.innerHTML, /山札全体: 残り60枚/);
});

test('same-seed UI replay and every CPU input stay identical with assist OFF versus repeatedly toggled', () => {
  for (const count of [2, 3, 4]) {
    const plainCpu = []; const assistedCpu = [];
    const capture = (calls) => (visible, legal) => { calls.push(structuredClone({ visible, legal })); return cpu.chooseCpuAction(visible, legal); };
    const plain = start(count, { seed: `assist-replay-${count}`, chooseAction: capture(plainCpu) });
    const assisted = start(count, { seed: `assist-replay-${count}`, chooseAction: capture(assistedCpu) });
    let steps = 0;
    while (plain.api.getState().phase !== 'finished') {
      assert.ok(++steps < 500);
      assisted.click('toggle-assist');
      const state = plain.api.getState(); const decision = match.getDecision(state);
      if (!state.players[decision.seat].isHuman) { plain.click('cpu-next'); assisted.click('cpu-next'); }
      else {
        const action = cpu.chooseCpuAction(match.publicMatch(state), match.legalActions(state));
        applyHuman(plain, action); applyHuman(assisted, action);
      }
      assert.deepEqual(assisted.api.getState(), plain.api.getState(), `same state after step ${steps} in ${count}-player match`);
      assert.deepEqual(match.publicMatch(assisted.api.getState()), match.publicMatch(plain.api.getState()));
      assert.equal(assisted.api.getUi().error, false, assisted.api.getUi().message);
    }
    assert.deepEqual(assistedCpu, plainCpu, 'the CPU never receives added inventory, flags or hidden information');
    for (const { visible } of assistedCpu) for (const key of ['seed', 'deck', 'deckCursor', 'assist', 'inventory', 'remainingTileCounts']) assert.ok(!Object.hasOwn(visible, key));
    assert.deepEqual(match.rankMatch(assisted.api.getState()), match.rankMatch(plain.api.getState()));
  }
});

// CPU match persistence is separate from the free-placement demo.
import { memoryEnvironment, savedFixture, saveScenarios, settleLocks } from './helpers/floating-garden-save.mjs';

async function startSaved(env, count = 4, options = {}) {
  const app = mount({ saveStore: env.store(), ...options }); app.click(`count-${count}`); await app.click('start'); return app;
}

test('saved game startup waits for explicit resume, preserves rules exactly and never advances CPU', async () => {
  for (const { state, actions } of saveScenarios()) {
    const env = memoryEnvironment(savedFixture(state, actions, true)); const before = env.raw();
    const app = mount({ saveStore: env.store() });
    assert.equal(app.api.getState(), null); assert.equal(env.raw(), before);
    assert.ok(app.button('resume')); await app.click('resume');
    assert.deepEqual(app.api.getState(), state); assert.equal(env.raw(), before, 'resume does not even rewrite the save');
    assert.equal(app.api.getUi().assist, true); assert.equal(app.api.getUi().pending, null);
    assert.equal(app.api.getUi().rotation, 0); assert.equal(app.api.getUi().stone, null); assert.equal(app.api.getUi().comparison, null);
    assert.doesNotMatch(app.root.innerHTML, new RegExp(state.seed));
    assert.doesNotMatch(app.root.innerHTML, /tile-\d+/);
    assert.deepEqual(match.publicMatch(app.api.getState()), match.publicMatch(state));
    app.api.unmount(); await settleLocks();
  }
});

test('reload discards uncommitted preview/selection but keeps assist, exact drawn tile and committed placement once', async () => {
  for (const kind of ['tile', 'stone']) {
    const env = memoryEnvironment(); const app = await startSaved(env, 2);
    app.click('command-draw'); app.click('command-store'); app.click('cell-5');
    if (kind === 'stone') { app.click('commit'); app.click('stone-wind'); app.click('cell-5'); }
    else app.click('rotate');
    app.click('toggle-assist');
    const state = app.api.getState(); const text = env.raw();
    app.api.unmount(); await settleLocks();
    const resumed = mount({ saveStore: env.store() }); await resumed.click('resume');
    assert.deepEqual(resumed.api.getState(), state); assert.equal(env.raw(), text);
    assert.equal(resumed.api.getUi().pending, null); assert.equal(resumed.api.getUi().stone, null); assert.equal(resumed.api.getUi().rotation, 0);
    assert.equal(resumed.api.getUi().assist, true);
    if (kind === 'tile') { resumed.click('cell-5'); const old = resumed.button('commit'); resumed.click('commit'); resumed.clickButton(old); assert.equal(resumed.api.getState().revision, state.revision + 1); }
    resumed.api.unmount(); await settleLocks();
  }
});

test('existing valid, finished, old-version or corrupt saves require replacement confirmation and cancellation keeps bytes', async () => {
  const finished = saveScenarios().find(({ state }) => state.phase === 'finished');
  for (const text of [savedFixture(match.createMatch()), savedFixture(finished.state, finished.actions), '{', '{"version":"old"}']) {
    const env = memoryEnvironment(text); const app = mount({ saveStore: env.store() });
    app.click('count-3'); app.click('start'); assert.equal(app.api.getState(), null); assert.equal(env.raw(), text);
    assert.ok(app.button('confirm-reset')); app.click('cancel-reset'); assert.equal(env.raw(), text);
    app.click('start'); const stale = app.button('confirm-reset'); const promise = app.click('confirm-reset'); app.clickButton(stale); await promise;
    assert.equal(app.api.getState().players.length, 3); assert.equal(app.api.getState().revision, 0);
    assert.equal(save.decodeMatchSave(env.raw()).state.players.length, 3); app.api.unmount(); await settleLocks();
  }
});

test('two tabs cannot resume/write together and unexpected changes pause without overwriting', async () => {
  const env = memoryEnvironment(); const a = await startSaved(env, 2); a.click('command-draw');
  const text = env.raw(); const b = mount({ saveStore: env.store() }); await b.click('resume');
  assert.equal(b.api.getState(), null); assert.match(b.root.innerHTML, /別のタブ/); assert.equal(env.raw(), text);
  a.api.unmount(); await settleLocks(); b.click('reload-save'); await b.click('resume');
  assert.equal(b.api.getState().revision, 1);
  const external = savedFixture(match.createMatch({ seed: 'other-match', playerCount: 3 })); env.storage.setItem(save.SAVE_KEY, external);
  b.pageListeners.get('storage')({ key: save.SAVE_KEY, newValue: external });
  const before = b.api.getState(); assert.match(b.root.innerHTML, /上書きせず/); b.click('toggle-assist'); assert.deepEqual(b.api.getState(), before);
  assert.equal(env.raw(), external); b.click('reload-save'); b.click('cancel-reset'); assert.deepEqual(b.api.getState(), before);
  b.click('reload-save'); b.click('confirm-reset'); assert.equal(b.api.getState(), null); await settleLocks(); await b.click('resume');
  assert.equal(b.api.getState().seed, 'other-match'); assert.equal(env.raw(), external); b.api.unmount();
});

test('quota failure pauses after one action and supports retry or explicit unsaved play without destroying last save', async () => {
  const env = memoryEnvironment(); const app = await startSaved(env, 2); const before = env.raw();
  env.faults.write = true; app.click('command-draw');
  assert.equal(app.api.getState().revision, 1); assert.equal(env.raw(), before); assert.match(app.root.innerHTML, /保存できませんでした/);
  app.click('toggle-assist'); assert.equal(app.api.getUi().assist, false);
  env.faults.write = false; app.click('retry-save'); assert.equal(save.decodeMatchSave(env.raw()).state.revision, 1);
  env.faults.write = true; app.click('command-store'); const last = env.raw(); const revision = app.api.getState().revision;
  app.click('continue-unsaved'); app.click('cell-0'); app.click('commit');
  assert.equal(app.api.getState().revision, revision + 1); assert.equal(env.raw(), last); assert.match(app.root.innerHTML, /保存なしでプレイ中/);
  app.api.unmount();
});

test('storage denial and unsupported locks allow clearly labeled unsaved play without a write', async () => {
  const original = savedFixture(match.createMatch());
  const env = memoryEnvironment(original); env.faults.read = true;
  const a = mount({ saveStore: env.store() }); a.click('start'); a.click('command-draw');
  assert.equal(a.api.getState().revision, 1); assert.equal(env.raw(), original); assert.match(a.root.innerHTML, /保存なし/); a.api.unmount();
  env.faults.read = false;
  const b = mount({ saveStore: save.createMatchSaveStore({ storage: env.storage }) }); await b.click('resume'); b.click('command-draw');
  assert.equal(b.api.getState().revision, 1); assert.equal(env.raw(), original); assert.match(b.root.innerHTML, /保存なし/); b.api.unmount();
});

test('saved rematch and player changes reset assist and preserve previous save until a confirmed new start', async () => {
  const env = memoryEnvironment(); const app = await startSaved(env, 2); app.click('command-draw'); app.click('toggle-assist');
  const before = env.raw(); app.click('setup'); app.click('cancel-reset'); assert.equal(env.raw(), before);
  app.click('setup'); app.click('confirm-reset'); assert.equal(app.api.getState(), null); assert.equal(env.raw(), before);
  app.click('count-4'); await app.click('start'); assert.equal(app.api.getState().players.length, 4); assert.equal(app.api.getUi().assist, false);
  assert.equal(save.decodeMatchSave(env.raw()).state.players.length, 4);
  app.click('toggle-assist'); app.click('restart'); app.click('confirm-reset');
  assert.equal(app.api.getUi().assist, false); assert.equal(save.decodeMatchSave(env.raw()).assist, false); app.api.unmount();
});

test('same-seed saved/resumed play finishes identically, including repeated resume at CPU waits', async () => {
  for (const count of [2, 3, 4]) {
    const env = memoryEnvironment(); let app = await startSaved(env, count, { seed: `resume-replay-${count}` });
    let reference = match.createMatch({ playerCount: count, seed: `resume-replay-${count}` }); let iterations = 0;
    while (reference.phase !== 'finished') {
      assert.ok(++iterations < 500);
      if (iterations % 9 === 0) { app.api.unmount(); await settleLocks(); app = mount({ saveStore: env.store() }); await app.click('resume'); assert.deepEqual(app.api.getState(), reference); }
      const decision = match.getDecision(reference);
      if (!reference.players[decision.seat].isHuman) {
        app.click('cpu-next');
        while (match.getDecision(reference) && !reference.players[match.getDecision(reference).seat].isHuman) reference = match.applyMatchAction(reference, cpu.chooseCpuAction(match.publicMatch(reference), match.legalActions(reference)));
      } else { const action = cpu.chooseCpuAction(match.publicMatch(reference), match.legalActions(reference)); applyHuman(app, action); reference = match.applyMatchAction(reference, action); }
      assert.deepEqual(app.api.getState(), reference); assert.equal(app.api.getUi().error, false);
    }
    assert.deepEqual(save.decodeMatchSave(env.raw()).state, reference); assert.deepEqual(match.rankMatch(app.api.getState()), match.rankMatch(reference));
    app.api.unmount(); await settleLocks();
  }
});

test('bfcache restoration is paused until choosing a safe recovery and unmount removes storage listeners', async () => {
  const env = memoryEnvironment(); const app = await startSaved(env, 2); const before = env.raw();
  app.pageListeners.get('pagehide')(); app.pageListeners.get('pageshow')({ persisted: true });
  assert.match(app.root.innerHTML, /一時停止/); assert.equal(env.raw(), before); assert.equal(app.api.getState().revision, 0);
  app.api.unmount(); assert.equal(app.pageListeners.size, 0); await settleLocks();
  const next = env.store(); assert.equal(await next.acquire(), 'acquired'); next.release();
});

test('a pending lock acquisition rejects repeated start and cannot resume after unmount', async () => {
  const env = memoryEnvironment(); const base = env.store(); let resolve;
  const gate = new Promise((done) => { resolve = done; });
  const delayed = { read: base.read, write: base.write, release: base.release, available: true, acquire: () => gate.then(() => base.acquire()) };
  const app = mount({ saveStore: delayed }); const old = app.button('start');
  const work = app.click('start'); app.clickButton(old); assert.equal(app.api.getState(), null); assert.equal(env.raw(), null);
  app.api.unmount(); resolve(); await work; await settleLocks();
  assert.equal(app.api.getState(), null); assert.equal(env.raw(), null);
  const next = env.store(); assert.equal(await next.acquire(), 'acquired'); next.release();
});

test('a save changed during startup confirmation is re-presented and never overwritten by the old confirmation', async () => {
  const old = savedFixture(match.createMatch({ seed: 'old' })); const env = memoryEnvironment(old);
  const app = mount({ saveStore: env.store() }); app.click('start');
  const latest = savedFixture(match.createMatch({ seed: 'latest', playerCount: 2 })); env.storage.setItem(save.SAVE_KEY, latest);
  await app.click('confirm-reset'); assert.equal(app.api.getState(), null); assert.equal(env.raw(), latest);
  assert.match(app.root.innerHTML, /保存の内容が更新/);
  await app.click('resume'); assert.equal(app.api.getState().seed, 'latest'); assert.equal(env.raw(), latest); app.api.unmount();
});

test('CPU quota failure stops the batch after exactly one transition and retry resumes from that saved decision', async () => {
  const env = memoryEnvironment(); const app = await startSaved(env, 4);
  app.click('command-draw'); app.click('command-self'); const state = app.api.getState(); const old = env.raw();
  assert.ok(!state.players[match.getDecision(state).seat].isHuman);
  env.faults.write = true; app.click('cpu-next');
  assert.equal(app.api.getState().revision, state.revision + 1); assert.equal(env.raw(), old);
  env.faults.write = false; app.click('retry-save'); assert.equal(save.decodeMatchSave(env.raw()).state.revision, state.revision + 1);
  app.api.unmount();
});


test('unsaved bfcache restoration refreshes generation without freezing match or setup controls', () => {
  const app = start(2);
  const before = app.api.getState();
  const stale = app.button('command-draw');
  app.pageListeners.get('pagehide')(); app.pageListeners.get('pageshow')({ persisted: true });
  assert.deepEqual(app.api.getState(), before);
  app.clickButton(stale); assert.deepEqual(app.api.getState(), before);
  app.click('command-draw'); assert.equal(app.api.getState().revision, before.revision + 1);
  app.api.unmount();
  const setup = mount(); setup.pageListeners.get('pagehide')(); setup.pageListeners.get('pageshow')({ persisted: true });
  setup.click('count-3'); setup.click('start'); assert.equal(setup.api.getState().players.length, 3);
  setup.api.unmount();
});


test('a storage event during pending replacement cannot transfer the old approval to newer saved data', async () => {
  const old = savedFixture(match.createMatch({ seed: 'old' })); const env = memoryEnvironment(old);
  const base = env.store(); let resolve; const gate = new Promise((done) => { resolve = done; });
  const delayed = { read: base.read, write: base.write, release: base.release, available: true, acquire: () => gate.then(() => base.acquire()) };
  const app = mount({ saveStore: delayed }); app.click('start'); const work = app.click('confirm-reset');
  const latest = savedFixture(match.createMatch({ seed: 'latest', playerCount: 2 })); env.storage.setItem(save.SAVE_KEY, latest);
  app.pageListeners.get('storage')({ key: save.SAVE_KEY, newValue: latest });
  resolve(); await work; await settleLocks();
  assert.equal(app.api.getState(), null); assert.equal(env.raw(), latest); assert.match(app.root.innerHTML, /保存の内容が更新/);
  app.click('start'); assert.ok(app.button('confirm-reset')); assert.equal(env.raw(), latest); app.api.unmount();
});

test('bfcache during pending acquisition recovers enabled setup controls once the stale request settles', async () => {
  const env = memoryEnvironment(); const base = env.store(); let resolve;
  const gate = new Promise((done) => { resolve = done; });
  const delayed = { read: base.read, write: base.write, release: base.release, available: true, acquire: () => gate.then(() => base.acquire()) };
  const app = mount({ saveStore: delayed }); const work = app.click('start');
  app.pageListeners.get('pagehide')(); app.pageListeners.get('pageshow')({ persisted: true });
  resolve(); await work; await settleLocks();
  assert.equal(app.api.getState(), null); assert.equal(env.raw(), null);
  assert.doesNotMatch(app.root.innerHTML, /保存の使用状況を確認しています/); assert.equal(app.button('start').disabled, false);
  app.click('reload-save'); await app.click('start'); assert.equal(app.api.getState().revision, 0); app.api.unmount();
});

test('explicit unsaved continuation remains interactive after bfcache without changing the last save', async () => {
  const env = memoryEnvironment(); const app = await startSaved(env, 2); const before = env.raw();
  env.faults.write = true; app.click('command-draw'); app.click('continue-unsaved');
  app.pageListeners.get('pagehide')(); app.pageListeners.get('pageshow')({ persisted: true });
  app.click('command-store'); assert.equal(app.api.getState().revision, 2); assert.equal(env.raw(), before);
  assert.match(app.root.innerHTML, /保存なしでプレイ中/); app.api.unmount();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as engine from '../lab/floating-garden/engine.js';
import * as match from '../lab/floating-garden/match-engine.js';
import * as cpu from '../lab/floating-garden/cpu.js';
import * as view from '../lab/floating-garden/match-view.js';
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function mount() {
  const listeners = new Map(); let buttons = []; let details = []; let dialog = null; let html = '';
  const page = { scrollX: 0, scrollY: 250, scrollTo(x, y) { this.scrollX = x; this.scrollY = y; } };
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
  const api = runInNewContext(`${source}\nmountMatch(root, { seed: 'garden-1' });`, { ...engine, ...match, ...cpu, ...view, root, structuredClone });
  const clickButton = (button) => { root.ownerDocument.activeElement = button; listeners.get('click')?.({ target: { closest: () => button } }); };
  return { api, root, page, listeners, button: (key) => root.querySelector(`[data-focus="${key}"]`), clickButton,
    click(key) { const button = this.button(key); assert.ok(button, `${key} exists`); clickButton(button); },
    escape() { listeners.get('keydown')?.({ key: 'Escape', preventDefault() {} }); },
    cancel() { listeners.get('cancel')?.({ target: dialog, preventDefault() {} }); },
  };
}
function start(count = 4) { const app = mount(); app.click(`count-${count}`); app.click('start'); return app; }
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

test('CPU entry is separate and preserves free placement/demo with versioned module assets', () => {
  assert.match(read('lab/floating-garden/index.html'), /href="\.\/match.html"/);
  assert.match(read('lab/floating-garden/match.html'), /href="\.\/index.html"/);
  for (const filename of ['match.html', 'match-app.js', 'match-view.js']) assert.match(read(`lab/floating-garden/${filename}`), /v=20261001-cpu-matches-r2/);
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
  const version = '20261001-cpu-matches-r2';
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

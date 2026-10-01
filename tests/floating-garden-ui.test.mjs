import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as engine from '../lab/floating-garden/engine.js';
import * as session from '../lab/floating-garden/session.js';
import * as view from '../lab/floating-garden/view.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/** Minimal DOM adapter: exercises real listeners and renderers, not browser layout. */
function mount() {
  const listeners = new Map();
  let html = '';
  let details = [];
  let buttons = [];
  const root = {
    ownerDocument: { activeElement: null },
    set innerHTML(value) {
      html = value;
      buttons = [...value.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((match) => {
        const attributes = match[1];
        const dataset = Object.fromEntries([...attributes.matchAll(/data-([\w-]+)="([^"]*)"/g)].map(([, key, text]) => [key, text]));
        return { dataset, disabled: /\bdisabled\b/.test(attributes), focus() { root.ownerDocument.activeElement = this; }, closest: () => null };
      });
      details = [...value.matchAll(/<details\b([^>]*)>/g)].map(([, attributes]) => ({ id: attributes.match(/id="([^"]+)"/)[1], open: /\bopen\b/.test(attributes) }));
    },
    get innerHTML() { return html; },
    querySelectorAll(selector) { return selector === 'details' ? details : []; },
    querySelector(selector) {
      if (selector.startsWith('#')) return details.find((detail) => `#${detail.id}` === selector);
      if (selector === '.replacement-confirm') return /replacement-confirm/.test(html) ? { scrollIntoView() {} } : null;
      const focus = selector.match(/^\[data-focus="([^"]+)"\]$/)?.[1];
      return buttons.find((button) => button.dataset.focus === focus) || null;
    },
    contains(button) { return buttons.includes(button); },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
  };
  const source = read('lab/floating-garden/app.js').replace(/^import[^\n]*\n/gm, '').replace('export function mountGarden', 'function mountGarden').replace(/const root = document\.querySelector[\s\S]*$/, '');
  const api = runInNewContext(`${source}\nmountGarden(root);`, { ...engine, ...session, ...view, root, structuredClone });
  return {
    root, api,
    click(focus) {
      const button = root.querySelector(`[data-focus="${focus}"]`);
      assert.ok(button, `button ${focus} should exist`);
      root.ownerDocument.activeElement = button;
      listeners.get('click')?.({ target: { closest: () => button } });
    },
    escape() { listeners.get('keydown')?.({ key: 'Escape' }); },
  };
}

test('renderer exposes 16 named tap targets, prototype limits and accessible controls', () => {
  const html = view.renderSession(session.createSession());
  assert.equal((html.match(/data-action="cell"/g) || []).length, 16);
  for (const name of ['A1', 'D1', 'A4', 'D4']) assert.ok(html.includes(`aria-label="${name}、空きマス"`));
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /data-action="commit"[^>]*disabled/);
  assert.match(html, /data-action="cancel"[^>]*disabled/);
  assert.match(html, /data-action="undo"[^>]*disabled/);
  assert.match(html, /CPU、複数人対戦、通信/);
  assert.match(read('lab/floating-garden/index.html'), /対戦・CPU・通信・手番や力の消費は、まだありません/);
});

test('actual click listener selects, previews, rotates, commits, and ignores repeated commit', () => {
  const app = mount();
  app.click('terrain-lake'); app.click('shape-bend'); app.click('cell-5');
  assert.equal(app.api.getSession().garden[5], null);
  assert.equal(app.api.getSession().pending.tile.terrain, 'lake');
  assert.match(app.root.innerHTML, /仮置きした庭の得点/);
  assert.match(app.root.innerHTML, /B2への配置を確定/);
  app.click('rotate');
  assert.equal(app.api.getSession().pending.tile.rotation, 1);
  app.click('commit');
  assert.equal(app.api.getSession().garden[5].rotation, 1);
  assert.equal(app.api.getSession().pending, null);
  assert.equal(app.root.ownerDocument.activeElement.dataset.focus, 'cell-5');
  app.click('commit');
  assert.equal(app.api.getSession().history.length, 1);
  assert.match(app.root.innerHTML, /いまの庭の得点/);
});

test('actual listener previews stone score, cancel restores baseline, commit and undo restore stock', () => {
  const app = mount();
  app.click('terrain-lake'); app.click('cell-0'); app.click('commit');
  app.click('stone-moon'); app.click('cell-0');
  assert.match(app.root.innerHTML, /確定済み 0点 → \+2点/);
  assert.match(app.root.innerHTML, /対象: A1/);
  app.click('cancel');
  assert.equal(app.api.getSession().garden[0].stone, null);
  app.click('cell-0'); app.click('commit');
  assert.equal(app.api.getSession().garden[0].stone, 'moon');
  assert.match(app.root.innerHTML, /data-stone="moon"[^>]*disabled/);
  app.click('stone-moon');
  assert.equal(app.api.getSession().selection.type, 'tile');
  app.click('undo');
  assert.equal(app.api.getSession().garden[0].stone, null);
  app.click('stone-moon');
  assert.equal(app.api.getSession().selection.stone, 'moon');
});

test('invalid placement leaves committed garden untouched and communicates the error', () => {
  const app = mount();
  app.click('cell-0'); app.click('commit');
  app.click('cell-0');
  assert.equal(app.api.getSession().history.length, 1);
  assert.equal(app.api.getSession().pending, null);
  assert.match(app.root.innerHTML, /status error/);
  assert.match(app.root.innerHTML, /地形のあるマスには重ねられません/);
  app.click('stone-color'); app.click('cell-1');
  assert.equal(app.api.getSession().pending, null);
  assert.match(app.root.innerHTML, /石は地形のあるマスに置きます/);
});

test('Escape cancels a preview; stale previews do not survive a new selection', () => {
  const app = mount();
  app.click('cell-0'); app.escape();
  assert.equal(app.api.getSession().pending, null);
  app.click('cell-1'); app.click('terrain-magic');
  assert.equal(app.api.getSession().pending, null);
  app.click('commit');
  assert.equal(app.api.getSession().garden.every((cell) => cell === null), true);
});

test('reset and example require local confirmation; cancel/Escape preserve the garden', () => {
  const app = mount();
  app.click('cell-0'); app.click('commit');
  app.click('reset');
  assert.equal(app.api.getSession().garden[0].terrain, 'cloud');
  assert.equal(app.root.ownerDocument.activeElement.dataset.focus, 'replace-cancel');
  app.click('replace-cancel');
  assert.equal(app.root.ownerDocument.activeElement.dataset.focus, 'reset');
  assert.equal(app.api.getSession().history.length, 1);
  app.click('example'); app.escape();
  assert.equal(app.api.getSession().history.length, 1);
  app.click('example'); app.click('replace-confirm');
  assert.equal(engine.scoreGarden(app.api.getSession().garden).total, 31);
  assert.equal(app.api.getSession().history.length, 0);
  assert.match(app.root.innerHTML, /4種類 × 2 = 8点 → 上限6点/);
  assert.match(app.root.innerHTML, /達成！/);
  app.click('reset'); app.click('replace-confirm');
  assert.equal(engine.scoreGarden(app.api.getSession().garden).filled, 0);
  assert.equal(app.api.getSession().history.length, 0);
});

test('editing dismisses a stale replacement prompt without replacing the garden', () => {
  const app = mount();
  app.click('cell-0'); app.click('commit');
  app.click('reset'); app.click('terrain-forest');
  assert.doesNotMatch(app.root.innerHTML, /id="replace-title"/);
  assert.equal(app.api.getSession().garden[0].terrain, 'cloud');
});

test('details expansion and focus survive re-rendering, and unmount removes listeners', () => {
  const app = mount();
  app.root.querySelector('#rules-details').open = true;
  app.root.querySelector('#score-details').open = false;
  app.click('terrain-magic');
  assert.equal(app.root.querySelector('#rules-details').open, true);
  assert.equal(app.root.querySelector('#score-details').open, false);
  assert.equal(app.root.ownerDocument.activeElement.dataset.focus, 'terrain-magic');
  app.api.unmount();
  app.click('cell-0');
  assert.equal(app.api.getSession().pending, null);
});

test('message content is escaped and there are no external assets or production APIs', () => {
  const html = view.renderSession(session.createSession(), { message: '<img onerror="bad()"> & test' });
  assert.doesNotMatch(html, /<img onerror/);
  assert.match(html, /&lt;img onerror=&quot;bad\(\)&quot;&gt; &amp; test/);
  const source = ['index.html', 'app.js', 'engine.js', 'session.js', 'view.js', 'style.css'].map((name) => read(`lab/floating-garden/${name}`)).join('\n');
  assert.doesNotMatch(source, /https?:\/\/|fetch\(|XMLHttpRequest|firebase|localStorage|Math\.random\(/);
  assert.doesNotMatch(read('index.html'), /floating-garden/);
  assert.doesNotMatch(read('toybox/index.html'), /floating-garden/);
});

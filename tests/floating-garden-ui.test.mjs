import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as engine from '../lab/floating-garden/engine.js';
import * as session from '../lab/floating-garden/session.js';
import * as view from '../lab/floating-garden/view.js';
import * as tableDemo from '../lab/floating-garden/table-demo.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/** Minimal DOM adapter: exercises real listeners and renderers, not browser layout. */
function mount() {
  const listeners = new Map();
  let html = '';
  let details = [];
  let buttons = [];
  let dialog = null;
  const page = { scrollX: 0, scrollY: 220, scrollTo(x, y) { this.scrollX = x; this.scrollY = y; } };
  const root = {
    ownerDocument: { activeElement: null, body: { style: { overflow: 'auto' } }, defaultView: page },
    set innerHTML(value) {
      html = value;
      dialog = value.includes('<dialog ') ? { id: 'garden-comparison', open: false, showModal() { this.open = true; }, close() { this.open = false; } } : null;
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
      if (selector === '#garden-comparison') return dialog;
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
  const api = runInNewContext(`${source}\nmountGarden(root);`, { ...engine, ...session, ...view, ...tableDemo, root, structuredClone });
  return {
    root, api,
    click(focus) {
      const button = root.querySelector(`[data-focus="${focus}"]`);
      assert.ok(button, `button ${focus} should exist`);
      root.ownerDocument.activeElement = button;
      listeners.get('click')?.({ target: { closest: () => button } });
    },
    escape() { listeners.get('keydown')?.({ key: 'Escape', preventDefault() {} }); },
    dialogCancel() { listeners.get('cancel')?.({ target: dialog, preventDefault() {} }); },
    page,
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
  const source = ['index.html', 'app.js', 'engine.js', 'session.js', 'view.js', 'table-demo.js', 'style.css'].map((name) => read(`lab/floating-garden/${name}`)).join('\n');
  assert.doesNotMatch(source, /https?:\/\/|fetch\(|XMLHttpRequest|firebase|localStorage|Math\.random\(/);
  assert.doesNotMatch(read('index.html'), /floating-garden/);
  assert.doesNotMatch(read('toybox/index.html'), /floating-garden/);
});

test('four-player fixtures are deterministic, valid, independent and differently filled', () => {
  const first = tableDemo.createTableDemo();
  const second = tableDemo.createTableDemo();
  assert.deepEqual(first, second);
  assert.deepEqual(first.opponents.map(({ garden }) => engine.scoreGarden(garden).filled), [8, 10, 6]);
  assert.deepEqual(first.opponents.map(({ id }) => id), ['moon', 'forest', 'crystal']);
  first.opponents[0].garden[0].terrain = 'magic';
  assert.equal(second.opponents[0].garden[0].terrain, 'lake');
  assert.notDeepEqual(first.opponents[0].garden, first.opponents[1].garden);
});

test('four-player view keeps one editable garden and three whole-preview buttons', () => {
  const html = view.renderSession(session.createSession(), { table: tableDemo.createTableDemo() });
  assert.equal((html.match(/data-action="cell"/g) || []).length, 16);
  assert.equal((html.match(/data-action="inspect"/g) || []).length, 3);
  assert.equal((html.match(/aria-haspopup="dialog"/g) || []).length, 3);
  assert.equal((html.match(/mini-board/g) || []).length, 3);
  assert.match(html, /手番の例：あなた/);
  assert.match(html, /引いた1枚の例：月光湖/);
  assert.match(html, /固定の見本/);
  assert.match(html, /あなたの庭/);
  assert.match(html, /すべてデモデータ/);
  assert.match(html, /CPU・対戦・通信は動きません/);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => id);
  assert.equal(new Set(ids).size, ids.length);
});

test('mode switching preserves selection, preview, undo history and details', () => {
  const app = mount();
  app.click('terrain-lake'); app.click('cell-0'); app.click('commit');
  app.click('shape-bend'); app.click('rotate'); app.click('cell-1');
  app.root.querySelector('#rules-details').open = true;
  app.root.querySelector('#score-details').open = false;
  const before = app.api.getSession();
  for (let count = 0; count < 3; count += 1) {
    app.click('view-table');
    assert.match(app.root.innerHTML, /table-layout/);
    assert.equal(app.root.ownerDocument.activeElement.dataset.focus, 'view-table');
    assert.deepEqual(app.api.getSession(), before);
    app.click('view-solo');
    assert.doesNotMatch(app.root.innerHTML, /opponent-card/);
    assert.deepEqual(app.api.getSession(), before);
  }
  assert.equal(app.root.querySelector('#rules-details').open, true);
  assert.equal(app.root.querySelector('#score-details').open, false);
  app.click('commit');
  assert.equal(app.api.getSession().garden[1].rotation, 1);
  app.click('undo');
  assert.deepEqual(app.api.getSession().garden, before.garden);
});

test('opening each preview creates a native dialog with only read-only cells', () => {
  const app = mount();
  app.click('view-table');
  for (const opponent of tableDemo.createTableDemo().opponents) {
    app.click(`inspect-${opponent.id}`);
    assert.equal(app.root.querySelector('#garden-comparison').open, true);
    assert.equal(app.root.ownerDocument.activeElement.dataset.focus, 'comparison-close');
    const dialog = app.root.innerHTML.match(/<dialog[\s\S]*<\/dialog>/)[0];
    assert.match(dialog, /aria-labelledby="comparison-title" aria-describedby="comparison-help"/);
    assert.ok(dialog.includes(`${opponent.seat} ${opponent.name}を拡大`));
    assert.equal((dialog.match(/role="img"/g) || []).length, 16);
    assert.doesNotMatch(dialog, /data-action="cell"/);
    app.click('comparison-close');
    assert.equal(app.root.querySelector('#garden-comparison'), null);
    assert.equal(app.root.ownerDocument.activeElement.dataset.focus, `inspect-${opponent.id}`);
  }
});

test('comparison targets and purpose can change without mutating any garden or pending state', () => {
  const app = mount();
  app.click('terrain-lake'); app.click('cell-0'); app.click('commit');
  app.click('stone-moon'); app.click('cell-0');
  app.click('view-table'); app.click('inspect-moon');
  const before = app.api.getSession();
  for (const intent of ['give', 'invite']) {
    app.click(`comparison-mode-${intent}`);
    for (const opponentId of ['forest', 'crystal', 'moon']) {
      app.click(`comparison-player-${opponentId}`);
      const dialog = app.root.innerHTML.match(/<dialog[\s\S]*<\/dialog>/)[0];
      assert.equal((dialog.match(/role="img"/g) || []).length, 32);
      assert.match(dialog, /あなた · P1/);
      assert.match(dialog, /A1の仮置きを含む/);
      assert.match(dialog, /aria-label="A1、月光湖、直線、流れは上と下、月読みの石、仮置き中"/);
      assert.match(dialog, /実際の譲渡・招き・力の消費は行いません/);
      assert.equal(app.root.ownerDocument.activeElement.dataset.focus, `comparison-player-${opponentId}`);
      assert.deepEqual(app.api.getSession(), before);
    }
  }
  app.click('comparison-mode-inspect');
  assert.equal((app.root.innerHTML.match(/<dialog[\s\S]*<\/dialog>/)[0].match(/role="img"/g) || []).length, 16);
  app.click('comparison-close'); app.click('commit');
  assert.equal(app.api.getSession().garden[0].stone, 'moon');
  assert.equal(app.api.getSession().history.length, 2);
});

test('Escape closes comparison first, restores original opener and scrolling, keeps pending placement', () => {
  const app = mount();
  app.click('cell-2'); app.click('view-table');
  app.page.scrollY = 420;
  app.click('inspect-forest');
  assert.equal(app.root.ownerDocument.body.style.overflow, 'hidden');
  app.click('comparison-mode-give'); app.click('comparison-player-crystal');
  app.page.scrollY = 17;
  app.escape();
  assert.equal(app.root.querySelector('#garden-comparison'), null);
  assert.equal(app.root.ownerDocument.activeElement.dataset.focus, 'inspect-forest');
  assert.equal(app.root.ownerDocument.body.style.overflow, 'auto');
  assert.equal(app.page.scrollY, 420);
  assert.equal(app.api.getSession().pending.index, 2);
  app.escape();
  assert.equal(app.api.getSession().pending, null);
});

test('native dialog cancel, repeated opening and unmount release the page lock', () => {
  const app = mount();
  app.click('view-table');
  for (let count = 0; count < 3; count += 1) {
    app.click('inspect-moon'); app.dialogCancel();
    assert.equal(app.root.querySelector('#garden-comparison'), null);
    assert.equal(app.root.ownerDocument.body.style.overflow, 'auto');
    assert.equal(app.root.ownerDocument.activeElement.dataset.focus, 'inspect-moon');
  }
  app.click('inspect-crystal');
  app.api.unmount();
  assert.equal(app.root.querySelector('#garden-comparison').open, false);
  assert.equal(app.root.ownerDocument.body.style.overflow, 'auto');
  app.click('cell-0');
  assert.equal(app.api.getSession().pending, null);
});

test('background editing and replacement actions are ignored while comparison is open', () => {
  const app = mount();
  app.click('cell-0'); app.click('commit'); app.click('cell-1');
  app.click('reset'); app.click('view-table');
  app.click('inspect-moon');
  const before = app.api.getSession();
  for (const action of ['cell-4', 'commit', 'terrain-magic', 'replace-confirm', 'view-solo']) app.click(action);
  assert.deepEqual(app.api.getSession(), before);
  assert.ok(app.root.querySelector('#garden-comparison').open);
  app.escape();
  assert.match(app.root.innerHTML, /id="replace-title"/);
  app.escape();
  assert.doesNotMatch(app.root.innerHTML, /id="replace-title"/);
  assert.deepEqual(app.api.getSession(), before);
});

test('comparison score uses current self preview and exposes no action to give, invite or spend', () => {
  let state = session.createSession();
  state = session.updateSession(state, { type: 'select-tile', terrain: 'lake' }).session;
  state = session.updateSession(state, { type: 'preview', index: 0 }).session;
  state = session.updateSession(state, { type: 'commit' }).session;
  state = session.updateSession(state, { type: 'select-stone', stone: 'moon' }).session;
  state = session.updateSession(state, { type: 'preview', index: 0 }).session;
  const before = structuredClone(state);
  const html = view.renderComparison(state, tableDemo.createTableDemo(), { opponentId: 'forest', intent: 'give' });
  assert.match(html, /あなた · P1<\/h3><span>2点 · 1\/16/);
  assert.deepEqual(state, before);
  assert.doesNotMatch(html, /data-action="(?:give|invite|spend|commit|cell)"/);
  assert.equal(view.renderComparison(state, tableDemo.createTableDemo(), { opponentId: 'missing', intent: 'give' }), '');
});

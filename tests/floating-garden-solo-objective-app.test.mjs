// Event-handler integration with an isolated DOM/storage test double; not browser rendering.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as engine from '../floating-garden/engine.js';
import * as match from '../floating-garden/match-engine.js';
import * as cpu from '../floating-garden/cpu.js';
import * as view from '../floating-garden/match-view.js';
import * as save from '../floating-garden/match-save.js';
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
  const source = read('floating-garden/match-app.js').replace(/^import[^\n]*\n/gm, '').replace('export function mountMatch', 'function mountMatch').replace(/const root = document\.querySelector[\s\S]*$/, '');
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

function testStore(initial = null) {
  let raw = initial;
  return { available: true, read() { return raw === null ? { status: 'empty', raw } : { status: 'valid', raw, snapshot: save.decodeMatchSave(raw) }; },
    async acquire() { return 'acquired'; }, write(expected, next) { if (expected !== raw) return { status: 'conflict' }; raw = next; return { status: 'saved', raw }; }, release() {}, raw: () => raw };
}
function seedFor(id) { for (let n = 0; n < 1000; n++) if (engine.selectObjectiveId(`app-${n}`) === id) return `app-${n}`; throw Error('No deterministic seed'); }

for (const id of engine.OBJECTIVE_IDS) test(`application: ${id} start, assist, preview, cancel, compare, commit and resume stay consistent`, async () => {
  const store = testStore(), seed = seedFor(id);
  const app = mount({ seed, saveStore: store }); app.click('count-2'); await app.click('start');
  assert.equal(app.api.getState().objective.id, id);
  assert.match(app.root.innerHTML, new RegExp(`data-shared-objective="${id}"`));
  app.click('toggle-assist'); assert.equal(app.api.getUi().assist, true);
  toHumanPlace(app);
  const before = app.api.getState(), oldRaw = store.raw();
  app.click('cell-5'); app.click('rotate');
  assert.deepEqual(app.api.getState(), before);
  assert.equal(store.raw(), oldRaw);
  assert.match(app.root.innerHTML, /data-objective-preview="true"/);
  assert.match(app.root.innerHTML, /確定済み:/);
  app.click('cancel'); assert.equal(app.api.getUi().pending, null); assert.deepEqual(app.api.getState(), before);
  app.click('cell-5'); app.click('inspect-1');
  assert.match(app.root.innerHTML, /data-objective-preview="true"/);
  app.click('comparison-close'); assert.equal(app.api.getUi().pending.index, 5);
  app.click('commit'); const committed = app.api.getState();
  assert.equal(committed.revision, before.revision + 1);
  assert.deepEqual(save.decodeMatchSave(store.raw()).state, committed);
  const saved = store.raw(); app.api.unmount();
  const resumed = mount({ seed: 'another-start-seed', saveStore: store }); await resumed.click('resume');
  assert.deepEqual(resumed.api.getState(), committed);
  assert.equal(resumed.api.getUi().pending, null);
  assert.equal(resumed.api.getUi().assist, true);
  assert.equal(store.raw(), saved, 'resume alone does not rewrite save or run CPU');
  resumed.api.unmount();
});

test('application: opening and resuming a legacy v1 save leaves its bytes, version and corner rule unchanged', async () => {
  const old = match.createMatch({ seed: 'old-app', playerCount: 2, legacy: true });
  const raw = save.encodeMatchSave({ state: old, actions: [], savedAt: 1792720800000 });
  const store = testStore(raw), app = mount({ saveStore: store });
  assert.equal(store.raw(), raw); await app.click('resume');
  assert.deepEqual(app.api.getState(), old); assert.equal(store.raw(), raw);
  assert.equal(app.api.getState().objective, undefined);
  assert.match(app.root.innerHTML, /旧ルールで保存した試合/);
  assert.match(app.root.innerHTML, /data-shared-objective="corners"/);
  app.api.unmount();
});

test('application: cancelling replacement retains the previous objective and exact save', async () => {
  const old = match.createMatch({ seed: seedFor('flow-chain'), playerCount: 2 });
  const raw = save.encodeMatchSave({ state: old, actions: [], savedAt: 1792720800000 });
  const store = testStore(raw), app = mount({ seed: seedFor('terrain-cluster'), saveStore: store });
  await app.click('start'); assert.equal(app.api.getState(), null);
  app.click('cancel-reset'); assert.equal(store.raw(), raw);
  await app.click('resume'); assert.deepEqual(app.api.getState(), old); assert.equal(store.raw(), raw);
  app.api.unmount();
});

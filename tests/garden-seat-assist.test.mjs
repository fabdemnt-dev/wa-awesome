import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeatAssist } from '../floating-garden/limited-trial/online/seat-assist.js';
function fixture() {
  const state = { uid: 'u', self: { seat: 0 }, room: { id: 'r', gameId: 'g', status: 'playing', playerCount: 2, humanSeatCount: 2, npcCount: 0, match: { revision: 0, phase: 'normal', step: 'source', players: [{ isHuman: true }, { isHuman: true }] } }, connection: 'ready', canConfirm: true, busy: false, pending: null, error: false, storageIssue: null, terminal: null, ui: { rotation: 0, stone: null, pending: null, comparison: null, returnConfirm: false } };
  const timers = new Map(), nodes = new Map(); let n = 0, clicked = 0, handler = () => {}, waiting = false;
  const doc = { visibilityState: 'visible', defaultView: { getComputedStyle: () => ({ visibility: 'visible' }) } };
  const button = { dataset: { action: 'command-draw', revision: '0', epoch: '1' }, disabled: false, hidden: false, closest: () => null, getClientRects: () => [1], click() { clicked++; handler(); } };
  const root = { ownerDocument: doc, isConnected: true, inert: false, closest: () => null, contains: b => b === button, querySelector(selector) { if (selector === '#online-controls .waiting-label') return waiting ? {} : null; if (selector === '#online-controls [data-action="command-draw"]') return button; if (!nodes.has(selector)) nodes.set(selector, {}); return nodes.get(selector); }, querySelectorAll: () => [] };
  const assist = createSeatAssist({ root, getState: () => state, getEpoch: () => 1, setTimer(fn) { timers.set(++n, fn); return n; }, clearTimer: id => timers.delete(id) });
  return { assist, state, root, doc, button, timers, set handler(fn) { handler = fn; }, set waiting(value) { waiting = value; }, get clicked() { return clicked; }, tick() { const item = timers.entries().next().value; if (item) { timers.delete(item[0]); item[1](); } } };
}
test('explicit start only, repeated updates use one timer, immediate stop cancels', () => {
  const f = fixture(); f.assist.update(); assert.equal(f.timers.size, 0);
  assert.equal(f.assist.start(), true); assert.equal(f.assist.start(), false);
  for (let i = 0; i < 20; i++) f.assist.update(); assert.equal(f.timers.size, 1);
  f.assist.stop(); f.tick(); assert.equal(f.clicked, 0); assert.equal(f.timers.size, 0);
});
test('synchronous pending publish and delayed own flight wait without duplicates', async () => {
  const f = fixture(); let done;
  f.handler = () => { f.state.pending = {}; f.state.busy = true; f.state.connection = 'syncing'; f.state.canConfirm = false; f.assist.update(); f.assist.track(new Promise(r => { done = r; })); };
  f.assist.start(); f.tick(); assert.equal(f.clicked, 1); assert.equal(f.assist.running, true); assert.equal(f.timers.size, 0);
  f.assist.update(); f.tick(); assert.equal(f.clicked, 1);
  f.assist.stop(); Object.assign(f.state, { pending: null, busy: false, connection: 'ready', canConfirm: true }); done(true);
  await new Promise(r => setImmediate(r)); assert.equal(f.assist.running, false); assert.equal(f.timers.size, 0);
});
for (const [name, change] of [
  ['uncertain', f => { f.state.connection = 'uncertain'; }],
  ['offline', f => { f.state.connection = 'offline'; }],
  ['cache', f => { f.state.connection = 'cache'; }],
  ['error', f => { f.state.error = true; }],
  ['storage failure', f => { f.state.storageIssue = 'failure'; }],
  ['pending recovery', f => { f.state.pending = {}; f.state.busy = true; f.state.connection = 'syncing'; }],
  ['hidden', f => { f.doc.visibilityState = 'hidden'; }],
  ['seat change', f => { f.state.self.seat = 1; }],
  ['identity change', f => { f.state.uid = 'other'; }],
  ['room change', f => { f.state.room.id = 'other'; }],
  ['game change', f => { f.state.room.gameId = 'other'; }],
  ['finished', f => { f.state.room.status = 'finished'; }],
  ['comparison', f => { f.state.ui.comparison = { seat: 1 }; }],
  ['detached root', f => { f.root.isConnected = false; }],
]) test(`${name} stops active helper and does not send`, () => { const f = fixture(); f.assist.start(); change(f); f.assist.update(); f.tick(); assert.equal(f.assist.running, false); assert.equal(f.clicked, 0); assert.equal(f.timers.size, 0); });
test('pending on entry cannot start', () => { const f = fixture(); f.state.pending = {}; assert.equal(f.assist.start(), false); assert.equal(f.timers.size, 0); });
for (const key of ['epoch', 'revision']) test(`old ${key} cannot click`, () => { const f = fixture(); f.button.dataset[key] = '-1'; f.assist.start(); f.tick(); assert.equal(f.clicked, 0); f.assist.dispose(); });
test('opponent wait and disabled button do not click', () => { const f = fixture(); f.waiting = true; f.assist.start(); f.tick(); assert.equal(f.clicked, 0); assert.equal(f.assist.running, true); f.waiting = false; f.button.disabled = true; f.tick(); assert.equal(f.clicked, 0); f.assist.dispose(); });
test('dispose and an already-captured callback cannot resume', () => { const f = fixture(); f.assist.start(); const fn = [...f.timers.values()][0]; f.assist.dispose(); fn(); assert.equal(f.clicked, 0); assert.equal(f.assist.start(), false); });
for (const value of [false, undefined]) test(`rejected synchronous click (${value}) stops without timer`, () => {
  const f = fixture(); f.handler = () => f.assist.track(value); f.assist.start(); f.tick();
  assert.equal(f.clicked, 1); assert.equal(f.assist.running, false); assert.equal(f.timers.size, 0);
});

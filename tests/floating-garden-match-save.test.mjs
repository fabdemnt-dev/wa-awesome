import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatch, applyMatchAction, legalActions, publicMatch } from '../lab/floating-garden/match-engine.js';
import { SAVE_KEY, SAVE_VERSION, decodeMatchSave, encodeMatchSave, createMatchSaveStore } from '../lab/floating-garden/match-save.js';
import { memoryEnvironment, savedFixture, saveScenarios, settleLocks } from './helpers/floating-garden-save.mjs';

const scenarios = saveScenarios();
test('save/load retains every rules field across every phase, rare decisions and replacement/storage paths', () => {
  const steps = new Set(); const phases = new Set(); const sources = new Set();
  for (const { state, actions } of scenarios) {
    steps.add(state.step); phases.add(state.phase); if (state.drawn) sources.add(state.drawn.source);
    const before = structuredClone(state);
    const text = savedFixture(state, actions, true);
    const loaded = decodeMatchSave(text);
    assert.deepEqual(loaded.state, state); assert.deepEqual(loaded.actions, actions); assert.equal(loaded.assist, true);
    assert.deepEqual(state, before, 'save/load is non-mutating');
    const action = legalActions(state)[0];
    if (action) assert.deepEqual(applyMatchAction(loaded.state, action), applyMatchAction(state, action));
    for (const key of ['seed', 'deck', 'deckCursor']) assert.ok(!Object.hasOwn(publicMatch(loaded.state), key));
  }
  for (const step of ['source', 'choose', 'offer-response', 'invite-response', 'welcome', 'place', 'care', 'final-stone', 'finished']) assert.ok(steps.has(step), step);
  for (const phase of ['normal', 'finishing', 'final-stone', 'finished']) assert.ok(phases.has(phase), phase);
  for (const source of ['draw', 'storage', 'storage-swap', 'replacement', 'finishing']) assert.ok(sources.has(source), source);
});

test('strict decoder rejects malformed, oversized, incompatible and tampered snapshots without partial repair', () => {
  const text = savedFixture(createMatch());
  for (const invalid of ['', '{', 'null', '[]', '{}', ' '.repeat(1000001)]) assert.throws(() => decodeMatchSave(invalid));
  const mutate = (fn) => { const value = JSON.parse(text); fn(value); return JSON.stringify(value); };
  for (const fn of [
    (v) => { v.version = 'old'; }, (v) => { v.matchVersion = 'future'; },
    (v) => { v.extra = 1; }, (v) => { delete v.state; }, (v) => { v.assist = 'false'; },
    (v) => { v.savedAt = -1; }, (v) => { v.saveRevision = 0.5; },
    (v) => { v.state.seed = 'a'.repeat(257); }, (v) => { v.state.phase = 'finished'; },
    (v) => { v.state.activeSeat = 999; }, (v) => { v.state.step = 'unknown'; },
    (v) => { v.state.players[0].power = 99; }, (v) => { v.state.players[0].isHuman = false; },
    (v) => { v.state.players[1].isHuman = true; }, (v) => { v.state.players[0].name = '<script>'; },
    (v) => { v.state.deck.reverse(); }, (v) => { v.state.deck[1] = v.state.deck[0]; },
    (v) => { v.state.players[0].garden[0] = v.state.deck[0]; }, (v) => { v.state.log.push('invented'); },
    (v) => { v.state.unknown = 1; }, (v) => { v.actions = [{}]; },
    (v) => { v.actions = Array(2001).fill({}); },
  ]) assert.throws(() => decodeMatchSave(mutate(fn)), fn.toString());
  const action = legalActions(createMatch())[0];
  assert.throws(() => decodeMatchSave(mutate((v) => { v.actions = [action]; })));
  assert.throws(() => decodeMatchSave(mutate((v) => { v.actions = [{ ...action, extra: 'injected' }]; })));
  const permuted = JSON.parse(text); permuted.state = Object.fromEntries(Object.entries(permuted.state).reverse());
  assert.deepEqual(decodeMatchSave(JSON.stringify(permuted)).state, createMatch(), 'key order is irrelevant');
});

test('one-tab lock and compare-before-write stop concurrent or stale overwrites', async () => {
  const env = memoryEnvironment(); const a = env.store(); const b = env.store();
  assert.equal(await a.acquire(), 'acquired'); assert.equal(await b.acquire(), 'busy');
  const text = savedFixture(createMatch());
  assert.equal(a.write(null, text).status, 'saved'); assert.equal(b.write(null, text).status, 'unavailable');
  assert.equal(a.write(null, text + ' ').status, 'conflict'); assert.equal(env.raw(), text);
  a.release(); await settleLocks(); assert.equal(await b.acquire(), 'acquired');
  assert.equal(b.write(text, text + ' ').status, 'saved'); b.release();
});

test('read failures, corrupt/old saves, quota failures and unavailable locks leave the existing bytes alone', async () => {
  for (const initial of ['{', JSON.stringify({ version: 'old' }), savedFixture(createMatch())]) {
    const env = memoryEnvironment(initial); const store = env.store();
    assert.equal(store.read().status, initial.startsWith('{"version":"' + SAVE_VERSION) ? 'valid' : 'invalid');
    assert.equal(env.raw(), initial);
    await store.acquire(); env.faults.write = true;
    assert.equal(store.write(initial, 'replacement').status, 'failed'); assert.equal(env.raw(), initial);
    env.faults.read = true; assert.equal(store.read().status, 'unavailable'); assert.equal(env.raw(), initial);
    store.release();
  }
  const env = memoryEnvironment('untouched'); const unsupported = createMatchSaveStore({ storage: env.storage });
  assert.equal(await unsupported.acquire(), 'unavailable'); assert.equal(unsupported.write('untouched', 'new').status, 'unavailable');
  assert.equal(env.raw(), 'untouched');
  const rejected = createMatchSaveStore({ storage: env.storage, locks: { request() { return Promise.reject(new Error('denied')); } } });
  assert.equal(await rejected.acquire(), 'unavailable'); assert.equal(env.raw(), 'untouched');
});

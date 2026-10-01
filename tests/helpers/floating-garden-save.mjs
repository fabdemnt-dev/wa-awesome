import { createMatch, applyMatchAction, legalActions } from '../../lab/floating-garden/match-engine.js';
import { SAVE_KEY, createMatchSaveStore, encodeMatchSave } from '../../lab/floating-garden/match-save.js';

export function savedFixture(state, actions = [], assist = false) {
  return encodeMatchSave({ state, actions, assist, savedAt: 1790870400000, saveRevision: 1 });
}
export function memoryEnvironment(initial = null) {
  const values = new Map(initial === null ? [] : [[SAVE_KEY, initial]]);
  const faults = { read: false, write: false };
  const storage = { getItem(key) { if (faults.read) throw new Error('denied'); return values.get(key) ?? null; }, setItem(key, value) { if (faults.write) throw new Error('quota'); values.set(key, value); } };
  let held = false;
  const locks = { request(name, options, callback) {
    if (held) return Promise.resolve(callback(null));
    held = true;
    return Promise.resolve(callback({ name })).finally(() => { held = false; });
  } };
  return { storage, locks, faults, values, store: () => createMatchSaveStore({ storage, locks }), raw: () => values.get(SAVE_KEY) ?? null };
}
export const settleLocks = () => new Promise((resolve) => setImmediate(resolve));

/** Legal paths only, including rare proposal, exchange and endgame continuations. */
export function saveScenarios() {
  const found = new Map();
  for (const count of [2, 3, 4]) {
    for (let seed = 1; seed <= 12; seed += 1) {
      let random = seed * 71;
      let state = createMatch({ playerCount: count, seed: `save-scenarios-${count}-${seed}` });
      let actions = [];
      while (state.phase !== 'finished') {
        const key = `${state.phase}/${state.step}/${state.drawn?.source || '-'}/${state.afterPlacement || '-'}`;
        if (!found.has(key)) found.set(key, { state, actions });
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        const legal = legalActions(state);
        const action = legal[random % legal.length];
        state = applyMatchAction(state, action); actions = [...actions, action];
      }
      found.set(`finished-${count}`, { state, actions });
    }
  }
  return [...found.values()];
}

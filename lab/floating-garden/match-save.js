/** Local-only CPU match snapshots. No DOM, network, or rule changes. */
import { MATCH_VERSION, createMatch, applyMatchAction } from './match-engine.js?v=20261002-match-save';

export const SAVE_KEY = 'floating-garden-cpu-match';
export const SAVE_LOCK = 'floating-garden-cpu-match-writer';
export const SAVE_VERSION = 'floating-garden-save-1';
export const MAX_SAVE_CHARS = 1000000;
const MAX_ACTIONS = 2000;
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
function equal(a, b) {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((value, index) => equal(value, b[index]));
  return object(a) && object(b) && exactKeys(b, Object.keys(a)) && Object.keys(a).every((key) => equal(a[key], b[key]));
}

/** Save only committed rules state plus assist. Previews/selections/modals are deliberately transient. */
export function encodeMatchSave({ state, actions, assist = false, saveRevision = 0, savedAt = Date.now() }) {
  const text = JSON.stringify({ version: SAVE_VERSION, matchVersion: MATCH_VERSION, saveRevision, savedAt, state, actions, assist });
  if (text.length > MAX_SAVE_CHARS) fail('too-large', '保存できる大きさを超えました');
  return text;
}

/** Replay the exact legal command history; reject unknown fields and impossible state, not merely malformed JSON. */
export function decodeMatchSave(text) {
  if (typeof text !== 'string' || text.length > MAX_SAVE_CHARS) fail('too-large', '保存データの大きさを確認できません');
  let value;
  try { value = JSON.parse(text); } catch { fail('invalid-json', '保存データを読み取れません'); }
  if (!object(value) || value.version !== SAVE_VERSION || value.matchVersion !== MATCH_VERSION) fail('old-version', 'この版では読み込めない保存データです');
  if (!exactKeys(value, ['version', 'matchVersion', 'saveRevision', 'savedAt', 'state', 'actions', 'assist']) || !Number.isSafeInteger(value.saveRevision) || value.saveRevision < 0 || !Number.isSafeInteger(value.savedAt) || value.savedAt < 0 || value.savedAt > 8640000000000000 || typeof value.assist !== 'boolean') fail('invalid-save', '保存データの形式が正しくありません');
  if (!object(value.state) || typeof value.state.seed !== 'string' || value.state.seed.length > 256 || !Array.isArray(value.state.players) || ![2, 3, 4].includes(value.state.players.length) || !Array.isArray(value.actions) || value.actions.length > MAX_ACTIONS) fail('invalid-save', '保存された対戦を確認できません');
  let state;
  try {
    state = createMatch({ playerCount: value.state.players.length, seed: value.state.seed, humanSeat: 0 });
    for (const action of value.actions) state = applyMatchAction(state, action);
  } catch { fail('invalid-history', '保存された手順を安全に再開できません'); }
  if (!equal(state, value.state)) fail('invalid-state', '保存された盤面と手順が一致しません');
  return { ...value, state };
}

/** One origin-wide writer for the lifetime of an open match; unsupported storage/locks never silently overwrite. */
export function createMatchSaveStore({ storage, locks } = {}) {
  let release = null;
  let acquiring = false;
  const read = () => {
    let raw;
    try { if (!storage) throw new Error(); raw = storage.getItem(SAVE_KEY); }
    catch { return { status: 'unavailable', raw: null, message: 'このブラウザーでは保存を利用できません' }; }
    if (raw === null) return { status: 'empty', raw };
    try { return { status: 'valid', raw, snapshot: decodeMatchSave(raw) }; }
    catch (error) { return { status: 'invalid', raw, message: error.message }; }
  };
  function acquire() {
    if (release) return Promise.resolve('acquired');
    if (acquiring) return Promise.resolve('busy');
    if (!storage || typeof locks?.request !== 'function') return Promise.resolve('unavailable');
    acquiring = true;
    return new Promise((resolve) => {
      let reported = false;
      const report = (status) => { if (!reported) { reported = true; acquiring = false; resolve(status); } };
      try {
        Promise.resolve(locks.request(SAVE_LOCK, { mode: 'exclusive', ifAvailable: true }, (lock) => {
          if (!lock) { report('busy'); return undefined; }
          return new Promise((unlock) => { release = () => { release = null; unlock(); }; report('acquired'); });
        })).catch(() => report('unavailable'));
      } catch { report('unavailable'); }
    });
  }
  function write(expectedRaw, text) {
    if (!release) return { status: 'unavailable' };
    try {
      if (storage.getItem(SAVE_KEY) !== expectedRaw) return { status: 'conflict' };
      storage.setItem(SAVE_KEY, text);
      if (storage.getItem(SAVE_KEY) !== text) return { status: 'conflict' };
      return { status: 'saved', raw: text };
    } catch { return { status: 'failed' }; }
  }
  return { read, acquire, write, release: () => release?.(), get available() { return Boolean(storage && typeof locks?.request === 'function'); } };
}

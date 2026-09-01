import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const roomSource = readFileSync(new URL('../poem-room.js', import.meta.url), 'utf8');
const actionSource = readFileSync(new URL('../poem-action.js', import.meta.url), 'utf8');
function between(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return source.slice(a, b);
}
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function syncHarness(getDocFromServer) {
  const applied = [];
  const errors = [];
  const button = {};
  const context = vm.createContext({
    window: {}, state: { roomRef: {} }, getDocFromServer,
    console: { warn() {} }, document: { getElementById: () => button },
    showGameError: error => errors.push(error),
    applied,
  });
  vm.runInContext(`let roomUpdateSequence = 0; let last = 0;
    function applyRoomData(data, sequence = ++roomUpdateSequence) {
      if (sequence < last) return; last = sequence; applied.push(data);
    }
    ${between(roomSource, 'let roomResyncPromise', '\nwindow.resyncPoemRoom')}
    window.resync = resyncRoomFromFirestore;
    window.historyUpdate = () => applyRoomData('history');
    ${between(roomSource, 'window.manualResync =', '\nexport const SAMPLE_PHRASES')}`, context);
  return { ...context, applied, errors, button };
}
test('履歴の再描画が取得中に入っても、取得成功したルームを反映する', async () => {
  const pending = deferred();
  const h = syncHarness(() => pending.promise);
  const work = h.window.resync();
  h.window.historyUpdate();
  pending.resolve({ exists: () => true, data: () => 'server' });
  assert.equal((await work).ok, true);
  assert.deepEqual(h.applied, ['history', 'server']);
});
test('手動更新失敗を通知してボタンを復帰する', async () => {
  const error = new Error('offline');
  const h = syncHarness(async () => { throw error; });
  await h.window.manualResync('lobby');
  assert.deepEqual(h.errors, [error]);
  assert.equal(h.button.disabled, false);
  assert.equal(h.applied.length, 0);
});
test('キャッシュからサーバー確認済みへの通知で定期取得を待たず反映する', () => {
  let listener, options;
  const applied = [];
  const context = vm.createContext({
    state: { roomRef: {} }, roomUpdateSequence: 0,
    onSnapshot: (_ref, opts, callback) => { options = opts; listener = callback; },
    applyRoomData: data => applied.push(data), console, resyncRoomFromFirestore() {},
  });
  vm.runInContext(between(roomSource, '    onSnapshot(state.roomRef', '\n    startRoomResyncPolling();'), context);
  const emit = fromCache => listener({ exists: () => true, data: () => 'playing', metadata: { fromCache } });
  emit(true);
  assert.deepEqual(applied, []);
  if (options.includeMetadataChanges) emit(false);
  assert.deepEqual(applied, ['playing']);
});
test('繰り返し画面更新しても入力1回につき保存とサイズ調整は1回だけ', () => {
  const handlers = new Set();
  let saves = 0, measurements = 0;
  const textarea = {
    value: 'draft', style: {},
    get scrollHeight() { measurements++; return 80; },
    removeEventListener: (_event, fn) => handlers.delete(fn),
    addEventListener: (_event, fn) => handlers.add(fn),
  };
  const context = vm.createContext({
    document: { getElementById: () => textarea },
    sessionStorage: { getItem: () => null, setItem: () => { saves++; } },
  });
  vm.runInContext(between(actionSource, 'export function setupAutoResize', '\nwindow.onCardClick').replace('export ', ''), context);
  for (let i = 0; i < 100; i++) context.setupAutoResize();
  for (const fn of handlers) fn.call(textarea);
  assert.equal(saves, 1);
  assert.equal(measurements, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const roomSource = readFileSync(new URL('../poem-room.js', import.meta.url), 'utf8');
const actionSource = readFileSync(new URL('../poem-action.js', import.meta.url), 'utf8');

test('履歴はキャッシュ後のサーバー確認通知で反映し、購読エラーも渡す', () => {
  const source = readFileSync(new URL('../room-history.js', import.meta.url), 'utf8');
  let options, receive, fail;
  const context = vm.createContext({
    collection: () => ({}), orderBy: () => ({}), query: () => ({}),
    onSnapshot: (_q, opts, callback, error) => { options = opts; receive = callback; fail = error; return 'unsubscribe'; },
  });
  vm.runInContext(source.slice(source.indexOf('export function subscribeRoomHistory')).replaceAll('export ', ''), context);
  const received = [], errors = [];
  assert.equal(context.subscribeRoomHistory({}, x => received.push(x), e => errors.push(e)), 'unsubscribe');
  assert.equal(options.includeMetadataChanges, true);
  const docs = [{ id: 'round_1', data: () => ({ round: 1, poems: { u: '作品' } }) }];
  receive({ metadata: { fromCache: true }, docs });
  assert.equal(received.length, 0);
  receive({ metadata: { fromCache: false }, docs });
  assert.equal(received[0][0].poems.u, '作品');
  const error = new Error('offline'); fail(error); assert.equal(errors[0], error);
});

test('ポエムCSVは引用符・改行・#を保持し、コピーの範囲と失敗通知を保つ', async () => {
  const source = readFileSync(new URL('../poem-export.js', import.meta.url), 'utf8');
  const data = { roundCount: 2, participantUids: { u: '名"前,さん' }, poems: { u: { text: '本文#1\n"引用",続き' } }, history: [{ round: 1, poems: { old: '過去作' } }] };
  let blob, copied, removed = 0, revoked = 0, failCopy = false;
  const attrs = {}, notices = [], timers = [];
  const context = vm.createContext({ Blob,
    getParticipantNameByUid: (d, k) => d.participantUids?.[k],
    URL: { createObjectURL: b => { blob = b; return 'blob:download'; }, revokeObjectURL: () => { revoked++; } },
    document: { createElement: () => ({ setAttribute: (k,v) => { attrs[k] = v; }, click() {} }), body: { appendChild() {}, removeChild() { removed++; } } },
    navigator: { clipboard: { writeText: async text => { if (failCopy) throw new Error('拒否'); copied = text; } } },
    alert: x => notices.push(x), setTimeout: fn => timers.push(fn),
  });
  vm.runInContext(source.replace(/^import[^\n]*\n/, '').replaceAll('export ', ''), context);
  context.exportPoemCSV(data, 'room', false);
  assert.equal(attrs.href, 'blob:download');
  assert.equal(Buffer.from(await blob.arrayBuffer()).toString('utf8'), '\uFEFF幕,作者,作品\n"2","名""前,さん","本文#1\n""引用"",続き"\n');
  assert.equal(removed, 1); timers[0](); assert.equal(revoked, 1);
  await context.exportPoemText(data, false); assert.ok(!copied.includes('過去作')); assert.ok(copied.includes('本文#1'));
  await context.exportPoemText(data, true); assert.ok(copied.includes('過去作'));
  failCopy = true; await context.exportPoemText(data, false); assert.match(notices.at(-1), /コピーに失敗/);
});

test('リアクションはラベルを保ち、送信中の二重送信を防ぎ、失敗を通知側へ伝える', async () => {
  for (const type of ['like', 'emo']) {
    for (const schemaVersion of [1, 2]) {
      const pending = deferred();
      let calls = 0;
      let fail = false;
      const send = async () => { calls++; if (fail) throw new Error('通信失敗'); await pending.promise; };
      const context = vm.createContext({
        window: { resyncPoemRoom: async () => ({ ok: true }) },
        state: { roomId: 'room', roomRef: {}, currentData: { schemaVersion, poems: { u: {} } } },
        getParticipantUidByName: () => 'u', reactPoemSecure: send, updateDoc: send, increment: n => n,
      });
      vm.runInContext(between(actionSource, 'const pendingReactions', '\nwindow.exportText'), context);
      const button = { innerText: 'リアクション (1)', disabled: false, setAttribute(k,v) { this[k] = v; }, removeAttribute(k) { delete this[k]; } };
      const first = context.window.addReaction('name', type, button);
      assert.equal(button.innerText, 'リアクション (1)');
      assert.equal(button.disabled, true);
      assert.equal(button['aria-busy'], 'true');
      await context.window.addReaction('name', type, { ...button }); // 再描画されたボタンでも重複させない
      assert.equal(calls, 1);
      pending.resolve(); await first;
      assert.equal(button.disabled, false);
      assert.equal(button['aria-busy'], undefined);
      fail = true;
      await assert.rejects(context.window.addReaction('name', type, button), /通信失敗/);
      assert.equal(button.disabled, false);
      fail = false;
      await context.window.addReaction('name', type, button);
      assert.equal(calls, 3);
    }
  }
});

test('いいねとエモいは共通の処理中表示から除外する', () => {
  const source = readFileSync(new URL('../poem-render.js', import.meta.url), 'utf8');
  const buttons = source.match(/<button[^>]*onclick="addReaction[^>]*>/g);
  assert.equal(buttons.length, 2);
  for (const button of buttons) assert.match(button, /data-no-busy-feedback="true"/);
});
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
    applied, setTimeout, clearTimeout,
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
    getParticipantStorageKey: () => 'user',
    state: { roomId: 'room', myUid: 'user', currentData: { status: 'playing', roundCount: 1 }, selectedHandIndices: new Set() },
    sessionStorage: { getItem: () => null, removeItem() {}, setItem: key => { if (key === 'poemDraft') saves++; } },
  });
  vm.runInContext(between(actionSource, 'let draftContext', '\nwindow.onCardClick').replaceAll('export ', ''), context);
  for (let i = 0; i < 100; i++) context.setupAutoResize();
  measurements = 0;
  for (const fn of handlers) fn.call(textarea);
  assert.equal(saves, 1);
  assert.equal(measurements, 1);
});

test('復帰時は停止中の取得を待たず、遅れて返ったロビーで画面を戻さない', async () => {
  const old = deferred();
  let calls = 0;
  const h = syncHarness(() => ++calls === 1 ? old.promise : Promise.resolve({ exists: () => true, data: () => 'playing' }));
  const oldWork = h.window.resync();
  assert.equal((await h.window.resync({ fresh: true })).ok, true);
  assert.deepEqual(h.applied, ['playing']);
  old.resolve({ exists: () => true, data: () => 'lobby' });
  assert.equal((await oldWork).superseded, true);
  assert.deepEqual(h.applied, ['playing']);
});

test('下書きは同じ部屋・本人・回で保持し、別の回や部屋へ持ち越さない', () => {
  const storage = new Map();
  const textarea = { value: '', style: {} };
  const state = { roomId: 'A', myUid: 'u1', currentData: { status: 'playing', roundCount: 1 }, selectedHandIndices: new Set([0]) };
  function create() {
    const context = vm.createContext({ state, getParticipantStorageKey: () => state.myUid, document: { getElementById: () => textarea }, sessionStorage: {
      getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k),
    } });
    vm.runInContext(between(actionSource, 'let draftContext', '\nwindow.onCardClick').replaceAll('export ', ''), context);
    return context;
  }
  let h = create();
  h.syncPoemDraftContext(); h.savePoemDraft('未投稿'); textarea.value = '未投稿';
  h.syncPoemDraftContext(); assert.equal(textarea.value, '未投稿');
  h = create(); textarea.value = ''; h.syncPoemDraftContext(); assert.equal(textarea.value, '未投稿');
  state.currentData.roundCount = 2; state.selectedHandIndices.add(0); h.syncPoemDraftContext();
  assert.equal(textarea.value, ''); assert.equal(state.selectedHandIndices.size, 0);
  h.savePoemDraft('2回目'); state.roomId = 'B'; h.syncPoemDraftContext(); assert.equal(textarea.value, '');
  h.savePoemDraft('Bの下書き'); state.myUid = 'u2'; h.syncPoemDraftContext(); assert.equal(textarea.value, '');
});

test('見学中は作成欄だけを隠し、復帰で本文と選択を復元する', () => {
  const storage = new Map();
  const elements = new Map();
  const textarea = { value: '', style: {}, scrollHeight: 80, addEventListener() {}, removeEventListener() {} };
  elements.set('poem-input-area', textarea);
  for (const id of ['hand-list', 'poem-composer', 'poem-spectator-notice', 'poem-clear-btn', 'poem-submit-btn', 'board-list']) elements.set(id, {});
  const state = { roomId: 'A', myUid: 'u', isSpectator: false, currentData: { status: 'playing', roundCount: 1, hands: { u: [{ id: 'card', text: '札' }] }, poems: {} }, selectedHandIndices: new Set() };
  const context = vm.createContext({ state, document: { getElementById: id => elements.get(id) }, getParticipantStorageKey: () => 'u', escapeHTML: x => x,
    sessionStorage: { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) } });
  vm.runInContext(between(actionSource, 'let draftContext', '\nwindow.onCardClick').replaceAll('export ', ''), context);
  const renderSource = readFileSync(new URL('../poem-render.js', import.meta.url), 'utf8');
  vm.runInContext(between(renderSource, 'export function renderHand', '\nexport function renderBoards').replace('export ', ''), context);
  context.syncPoemDraftContext(); textarea.value = '下書き'; state.selectedHandIndices.add(0); context.saveCurrentPoemDraft();
  state.isSpectator = true; context.syncPoemDraftContext(); context.renderHand();
  assert.equal(elements.get('poem-composer').hidden, true);
  assert.equal(elements.get('poem-spectator-notice').hidden, false);
  assert.equal(textarea.value, '下書き');
  assert.equal(elements.get('board-list').hidden, undefined);
  state.isSpectator = false; context.syncPoemDraftContext(); context.renderHand(); context.setupAutoResize();
  assert.equal(elements.get('poem-composer').hidden, false);
  assert.equal(textarea.value, '下書き'); assert.ok(state.selectedHandIndices.has(0));
  assert.equal(textarea.style.height, '80px');
  state.isSpectator = true; state.currentData.roundCount = 2; context.syncPoemDraftContext();
  state.isSpectator = false; context.syncPoemDraftContext(); context.renderHand();
  assert.equal(textarea.value, ''); assert.equal(state.selectedHandIndices.size, 0);
  state.currentData.poems.u = { text: '投稿済み' }; context.syncPoemDraftContext(); context.renderHand();
  assert.equal(elements.get('poem-submit-btn').disabled, true);
  assert.equal(textarea.disabled, true);
});

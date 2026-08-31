import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

function extractBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `開始位置が見つかりません: ${start}`);
  assert.notEqual(endIndex, -1, `終了位置が見つかりません: ${end}`);
  return source.slice(startIndex, endIndex);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function loadAddWordsHarness({ submitImpl }) {
  const source = await fs.readFile(new URL('../haiku-game.js', import.meta.url), 'utf8');
  const implementation = extractBetween(source, 'window.addWords =', '\nwindow.fillDefaultWords');
  const button = { disabled: false, innerText: '素材を提出する', dataset: {}, style: {}, setAttribute() {}, removeAttribute() {} };
  const inputs = new Map([
    ['word-5-input-1', { value: '☆!?ーんっゃABC' }],
    ['word-7-input-1', { value: '七音ではない' }],
    ['add-word-btn', button],
  ]);
  const state = {
    currentData: { schemaVersion: 2, settings: { hand5: 1, hand7: 1 } },
    isSpectator: false,
    isSubmittingWords: false,
    myName: '参加者',
    roomId: 'room',
  };
  const alerts = [];
  let renderCount = 0;
  const window = {};
  const document = { getElementById: (id) => inputs.get(id) || null };
  const setButtonBusy = (target, busy, text) => {
    if (!target) return;
    target.disabled = busy;
    target.innerText = busy ? text : '素材を提出する';
  };
  const consoleMock = { error() {} };
  const install = new Function(
    'window', 'state', 'document', 'alert', 'submitHaikuWords', 'updateDoc', 'arrayUnion',
    'renderInputFields', 'setButtonBusy', 'console',
    implementation,
  );
  install(
    window,
    state,
    document,
    (message) => alerts.push(message),
    submitImpl,
    async () => {},
    (...items) => items,
    () => { renderCount += 1; },
    setButtonBusy,
    consoleMock,
  );
  return { window, state, button, inputs, alerts, getRenderCount: () => renderCount };
}

async function loadSubmitPhraseHarness({ submitImpl, resyncImpl }) {
  const source = await fs.readFile(new URL('../haiku-action.js', import.meta.url), 'utf8');
  const implementation = extractBetween(source, 'function hasSubmittedCurrentPhrase', '\nwindow.revealPhrase');
  const state = {
    currentData: { schemaVersion: 2, roundCount: 1, phrases: {} },
    isSubmittingPhrase: false,
    isSpectator: false,
    submittedPhraseKey: '',
    selectedHand: [
      { id: 'five-a', text: '五ではない', author: '参加者' },
      { id: 'seven-a', text: '七ではない', author: '参加者' },
      { id: 'five-b', text: '記号☆', author: '参加者' },
    ],
    myUid: 'uid-player',
    myName: '参加者',
    roomId: 'room',
  };
  const alerts = [];
  let refreshCount = 0;
  const window = {};
  if (resyncImpl) window.resyncHaikuRoom = resyncImpl;
  const consoleMock = { error() {} };
  const install = new Function(
    'window', 'state', 'alert', 'getParticipantStorageKey', 'submitHaikuPhrase',
    'updateDoc', 'refreshPhraseSubmitButton', 'console',
    implementation,
  );
  install(
    window,
    state,
    (message) => alerts.push(message),
    (_data, uid, name) => uid || name,
    submitImpl,
    async () => {},
    () => { refreshCount += 1; },
    consoleMock,
  );
  return { window, state, alerts, getRefreshCount: () => refreshCount };
}

test('素材登録中の連打はCallableを1回だけ実行し、成功後にボタンを復帰する', async () => {
  const pending = deferred();
  let calls = 0;
  const harness = await loadAddWordsHarness({
    submitImpl: async () => {
      calls += 1;
      await pending.promise;
    },
  });

  const first = harness.window.addWords();
  const second = harness.window.addWords();
  assert.equal(calls, 1);
  assert.equal(harness.state.isSubmittingWords, true);
  assert.equal(harness.button.disabled, true);
  assert.equal(harness.button.innerText, '追加中…');

  pending.resolve();
  await Promise.all([first, second]);
  assert.equal(harness.state.isSubmittingWords, false);
  assert.equal(harness.button.disabled, false);
  assert.equal(harness.button.innerText, '✅ 追加完了！');
  assert.equal(harness.getRenderCount(), 1);
});

test('素材登録失敗時は入力を保持し、成功表示にせず再送信可能に戻す', async () => {
  let calls = 0;
  const harness = await loadAddWordsHarness({
    submitImpl: async () => {
      calls += 1;
      throw Object.assign(new Error('internal detail'), { code: 'functions/unavailable' });
    },
  });

  await harness.window.addWords();
  assert.equal(calls, 1);
  assert.equal(harness.state.isSubmittingWords, false);
  assert.equal(harness.button.disabled, false);
  assert.equal(harness.button.innerText, '素材を提出する');
  assert.equal(harness.inputs.get('word-5-input-1').value, '☆!?ーんっゃABC');
  assert.equal(harness.getRenderCount(), 0);
  assert.deepEqual(harness.alerts, ['素材を登録できませんでした。通信状態を確認して、もう一度お試しください。']);
});

test('句投稿中の連打はCallableを1回だけ実行し、成功後は同じ節の再投稿を止める', async () => {
  const pending = deferred();
  let calls = 0;
  const harness = await loadSubmitPhraseHarness({
    submitImpl: async () => {
      calls += 1;
      await pending.promise;
    },
  });

  const first = harness.window.submitPhrase();
  const second = harness.window.submitPhrase();
  assert.equal(calls, 1);
  assert.equal(harness.state.isSubmittingPhrase, true);

  pending.resolve();
  await Promise.all([first, second]);
  assert.equal(harness.state.isSubmittingPhrase, false);
  assert.equal(harness.state.submittedPhraseKey, 'room:1');

  await harness.window.submitPhrase();
  assert.equal(calls, 1);
  assert.equal(harness.alerts.at(-1), 'この節では、すでに句を投稿済みです。');
  assert.ok(harness.getRefreshCount() >= 2);
});

test('句投稿の重複エラーは専用メッセージを表示し、投稿済み状態を維持する', async () => {
  const harness = await loadSubmitPhraseHarness({
    submitImpl: async () => {
      throw Object.assign(new Error('句は1節につき1つまでです。'), { code: 'functions/failed-precondition' });
    },
  });

  await harness.window.submitPhrase();
  assert.equal(harness.state.isSubmittingPhrase, false);
  assert.equal(harness.state.submittedPhraseKey, 'room:1');
  assert.deepEqual(harness.alerts, ['この節では、すでに句を投稿済みです。']);
});

test('句投稿成功後に再同期だけ失敗しても再投稿可能には戻さない', async () => {
  const harness = await loadSubmitPhraseHarness({
    submitImpl: async () => {},
    resyncImpl: async () => { throw new Error('offline'); },
  });

  await harness.window.submitPhrase();
  assert.equal(harness.state.isSubmittingPhrase, false);
  assert.equal(harness.state.submittedPhraseKey, 'room:1');
  assert.deepEqual(harness.alerts, ['句は投稿されましたが、画面への反映を確認できませんでした。最新の状態に更新してください。']);
});


async function loadPhraseButtonHarness(stateOverrides = {}) {
  const source = await fs.readFile(new URL('../haiku-render.js', import.meta.url), 'utf8');
  const extracted = extractBetween(source, 'export function refreshPhraseSubmitButton', '\nexport function refreshRoleBasedControls');
  const implementation = extracted.replace('export function refreshPhraseSubmitButton', 'function refreshPhraseSubmitButton');
  const button = {
    disabled: false,
    innerText: '整いました！',
    style: {},
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
  };
  const state = {
    currentData: { schemaVersion: 2, roundCount: 1, phrases: {} },
    selectedHand: [null, null, null],
    isSpectator: false,
    isSubmittingPhrase: false,
    submittedPhraseKey: '',
    myUid: 'uid-player',
    myName: '参加者',
    roomId: 'room',
    ...stateOverrides,
  };
  const document = { getElementById: (id) => id === 'submit-phrase-btn' ? button : null };
  const install = new Function(
    'state', 'document', 'getParticipantStorageKey',
    `${implementation}\nreturn refreshPhraseSubmitButton;`,
  );
  const refreshPhraseSubmitButton = install(state, document, (_data, uid, name) => uid || name);
  return { state, button, refreshPhraseSubmitButton };
}

test('句投稿ボタンは未完成・投稿中・投稿済みで無効になり、次節で再び有効になる', async () => {
  const harness = await loadPhraseButtonHarness();
  harness.refreshPhraseSubmitButton();
  assert.equal(harness.button.disabled, true);
  assert.equal(harness.button.innerText, '整いました！');

  harness.state.selectedHand = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  harness.refreshPhraseSubmitButton();
  assert.equal(harness.button.disabled, false);

  harness.state.isSubmittingPhrase = true;
  harness.refreshPhraseSubmitButton();
  assert.equal(harness.button.disabled, true);
  assert.equal(harness.button.innerText, '投稿中…');

  harness.state.isSubmittingPhrase = false;
  harness.state.submittedPhraseKey = 'room:1';
  harness.refreshPhraseSubmitButton();
  assert.equal(harness.button.disabled, true);
  assert.equal(harness.button.innerText, '投稿済み');

  harness.state.currentData = { ...harness.state.currentData, roundCount: 2 };
  harness.refreshPhraseSubmitButton();
  assert.equal(harness.button.disabled, false);
  assert.equal(harness.button.innerText, '整いました！');
});

test('v2俳句の作成・入室・再接続はCallableを使い、v1だけ直接更新へフォールバックする', async () => {
  const source = await fs.readFile(new URL('../haiku-room.js', import.meta.url), 'utf8');
  const implementation = extractBetween(source, 'window.joinRoom =', '\nwindow.removeSubmittedWord');
  assert.match(source, /import \{ joinHaikuRoom,/);
  assert.match(implementation, /if \(!existingData \|\| existingData\.schemaVersion === 2\)/);
  assert.match(implementation, /await joinHaikuRoom\(state\.roomId, state\.myName, role\)/);
  assert.match(implementation, /v1ルームは従来互換の直接更新を維持する/);
  assert.doesNotMatch(implementation, /const initialData =/);
  assert.doesNotMatch(implementation, /transaction\.set\(state\.roomRef/);
});


test('空文字・空白だけの素材はCallableへ送信しない', async () => {
  let calls = 0;
  const harness = await loadAddWordsHarness({
    submitImpl: async () => { calls += 1; },
  });
  harness.inputs.get('word-5-input-1').value = '   ';
  harness.inputs.get('word-7-input-1').value = '';

  await harness.window.addWords();
  assert.equal(calls, 0);
  assert.equal(harness.state.isSubmittingWords, false);
  assert.deepEqual(harness.alerts, ['少なくとも1つ素材を入力してください']);
});

test('完了後は同一文字列の素材を再度送信できる', async () => {
  let calls = 0;
  const harness = await loadAddWordsHarness({
    submitImpl: async () => { calls += 1; },
  });

  await harness.window.addWords();
  await harness.window.addWords();
  assert.equal(calls, 2);
  assert.equal(harness.state.isSubmittingWords, false);
  assert.equal(harness.button.disabled, false);
});

test('句投稿の一般エラー後は送信中フラグを解除して再操作可能に戻す', async () => {
  const harness = await loadSubmitPhraseHarness({
    submitImpl: async () => {
      throw Object.assign(new Error('internal detail'), { code: 'functions/permission-denied' });
    },
  });

  await harness.window.submitPhrase();
  assert.equal(harness.state.isSubmittingPhrase, false);
  assert.equal(harness.state.submittedPhraseKey, '');
  assert.deepEqual(harness.alerts, ['句の投稿に失敗しました。入力内容を確認して、もう一度お試しください。']);
});


async function loadRedrawHarness({ schemaVersion, redrawImpl, transactionImpl, currentData = {} }) {
  const source = await fs.readFile(new URL('../haiku-game.js', import.meta.url), 'utf8');
  const implementation = extractBetween(source, 'window.redrawHand =', '\nwindow.saveGameAsWordSet');
  const state = {
    currentData: {
      schemaVersion,
      status: 'playing',
      roundCount: 1,
      phrases: {},
      deck5: [{ id: 'deck-five', text: '五音札' }],
      deck7: [{ id: 'deck-seven', text: '七音札' }],
      ...currentData,
    },
    isSpectator: false,
    isProcessingRedraw: false,
    redrawSelected5: ['hand-five'],
    redrawSelected7: ['hand-seven'],
    redrawUsed: false,
    redrawSuccessKey: '',
    myUid: 'uid-player',
    myName: '参加者',
    roomId: 'redraw-room',
    roomRef: { id: 'redraw-room' },
  };
  const alerts = [];
  const calls = { redraw: [], transactions: 0, updates: [] };
  const window = {};
  const consoleMock = { error() {} };
  const transaction = {
    async get() {
      return { data: () => ({
        status: 'playing',
        roundCount: 1,
        phrases: {},
        redraws: {},
        hands5: { 'uid-player': [{ id: 'hand-five', text: '五音札' }] },
        hands7: { 'uid-player': [{ id: 'hand-seven', text: '七音札' }] },
        deck5: [{ id: 'deck-five', text: '五音札' }],
        deck7: [{ id: 'deck-seven', text: '七音札' }],
        ...currentData,
      }) };
    },
    update(ref, fields) { calls.updates.push({ ref, fields }); },
  };
  const redrawHaikuHand = async (...args) => {
    calls.redraw.push(args);
    return redrawImpl ? redrawImpl(...args) : undefined;
  };
  const runTransaction = async (_db, callback) => {
    calls.transactions += 1;
    return transactionImpl ? transactionImpl(callback, transaction) : callback(transaction);
  };
  const install = new Function(
    'window', 'state', 'alert', 'redrawHaikuHand', 'runTransaction', 'db',
    'getParticipantStorageKey', 'confirm', 'console',
    implementation,
  );
  install(
    window,
    state,
    (message) => alerts.push(message),
    redrawHaikuHand,
    runTransaction,
    {},
    (_data, uid, name) => uid || name,
    () => true,
    consoleMock,
  );
  return { window, state, alerts, calls };
}

test('v2引き直しはCallableだけを呼び、成功後に選択状態を消去する', async () => {
  const harness = await loadRedrawHarness({ schemaVersion: 2 });
  await harness.window.redrawHand();
  assert.deepEqual(harness.calls.redraw, [['redraw-room', ['hand-five'], ['hand-seven']]]);
  assert.equal(harness.calls.transactions, 0);
  assert.deepEqual(harness.state.redrawSelected5, []);
  assert.deepEqual(harness.state.redrawSelected7, []);
  assert.equal(harness.state.redrawUsed, true);
  assert.equal(harness.state.redrawSuccessKey, 'redraw-room:1');
  assert.equal(harness.state.isProcessingRedraw, false);
  assert.deepEqual(harness.alerts, ['手札を引き直しました。']);
});

test('v2引き直しCallable失敗時は選択状態を保持し、再操作可能に戻す', async () => {
  const harness = await loadRedrawHarness({
    schemaVersion: 2,
    redrawImpl: async () => { throw Object.assign(new Error('internal detail'), { code: 'functions/failed-precondition' }); },
  });
  await harness.window.redrawHand();
  assert.deepEqual(harness.calls.redraw, [['redraw-room', ['hand-five'], ['hand-seven']]]);
  assert.equal(harness.calls.transactions, 0);
  assert.deepEqual(harness.state.redrawSelected5, ['hand-five']);
  assert.deepEqual(harness.state.redrawSelected7, ['hand-seven']);
  assert.equal(harness.state.redrawUsed, false);
  assert.equal(harness.state.isProcessingRedraw, false);
  assert.deepEqual(harness.alerts, ['引き直しに失敗しました: internal detail']);
});

test('v2引き直し成功後は同じ節の古いSnapshotでも成功キーと表示状態を維持する', async () => {
  const source = await fs.readFile(new URL('../haiku-room.js', import.meta.url), 'utf8');
  const handSubscription = extractBetween(source, 'function subscribeOwnHand', 'async function resyncOwnHandFromFirestore');
  assert.match(handSubscription, /state\.redrawSuccessKey/);
  assert.match(handSubscription, /state\.redrawSuccessKey === snapshotKey \|\| hand\.redrawUsed === true/);
  assert.match(handSubscription, /state\.redrawUsed = state\.redrawSuccessKey === snapshotKey/);
  assert.match(handSubscription, /state\.myHand5 = Array\.isArray\(hand\.hand5\)/);
  const render = await fs.readFile(new URL('../haiku-render.js', import.meta.url), 'utf8');
  assert.match(render, /state\.redrawUsed === true/);
  assert.match(render, /hasRedrawn \? ''/);
});

test('v2引き直し成功後は同じ節で再クリックしてもCallableを追加実行しない', async () => {
  const harness = await loadRedrawHarness({ schemaVersion: 2 });
  await harness.window.redrawHand();
  harness.state.redrawSelected5 = ['another-five'];
  harness.state.redrawSelected7 = [];
  await harness.window.redrawHand();
  assert.equal(harness.calls.redraw.length, 1);
  assert.equal(harness.state.redrawUsed, true);
});

test('引き直し成功キーは節・ルーム変更時にリセットされる', async () => {
  const source = await fs.readFile(new URL('../haiku-room.js', import.meta.url), 'utf8');
  const applyRoom = extractBetween(source, 'function applyRoomData', '\n// ブラウザがバックグラウンド');
  assert.match(applyRoom, /previousRoundKey !== nextRoundKey/);
  assert.doesNotMatch(applyRoom, /previousRoundKey !== nextRoundKey \|\| data\?\.status/);
  assert.match(applyRoom, /state\.redrawSuccessKey = ''/);
  assert.match(source, /if \(state\.roomId !== nextRoomId\)/);
});

test('v2引き直し処理中の連打はCallableを1回だけ呼ぶ', async () => {
  const pending = deferred();
  const harness = await loadRedrawHarness({
    schemaVersion: 2,
    redrawImpl: async () => pending.promise,
  });
  const first = harness.window.redrawHand();
  const second = harness.window.redrawHand();
  assert.equal(harness.calls.redraw.length, 1);
  assert.equal(harness.state.isProcessingRedraw, true);
  pending.resolve();
  await Promise.all([first, second]);
  assert.equal(harness.calls.redraw.length, 1);
  assert.equal(harness.state.isProcessingRedraw, false);
});

test('Callable失敗時は成功キーを設定せず、選択状態と再操作可能状態を維持する', async () => {
  const harness = await loadRedrawHarness({
    schemaVersion: 2,
    redrawImpl: async () => { throw new Error('失敗'); },
  });
  await harness.window.redrawHand();
  assert.equal(harness.state.redrawSuccessKey, '');
  assert.equal(harness.state.redrawUsed, false);
  assert.deepEqual(harness.state.redrawSelected5, ['hand-five']);
  assert.equal(harness.state.isProcessingRedraw, false);
});

test('v1引き直しはCallableを呼ばず従来のrunTransactionを使う', async () => {
  const harness = await loadRedrawHarness({ schemaVersion: 1 });
  await harness.window.redrawHand();
  assert.equal(harness.calls.redraw.length, 0);
  assert.equal(harness.calls.transactions, 1);
  assert.equal(harness.state.isProcessingRedraw, false);
  assert.deepEqual(harness.state.redrawSelected5, []);
  assert.deepEqual(harness.state.redrawSelected7, []);
  assert.equal(harness.calls.updates.length, 1);
  assert.deepEqual(harness.calls.updates[0].fields, {
    'hands5.uid-player': [{ id: 'deck-five', text: '五音札' }],
    'hands7.uid-player': [{ id: 'deck-seven', text: '七音札' }],
    deck5: [],
    deck7: [],
    'redraws.uid-player': true,
  });
});

test('v2引き直しの成功条件はplaying状態に限定され、Callableを呼ばない', async () => {
  const harness = await loadRedrawHarness({ schemaVersion: 2, currentData: { status: 'lobby' } });
  await harness.window.redrawHand();
  assert.equal(harness.calls.redraw.length, 0);
  assert.equal(harness.state.isProcessingRedraw, false);
});

test('v2引き直しの札未選択時はCallableを呼ばない', async () => {
  const harness = await loadRedrawHarness({ schemaVersion: 2 });
  harness.state.redrawSelected5 = [];
  harness.state.redrawSelected7 = [];
  await harness.window.redrawHand();
  assert.equal(harness.calls.redraw.length, 0);
  assert.deepEqual(harness.alerts, ['引き直す札を選んでください。']);
});

test('v2引き直しは見学者がCallableを呼ばない', async () => {
  const harness = await loadRedrawHarness({ schemaVersion: 2 });
  harness.state.isSpectator = true;
  await harness.window.redrawHand();
  assert.equal(harness.calls.redraw.length, 0);
});

// Source-level guard: v2 must return before entering the legacy transaction block.
test('v2分岐はCallable後にreturnし、v1の直接トランザクションを再利用する', async () => {
  const source = await fs.readFile(new URL('../haiku-game.js', import.meta.url), 'utf8');
  const implementation = extractBetween(source, 'window.redrawHand =', '\nwindow.saveGameAsWordSet');
  assert.match(implementation, /schemaVersion === 2/);
  assert.match(implementation, /await redrawHaikuHand\(state\.roomId, state\.redrawSelected5, state\.redrawSelected7\)/);
  assert.match(implementation, /\n\s*return;\n\s*}\n\s*if \(state\.currentData\.status !== 'playing'\)/);
  assert.match(implementation, /runTransaction\(db,/);
});


test('redrawHaikuHandラッパーはCallable名・引数・戻り値形式を維持する', async () => {
  const source = await fs.readFile(new URL('../haiku-functions.js', import.meta.url), 'utf8');
  const implementation = extractBetween(source, 'export async function redrawHaikuHand', '\nexport async function submitHaikuPhrase');
  assert.match(implementation, /redrawHaikuHandCallable\(\{/);
  assert.match(implementation, /roomId: requireRoomId\(roomId\)/);
  assert.match(implementation, /selectedIds5: Array\.isArray\(selectedIds5\) \? selectedIds5 : \[\]/);
  assert.match(implementation, /selectedIds7: Array\.isArray\(selectedIds7\) \? selectedIds7 : \[\]/);
  assert.match(implementation, /return result\.data/);
});


test('v2引き直しの直接更新対象はサーバーCallable内に限定される', async () => {
  const source = await fs.readFile(new URL('../haiku-game.js', import.meta.url), 'utf8');
  const redraw = extractBetween(source, 'window.redrawHand =', '\nwindow.saveGameAsWordSet');
  const v2 = extractBetween(redraw, 'if (state.currentData.schemaVersion === 2)', '\n  if (state.currentData.status !== \'playing\')');
  assert.doesNotMatch(v2, /runTransaction|updateDoc|transaction\.update/);
  assert.match(v2, /redrawHaikuHand\(/);
  const functions = await fs.readFile(new URL('../functions/index.js', import.meta.url), 'utf8');
  const serverRedraw = extractBetween(functions, 'exports.redrawHaikuHand =', '\nfunction requireParticipant');
  for (const field of ['hand5', 'hand7', 'redrawUsed', 'deck5', 'deck7']) assert.match(serverRedraw, new RegExp(field));
  assert.match(serverRedraw, /transaction\.update\(handRef/);
  assert.match(serverRedraw, /transaction\.update\(roomRef/);
});


test('同一節のhand SnapshotがredrawUsed:falseでも成功済み状態を維持する', async () => {
  const source = await fs.readFile(new URL('../haiku-room.js', import.meta.url), 'utf8');
  const implementation = extractBetween(source, 'function subscribeOwnHand', 'async function resyncOwnHandFromFirestore');
  const state = {
    roomRef: { path: 'rooms/haiku-redraw-room' },
    myUid: 'uid-player',
    roomId: 'redraw-room',
    currentData: { schemaVersion: 2, status: 'playing', roundCount: 1 },
    redrawSuccessKey: 'redraw-room:1',
    redrawUsed: true,
    myHand5: [{ id: 'new-five' }],
    myHand7: [{ id: 'new-seven' }],
  };
  let snapshotCallback;
  let renders = 0;
  const onSnapshot = (_ref, callback) => { snapshotCallback = callback; return () => {}; };
  const install = new Function('state', 'doc', 'onSnapshot', 'renderHand', 'renderBoards', `let handUnsubscribe = null; let handSubscriptionKey = ''; ${implementation}; return subscribeOwnHand;`);
  const subscribeOwnHand = install(state, () => ({}), onSnapshot, () => { renders += 1; }, () => {});
  subscribeOwnHand(state.currentData);
  snapshotCallback({ exists: () => true, data: () => ({ hand5: [{ id: 'old-five' }], hand7: [{ id: 'old-seven' }], redrawUsed: false }) });
  assert.equal(state.redrawUsed, true);
  assert.equal(state.redrawSuccessKey, 'redraw-room:1');
  assert.deepEqual(state.myHand5, [{ id: 'old-five' }]);
  assert.deepEqual(state.myHand7, [{ id: 'old-seven' }]);
  assert.equal(renders, 1);
});


test('新節のhand Snapshotでは成功済みキーを新節へ持ち越さない', async () => {
  const source = await fs.readFile(new URL('../haiku-room.js', import.meta.url), 'utf8');
  const implementation = extractBetween(source, 'function subscribeOwnHand', 'async function resyncOwnHandFromFirestore');
  const state = {
    roomRef: { path: 'rooms/haiku-redraw-room' },
    myUid: 'uid-player',
    roomId: 'redraw-room',
    currentData: { schemaVersion: 2, status: 'playing', roundCount: 2 },
    redrawSuccessKey: 'redraw-room:1',
    redrawUsed: true,
    myHand5: [], myHand7: [],
  };
  let snapshotCallback;
  const onSnapshot = (_ref, callback) => { snapshotCallback = callback; return () => {}; };
  const install = new Function('state', 'doc', 'onSnapshot', 'renderHand', 'renderBoards', `let handUnsubscribe = null; let handSubscriptionKey = ''; ${implementation}; return subscribeOwnHand;`);
  const subscribeOwnHand = install(state, () => ({}), onSnapshot, () => {}, () => {});
  subscribeOwnHand(state.currentData);
  snapshotCallback({ exists: () => true, data: () => ({ hand5: [], hand7: [], redrawUsed: false }) });
  assert.equal(state.redrawSuccessKey, '');
  assert.equal(state.redrawUsed, false);
});


test('デフォルト素材補充成功後は最新ルーム状態を再同期してから成功通知する', async () => {
  const source = await fs.readFile(new URL('../haiku-game.js', import.meta.url), 'utf8');
  const fillDefault = extractBetween(source, 'window.fillDefaultWords = async function()', 'window.startGame');
  assert.match(fillDefault, /await supplementHaikuWords\(state\.roomId, add5, add7\)/);
  assert.match(fillDefault, /typeof window\.resyncHaikuRoom === 'function'/);
  assert.match(fillDefault, /await window\.resyncHaikuRoom\(\{ requireSuccess: true \}\)/);
  assert.ok(fillDefault.indexOf('resyncHaikuRoom') < fillDefault.indexOf('alert(`🎴'), '再同期は成功通知より先に実行する');
});

test('補充後再同期はv1直接更新の互換経路を変更しない', async () => {
  const source = await fs.readFile(new URL('../haiku-game.js', import.meta.url), 'utf8');
  const fillDefault = extractBetween(source, 'window.fillDefaultWords = async function()', 'window.startGame');
  assert.match(fillDefault, /updateDoc\(state\.roomRef, \{ words5: arrayUnion\(\.\.\.add5\), words7: arrayUnion\(\.\.\.add7\) \}\)/);
  assert.match(fillDefault, /state\.currentData\.schemaVersion === 2/);
});


test('引き直し成功後はサーバー手札を再取得し、取得失敗でも成功状態を維持する', async () => {
  const game = await fs.readFile(new URL('../haiku-game.js', import.meta.url), 'utf8');
  const redraw = extractBetween(game, 'window.redrawHand =', '\nwindow.saveGameAsWordSet');
  assert.match(redraw, /typeof window\.resyncHaikuHand === 'function'/);
  assert.match(redraw, /await window\.resyncHaikuHand\(\)/);
  assert.match(redraw, /引き直しは完了しましたが、手札表示の更新に失敗しました/);
  assert.ok(redraw.indexOf('resyncHaikuHand') < redraw.indexOf('state.redrawUsed = true'));
});

test('手札再同期はサーバー取得結果を描画し、redrawSuccessKeyと整合させる', async () => {
  const room = await fs.readFile(new URL('../haiku-room.js', import.meta.url), 'utf8');
  const resync = extractBetween(room, 'async function resyncOwnHandFromFirestore', '\nwindow.resyncHaikuHand');
  assert.match(resync, /getDocFromServer\(doc\(state\.roomRef, 'hands', state\.myUid\)\)/);
  assert.match(resync, /state\.myHand5 = Array\.isArray\(hand\.hand5\)/);
  assert.match(resync, /state\.myHand7 = Array\.isArray\(hand\.hand7\)/);
  assert.match(resync, /state\.redrawUsed = state\.redrawSuccessKey === snapshotKey \|\| hand\.redrawUsed === true/);
  assert.match(resync, /renderHand\(\);/);
  assert.match(resync, /renderBoards\(\);/);
});

test('FirestoreはFirestore WebChannelが不安定な環境向けにlong-polling自動検出を有効化する', async () => {
  const config = await fs.readFile(new URL('../firebase-config.js', import.meta.url), 'utf8');
  assert.match(config, /initializeFirestore/);
  assert.match(config, /experimentalAutoDetectLongPolling: true/);
  assert.doesNotMatch(config, /getFirestore\(app\)/);
});


test('visibility復帰時のroom再同期後にv2プレイヤーの手札も再取得する', async () => {
  const room = await fs.readFile(new URL('../haiku-room.js', import.meta.url), 'utf8');
  const resync = extractBetween(room, 'async function resyncRoomFromFirestore', '// メイン: タブ/アプリの表示・非表示切替');
  assert.match(resync, /state\.currentData\?\.schemaVersion === 2/);
  assert.match(resync, /state\.currentData\.status === 'playing'/);
  assert.match(resync, /!state\.isSpectator/);
  assert.match(resync, /await resyncOwnHandFromFirestore\(\)/);
  assert.match(resync, /手札の再同期に失敗しました/);
});

test('御印・投票成功後はroom再同期を行い、既存の確認フローを維持する', async () => {
  const action = await fs.readFile(new URL('../haiku-action.js', import.meta.url), 'utf8');
  assert.match(action, /const resyncAndVerify = async \(\) =>/);
  assert.match(action, /await window\.resyncHaikuRoom\(\{ requireSuccess: true \}\)/);
  assert.match(action, /御印はサーバーに保存されましたが、画面への反映確認に失敗しました/);
});

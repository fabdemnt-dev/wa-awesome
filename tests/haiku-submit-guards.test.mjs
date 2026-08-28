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

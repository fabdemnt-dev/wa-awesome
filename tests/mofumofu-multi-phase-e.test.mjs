import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

// Phase E（3〜6人版の入口・クライアント・表示）の純粋テストと静的検査。
// Firebaseへは依存しない。server正本（functions/mofumofu-multi/*）と同じ値・同じ判断かを機械的に確認し、
// 既存2人＋こはる版（online/）の導線を壊していないことも同時に固定する。
const functionRequire = createRequire(new URL('../functions/package.json', import.meta.url));
const rules = functionRequire('./mofumofu-multi/rules.js');
const presence = functionRequire('./mofumofu-multi/presence.js');

const core = await import('../toybox/mofumofu-gathering/online/multi/multi-core.js');
const resumeHelpers = await import('../toybox/mofumofu-gathering/online/multi/multi-resume.js');
const actionHelpers = await import('../toybox/mofumofu-gathering/online/multi/multi-action-recovery.js');

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
const multiPage = read('../toybox/mofumofu-gathering/online/multi/index.html');
const multiClient = read('../toybox/mofumofu-gathering/online/multi/script.js');
const multiStyle = read('../toybox/mofumofu-gathering/online/multi/style.css');
const multiConfig = read('../toybox/mofumofu-gathering/online/multi/firebase-config.js');
const multiEntry = read('../toybox/mofumofu-gathering/multi-entry.js');
const gamePage = read('../toybox/mofumofu-gathering/index.html');
const onlineEntry = read('../toybox/mofumofu-gathering/online-entry.js');
const onlinePage = read('../toybox/mofumofu-gathering/online/index.html');
const onlineClient = read('../toybox/mofumofu-gathering/online/script.js');

const NOW = Date.now();
const card = (animalType, cardId) => ({ cardId, animalType });
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    size: () => map.size,
  };
}
function baseRoom(count, overrides = {}) {
  const seats = rules.SEAT_IDS.slice(0, count);
  const playerUids = Object.fromEntries(seats.map((seat) => [seat, `uid-${seat}`]));
  return {
    schemaVersion: 2, kind: 'multi', roomId: 'room-phase-e', status: rules.ROOM_STATUS.WAITING,
    hostUid: playerUids.S1, joinExpiresAt: NOW + 30 * 60 * 1000, dealt: false,
    seatOrder: seats,
    players: Object.fromEntries(seats.map((seat) => [seat, { seatId: seat, joined: true, joinedAt: NOW, displayName: null }])),
    playerUids,
    playerStatus: Object.fromEntries(seats.map((seat) => [seat, rules.PLAYER_STATUS.ACTIVE])),
    handCounts: Object.fromEntries(seats.map((seat) => [seat, 0])),
    faceUpCards: Object.fromEntries(seats.map((seat) => [seat, []])),
    currentTurnPlayerId: null, turnState: rules.TURN_STATE.WAITING, turnNumber: 0, publicOffer: null,
    winnerPlayerIds: [], loserPlayerIds: [], leftPlayerIds: [], draw: false,
    finishReason: null, gatheringReason: null, finalResult: null, deleteAt: NOW + 6 * 60 * 60 * 1000,
    ...overrides,
  };
}
function playingRoom(count, overrides = {}) {
  const room = baseRoom(count, {
    status: rules.ROOM_STATUS.PLAYING, dealt: true, turnState: rules.TURN_STATE.AWAITING_OFFER,
    currentTurnPlayerId: 'S1',
    handCounts: Object.fromEntries(rules.SEAT_IDS.slice(0, count).map((seat) => [seat, core.handSizeFor(count)])),
    ...overrides,
  });
  return room;
}
function connection(uid, seatId, offsetMs = 0) {
  return presence.heartbeatRecord({
    uid, roomId: 'room-phase-e', seatId, connectionId: presence.newConnectionId(), now: NOW - offsetMs,
  });
}

/* ------------------------------------------------------------------- gate */

test('E-1 gate: 3〜6人版は非公開のまま、2人＋こはるは今までどおり選べる', () => {
  assert.equal(core.MULTI_ONLINE_PUBLIC_ENABLED, false);
  const options = core.onlineModeOptions();
  assert.equal(options.length, 2);
  const [twoPlayer, multi] = options;
  assert.deepEqual(
    { id: twoPlayer.id, href: twoPlayer.href, enabled: twoPlayer.enabled },
    { id: 'two-player', href: './online/', enabled: true },
  );
  assert.equal(multi.id, 'multi');
  assert.equal(multi.href, './online/multi/');
  assert.equal(multi.enabled, false, 'gate=falseで3〜6人版が選べてしまう');
  assert.equal(multi.description, 'じゅんびちゅう');
  assert.equal(core.MULTI_PAGE_PATH, './online/multi/');
  assert.equal(core.TWO_PLAYER_PAGE_PATH, './online/');
});

test('E-2 既存2人＋こはる版の入口を壊していない（href・gate・module版数の維持）', () => {
  // 既存回帰の制約（tests/mofumofu-online-phase7.test.mjs:73）が要求する文字列はそのまま。
  assert.ok(gamePage.includes('href="./online/"'), '既存hrefが消えている');
  assert.ok(gamePage.includes('<a id="onlineEntry" href="./online/" hidden>'), '既存入口の要素が変わっている');
  assert.ok(onlineEntry.includes('ONLINE_PUBLIC_ENABLED = true') || onlineEntry.includes('ONLINE_PUBLIC_ENABLED = true;'));
  assert.ok(onlinePage.includes('script.js?v=20260925-4'), '既存2人版のscript版数が変わっている');
  assert.ok(onlinePage.includes('style.css?v=20260925-2'), '既存2人版のstyle版数が変わっている');
  assert.ok(onlineClient.includes('mofumofuOnlinePresence/'), '既存2人版のpresenceルートが変わっている');
  // 追加はしたが、既存入口の要素・hrefは残したままmulti-entry.jsを足すだけ。
  assert.ok(gamePage.includes('src="online-entry.js?v=20260922-1"'));
  assert.ok(gamePage.includes('src="multi-entry.js?v=20260929-1"'));
  assert.ok(gamePage.includes('<dialog id="onlineModeDialog"'), 'モード選択のmarkupが無い');
  assert.ok(gamePage.indexOf('onlineModeDialog') > gamePage.indexOf('id="onlineEntry"'), '入口より前にダイアログを置いている');
});

test('E-3 モード選択: 修飾クリックは素通しし、無効モードはリンクにしない', () => {
  assert.ok(multiEntry.includes("import { onlineModeOptions } from './online/multi/multi-core.js?v=20260926-1'"));
  for (const guard of ['event.metaKey', 'event.ctrlKey', 'event.shiftKey', 'event.altKey']) {
    assert.ok(multiEntry.includes(guard), `${guard} を素通ししていない`);
  }
  assert.ok(multiEntry.includes('event.preventDefault()'));
  assert.ok(multiEntry.includes('document.createElement(mode.enabled ? \'a\' : \'span\')'), '無効モードをリンクで描いている');
  // 3〜6人版ページ自体のキャッシュ版数は固定（ランダム生成・時刻生成をしない）。
  assert.ok(multiPage.includes('../multi/script.js?v=20260930-3'));
  assert.ok(multiPage.includes('../multi/style.css?v=20260929-1'));
  assert.equal(/\?v=\$\{/.test(multiPage), false, '版数を変数で組み立てている');
  assert.equal(/Math\.random|Date\.now\(\)\s*\)\s*\?v=/.test(multiPage), false);
});

test('モード選択はstagingだけ3〜6人版を有効にし、productionでは準備中を保つ', () => {
  function renderFor(hostname) {
    const listeners = new Map();
    const children = [];
    const elements = {
      onlineEntry: { addEventListener: (name, fn) => listeners.set(name, fn) },
      onlineModeDialog: { showModal() {}, close() {} },
      onlineModeOptions: { replaceChildren: (...nodes) => children.splice(0, children.length, ...nodes) },
      closeModeDialog: { addEventListener() {} },
    };
    const document = {
      head: { append() {} },
      getElementById: (id) => elements[id],
      createElement: (tag) => ({ tag, children: [], attributes: {}, setAttribute(key, value) { this.attributes[key] = value; }, append(...nodes) { this.children.push(...nodes); }, addEventListener() {} }),
    };
    vm.runInNewContext(multiEntry.replace(/^import .*;\s*/m, 'const onlineModeOptions = globalThis.testOptions;\n'), {
      document,
      location: { hostname },
      testOptions: core.onlineModeOptions,
    });
    listeners.get('click')({ defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault() {} });
    return children.map((node) => ({ tag: node.tag, href: node.href, disabled: node.attributes['aria-disabled'], label: node.children[0].textContent, description: node.children[1].textContent }));
  }
  for (const hostname of ['wa-awesome-mofumofu-stg.web.app', 'fabdemnt-dev.github.io']) {
    const [twoPlayer, multi] = renderFor(hostname);
    assert.equal(twoPlayer.tag, 'a');
    assert.equal(twoPlayer.href, './online/');
    if (hostname === 'wa-awesome-mofumofu-stg.web.app') {
      assert.equal(multi.tag, 'a');
      assert.equal(multi.href, './online/multi/');
      assert.notEqual(multi.description, 'じゅんびちゅう');
    } else {
      assert.equal(multi.tag, 'span');
      assert.equal(multi.disabled, 'true');
      assert.equal(multi.description, 'じゅんびちゅう');
    }
  }
});

test('保存roomなしの初期認証後は接続完了を表示し、復帰処理を呼ばない', () => {
  assert.match(multiClient, /await auth\.authStateReady\(\);\s*if \(!auth\.currentUser\) await signInAnonymously\(auth\);\s*if \(state\.roomId\) await requestResume\('initial'\);\s*else message\('接続しました。'\);/);
});

test('playing中の自分の手札は手番外も閲覧でき、選択は自分の出す手番だけ', () => {
  for (const count of [3, 4, 5, 6]) {
    const room = playingRoom(count, { currentTurnPlayerId: 'S1' });
    assert.equal(room.handCounts.S2, core.handSizeFor(count));
    assert.equal(core.handMode(core.gameView(room, 'S1')), 'select');
    assert.equal(core.handMode(core.gameView(room, 'S2')), 'view');
    const judging = playingRoom(count, {
      currentTurnPlayerId: 'S1', turnState: rules.TURN_STATE.AWAITING_JUDGMENT,
      publicOffer: { status: 'pending', fromPlayerId: 'S1', toPlayerId: 'S2', claimAnimal: 'cat' },
    });
    assert.equal(core.handMode(core.gameView(judging, 'S2')), 'judging');
    assert.equal(core.handMode(core.gameView(judging, 'S3')), 'view');
  }
  assert.equal(core.handMode(core.gameView(baseRoom(3), 'S1')), 'hidden');
  assert.match(multiClient, /\['select', 'view'\]\.includes\(handMode\) \? state\.cards : \[\]/);
  assert.match(multiClient, /document\.createElement\(canMake \? 'button' : 'span'\)/);
  assert.match(multiClient, /if \(canMake\) node\.addEventListener\('click'/);
  assert.match(multiClient, /if \(!core\.canMakeOffer\(state\.room, state\.seatId\) \|\| multiActionBlocked\(state\)\) return/);
  assert.match(multiClient, /state\.cards = Array\.isArray\(value\.cards\) \? value\.cards : \[\];[\s\S]*?renderAll\(\)/);
  assert.match(multiClient, /if \(view\.canJudge\) \{\s*\$\('judgeHand'\)\.replaceChildren\(\.\.\.state\.cards\.map/);
  assert.ok(multiPage.includes('id="hand" class="hand"'));
  assert.ok(multiStyle.includes('.hand{display:flex;gap:8px;overflow-x:auto'));
  assert.equal(multiClient.includes('other.cards'), false);
});

test('waiting・playing・resume後のconnected表示は入口と一致し、接続途中と区別する', () => {
  assert.equal(core.TEXT.connecting, '接続中');
  assert.equal(core.TEXT.connected, '接続しました。');
  assert.notEqual(core.TEXT.connected, core.TEXT.connecting);
  assert.equal(core.TEXT.syncing, '再接続中／同期中…');
  assert.equal(core.TEXT.chipReconnecting, '○ 再接続待ち');
  assert.match(multiClient, /next === 'connected' \? core\.TEXT\.connected : next === 'syncing' \? core\.TEXT\.syncing/);
  assert.match(multiClient, /renderAll\(\);\s*listenRoom\(generation\);\s*startSafetySync\(generation\);\s*setConnectionState\('connected'\);/);
  assert.match(multiClient, /if \(room\.status === core\.ROOM_STATUS\.WAITING\) renderLobby\(room\);\s*else renderGame\(room\);/);
});

test('カード→宣言→相手の表示段階はhidden属性で切り替え、固定CSS非表示にしない', () => {
  for (const id of ['claimStep', 'targetStep', 'judgeStep']) {
    assert.match(multiPage, new RegExp(`id="${id}" class="step" hidden`));
    assert.doesNotMatch(multiPage, new RegExp(`id="${id}"[^>]*class="[^"]*\\bhidden\\b`));
  }
  assert.ok(multiStyle.includes('[hidden]{display:none!important}'));
  assert.match(multiClient, /const showClaims = canMake && Boolean\(ui\.cardId\);[\s\S]*?\$\('claimStep'\)\.hidden = !showClaims/);
  assert.match(multiClient, /const showTargets = canMake && Boolean\(ui\.claim\);[\s\S]*?\$\('targetStep'\)\.hidden = !showTargets/);
  assert.match(multiClient, /node\.textContent = `\$\{target\.label\}へ渡す`;[\s\S]*?submitOffer\(target\.seatId, node\)/);
  assert.match(multiClient, /\$\('judgeStep'\)\.hidden = !view\.canJudge/);
  for (const count of [3, 4, 5, 6]) {
    const room = playingRoom(count);
    const seats = core.validTargets(room, 'S1');
    assert.deepEqual(seats.map((target) => target.seatId), room.seatOrder.slice(1));
    room.players.S2.displayName = 'ふわ';
    assert.equal(core.validTargets(room, 'S1')[0].label, 'ふわ');
    room.players.S2.displayName = null;
    assert.equal(core.validTargets(room, 'S1')[0].label, 'あいて1');
    assert.deepEqual(core.validTargets(room, 'S2'), [], '他人の手番で相手選択できない');
  }
});

test('相手への送信は選択完了後だけで、連打してもCallableを一度だけ発行する', async () => {
  const source = multiClient.slice(multiClient.indexOf('async function submitOffer('), multiClient.indexOf('async function submitJudgment('));
  const room = playingRoom(3);
  const state = { room, roomId: room.roomId, seatId: 'S1', makeBusy: false, makeRequest: null };
  const ui = { cardId: null, claim: null };
  const buttons = [{ disabled: false }, { disabled: false }];
  const button = buttons[0];
  const calls = [];
  let complete;
  const context = {
    state, ui, core, multiActionBlocked: actionHelpers.multiActionBlocked,
    definitiveMultiActionRejection: actionHelpers.definitiveMultiActionRejection,
    recoverPendingActions: () => {}, $: () => ({ children: buttons }), newId: () => 'action-1',
    call: (name, request) => { calls.push({ name, request: { ...request } }); return new Promise((resolve) => { complete = resolve; }); },
    renderGame: () => {}, message: () => {},
  };
  const submit = vm.runInNewContext(`${source}; submitOffer`, context);
  await submit('S2', button);
  assert.equal(calls.length, 0, 'カード未選択で送信しない');
  ui.cardId = 'own-card';
  await submit('S2', button);
  assert.equal(calls.length, 0, '宣言未選択で送信しない');
  ui.claim = 'cat';
  const first = submit('S2', button);
  const duplicate = submit('S2', button);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'makeMofumofuMultiOffer');
  assert.equal(calls[0].request.targetPlayerId, 'S2');
  assert.equal(calls[0].request.cardId, 'own-card');
  assert.equal(calls[0].request.claimedAnimalType, 'cat');
  assert.equal(button.disabled, true);
  complete();
  await Promise.all([first, duplicate]);
  assert.equal(state.makeRequest, null);
  assert.equal(ui.cardId, null);
  assert.equal(ui.claim, null);
  state.room = playingRoom(3, { currentTurnPlayerId: 'S2' });
  ui.cardId = 'own-card'; ui.claim = 'cat'; button.disabled = false;
  await submit('S2', button);
  assert.equal(calls.length, 1, '他人の手番では送信しない');
  assert.doesNotMatch(source, /privateHands|playerUids/);
});

/* ------------------------------------------------------------ 公開契約の一致 */

test('E-4 人数別の枚数・席・状態語彙がserverの契約と一致する', () => {
  assert.equal(core.MIN_PLAYERS, rules.MIN_PLAYERS);
  assert.equal(core.MAX_PLAYERS, rules.MAX_PLAYERS);
  assert.deepEqual(core.SEAT_IDS, rules.SEAT_IDS);
  for (const count of [3, 4, 5, 6]) {
    assert.equal(core.handSizeFor(count), rules.handSizeFor(count), `${count}人の手札枚数`);
    assert.equal(core.deckCountFor(count), rules.LEFTOVERS_BY_PLAYER_COUNT[count], `${count}人の山札枚数`);
  }
  assert.equal(core.handSizeFor(2), null);
  assert.deepEqual(core.TURN_STATE, rules.TURN_STATE);
  assert.deepEqual(core.FINISH_REASON, rules.FINISH_REASON);
  assert.deepEqual(core.GATHERING_REASON, rules.GATHERING_REASON);
  assert.deepEqual(core.PLAYER_STATUS, rules.PLAYER_STATUS);
  assert.deepEqual(core.JUDGMENTS, presence && { TRUTH: 'truth', LIE: 'lie' });
  assert.deepEqual(Object.values(core.SESSION_REASONS).sort(), Object.values(presence.SESSION_REASONS).sort());
  assert.deepEqual(core.RTDB_ROOTS, presence.RTDB_ROOTS, 'RTDBルートがserver契約と違う');
  assert.equal(core.HEARTBEAT_INTERVAL_MS, presence.HEARTBEAT_INTERVAL_MS);
  assert.equal(core.PRESENCE_STALE_MS, presence.PRESENCE_STALE_MS);
  assert.equal(core.ACCESS_REFRESH_MS, presence.PRESENCE_ACCESS_TTL_MS - 60_000);
  assert.equal(core.INVITE_LENGTH, presence.INVITE_LENGTH ?? 8);
  assert.equal(core.MIN_TAP_TARGET_PX, 44);
});

/* ------------------------------------------------------------------- 入口 */

test('E-5 入口: 3/4/5/6人でロビー表示と開始条件が正しい', () => {
  const waiting3 = baseRoom(3);
  const view = core.lobbyView(waiting3, 'S1');
  assert.equal(view.playerCount, 3);
  assert.equal(view.playerCountText, '3人 / 6人');
  assert.equal(view.isHost, true);
  assert.equal(view.canStart, true);
  assert.equal(view.startVisible, true);
  assert.equal(view.inviteVisible, true, 'ホストのwaiting中は招待コードを出す');
  assert.equal(view.nextSeatId, 'S4');
  assert.equal(view.full, false);

  const waiting2 = baseRoom(2);
  const shortView = core.lobbyView(waiting2, 'S1');
  assert.equal(shortView.canStart, false);
  assert.equal(shortView.startNote, '3人以上で開始できます');
  assert.equal(shortView.nextSeatId, 'S3');

  const full = core.lobbyView(baseRoom(6), 'S1');
  assert.equal(full.full, true);
  assert.equal(full.fullText, '満員です');
  assert.equal(full.emptySeats, 0);
  assert.equal(full.nextSeatId, null);

  // participant（非ホスト）には開始ボタンも招待コードも出さない。
  const guest = core.lobbyView(baseRoom(4), 'S3');
  assert.equal(guest.isHost, false);
  assert.equal(guest.startVisible, false);
  assert.equal(guest.inviteVisible, false);
  assert.equal(guest.waitingNote, 'ホストがゲームを開始するまで待ってね。');
  assert.equal(guest.seats.find((seat) => seat.seatId === 'S1').isHost, true);
  assert.equal(guest.seats.find((seat) => seat.seatId === 'S3').isSelf, true);
  assert.equal(guest.seats.find((seat) => seat.seatId === 'S2').label, 'あいて2');
  assert.equal(core.seatDisplayName(baseRoom(4), 'S4', 'S1'), 'あいて3');
  assert.equal(core.seatDisplayName(baseRoom(4), 'S1', 'S1'), 'あなた');
});

test('E-6 保存key・招待コードは3〜6人版専用で、既存2人版と共有しない', () => {
  assert.deepEqual(core.STORAGE_KEYS, {
    roomId: 'mofumofuMultiRoomId', seatId: 'mofumofuMultiSeatId', invitePrefix: 'mofumofuMultiInvite:',
  });
  assert.equal(core.inviteKey('r1'), 'mofumofuMultiInvite:r1');
  for (const legacy of ['mofumofuRoomId', 'mofumofuSeatId', "'mofumofuInvite:", 'mofumofuOnlinePresence']) {
    assert.equal(multiClient.includes(legacy), false, `clientが既存key/ルート ${legacy} を使っている`);
  }
  const storage = fakeStorage();
  assert.equal(core.saveRoom(storage, { roomId: 'room-1', seatId: 'S2' }), true);
  assert.deepEqual(core.loadRoom(storage), { roomId: 'room-1', seatId: 'S2' });
  assert.equal(core.saveRoom(storage, { roomId: '', seatId: 'S2' }), false);
  core.clearSavedRoom(storage);
  assert.equal(core.loadRoom(storage), null);

  // 招待コードは8文字・大文字正規化。平文はsessionStorageの専用keyにだけ置く。
  assert.equal(core.normalizeInviteCode(' abcd2345 '), 'ABCD2345');
  assert.equal(core.isInviteCode('abcd2345'), true);
  assert.equal(core.isInviteCode('abcd234'), false);
  assert.equal(core.isInviteCode('abcd234I'), false, '紛らわしい文字(I)を受け付けている');
  const session = fakeStorage();
  assert.equal(core.rememberInvite(session, 'room-1', 'abcd2345'), true);
  assert.equal(session.getItem('mofumofuMultiInvite:room-1'), 'ABCD2345');
  assert.equal(core.restoreInvite(session, 'room-1'), 'ABCD2345');
  core.forgetInvite(session, 'room-1');
  assert.equal(core.restoreInvite(session, 'room-1'), '');
});

/* --------------------------------------------------------------- ゲーム画面 */

test('E-7 3/4/5/6人: 自分は下・他は最大5人、手札枚数と表向きの内訳を出す', () => {
  for (const count of [3, 4, 5, 6]) {
    const room = playingRoom(count, {
      faceUpCards: Object.fromEntries(rules.SEAT_IDS.slice(0, count).map((seat) => [seat, seat === 'S2' ? [card('cat', 'a'), card('cat', 'b'), card('fox', 'c')] : []])),
    });
    const view = core.gameView(room, 'S1', {}, { presenceReady: false, now: NOW });
    assert.equal(view.others.length, count - 1, `${count}人の他席数`);
    assert.equal(view.others.length <= core.MAX_OTHERS, true);
    assert.equal(view.self.seatId, 'S1');
    assert.equal(view.self.label, 'あなた');
    assert.equal(view.self.handCount, core.handSizeFor(count));
    assert.equal(view.others.every((seat) => seat.label !== 'S1'), true);
    assert.equal(view.others.every((seat) => !/^S[1-6]$/.test(seat.label)), true, '内部seat IDを表示名にしている');
    assert.equal(view.board.deckText, `山札 ${core.deckCountFor(count)}枚`);
    assert.equal(view.turnText, 'あなたの番');
    assert.equal(view.isMyTurn, true);
    assert.equal(view.targets.length, count - 1, `${count}人の渡せる相手`);
    assert.equal(view.targets.some((target) => target.seatId === 'S1'), false, '自分へ渡せる');
    assert.equal(view.claims.length, core.ANIMALS.length);
    assert.equal(view.claims.every((option) => option.image.startsWith(core.ASSET_BASE)), true);
    assert.equal(view.targets.length <= core.MAX_OTHERS, true);
    // 表向きカードの内訳（S2は ねこ×2・きつね×1）。
    const s2 = view.others.find((seat) => seat.seatId === 'S2');
    assert.deepEqual(s2.faceUp.map((entry) => [entry.animalType, entry.count]), [['cat', 2], ['fox', 1]]);
    assert.equal(s2.faceUpCount, 3);
    assert.ok(s2.ariaLabel.includes('手札'), 'ariaLabelに手札情報が無い');
    assert.equal(/S[1-6]/.test(s2.ariaLabel), false, 'ariaLabelに内部seat IDが入っている');
  }
});

test('E-8 4人（山札0枚）でも表示が崩れず、山札からカードを引かないことを明示する', () => {
  const room = playingRoom(4);
  const view = core.gameView(room, 'S2', {}, { presenceReady: false, now: NOW });
  assert.equal(view.board.deckCount, 0);
  assert.equal(view.board.deckText, '山札 0枚');
  assert.equal(view.board.deckEmpty, true);
  assert.equal(core.TEXT.gatheringDeckNote, '山札は使いません。');
  assert.ok(core.helpTextFlat().some((line) => line.includes('ゲーム中はだれも引きません')), '山札を引かないことを説明していない');
  assert.ok(core.helpTextFlat().some((line) => line.includes('4人=8枚')));
});

test('E-9 手番と判定: 自分の手番だけ make、受取人本人だけ judge', () => {
  const room = playingRoom(5, { currentTurnPlayerId: 'S3' });
  for (const seat of room.seatOrder) {
    const view = core.gameView(room, seat, {}, { presenceReady: false, now: NOW });
    assert.equal(view.canMakeOffer, seat === 'S3', `${seat}のmake可否`);
    assert.equal(view.canJudge, false);
    assert.equal(view.targets.length, seat === 'S3' ? 4 : 0);
  }
  const judging = playingRoom(5, {
    turnState: rules.TURN_STATE.AWAITING_JUDGMENT, currentTurnPlayerId: 'S3',
    publicOffer: { status: 'pending', fromPlayerId: 'S3', toPlayerId: 'S5', claimAnimal: 'cat' },
  });
  for (const seat of judging.seatOrder) {
    const view = core.gameView(judging, seat, {}, { presenceReady: false, now: NOW });
    assert.equal(view.canJudge, seat === 'S5', `${seat}が判定できる/できない判定`);
    assert.equal(view.canMakeOffer, false);
    assert.equal(view.board.cardSub, `${core.seatDisplayName(judging, 'S3', seat)}の宣言`);
    assert.equal(view.board.message, seat === 'S5' ? 'うそ？ ほんと？ えらんでね。' : 'みんなが判定するのを待っています…');
    // 判定前は実animalTypeを見せない。
    assert.equal(JSON.stringify(view).includes('actualAnimal'), false, '判定前に実カードが混ざっている');
  }
  // 判定後だけ本当の動物・成功可否・受取人を公開する。
  const done = playingRoom(5, {
    turnState: rules.TURN_STATE.AWAITING_OFFER, currentTurnPlayerId: 'S1',
    publicOffer: { status: 'completed', fromPlayerId: 'S3', toPlayerId: 'S5', claimAnimal: 'cat', actualAnimal: 'fox', success: false, faceUpRecipientPlayerId: 'S5' },
  });
  const view = core.gameView(done, 'S1', {}, { presenceReady: false, now: NOW });
  assert.equal(view.board.card.animalType, 'fox');
  assert.equal(view.board.message, '× 判定失敗！');
  assert.equal(view.board.resultLine, `本当はきつね。判定失敗。${core.seatDisplayName(done, 'S5', 'S1')}が表向きカードを受け取りました。`);
  assert.deepEqual(presence.publicOfferViolations(done.publicOffer), []);
});

test('判定結果は宣言の真偽ではなく受け手の判定成否として表示する', () => {
  for (const [claimAnimal, actualAnimal, judgment, success] of [
    ['rabbit', 'rabbit', 'truth', true],
    ['rabbit', 'rabbit', 'lie', false],
    ['rabbit', 'cat', 'lie', true],
    ['rabbit', 'cat', 'truth', false],
  ]) {
    assert.equal(rules.judgeSuccess(claimAnimal, actualAnimal, judgment), success);
    const room = playingRoom(3, { publicOffer: {
      status: 'completed', fromPlayerId: 'S1', toPlayerId: 'S2', claimAnimal,
      actualAnimal, judgment, success, faceUpRecipientPlayerId: success ? 'S1' : 'S2',
    } });
    const board = core.gameView(room, 'S3', {}, { now: NOW }).board;
    assert.equal(board.message, success ? '○ 判定成功！' : '× 判定失敗！');
    assert.equal(board.cardSub, `あいて1の宣言は「${core.ANIMAL_LABELS[claimAnimal]}」`);
    assert.equal(board.card.animalType, actualAnimal);
    assert.equal(board.resultLine, `本当は${core.ANIMAL_LABELS[actualAnimal]}。判定${success ? '成功' : '失敗'}。${core.seatDisplayName(room, success ? 'S1' : 'S2', 'S3')}が表向きカードを受け取りました。`);
  }
  assert.match(multiClient, /flash\(offer\.success \? '○ 判定成功！' : '× 判定失敗！'\)/);
  assert.match(multiClient, /判定\$\{offer\.success \? '成功' : '失敗'\}/);
});

test('終了時の手番領域は非操作表示に変わり、集合ロゴと最終結果を維持する', () => {
  const room = baseRoom(3, { status: rules.ROOM_STATUS.FINISHED,
    finishReason: rules.FINISH_REASON.GATHERING, gatheringReason: rules.GATHERING_REASON.FOUR_OF_A_KIND,
    winnerPlayerIds: ['S1', 'S3'], loserPlayerIds: ['S2'],
    faceUpCards: { S1: [], S2: Array.from({ length: 4 }, (_, index) => card('rabbit', `r${index}`)), S3: [] },
  });
  const view = core.gameView(room, 'S1', {}, { now: NOW });
  assert.equal(view.finished, true);
  assert.equal(view.turnText, 'ゲーム終了');
  assert.equal(view.isMyTurn, false);
  assert.equal(view.result.showGatheringOverlay, true);
  assert.equal(view.result.logoPath, `${core.ASSET_BASE}mofumofu-logo.png`);
  assert.match(view.result.title, /もふもふ大集合！/);
  assert.match(multiPage, /<div id="turn" class="turn-badge">/);
  assert.match(multiClient, /\$\('turn'\)\.classList\.toggle\('finished', view\.finished\)/);
  assert.match(multiStyle, /\.turn-badge\.finished\{[^}]*box-shadow:none;[^}]*cursor:default/);
});

test('新しく遊ぶは正本のfinishedと接続完了でだけ表示され、結果表示は押すまで残る', () => {
  const state = { roomId: 'room-1', seatId: 'S1', room: { status: core.ROOM_STATUS.FINISHED },
    finishedConfirmedRoomId: 'room-1', connectionState: 'connected' };
  assert.equal(resumeHelpers.canForgetFinishedRoom(state), true);
  for (const status of [core.ROOM_STATUS.PLAYING, core.ROOM_STATUS.WAITING]) {
    assert.equal(resumeHelpers.canForgetFinishedRoom({ ...state, room: { status } }), false);
  }
  assert.equal(resumeHelpers.canForgetFinishedRoom({ ...state, finishedConfirmedRoomId: null }), false);
  assert.equal(resumeHelpers.canForgetFinishedRoom({ ...state, connectionState: 'syncing' }), false);
  assert.equal(resumeHelpers.canForgetFinishedRoom({ ...state, connectionState: 'error' }), false);
  assert.match(multiPage, /<section id="final-result"[^>]*>[\s\S]*<button id="new-game" class="primary big" type="button" hidden>新しく遊ぶ<\/button>/);
  assert.match(multiStyle, /\.big\{[^}]*min-height:54px/);
  assert.match(multiClient, /\$\('new-game'\)\.hidden = !canForgetFinishedRoom\(state\)/);
  assert.match(multiClient, /state\.finishedConfirmedRoomId = value\.status === core\.ROOM_STATUS\.FINISHED/);
  assert.match(multiClient, /snap\.metadata\?\.fromCache === false/);
});

test('finishedだけ端末credentialと旧購読を解除し、presence通信が保留でも新規入口へ戻る', () => {
  const storage = fakeStorage();
  core.saveRoom(storage, { roomId: 'room-1', seatId: 'S1' });
  const state = { roomId: 'room-1', seatId: 'S1', room: { status: core.ROOM_STATUS.FINISHED },
    cards: [card('cat', 'secret')], finishedConfirmedRoomId: 'room-1', connectionState: 'connected',
    resumeGeneration: 3, resumeFlight: Promise.resolve(), handRetryFlight: Promise.resolve(),
    makeRequest: { actionId: 'old' }, judgeRequest: { actionId: 'old' },
    makeBusy: true, judgeBusy: true, entryBusy: false, lastSuccessfulResumeAt: 42,
    lastSuccessfulResumeRoomId: 'room-1' };
  const events = [];
  const forgot = resumeHelpers.forgetFinishedRoom({
    state, storage,
    stopRealtime: () => { events.push('stop'); },
    retirePresence: () => { events.push('retire'); return new Promise(() => {}); },
    forgetInvite: (roomId) => { assert.equal(roomId, 'room-1'); events.push('invite'); },
    resetEntryView: () => {
      events.push('entry'); state.roomId = null; state.seatId = null; state.room = null;
      state.cards = []; state.makeRequest = null; state.judgeRequest = null;
      state.makeBusy = false; state.judgeBusy = false; state.finishedConfirmedRoomId = null;
    },
  });
  assert.equal(forgot, true);
  assert.deepEqual(events, ['stop', 'retire', 'invite', 'entry']);
  assert.equal(core.loadRoom(storage), null);
  assert.equal(state.resumeGeneration, 4);
  assert.equal(state.room, null);
  assert.equal(state.cards.length, 0);
  assert.equal(state.makeRequest, null);
  assert.equal(state.judgeRequest, null);
  assert.equal(state.resumeFlight, null);
  assert.equal(state.handRetryFlight, null);
  assert.equal(state.lastSuccessfulResumeRoomId, null);
  assert.equal(state.handStatus, 'pending');
  assert.match(multiClient, /stopRealtime\(\)/);
  assert.match(multiClient, /\$\('display-name'\)\.value = ''; \$\('invite-code'\)\.value = ''/);
  assert.match(multiClient, /\$\('gathering-overlay'\)\.classList\.add\('hidden'\)/);
  assert.match(multiClient, /setConnectionState\('connected'\)/);
  assert.doesNotMatch(resumeHelpers.forgetFinishedRoom.toString(), /httpsCallable|Firestore|deleteDoc/);
});

test('waiting/playing中は新しく遊ぶ操作からcredentialもserver roomも変更しない', () => {
  for (const status of [core.ROOM_STATUS.WAITING, core.ROOM_STATUS.PLAYING]) {
    const storage = fakeStorage();
    core.saveRoom(storage, { roomId: 'room-1', seatId: 'S1' });
    const state = { roomId: 'room-1', seatId: 'S1', room: { status },
      finishedConfirmedRoomId: 'room-1', connectionState: 'connected', resumeGeneration: 3 };
    const fail = () => { throw new Error('未完了roomには触れてはいけない'); };
    assert.equal(resumeHelpers.forgetFinishedRoom({ state, storage,
      stopRealtime: fail, retirePresence: fail, forgetInvite: fail, resetEntryView: fail }), false);
    assert.deepEqual(core.loadRoom(storage), { roomId: 'room-1', seatId: 'S1' });
    assert.equal(state.resumeGeneration, 3);
  }
});

test('古いresumeが入口復帰後に失敗しても新しい接続状態を書き換えない', async () => {
  let rejectOld;
  const state = { resumeFlight: null, connectionState: 'connected',
    lastSuccessfulResumeAt: 0, lastSuccessfulResumeRoomId: null };
  let roomId = 'room-1';
  const errors = [];
  const requestResume = resumeHelpers.createMultiResumeCoordinator({
    state, getRoomId: () => roomId,
    runResume: () => new Promise((_, reject) => { rejectOld = reject; }),
    onError: (error) => errors.push(error.message),
  });
  const oldFlight = requestResume('lifecycle');
  await Promise.resolve();
  roomId = null;
  state.resumeFlight = null;
  rejectOld(new Error('old connection'));
  await oldFlight;
  assert.deepEqual(errors, []);
  assert.equal(state.connectionState, 'connected');
  assert.equal(state.resumeFlight, null);
});

/* ------------------------------------------------------------------ presence */

test('E-10 presence: 接続中／再接続待ちの表示と、再接続待ちの案内は手番・判定の人だけ', () => {
  const room = playingRoom(6, { currentTurnPlayerId: 'S4' });
  const presenceValue = {
    'uid-S1': { connections: { a: connection('uid-S1', 'S1', 1_000) } },
    'uid-S2': { connections: { a: connection('uid-S2', 'S2', 121_000) } },
    'uid-S3': { connections: { a: connection('uid-S3', 'S3', 120_000) } },
  };
  const view = core.gameView(room, 'S1', presenceValue, { presenceReady: true, now: NOW });
  const bySeat = Object.fromEntries([view.self, ...view.others].map((seat) => [seat.seatId, seat]));
  assert.equal(bySeat.S1.presenceText, core.TEXT.chipOnline);
  assert.equal(bySeat.S1.online, true);
  assert.equal(bySeat.S2.presenceText, core.TEXT.chipReconnecting, '121秒は再接続待ち');
  assert.equal(bySeat.S2.online, false);
  assert.equal(bySeat.S3.presenceText, core.TEXT.chipOnline, 'ちょうど120秒は接続中');
  assert.equal(bySeat.S4.presenceText, '', 'presence未受信の席は断定しない');
  assert.equal(bySeat.S2.status, rules.PLAYER_STATUS.ACTIVE, 'staleを退出扱いしている');
  // 手番の人がstale（S2）のときだけ案内を出し、ほかのstaleやpresence未受信では出さない
  // —— ただし手番者本人の接続をまだ確認できないS4は「再接続待ち」として案内する。
  assert.equal(view.reconnect.seatId, 'S4');
  assert.equal(view.reconnect.text, 'あいて3の再接続を待っています');

  const waiting = core.gameView(playingRoom(6, { currentTurnPlayerId: 'S2' }), 'S1', presenceValue, { presenceReady: true, now: NOW });
  assert.equal(waiting.reconnect.seatId, 'S2');
  assert.equal(waiting.reconnect.text, 'あいて1の再接続を待っています');
  const selfWaiting = core.gameView(playingRoom(6, { currentTurnPlayerId: 'S2' }), 'S2', presenceValue, { presenceReady: true, now: NOW });
  assert.equal(selfWaiting.reconnect.isSelf, true);
  assert.equal(selfWaiting.reconnect.text, core.TEXT.reconnectSelf);

  const judging = core.gameView(playingRoom(6, {
    turnState: rules.TURN_STATE.AWAITING_JUDGMENT,
    currentTurnPlayerId: 'S5',
    publicOffer: { status: 'pending', fromPlayerId: 'S5', toPlayerId: 'S2', claimAnimal: 'cat' },
  }), 'S1', presenceValue, { presenceReady: true, now: NOW });
  assert.equal(judging.reconnect.seatId, 'S2', '判定者がstaleのときに待つ');
});

/* -------------------------------------------------------------------- 結果 */

test('E-11 結果: 集合（4枚／8種類）だけロゴ演出、同率優勝とhand-emptyは演出なし', () => {
  const four = baseRoom(4, {
    status: rules.ROOM_STATUS.FINISHED, dealt: true, turnState: rules.TURN_STATE.FINISHED, turnNumber: 18,
    finishReason: rules.FINISH_REASON.GATHERING, gatheringReason: rules.GATHERING_REASON.FOUR_OF_A_KIND,
    winnerPlayerIds: ['S1', 'S3', 'S4'], loserPlayerIds: ['S2'],
    faceUpCards: { S1: [], S2: [card('cat', '1'), card('cat', '2'), card('cat', '3'), card('cat', '4')], S3: [], S4: [] },
    handCounts: { S1: 3, S2: 2, S3: 4, S4: 1 },
    finalResult: { finishReason: 'gathering', gatheringReason: 'four-of-a-kind', winnerPlayerIds: ['S1', 'S3', 'S4'], loserPlayerIds: ['S2'], draw: false, players: [{ seatId: 'S1', status: 'active', handCount: 3 }, { seatId: 'S2', status: 'active', handCount: 2 }, { seatId: 'S3', status: 'active', handCount: 4 }, { seatId: 'S4', status: 'active', handCount: 1 }] },
  });
  const result = core.resultView(four, 'S1');
  assert.equal(result.kind, 'gathering');
  assert.equal(result.showGatheringOverlay, true);
  assert.equal(result.logoPath, `${core.ASSET_BASE}mofumofu-logo.png`);
  assert.equal(result.reason, 'ねこが4枚そろってしまいました');
  assert.equal(result.title, 'もふもふ大集合！ あいて1の負け');
  assert.equal(result.eliminationAnimal, 'cat');
  assert.equal(result.players.find((player) => player.seatId === 'S2').verdict, core.TEXT.loserVerdict);
  assert.equal(result.players.find((player) => player.seatId === 'S1').verdict, core.TEXT.winVerdict);
  assert.equal(result.draw, false);
  assert.equal(core.isGatheringResult(four), true);

  const eight = baseRoom(3, {
    status: rules.ROOM_STATUS.FINISHED, finishReason: rules.FINISH_REASON.GATHERING,
    gatheringReason: rules.GATHERING_REASON.ALL_EIGHT_TYPES, winnerPlayerIds: ['S1', 'S2'], loserPlayerIds: ['S3'],
    faceUpCards: { S3: core.ANIMALS.map((animalType, index) => card(animalType, `c${index}`)) },
  });
  assert.equal(core.resultView(eight, 'S1').reason, '全8種類の動物が表向きにそろってしまいました');

  // hand-empty: 演出なし＋表向き合計が最少の人が勝ち。同率なら全員の名前を出す。
  const handEmpty = baseRoom(3, {
    status: rules.ROOM_STATUS.FINISHED, finishReason: rules.FINISH_REASON.HAND_EMPTY, draw: false,
    winnerPlayerIds: ['S1', 'S3'], loserPlayerIds: [], handCounts: { S1: 0, S2: 4, S3: 1 },
    faceUpCards: { S1: [], S2: [card('bear', 'x')], S3: [] },
    finalResult: { finishReason: 'hand-empty', winnerPlayerIds: ['S1', 'S3'], draw: false, players: [{ seatId: 'S1', handCount: 0 }, { seatId: 'S2', handCount: 4 }, { seatId: 'S3', handCount: 1 }] },
  });
  const empty = core.resultView(handEmpty, 'S1');
  assert.equal(empty.kind, 'hand-empty');
  assert.equal(core.isGatheringResult(handEmpty), false);
  assert.equal(empty.showGatheringOverlay, false, 'draw/hand-emptyでロゴ演出を出している');
  assert.equal(empty.draw, false);
  assert.equal(empty.title, core.TEXT.tiedWinners);
  assert.equal(empty.winnerText, 'あなた・あいて2が同率で勝ち！');
  assert.equal(empty.reason, core.TEXT.handEmptyNote);
  assert.equal(empty.logoPath, `${core.ASSET_BASE}mofumofu-logo.png`);

  // draw=true だけで集合演出を出さない。
  const drawn = { ...handEmpty, draw: true, winnerPlayerIds: [], finalResult: { ...handEmpty.finalResult, draw: true, winnerPlayerIds: [] } };
  const drawView = core.resultView(drawn, 'S2');
  assert.equal(drawView.showGatheringOverlay, false);
  assert.equal(drawView.draw, true);
  assert.equal(drawView.kind, 'hand-empty');

  // too-few-active は結果表示のみ（退出ボタン等は出さない）。
  const few = baseRoom(3, { status: rules.ROOM_STATUS.FINISHED, finishReason: rules.FINISH_REASON.TOO_FEW_ACTIVE, winnerPlayerIds: [], loserPlayerIds: [] });
  const fewView = core.resultView(few, 'S1');
  assert.equal(fewView.kind, 'too-few-active');
  assert.equal(fewView.showGatheringOverlay, false);
  assert.equal(fewView.reason, core.TEXT.tooFewActiveNote);
  assert.equal(core.resultView(playingRoom(3), 'S1'), null);
});

/* --------------------------------------------------- 復帰（resume）と失敗時 */

test('E-12 resume: 復帰の順序と、古い世代の結果を反映しない中断', async () => {
  const calls = [];
  const deps = {
    auth: { authStateReady: async () => { calls.push('auth'); }, currentUser: null },
    signInAnonymously: async () => { calls.push('signIn'); },
    isCurrent: () => true,
    retirePresence: async () => { calls.push('retire'); },
    createConnectionId: () => 'cn-1',
    authorizePresence: async (connectionId) => { calls.push(`authorize:${connectionId}`); return { seatId: 'S3', expiresAt: NOW + 1 }; },
    beginPresence: async (seatId, connectionId) => { calls.push(`begin:${seatId}:${connectionId}`); },
    resumeRoom: async () => { calls.push('resume'); return { seatId: 'S3', cards: [], handStatus: 'ready', status: 'playing' }; },
    applyResume: async (value, connectionId) => { calls.push(`apply:${value.seatId}:${connectionId}`); },
  };
  assert.equal(await resumeHelpers.runMofumofuMultiFullResume(deps), true);
  assert.deepEqual(calls, ['auth', 'signIn', 'retire', 'authorize:cn-1', 'begin:S3:cn-1', 'resume', 'apply:S3:cn-1']);

  // resume応答が返る前に世代が変わったら、applyResumeを呼ばない（古い結果を反映しない）。
  const staleCalls = [];
  const stale = {
    ...deps,
    isCurrent: () => staleCalls.length < 3,
    retirePresence: async () => { staleCalls.push('retire'); },
    authorizePresence: async () => { staleCalls.push('authorize'); return { seatId: 'S1' }; },
    beginPresence: async () => { staleCalls.push('begin'); },
  };
  assert.equal(await resumeHelpers.runMofumofuMultiFullResume(stale), false);
  assert.deepEqual(staleCalls, ['retire', 'authorize', 'begin'], '古い世代でpresence開始まで進んでいる');
});

test('E-13 resume失敗: 4つの理由だけ保存roomを解除して入口へ戻し、他は通常エラーに流す', () => {
  const notices = [];
  for (const [reason, code] of [['room-not-found', 'not-found'], ['not-member', 'permission-denied'], ['room-expired', 'failed-precondition'], ['room-status', 'failed-precondition']]) {
    const storage = fakeStorage();
    core.saveRoom(storage, { roomId: 'room-1', seatId: 'S2' });
    core.rememberInvite(storage, 'room-1', 'ABCD2345');
    let reset = 0;
    const handled = resumeHelpers.handleMultiSessionFailure({
      error: { code: `functions/${code}`, details: { reason } },
      storage,
      forgetInvite: () => {},
      resetEntryView: () => { reset += 1; },
      message: (text) => notices.push(text),
    });
    assert.equal(handled, reason, `${reason} を解除対象と判定できていない`);
    assert.equal(core.loadRoom(storage), null, `${reason} で保存roomが残っている`);
    assert.equal(reset, 1);
  }
  // 無関係なエラーは握り潰さない。
  const storage = fakeStorage();
  core.saveRoom(storage, { roomId: 'room-1', seatId: 'S2' });
  const handled = resumeHelpers.handleMultiSessionFailure({
    error: { code: 'functions/internal', message: 'boom' },
    storage, forgetInvite: () => {}, resetEntryView: () => { throw new Error('resetしてはいけない'); }, message: () => {},
  });
  assert.equal(handled, null);
  assert.deepEqual(core.loadRoom(storage), { roomId: 'room-1', seatId: 'S2' });
  assert.equal(notices.length, 4);
  assert.equal(new Set(notices).size, 4, '理由ごとに違う案内を出していない');
});

test('確定した保存room失敗は、既に隠れた入口を再表示して新規作成・参加を使えるようにする', () => {
  const screenSource = multiClient.slice(multiClient.indexOf('function showScreen(room) {'), multiClient.indexOf('function renderLobby(room) {'));
  const resetSource = multiClient.slice(multiClient.indexOf('function renderAll() {'), multiClient.indexOf('/* -------------------------------------------------------------------- 通信 */'));
  for (const [reason, code] of [
    ['room-expired', 'failed-precondition'], ['room-not-found', 'not-found'],
    ['not-member', 'permission-denied'], ['room-status', 'failed-precondition'],
  ]) {
    const storage = fakeStorage();
    core.saveRoom(storage, { roomId: 'room-1', seatId: 'S2' });
    const nodes = new Map();
    const $ = (id) => {
      if (!nodes.has(id)) nodes.set(id, { hidden: false, disabled: false, textContent: '',
        replaceChildren(...children) { this.children = children; } });
      return nodes.get(id);
    };
    const state = { room: { status: core.ROOM_STATUS.PLAYING }, roomId: 'room-1', seatId: 'S2',
      cards: [card('cat', 'private-card')], entryBusy: false, makeRequest: null, judgeRequest: null };
    const ui = { cardId: 'private-card', claim: 'cat', lastLogKey: 'old', gatheringShown: true };
    const context = { $, state, ui, core, renderGame: () => {}, renderLobby: () => {} };
    const { renderAll, resetEntryView } = vm.runInNewContext(`${screenSource}\n${resetSource}\n({ renderAll, resetEntryView })`, context);
    renderAll();
    assert.equal($('entry').hidden, true, `${reason}: 事前に入口が隠れていない`);
    const transient = resumeHelpers.handleMultiSessionFailure({
      error: { code: 'functions/unavailable' }, storage, forgetInvite: () => {},
      resetEntryView: () => { throw new Error('通信失敗で入口へ戻してはならない'); }, message: () => {},
    });
    assert.equal(transient, null);
    assert.deepEqual(core.loadRoom(storage), { roomId: 'room-1', seatId: 'S2' });
    assert.equal(state.roomId, 'room-1');
    assert.equal($('entry').hidden, true);
    const handled = resumeHelpers.handleMultiSessionFailure({
      error: { code: `functions/${code}`, details: { reason } }, storage,
      forgetInvite: () => {}, resetEntryView, message: (value) => { $('status').textContent = value; },
    });
    assert.equal(handled, reason);
    assert.equal(core.loadRoom(storage), null);
    assert.equal(state.room, null);
    assert.equal(state.roomId, null);
    assert.equal(state.seatId, null);
    assert.equal(state.cards.length, 0);
    assert.equal($('entry').hidden, false, `${reason}: 入口が非表示のまま`);
    assert.equal($('lobby').hidden, true);
    assert.equal($('game').hidden, true);
    assert.equal($('create-room').disabled, false);
    assert.equal($('join-room').disabled, false);
    assert.equal($('status').textContent, core.sessionRecoveryNotice(reason));
  }
});

test('E-14 復帰の同時実行: 1本にまとめ、lifecycleの連続発火はcooldownで吸収する', async () => {
  const state = { resumeFlight: null, connectionState: 'connected', lastSuccessfulResumeRoomId: null, lastSuccessfulResumeAt: 0 };
  let runs = 0;
  let clock = 0;
  const requestResume = resumeHelpers.createMultiResumeCoordinator({
    state, getRoomId: () => 'room-1', runResume: async () => { runs += 1; }, onError: () => {}, now: () => clock, cooldownMs: 1_500,
  });
  await Promise.all([requestResume('create-room'), requestResume('create-room'), requestResume('heartbeat-error')]);
  assert.equal(runs, 1, '復帰が多重実行されている');
  await requestResume('lifecycle');
  assert.equal(runs, 1, 'lifecycleの連続発火を吸収できていない');
  clock += 5_000;
  await requestResume('lifecycle');
  assert.equal(runs, 2);
  const failingState = { resumeFlight: null, connectionState: 'connected', lastSuccessfulResumeRoomId: null, lastSuccessfulResumeAt: 0 };
  let failedRuns = 0;
  const failing = resumeHelpers.createMultiResumeCoordinator({
    state: failingState,
    getRoomId: () => 'room-1',
    runResume: async () => { failedRuns += 1; throw new Error('boom'); },
    onError: () => {},
  });
  await failing('manual');
  assert.equal(failingState.resumeFlight, null, '失敗後もflightが残っている');
  await failing('manual');
  assert.equal(failedRuns, 2, '失敗後に次の復帰を実行できない');
});

test('開始通知で本人の未取得手札だけを一度resumeし、通常更新と取得済み手札を除外する', async () => {
  const waiting = baseRoom(3);
  const playing = playingRoom(3);
  const state = {
    roomId: playing.roomId, seatId: 'S2', room: playing, cards: [], handStatus: 'pending',
    resumeFlight: null, connectionState: 'connected',
  };
  const reasons = [];
  const onRoom = resumeHelpers.createMultiHandStartResume({
    state, requestResume: (reason) => { reasons.push(reason); return Promise.resolve(); },
  });
  onRoom(waiting, playing);
  onRoom(playing, { ...playing, turnNumber: 2 });
  assert.deepEqual(reasons, ['hand-on-game-start']);
  state.roomId = 'next-room';
  onRoom(waiting, { ...playing, roomId: 'next-room' });
  assert.deepEqual(reasons, ['hand-on-game-start', 'hand-on-game-start'], '別roomでも開始通知を扱う');
  assert.match(multiClient, /const previousRoom = state\.room;\s*state\.room = room;\s*state\.finishedConfirmedRoomId = fromServer[^;]+;\s*renderAll\(\);\s*onHandStart\(previousRoom, room\)/);
  assert.match(multiPage, /id="hand-loading"[^>]*>手札を読み込んでいます…<\/p>/);
  assert.match(multiClient, /\$\('hand-loading'\)\.hidden = !\(state\.room\?\.status === core\.ROOM_STATUS\.PLAYING[\s\S]*?state\.handStatus === 'pending' && state\.cards\.length === 0/);

  for (const patch of [
    { cards: [card('cat', 'own-card')], handStatus: 'ready' },
    { roomId: null },
    { seatId: null },
  ]) {
    const own = { ...state, cards: [], handStatus: 'pending', ...patch };
    resumeHelpers.createMultiHandStartResume({ state: own, requestResume: () => { throw new Error('不要なresume'); } })(waiting, playing);
  }
  const former = { ...state, cards: [], handStatus: 'pending' };
  resumeHelpers.createMultiHandStartResume({ state: former, requestResume: () => { throw new Error('他人の手札を取得してはならない'); } })(
    waiting, playingRoom(3, { playerStatus: { ...playing.playerStatus, S2: 'left' } }),
  );
  assert.match(multiClient, /call\('resumeMofumofuMultiRoom', \{ roomId: state\.roomId \}\)/);
  assert.doesNotMatch(multiClient, /privateHands\//);
});

test('開始通知と初期・visibilitychange・pageshow復帰の近接時は同時Callableを発行しない', async () => {
  const waiting = baseRoom(3);
  const playing = playingRoom(3);
  const state = {
    roomId: playing.roomId, seatId: 'S1', room: playing, cards: [], handStatus: 'pending',
    resumeFlight: null, connectionState: 'connected', lastSuccessfulResumeRoomId: null, lastSuccessfulResumeAt: 0,
  };
  let release;
  let runs = 0;
  const requestResume = resumeHelpers.createMultiResumeCoordinator({
    state, getRoomId: () => state.roomId,
    runResume: async () => { runs += 1; await new Promise((resolve) => { release = resolve; }); },
    onError: () => {},
  });
  const initial = requestResume('initial');
  await Promise.resolve();
  const onRoom = resumeHelpers.createMultiHandStartResume({ state, requestResume });
  onRoom(waiting, playing);
  const visible = requestResume('lifecycle');
  const page = requestResume('lifecycle');
  assert.equal(runs, 1);
  release();
  await Promise.all([initial, visible, page]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 2, '初期復帰が手札を返さなかった場合に限り一度取り直す');
  onRoom(playing, { ...playing, turnNumber: 2 });
  assert.equal(runs, 2);
  state.cards = [card('cat', 'own-card')];
  state.handStatus = 'ready';
  release();
  await state.resumeFlight;

  // 初期復帰がすでに手札を返した場合は追加resumeなし。
  const ready = { ...state, cards: [], handStatus: 'pending', resumeFlight: null };
  let finish;
  const flight = new Promise((resolve) => { finish = resolve; });
  ready.resumeFlight = flight;
  let additional = 0;
  resumeHelpers.createMultiHandStartResume({ state: ready, requestResume: () => { additional += 1; } })(waiting, playing);
  ready.cards = [card('cat', 'own-card')];
  ready.handStatus = 'ready';
  finish();
  await flight;
  await Promise.resolve();
  assert.equal(additional, 0);
});

test('背景復帰: make/judgeの応答喪失を同一payloadで一度確認し、次の操作を開放する', async () => {
  for (const kind of ['make', 'judge']) {
    const request = kind === 'make'
      ? { roomId: 'room-1', actionId: 'action-1', cardId: 'own-card', claimedAnimalType: 'cat', targetPlayerId: 'S2' }
      : { roomId: 'room-1', actionId: 'action-2', judgment: 'truth' };
    const state = { roomId: 'room-1', room: { status: 'playing', publicOffer: null },
      makeRequest: kind === 'make' ? request : null, judgeRequest: kind === 'judge' ? request : null,
      makeBusy: kind === 'make', judgeBusy: kind === 'judge', actionRecoveryFlight: null };
    let finish;
    const calls = [];
    let refreshed = 0;
    const recover = actionHelpers.createMultiPendingActionRecovery({
      state, replay: (type, payload) => { calls.push({ type, payload }); return new Promise((resolve) => { finish = resolve; }); },
      refresh: async () => { refreshed += 1; }, onUncertain: () => {}, onRejected: () => {},
    });
    const first = recover();
    const nearEvents = [recover(), recover()]; // visibilitychange + pageshow + online
    await Promise.resolve();
    assert.equal(calls.length, 1, `${kind}: 同時再送している`);
    assert.equal(actionHelpers.multiActionBlocked(state), true);
    assert.deepEqual(calls[0], { type: kind, payload: request });
    finish({ roomId: 'room-1' });
    await Promise.all([first, ...nearEvents]);
    assert.equal(calls.length, 1);
    assert.equal(refreshed, 1);
    assert.equal(state[`${kind}Request`], null);
    assert.equal(state[`${kind}Busy`], false);
    assert.equal(actionHelpers.multiActionBlocked(state), false);
  }
});

test('背景復帰: makeの公開actionId一致は成立済み。未一致とjudgeは元ID再送で判定する', async () => {
  const request = { roomId: 'room-1', actionId: 'action-1', cardId: 'own-card', claimedAnimalType: 'cat', targetPlayerId: 'S2' };
  const state = { roomId: 'room-1', room: { publicOffer: { actionId: 'action-1', status: 'completed' } },
    makeRequest: request, judgeRequest: null, makeBusy: true, judgeBusy: false, actionRecoveryFlight: null };
  let calls = 0;
  const recover = actionHelpers.createMultiPendingActionRecovery({ state,
    replay: async () => { calls += 1; }, refresh: async () => {}, onUncertain: () => {}, onRejected: () => {} });
  await recover();
  assert.equal(calls, 0);
  assert.equal(state.makeRequest, null);
  assert.equal(state.makeBusy, false);
  state.room = { publicOffer: { actionId: 'some-other-action', status: 'pending' } };
  state.makeRequest = request;
  state.makeBusy = true;
  await recover();
  assert.equal(calls, 1, '公開offer不一致だけで未成立と断定してはならない');
});

test('背景復帰: 不明な通信失敗は保留payloadを保持し、明確な拒否は有限回で止める', async () => {
  const request = { roomId: 'room-1', actionId: 'action-1', judgment: 'truth' };
  const state = { roomId: 'room-1', room: { publicOffer: null }, makeRequest: null, judgeRequest: request,
    makeBusy: false, judgeBusy: true, actionRecoveryFlight: null };
  let attempts = 0;
  const errors = [];
  const recover = actionHelpers.createMultiPendingActionRecovery({ state,
    replay: async () => { attempts += 1; throw { code: attempts === 1 ? 'functions/unavailable' : 'functions/failed-precondition' }; },
    refresh: async () => {}, onUncertain: () => errors.push('uncertain'), onRejected: () => errors.push('rejected') });
  await recover();
  assert.equal(attempts, 1);
  assert.equal(state.judgeRequest, request, '通信不明時はpayloadを失わない');
  assert.equal(actionHelpers.multiActionBlocked(state), true);
  await recover();
  assert.equal(attempts, 2);
  assert.deepEqual(errors, ['uncertain', 'rejected']);
  assert.equal(state.judgeRequest, null);
  assert.equal(actionHelpers.multiActionBlocked(state), false);
});

test('背景復帰: 操作なしは再送せず、時間切れも一度で止めて次回の確認用payloadを残す', async () => {
  const state = { roomId: 'room-1', room: {}, makeRequest: null, judgeRequest: null,
    makeBusy: false, judgeBusy: false, actionRecoveryFlight: null };
  let attempts = 0;
  let uncertain = 0;
  const recover = actionHelpers.createMultiPendingActionRecovery({ state, timeoutMs: 5,
    replay: () => { attempts += 1; return new Promise(() => {}); },
    refresh: async () => {}, onUncertain: () => { uncertain += 1; }, onRejected: () => {} });
  await recover();
  assert.equal(attempts, 0);
  state.makeRequest = { roomId: 'room-1', actionId: 'action-1', cardId: 'own-card', claimedAnimalType: 'cat', targetPlayerId: 'S2' };
  await recover();
  assert.equal(attempts, 1);
  assert.equal(uncertain, 1);
  assert.ok(state.makeRequest, '時間切れでactionIdを捨てない');
  assert.equal(state.actionRecoveryFlight, null);
  await recover();
  assert.equal(attempts, 1, '前回の再送が未完了なら新しいCallableを重ねない');
});

test('背景復帰: 遅れて届いた元のmake応答は回復済みの次の操作を変更しない', async () => {
  const source = multiClient.slice(multiClient.indexOf('async function submitOffer('), multiClient.indexOf('async function submitJudgment('));
  const state = { roomId: 'room-1', seatId: 'S1', room: playingRoom(3, { roomId: 'room-1' }),
    makeRequest: null, judgeRequest: null, makeBusy: false, judgeBusy: false, actionRecoveryFlight: null };
  const ui = { cardId: 'own-card', claim: 'cat' };
  let finishOriginal;
  const calls = [];
  const context = { state, ui, core, multiActionBlocked: actionHelpers.multiActionBlocked,
    definitiveMultiActionRejection: actionHelpers.definitiveMultiActionRejection,
    newId: () => 'action-1', $: () => ({ children: [{ disabled: false }] }),
    renderGame: () => {}, message: () => {}, recoverPendingActions: () => {},
    call: (name, request) => { calls.push({ name, request }); return new Promise((resolve) => { finishOriginal = resolve; }); } };
  const submit = vm.runInNewContext(`${source}; submitOffer`, context);
  const original = submit('S2', { disabled: false });
  const pending = state.makeRequest;
  assert.equal(state.makeBusy, true);
  const recover = actionHelpers.createMultiPendingActionRecovery({ state,
    replay: async (kind, request) => { calls.push({ name: kind, request }); return { ok: true }; },
    refresh: async () => {}, onUncertain: () => {}, onRejected: () => {} });
  await recover();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].request, pending);
  assert.equal(calls[1].request, pending, '新しいpayloadを作っていない');
  state.makeRequest = { roomId: 'room-1', actionId: 'action-2', cardId: 'next-card', claimedAnimalType: 'dog', targetPlayerId: 'S3' };
  state.makeBusy = true;
  ui.cardId = 'next-card'; ui.claim = 'dog';
  finishOriginal({ ok: true });
  await original;
  assert.equal(state.makeRequest.actionId, 'action-2');
  assert.equal(state.makeBusy, true);
  assert.equal(ui.cardId, 'next-card');
});

test('判定ボタンは後のターンでも正本とbusyに合わせて有効に戻す', () => {
  const state = { makeBusy: false, judgeBusy: false, makeRequest: null, judgeRequest: null, actionRecoveryFlight: null };
  assert.equal(actionHelpers.multiJudgeButtonsDisabled({ canJudge: true }, state), false);
  state.judgeBusy = true;
  assert.equal(actionHelpers.multiJudgeButtonsDisabled({ canJudge: true }, state), true);
  state.judgeBusy = false;
  assert.equal(actionHelpers.multiJudgeButtonsDisabled({ canJudge: false }, state), true);
  assert.equal(actionHelpers.multiJudgeButtonsDisabled({ canJudge: true }, state), false, '次の判定役では有効に戻す');
  assert.match(multiClient, /for \(const node of \$\('judge-buttons'\)\.querySelectorAll\('button'\)\) node\.disabled = multiJudgeButtonsDisabled\(view, state\)/);
  assert.match(multiClient, /const recovery = recoverPendingActions\(generation\)/);
});

/* ------------------------------------------------------------ あそびかた・禁止 */

test('E-15 あそびかた: いま遊べるルールだけを書き、未実装の機能は載せない', () => {
  const flat = core.helpTextFlat().join('\n');
  for (const required of ['3人から6人まで', '3人=10枚', '4人=8枚', '5人=6枚', '6人=5枚', '最大5人', '受け取った本人だけ', '同率', '再接続待ち']) {
    assert.ok(flat.includes(required), `あそびかたに ${required} が無い`);
  }
  assert.equal(/NPC|こはる|観戦|40枚|途中で抜ける|部屋を閉じる|まだありません|まだできません/.test(flat), false, '未実装の機能をあそびかたに書いている');
  // ページ側のダイアログはmulti-coreの文面から描く（文面の二重管理をしない）。
  assert.ok(multiClient.includes('core.helpSections()'), 'あそびかたを自前で書いている');
  assert.ok(multiPage.includes('id="help-body"'));
});

test('E-16 未実装機能をUIとクライアントに出さない（部屋を閉じる・観戦・NPC・40枚）', () => {
  const ui = `${multiPage}\n${multiClient}\n${multiEntry}`;
  assert.equal(ui.includes('close-room'), false, '2人版の閉室UIが混ざっている');
  assert.equal(ui.includes('closeMofumofuMultiRoom'), false, '未実装の閉室Callableを呼んでいる');
  assert.ok(ui.includes('leaveMofumofuMultiGame'), '明示退出Callableがない');
  assert.equal(ui.includes('観戦'), false);
  assert.equal(ui.includes('NPC'), false);
  assert.equal(/\b40枚\b/.test(ui), false);
  assert.equal(ui.includes('id="offer-card"'), false);
  assert.equal(ui.includes('<select'), false, 'selectを使っている（既存UI契約と不一致）');
  // 未実装機能のためのCSS/ボタンも置かない。
  assert.equal(/\.close-room|\.spectator/.test(multiStyle), false);
});

/* --------------------------------------------------------------- Firebase結線 */

test('E-17 Firebase結線: 専用Callableだけを使い、Firestoreへの書き込みを行わない', () => {
  for (const callable of [
    'createMofumofuMultiRoom', 'joinMofumofuMultiRoom', 'startMofumofuMultiGame',
    'makeMofumofuMultiOffer', 'judgeMofumofuMultiOffer',
    'leaveMofumofuMultiGame',
    'authorizeMofumofuMultiPresence', 'resumeMofumofuMultiRoom',
  ]) {
    assert.ok(multiClient.includes(callable), `${callable} を使っていない`);
  }
  assert.equal(/\b(setDoc|updateDoc|addDoc|deleteDoc)\b/.test(multiClient), false, 'clientがFirestoreへ書き込んでいる');
  assert.ok(multiClient.includes('onSnapshot(doc(firestore, ROOM_COLLECTION, state.roomId)'), '公開roomの購読が無い');
  assert.ok(multiClient.includes("const ROOM_COLLECTION = 'mofumofuMultiRooms'"));
  assert.ok(multiClient.includes('getDocFromServer'), '安全同期（server読み）が無い');
  // RTDBへ書くのはpresence（自分のconnection node）だけ。
  assert.ok(multiClient.includes('core.RTDB_ROOTS.presence'), 'presenceルートを自前で書いている');
  assert.ok(multiClient.includes('onDisconnect(ownPresenceRef)'));
  assert.ok(multiClient.includes('core.HEARTBEAT_INTERVAL_MS'));
  assert.ok(multiClient.includes('core.ACCESS_REFRESH_MS'));
  assert.equal(/\b15000\b|\b120000\b/.test(multiClient), false, '周期・境界を自前の数値で持っている');
  assert.ok(multiConfig.includes('firebase.mofumofu-multi-emulator.json') || multiConfig.includes('firestorePort: 8181'));
  assert.ok(multiConfig.includes('databasePort: 9000'));
  assert.ok(multiConfig.includes('functionsPort: 5102'));
  assert.ok(multiConfig.includes("export const REGION = 'asia-northeast1'"));
  assert.equal(multiConfig.includes('mofumofu-multi'), true);
});

/* -------------------------------------------------------------------- viewport */

test('E-18 viewport: 320/360/390で崩れないCSS契約（実ブラウザ確認は別枠）', () => {
  // 他の参加者は2列折返し、自分は下に固定。
  assert.ok(multiStyle.includes('.others-grid{display:grid;grid-template-columns:1fr 1fr'), '他席が2列グリッドでない');
  assert.ok(multiStyle.includes('.self-seat{position:sticky;bottom:'), '自分が下固定でない');
  assert.ok(multiStyle.includes('.hand{display:flex'), '手札がflexでない');
  assert.ok(/\.hand\{[^}]*overflow-x:auto/.test(multiStyle), '手札が横スクロールでない');
  assert.ok(multiStyle.includes('@media(max-width:360px)'), '320/360px幅の調整が無い');
  assert.ok(multiStyle.includes('body{overflow-x:hidden'), '横overflowの抑制が無い');
  assert.ok(/dialog\{[^}]*max-height:85dvh/.test(multiStyle), 'ダイアログが画面内に収まらない');
  assert.ok(/dialog\{[^}]*overflow:auto/.test(multiStyle), '長いダイアログをスクロールできない');
  assert.ok(multiStyle.includes('.face-line'), '表向きカードの行が無い');
  // 44px以上のタップ領域。
  assert.ok(multiStyle.includes('button,select,input,a{min-height:44px}'));
  assert.ok(/\.animal-buttons button,\.target-buttons button\{min-height:46px/.test(multiStyle));
  assert.ok(/\.judge-buttons button\{min-height:62px/.test(multiStyle));
  assert.ok(/\.hand-card\{flex:0 0 64px;height:88px/.test(multiStyle));
  // 320px幅を超える固定幅を置かない。
  assert.equal(/(?<!max-|min-)width:\s*(3[3-9][0-9]|[4-9][0-9]{2,})px/.test(multiStyle), false, '320px超の固定幅がある');
  assert.ok(multiStyle.includes('width:min(100%,520px)'), 'アプリ枠が可変幅でない');
  // 画面の骨格は320pxでも横並びが崩れない順序で置く（他席→盤面→手札→自分）。
  const order = ['id="others"', 'class="table-center"', 'id="hand"', 'id="self-seat"'].map((token) => multiPage.indexOf(token));
  assert.equal(order.every((index) => index > 0), true, '必須要素が無い');
  assert.deepEqual([...order].sort((a, b) => a - b), order, '自分より上に他席が無い（並び順が逆）');
  assert.ok(multiPage.includes('class="others-grid"'));
});

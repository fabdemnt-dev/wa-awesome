import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

function between(source, start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.notEqual(a, -1, `開始位置が見つかりません: ${start}`);
  assert.notEqual(b, -1, `終了位置が見つかりません: ${end}`);
  return source.slice(a, b);
}

test('俳句のroom更新はplaying中に盤面を再描画する', async () => {
  const source = await fs.readFile(new URL('../haiku-room.js', import.meta.url), 'utf8');
  const apply = between(source, 'function applyRoomData', '\n// ブラウザがバックグラウンド');
  const playing = between(apply, "} else if (state.currentData.status === 'playing')", '\n  const statusChanged');
  assert.match(playing, /renderBoards\(\);/);
});

test('hand Snapshotは手札だけを描画し、room更新と盤面を二重描画しない', async () => {
  const source = await fs.readFile(new URL('../haiku-room.js', import.meta.url), 'utf8');
  const hand = between(source, 'function subscribeOwnHand', 'async function resyncOwnHandFromFirestore');
  assert.match(hand, /renderHand\(\);/);
  assert.doesNotMatch(hand, /renderBoards\(\);/);
  const apply = between(source, 'function applyRoomData', '\n// ブラウザがバックグラウンド');
  assert.match(apply, /renderBoards\(\);/);
});
test('履歴Snapshotは現在のroomデータをapplyRoomDataへ再投入する', async () => {
  const source = await fs.readFile(new URL('../haiku-room.js', import.meta.url), 'utf8');
  const join = between(source, 'window.joinRoom =', '\nwindow.removeSubmittedWord');
  assert.match(join, /subscribeRoomHistory\(state\.roomRef/);
  assert.match(join, /const roomData = \{ \.\.\.state\.currentData \}/);
  assert.match(join, /delete roomData\.history/);
  assert.match(join, /applyRoomData\(roomData\)/);
});

test('5秒再同期はonSnapshotと並行する補助経路として残っている', async () => {
  const source = await fs.readFile(new URL('../haiku-room.js', import.meta.url), 'utf8');
  const polling = between(source, 'function startRoomResyncPolling()', '\nwindow.manualResync');
  assert.match(polling, /setInterval/);
  assert.match(polling, /resyncRoomFromFirestore\(\)/);
  assert.match(polling, /5000/);
  const join = between(source, 'window.joinRoom =', '\nwindow.removeSubmittedWord');
  assert.match(join, /onSnapshot\(state\.roomRef/);
  assert.match(join, /startRoomResyncPolling\(\)/);
});

test('調査段階では同期方式・fromCache方針を変更しない', async () => {
  const source = await fs.readFile(new URL('../haiku-room.js', import.meta.url), 'utf8');
  const join = between(source, 'window.joinRoom =', '\nwindow.removeSubmittedWord');
  assert.match(join, /fromCacheを含むSnapshotも共通の更新順序制御へ渡す/);
  assert.match(join, /applyRoomData\(snapshot\.data\(\), \+\+roomUpdateSequence\)/);
});

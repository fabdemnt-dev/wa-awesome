import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const html = read('toybox/mofumofu-gathering/online/index.html');
const script = read('toybox/mofumofu-gathering/online/script.js');
const css = read('toybox/mofumofu-gathering/online/style.css');
const entry = read('toybox/mofumofu-gathering/online-entry.js');

// 正本で固定する世代version（人間が管理する固定値。ランダム・時刻生成は禁止）。
const SCRIPT_GEN = '20260925-4'; // script.js本体（production gate ON）
const CC_GEN = '20260925-5'; // connection-control.js（ダイアログ挙動の追加で更新）
const RR_GEN = '20260925-3'; // room-recovery.js
const graph = ['firebase-config.js', 'initial-connection.js', 'connection-control.js', 'full-resume.js', 'room-recovery.js'];

test('1. index.htmlのmodule importが解決できる（script.js本体の参照が世代version付き）', async () => {
  assert.ok(html.includes(`<script type="module" src="./script.js?v=${SCRIPT_GEN}"></script>`), 'script.jsは世代version付きで読み込む');
  for (const mod of graph) await import(`../toybox/mofumofu-gathering/online/${mod}`);
});

test('2. beginEntrySubmitが解決できる', async () => {
  const cc = await import('../toybox/mofumofu-gathering/online/connection-control.js');
  assert.equal(typeof cc.beginEntrySubmit, 'function');
});

test('3. endEntrySubmitが解決できる', async () => {
  const cc = await import('../toybox/mofumofu-gathering/online/connection-control.js');
  assert.equal(typeof cc.endEntrySubmit, 'function');
});

test('4. room-recoveryの新state.entryBusy契約が読まれる', async () => {
  const rr = await import('../toybox/mofumofu-gathering/online/room-recovery.js');
  const state = { roomId: 'r', seatId: 'A', entryBusy: true, cards: [] };
  const recover = rr.createRoomGoneRecovery({ state, storage: { removeItem() {} }, message() {}, resetEntryView() {} });
  recover('部屋が閉じられました。');
  assert.equal(state.entryBusy, false);
  assert.equal(typeof rr.roomGoneNotice, 'function');
  assert.equal(typeof rr.isSavedRoomGoneError, 'function');
});

test('5. 古いqueryなし参照が残っていない', () => {
  assert.equal(script.includes("from './connection-control.js';"), false);
  assert.equal(script.includes("from './room-recovery.js';"), false);
  assert.ok(script.includes(`from './connection-control.js?v=${CC_GEN}';`));
  assert.equal((script.match(/room-recovery\.js\?v=/g) || []).length, 2, 'room-recovery.jsの2つのimport両方に世代versionが必要');
  assert.ok(script.includes(`from './room-recovery.js?v=${RR_GEN}';`));
});

test('6. module URLが意図した同世代へ揃う', () => {
  assert.equal(html.match(/script\.js\?v=([\w-]+)"/)?.[1], SCRIPT_GEN);
  assert.equal(script.match(/connection-control\.js\?v=([\w-]+)/)?.[1], CC_GEN);
  assert.equal(script.match(/room-recovery\.js\?v=([\w-]+)/)?.[1], RR_GEN);
});

test('7. 320/390px UIに変更なし（style.css構造は据え置き）', () => {
  assert.ok(html.includes('./style.css?v=20260925-2'), 'style.cssの世代は据え置き（未変更）');
  assert.ok(css.includes('.dialog-actions{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:12px;}'));
});

test('8. CLOSE_ROOM_ENABLED=true維持', () => {
  assert.ok(script.includes('const CLOSE_ROOM_ENABLED = true;'));
});

test('9. ONLINE_PUBLIC_ENABLED=true維持', () => {
  assert.ok(entry.includes('const ONLINE_PUBLIC_ENABLED = true;'));
});

test('10. 回帰: 旧依存moduleがキャッシュされた状態を模しても起動不能にならない', async () => {
  assert.ok(script.includes(`from './connection-control.js?v=${CC_GEN}';`), '世代versionが無いと旧キャッシュと同一視される');
  assert.ok(script.includes(`from './room-recovery.js?v=${RR_GEN}';`));
  const cc = await import('../toybox/mofumofu-gathering/online/connection-control.js');
  assert.ok('beginEntrySubmit' in cc && 'endEntrySubmit' in cc && 'dialogScrollTargets' in cc);
  assert.ok(/import \{[^}]*beginEntrySubmit[^}]*endEntrySubmit[^}]*\} from '\.\/connection-control\.js\?v=/.test(script));
});

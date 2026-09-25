import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const html = read('toybox/mofumofu-gathering/online/index.html');
const script = read('toybox/mofumofu-gathering/online/script.js');
const css = read('toybox/mofumofu-gathering/online/style.css');
const entry = read('toybox/mofumofu-gathering/online-entry.js');

// 正本で固定する世代version（人間が管理する固定値。ランダム・時刻生成は禁止）。
const GEN = '20260925-3';

const graph = ['firebase-config.js', 'initial-connection.js', 'connection-control.js', 'full-resume.js', 'room-recovery.js'];

test('1. index.htmlのmodule importが解決できる（script.js本体の参照が世代version付き）', async () => {
  assert.ok(html.includes(`<script type="module" src="./script.js?v=${GEN}"></script>`), 'script.jsは世代version付きで読み込む');
  for (const mod of graph) {
    await import(`../toybox/mofumofu-gathering/online/${mod}`);
  }
});

test('2. beginEntrySubmitが解決できる（新script.jsが必要とするexport）', async () => {
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

test('5. 古いqueryなし参照が残っていない（connection-control.js / room-recovery.js）', () => {
  assert.equal(script.includes("from './connection-control.js';"), false, 'queryなしconnection-control.js参照が残っている');
  assert.equal(script.includes("from './room-recovery.js';"), false, 'queryなしroom-recovery.js参照が残っている');
  assert.ok(script.includes(`from './connection-control.js?v=${GEN}';`));
  assert.equal((script.match(/room-recovery\.js\?v=/g) || []).length, 2, 'room-recovery.jsの2つのimport両方に世代versionが必要');
});

test('6. module URLが意図した同世代へ揃う（script.js / connection-control.js / room-recovery.js）', () => {
  const htmlV = html.match(/script\.js\?v=([\w-]+)"/)?.[1];
  const ccV = script.match(/connection-control\.js\?v=([\w-]+)/)?.[1];
  const rrV = script.match(/room-recovery\.js\?v=([\w-]+)/)?.[1];
  assert.equal(htmlV, GEN);
  assert.equal(ccV, GEN);
  assert.equal(rrV, GEN);
});

test('7. 320/390px UIに変更なし（style.cssの構造は据え置き）', () => {
  // 今回の変更はJSのキャッシュ識別子のみで、CSS/レイアウトには触れない。
  assert.ok(html.includes('./style.css?v=20260925-2'), 'style.cssの世代は据え置き（未変更）');
  assert.ok(css.includes('.dialog-actions{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:12px;}'));
});

test('8. CLOSE_ROOM_ENABLED=false維持', () => {
  assert.ok(script.includes('const CLOSE_ROOM_ENABLED = false;'));
});

test('9. ONLINE_PUBLIC_ENABLED=true維持', () => {
  assert.ok(entry.includes('const ONLINE_PUBLIC_ENABLED = true;'));
});

test('10. 回帰: 旧依存moduleがキャッシュされた状態を模しても起動不能にならない', async () => {
  // ブラウザが旧connection-control.jsをキャッシュしていると、queryなしの同一URLは旧moduleへ解決し、
  // 新script.jsの beginEntrySubmit/endEntrySubmit が解決できず起動不能になる（stagingで実発生）。
  // 世代versionが付いていれば、旧（queryなし）キャッシュとは別リソースとして新moduleを取得する。
  assert.ok(script.includes(`from './connection-control.js?v=${GEN}';`), '世代versionが無いと旧キャッシュと同一視される');
  assert.ok(script.includes(`from './room-recovery.js?v=${GEN}';`));
  // 実module側に新exportが存在すること（旧moduleでは解決できない契約）。
  const cc = await import('../toybox/mofumofu-gathering/online/connection-control.js');
  assert.ok('beginEntrySubmit' in cc && 'endEntrySubmit' in cc);
  // 新script.jsが実際にその2つをimportしていること。
  assert.ok(/import \{[^}]*beginEntrySubmit[^}]*endEntrySubmit[^}]*\} from '\.\/connection-control\.js\?v=/.test(script));
});

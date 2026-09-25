import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dialogScrollTargets } from '../toybox/mofumofu-gathering/online/connection-control.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const soloHtml = read('toybox/mofumofu-gathering/index.html');
const onlineHtml = read('toybox/mofumofu-gathering/online/index.html');
const readme = read('toybox/mofumofu-gathering/README.md');
const toyboxHtml = read('toybox/index.html');
const onlineScript = read('toybox/mofumofu-gathering/online/script.js');
const onlineCss = read('toybox/mofumofu-gathering/online/style.css');

// 集合判定の説明に使う共通コア（solo/duo/onlineで表現が揃っていること）。
const CORE = ['同じ動物が4枚', '8種類', '手札', '残り2人'];

test('1. 同種4枚の敗北条件が説明されている（solo/duo/online）', () => {
  for (const [name, src] of [['solo', soloHtml], ['online', onlineHtml], ['readme', readme]]) {
    assert.match(src, /同じ動物[^。]{0,12}4枚/, `${name}: 同種4枚の集合を説明`);
  }
});

test('2. 8種類集合の敗北条件が説明されている（solo/duo/online）', () => {
  for (const [name, src] of [['solo', soloHtml], ['online', onlineHtml], ['readme', readme]]) {
    assert.match(src, /8種類すべて/, `${name}: 8種類集合を説明`);
  }
});

test('3. 対象は表向きでもらったカードだけであると分かる', () => {
  assert.ok(soloHtml.includes('表向きでもらったカード'), 'solo: 表向きで受け取ったカードが対象');
  assert.ok(onlineHtml.includes('表向きでもらったカード'), 'online: 表向きで受け取ったカードが対象');
  assert.ok(readme.includes('表向きでもらったカード'), 'readme: 表向きで受け取ったカードが対象');
});

test('4. 手札4枚だけでは負けないと分かる', () => {
  assert.ok(soloHtml.includes('手札に同じ動物が4枚あっても、それだけでは負けになりません'));
  assert.ok(onlineHtml.includes('手札に同じ動物が4枚あっても、それだけでは負けになりません'));
  assert.ok(readme.includes('手札に同じ動物が4枚あっても、それだけでは負けになりません'));
});

test('5. 集合成立で即終了と分かる', () => {
  assert.ok(soloHtml.includes('瞬間にゲームは終わり'));
  assert.ok(onlineHtml.includes('になった瞬間に終了'));
  assert.ok(readme.includes('成立した瞬間にゲームは終了'));
});

test('6. 残り2人が勝ちと説明されている', () => {
  assert.ok(soloHtml.includes('残り2人の勝ち'));
  assert.ok(onlineHtml.includes('残り2人の勝ち'));
  assert.ok(readme.includes('残り2人が勝者'));
});

test('7. 脱落戦継続という旧説明がない（solo/duo/online説明・README）', () => {
  for (const [name, src] of [['solo', soloHtml], ['online', onlineHtml], ['readme', readme]]) {
    assert.equal(src.includes('脱落'), false, `${name}: 「脱落」の旧説明が残っている`);
    assert.equal(/最後の1人|最後まで残った1人が勝者|最後まで残る/.test(src), false, `${name}: 「最後の1人」系の旧説明が残っている`);
  }
  assert.equal(toyboxHtml.includes('4枚揃うと脱落'), false, 'toybox一覧: 4枚で脱落の旧説明が残っている');
});

test('8. solo/duo/onlineで集合ルールの表現が矛盾しない', () => {
  for (const [name, src] of [['solo', soloHtml], ['online', onlineHtml]]) {
    for (const token of CORE) assert.ok(src.includes(token), `${name}: 共通説明トークンが欠落 ${token}`);
  }
});

test('9. 未実装の「人間3人以上のオンライン」を説明していない', () => {
  assert.equal(/3人以上の人間|人間3人以上|3人でオンライン/.test(onlineHtml), false, 'onlineのあそびかたに未実装機能の記載がある');
  assert.equal(/3人以上の人間/.test(onlineScript), false);
});

test('10. 「部屋を閉じる」がロビー説明に反映されている（オンライン）', () => {
  assert.ok(onlineHtml.includes('「部屋を閉じる」'), 'onlineヘルプにロビー操作として簡潔に記載');
});

test('11. オンライン結果画面に旧説明（最後の1人／手札が0枚）が残っていない', () => {
  assert.equal(onlineScript.includes('最後の1人が残ったため終了'), false);
  assert.equal(onlineScript.includes('手札が0枚になったため終了'), false);
  assert.ok(onlineScript.includes("$('final-reason').textContent = gatheringReasonText(finalResult.finishReason, loser?.eliminationAnimal);"));
});

test('12. ダイアログは320/390pxで横幅が収まり縦スクロールできる（CSS保証）', () => {
  // dialog 幅は viewport-28 と 480 の小さい方 → 320pxで292px、390pxで362px。左右overflowしない。
  assert.ok(/dialog\{width:min\(calc\(100% - 28px\),480px\);max-height:85dvh;/.test(onlineCss), 'dialog幅/高さの上限ルール');
  assert.ok(onlineCss.includes('overflow-x:hidden'), 'appは横overflowを出さない');
  // ダイアログ内部は縦スクロール可能（ブラウザ既定のdialog overflow:auto）で全文を読める。
});

test('13. 閉じる操作領域は44px以上（CSS保証）', () => {
  assert.ok(onlineCss.includes('button,select,input,a{min-height: 44px}'), 'ボタン等の最小タップ領域44px');
  assert.ok(onlineCss.includes('.big{width:100%;min-height:54px;'), 'わかった！等の主要ボタンは54px');
});

test('14. ダイアログのスクロール初期位置は収まれば先頭、収まらなければ末尾（全文が読める）', () => {
  assert.deepEqual(dialogScrollTargets({ contentH: 400, viewH: 600, wasAtBottom: false }), [0]);
  assert.deepEqual(dialogScrollTargets({ contentH: 600, viewH: 600, wasAtBottom: false }), [0]);
  assert.deepEqual(dialogScrollTargets({ contentH: 900, viewH: 600, wasAtBottom: false }), [0, 300]);
  assert.deepEqual(dialogScrollTargets({ contentH: 900, viewH: 600, wasAtBottom: true }), [300]);
  assert.deepEqual(dialogScrollTargets({ contentH: 900, viewH: 0, wasAtBottom: false }), [0], '高さ未確定時は動かさない');
  assert.deepEqual(dialogScrollTargets({ contentH: 0, viewH: 600, wasAtBottom: false }), [0]);
});

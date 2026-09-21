import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const script = await readFile(new URL('../toybox/mofumofu-gathering/script.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../toybox/mofumofu-gathering/index.html', import.meta.url), 'utf8');
const readme = await readFile(new URL('../toybox/mofumofu-gathering/README.md', import.meta.url), 'utf8');

test('32枚を8種類4枚で作り、3人へ10枚ずつ配って2枚を山札に残す', () => {
  assert.match(script, /ANIMALS\.forEach\(a => \{ for\(let i=0;i<4;i\+\+\) cards\.push/);
  assert.match(script, /for\(let i=0;i<10;i\+\+\) players\.forEach\(p => p\.hand\.push\(deck\.pop\(\)\)\)/);
  assert.match(readme, /余った2枚は山札として置きます。山札は対戦中には使いません/);
});

test('判定4パターンは宣言一致と選択の一致で成功を決める', () => {
  assert.match(script, /const actualTruth=offer\.card\.id===offer\.claim/);
  assert.match(script, /const success=\(saysTrue && actualTruth\)\|\|\(!saysTrue && !actualTruth\)/);
  assert.match(script, /const receiver=success \? giver : judge/);
  assert.match(html, /○ ほんと？/);
  assert.match(html, /× うそ！/);
});

test('同種4枚で脱落し、手札と表向きカードを捨て札へ移す', () => {
  assert.match(script, /receiver\.faceUp\[offer\.card\.id\]>=4/);
  assert.match(script, /player\.out=true/);
  assert.match(script, /game\.discard\.push\(\.\.\.player\.hand\)/);
  assert.match(script, /player\.hand=\[\]/);
  assert.match(script, /player\.faceUp\[a\.id\]=0/);
  assert.match(script, /activePlayers\(\).*filter\(p=>p\.id!==/s);
});

test('手札0枚が出たら生存者全員の表向き総数を比較し、最少同数は引き分け', () => {
  assert.match(script, /alive\.some\(p => p\.hand\.length === 0\)/);
  assert.match(script, /Math\.min\(\.\.\.counts\.map\(x=>x\.n\)\)/);
  assert.match(script, /counts\.filter\(x=>x\.n===minCount\)/);
  assert.match(script, /leaders\.length>1/);
  assert.match(script, /const winner=leaders\[0\]\.p/);
  assert.doesNotMatch(script, /counts\[0\]\.n===counts\[1\]\.n/);
  assert.doesNotMatch(script, /counts\[0\]\.n<counts\[1\]\.n/);
});

test('CPUは性格と宣言履歴を使い、判断確率に上限下限がある', () => {
  assert.match(script, /personality==="honest" \? \.72 : \.30/);
  assert.match(script, /const observed=h\.total>1 \? h\.truth\/h\.total : \.5/);
  assert.match(script, /Math\.max\(\.28,Math\.min\(\.72,believe\)\)/);
});

test('将来の人数拡張に備え履歴はプレイヤー配列から生成する', () => {
  assert.match(script, /Object\.fromEntries\(players\.map\(p => \[p\.id,\{truth:0,total:0\}\]\)\)/);
  assert.doesNotMatch(script, /history:\{you:/);
});


test('宣言した動物は選択中であることを見た目と文章で示す', () => {
  assert.match(script, /game\.claim===a\.id\?"selected":""/);
  assert.match(script, /aria-pressed/);
  assert.match(script, /game\.claim===a\.id\?"✓ ":""/);
});


test('手札の自動整列は動物の固定順で並べ替え、選択IDを変更しない', () => {
  assert.match(script, /function sortHand\(player\)/);
  assert.match(script, /player\.hand\.sort/);
  assert.match(html, /id="sortHandBtn"/);
});

test('判定結果はテーブルの絶対配置から分離し、表向きカードはプレイヤー別エリアにする', () => {
  assert.doesNotMatch(script, /class="collection-row/);
  assert.match(script, /class="collection-player/);
  assert.match(html, /id="flash"/);
});

test('結果画面に各プレイヤーの表向き枚数を表示する', () => {
  assert.match(html, /id="resultDetails"/);
  assert.match(script, /finalSnapshot/);
  assert.match(script, /class="result-row"/);
});


test('結果画面に文字列の改行コードを表示しない', () => {
  assert.doesNotMatch(html, /<\/p>\\n\s*<div id="resultDetails"/);
});

test('判定中は宣言アイコンと判定後の表向きカードを区別し、自分の手札も表示する', () => {
  assert.match(html, /id="judgeHand"/);
  assert.match(script, /offerCard"\)\.classList\.remove\("revealed"\)/);
  assert.match(script, /offerCardMain"\)\.textContent=a\.emoji/);
  assert.match(script, /offerCard"\)\.classList\.add\("revealed"\)/);
  assert.match(script, /offerCardMain"\)\.textContent=animal\(offer\.card\.id\)\.emoji/);
  assert.doesNotMatch(script, /宣言：/);
  assert.doesNotMatch(script, /正体：/);
  assert.match(script, /function renderJudgeHand/);
});

test('CPUアイコンはカード8種の動物と重複しない', () => {
  assert.match(script, /name:"こはる", face:"🌸"/);
  assert.match(script, /name:"みつき", face:"🌙"/);
});


test('集まったカードはプレイヤーごとの独立パネルで表示する', () => {
  assert.match(script, /class="collection-player/);
  assert.match(script, /class="collection-owner"/);
  assert.match(script, /class="collection-total">表向き/);
  assert.doesNotMatch(script, /class="collection-row \$\{p\.out/);
});


test('宣言カードの補助文字は空で、判定後だけ表面クラスになる', () => {
  assert.match(script, /offerCardSub"\)\.textContent=""/);
  assert.match(script, /offerCard"\)\.classList\.add\("revealed"\)/);
  assert.doesNotMatch(script, /offerCardSub"\)\.textContent=\`宣言：/);
  assert.doesNotMatch(script, /offerCardSub"\)\.textContent=\`正体：/);
});

test('最終結果は各プレイヤーが集めた動物ごとの枚数も保存して表示する', () => {
  assert.match(script, /faceUp:\{\.\.\.p\.faceUp\}/);
  assert.match(script, /class="result-breakdown"/);
  assert.match(script, /class="result-chip"/);
});


test('もう一回あそぶ時は前ゲームのカード表面と判定表示をリセットする', () => {
  assert.match(script, /function resetOfferVisual\(\)/);
  assert.match(script, /offerCard"\)\.classList\.remove\("revealed"\)/);
  assert.match(script, /offerCardMain"\)\.textContent="？"/);
  assert.match(script, /flash"\)\.textContent=""/);
  assert.match(script, /function startGame\(\) \{\s*clearTimers\(\);\s*resetOfferVisual\(\);/);
});


test('3人生存時も3人目を含めて最少枚数を選ぶ実装である', () => {
  assert.match(script, /const counts=alive\.map/);
  assert.match(script, /const minCount=Math\.min\(\.\.\.counts\.map/);
  assert.match(script, /const leaders=counts\.filter/);
});


test('公開更新時にCSSとJSの古いキャッシュを使わず、ゲーム中に自動スクロールしない', () => {
  assert.match(html, /style\.css\?v=20260921-1/);
  assert.match(html, /script\.js\?v=20260921-1/);
  assert.doesNotMatch(script, /window\.scrollTo/);
  assert.doesNotMatch(script, /scrollIntoView/);
});


test('山札は裏向きカードを残し、カード中央の？だけ表示しない', () => {
  assert.match(html, /<div class="deck-card" aria-hidden="true"><\/div>/);
  assert.match(html, /山札 <b id="deckCount">2<\/b>枚/);
  assert.doesNotMatch(html, /class="deck-card"[^>]*>？<\/div>/);
});

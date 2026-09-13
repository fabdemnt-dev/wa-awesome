import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../moon-scale-duel/index.html', import.meta.url), 'utf8');

test('月秤の決闘は結果3種を正しいWebPへ対応付ける', () => {
  assert.match(source, /win:\s*\{ src: 'assets\/images\/results\/result-victory\.webp'/);
  assert.match(source, /lose:\s*\{ src: 'assets\/images\/results\/result-defeat\.webp'/);
  assert.match(source, /draw:\s*\{ src: 'assets\/images\/results\/result-draw\.webp'/);
});

test('結果画像は理由と最終月影の間にあり、共通表示仕様を使う', () => {
  const reason = source.indexOf('id="endReason"');
  const image = source.indexOf('id="endImage"');
  const score = source.indexOf('id="endScore"');
  assert.ok(reason < image && image < score);
  assert.match(source, /\.result-art \{[^}]*width: 100%;[^}]*height: 90px;[^}]*margin: 12px 0;[^}]*border-radius: 10px;/);
  assert.match(source, /\.result-art img \{[^}]*object-fit: cover;[^}]*object-position: 50% 48%;/);
});

test('再戦を含む非終了状態では前回の結果画像を解除する', () => {
  assert.match(source, /if \(!ended\) \{\s*el\('endImage'\)\.removeAttribute\('src'\);\s*el\('endImage'\)\.alt = '';\s*return;/);
  assert.match(source, /el\('rematchButton'\)\.addEventListener\('click', resetGame\);/);
});

test('中央決闘背景はWebPを参照し、公開時の追加演出は持ち込まない', () => {
  assert.match(source, /assets\/images\/duel\/duel-scene-background\.webp/);
  assert.doesNotMatch(source, /reveal-motion|moonlight-clash|clash-layer/);
});

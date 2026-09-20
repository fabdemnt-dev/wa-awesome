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

test('手札0枚が出たら表向き総数で終了判定し、同数は引き分け', () => {
  assert.match(script, /alive\.some\(p => p\.hand\.length === 0\)/);
  assert.doesNotMatch(script, /alive\.length === 2 && alive\.some/);
  assert.match(script, /counts\[0\]\.n===counts\[1\]\.n/);
  assert.match(script, /counts\[0\]\.n<counts\[1\]\.n\?counts\[0\]\.p:counts\[1\]\.p/);
  assert.match(script, /引き分けです！/);
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

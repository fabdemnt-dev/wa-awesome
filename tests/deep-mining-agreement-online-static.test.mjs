import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('title offers solo plus two-to-four player modes', () => {
  const app = fs.readFileSync(new URL('../deep-mining-agreement/app.js', import.meta.url), 'utf8');
  for (const count of [2, 3, 4]) assert.match(app, new RegExp(`online\\.html\\?players=${count}`));
  assert.match(app, /1人で遊ぶ（CPU対戦）/);
});

test('online client uses server callable state and stores only recovery room id', () => {
  const source = fs.readFileSync(new URL('../deep-mining-agreement/online.js', import.meta.url), 'utf8');
  assert.match(source, /deepMiningAgreementCreateRoom/);
  assert.match(source, /deepMiningAgreementSubmitAction/);
  assert.match(source, /localStorage\.setItem\('deepMiningAgreementRoomId', state\.roomId\)/);
  assert.doesNotMatch(source, /localStorage\.setItem\([^\n]*(secret|action|ore)/i);
});

test('server snapshot exposes only the caller private state before completion', () => {
  const source = fs.readFileSync(new URL('../functions/deep-mining-agreement-online/index.js', import.meta.url), 'utf8');
  assert.match(source, /selfPrivate/);
  assert.match(source, /publicPlayer\(p, game\.ended\)/);
  assert.doesNotMatch(source, /oreSequence:\s*game\.oreSequence/);
});

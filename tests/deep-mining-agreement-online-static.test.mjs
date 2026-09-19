import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { lobbyCapacity, roomCountPayload } from '../deep-mining-agreement/online-compat.js';

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

test('online rooms treat the selected count as humans and fill four seats with server NPCs', () => {
  const server = fs.readFileSync(new URL('../functions/deep-mining-agreement-online/index.js', import.meta.url), 'utf8');
  const rules = fs.readFileSync(new URL('../functions/deep-mining-agreement-online/rules.js', import.meta.url), 'utf8');
  const client = fs.readFileSync(new URL('../deep-mining-agreement/online.js', import.meta.url), 'utf8');
  assert.match(server, /humanPlayerCount/);
  assert.match(server, /rules\.addNpcSubmissions\(room\.game\)/);
  assert.match(rules, /seatNumber <= 4/);
  assert.match(rules, /NPC_PROFILES/);
  assert.match(client, /roomCountPayload\(desiredCount\)/);
  assert.match(client, /4席対戦/);
});

test('online client remains compatible while old and new Functions versions overlap', () => {
  for (const humanPlayerCount of [2, 3, 4]) {
    assert.deepEqual(roomCountPayload(humanPlayerCount), {
      humanPlayerCount,
      playerCount: humanPlayerCount,
    });
    assert.equal(lobbyCapacity({ humanPlayerCount, playerCount: 4 }), humanPlayerCount);
    assert.equal(lobbyCapacity({ playerCount: humanPlayerCount }), humanPlayerCount);
    assert.equal(4 - lobbyCapacity({ playerCount: humanPlayerCount }), 4 - humanPlayerCount);
  }
});

test('server requires an explicit HMAC secret and uses a dedicated TTL member collection', () => {
  const source = fs.readFileSync(new URL('../functions/deep-mining-agreement-online/index.js', import.meta.url), 'utf8');
  assert.match(source, /requireInviteHmacKey/);
  assert.doesNotMatch(source, /emulator-dma-key/);
  assert.match(source, /collection\('deepMiningAgreementMembers'\)/);
  assert.doesNotMatch(source, /collection\('members'\)/);
});

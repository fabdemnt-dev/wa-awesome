import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

test('online UI renders the solo-game step flow', () => {
  const html = read('toybox/mofumofu-gathering/online/index.html');
  for (const token of ['id="claimButtons"', 'id="targetButtons"', 'id="judgeHand"', 'id="presence-list"', 'id="self-seat"', 'id="log"', 'data-judgment="truth"', 'data-judgment="lie"', '① 渡すカードを選ぶ', '② 何の動物だと言う？', '③ 誰に渡す？', 'おはなし']) assert.ok(html.includes(token), `index.html missing ${token}`);
  assert.ok(!html.includes('<select'), 'index.html must not use select elements');
  assert.ok(!html.includes('id="offer-card"'), 'index.html must not keep the old offer select');
});

test('online script drives the new UI without legacy ids', () => {
  const script = read('toybox/mofumofu-gathering/online/script.js');
  for (const token of ['ui.selectedUid', 'ui.claim', 'claimButtons', 'targetButtons', 'dataset.target', 'seatNode', 'renderLobbySeats', 'pushLog', 'observeRoomEvents', 'tableCardMain']) assert.ok(script.includes(token), `script.js missing ${token}`);
  for (const token of ["$('offer-card')", "$('claim-animal')", "$('target-player')", "$('elimination-notice')", "$('offer')", '<option']) assert.ok(!script.includes(token), `script.js must not use ${token}`);
});

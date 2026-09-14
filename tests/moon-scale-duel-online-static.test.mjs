import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const invite = require('../functions/moon-scale-duel-online/invite-code.js');

test('moon-scale invite code is deterministic, parseable, and does not expose its key', () => {
  const first = invite.createInviteCode('uid-a', 'request-a', 'test-key');
  const replay = invite.createInviteCode('uid-a', 'request-a', 'test-key');
  assert.deepEqual(replay, first);
  assert.deepEqual(invite.parseInviteCode(first.code), { locator: first.locator, secret: first.secret });
  assert.equal(invite.parseInviteCode('invalid'), null);
  assert.equal(invite.safeEqual(invite.mac(first.locator, first.secret, 'test-key'), invite.mac(first.locator, first.secret, 'test-key')), true);
});

test('stage-three page keeps secret submission and copy resolution on the dedicated online client', () => {
  const html = fs.readFileSync(new URL('../moon-scale-duel-online.html', import.meta.url), 'utf8');
  const main = fs.readFileSync(new URL('../moon-scale-duel-online-main.js', import.meta.url), 'utf8');
  const api = fs.readFileSync(new URL('../moon-scale-duel-online-api.js', import.meta.url), 'utf8');
  const ui = fs.readFileSync(new URL('../moon-scale-duel-online-ui.js', import.meta.url), 'utf8');
  assert.match(html, /月秤の決闘/);
  assert.match(html, /この札で決定/);
  assert.match(api, /moonScaleDuelSubmitCard/);
  assert.match(api, /moonScaleDuelSubmitCopyTarget/);
  assert.match(api, /moonScaleDuelReadyNextRound/);
  assert.match(api, /moonScaleDuelExtendNextRoundWait/);
  assert.match(api, /moonScaleDuelAbortAfterWait/);
  assert.match(main, /stateVersion:\s*snapshot\.game\.stateVersion/);
  assert.match(ui, /対手の選択を待っています/);
  assert.match(ui, /choosing-copy/);
  assert.match(ui, /round-result/);
  assert.match(ui, /nextRoundReady/);
  assert.match(ui, /deadlineMillis/);
  assert.match(html, /この効果を模倣する/);
  assert.doesNotMatch(html + main + ui, /localStorage\.(?:setItem|getItem)\([^\n]*(?:card|札|selection)/i);
  assert.match(main, /localStorage\.setItem\(STORAGE_KEY, state\.roomId\)/);
});

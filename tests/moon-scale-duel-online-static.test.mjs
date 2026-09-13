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

test('stage-one page is separate and does not expose card submission controls', () => {
  const html = fs.readFileSync(new URL('../moon-scale-duel-online.html', import.meta.url), 'utf8');
  const main = fs.readFileSync(new URL('../moon-scale-duel-online-main.js', import.meta.url), 'utf8');
  assert.match(html, /月秤の決闘/);
  assert.match(html, /第1ラウンドの札選択は第2段階で実装します/);
  assert.doesNotMatch(html + main, /この札で決定|submitCard|submitChoice/);
  assert.match(main, /localStorage\.setItem\(STORAGE_KEY, state\.roomId\)/);
});

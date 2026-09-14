import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { resultPresentation } from '../moon-scale-duel-online-state.js';

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

test('online page keeps secret play, final results, and rematch on the dedicated client', () => {
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
  assert.match(api, /moonScaleDuelRequestRematch/);
  assert.match(api, /moonScaleDuelCancelRematch/);
  assert.match(main, /stateVersion:\s*snapshot\.game\.stateVersion/);
  assert.match(ui, /対手の選択を待っています/);
  assert.match(ui, /choosing-copy/);
  assert.match(ui, /round-result/);
  assert.match(ui, /nextRoundReady/);
  assert.match(ui, /deadlineMillis/);
  assert.match(html, /この効果を模倣する/);
  assert.match(html, /result-victory\.webp|final-result-image/);
  assert.match(html, /もう一度決闘する/);
  assert.match(main, /cancellation must succeed before navigation/);
  assert.doesNotMatch(html + main + ui, /localStorage\.(?:setItem|getItem)\([^\n]*(?:card|札|selection)/i);
  assert.match(main, /localStorage\.setItem\(STORAGE_KEY, state\.roomId\)/);
});

test('completed results use the server outcome from each seat perspective and aborted stays separate', () => {
  const seat1Win = { phase: 'ended', moonShadow: { seat1: 12, seat2: 7 }, result: { type: 'completed', outcome: 'seat1', moonShadow: { seat1: 12, seat2: 7 } } };
  assert.deepEqual(
    [resultPresentation(seat1Win, 'seat1').kind, resultPresentation(seat1Win, 'seat2').kind],
    ['win', 'lose'],
  );
  assert.equal(resultPresentation(seat1Win, 'seat1').image.src, 'moon-scale-duel/assets/images/results/result-victory.webp');
  assert.equal(resultPresentation(seat1Win, 'seat2').image.src, 'moon-scale-duel/assets/images/results/result-defeat.webp');
  assert.equal(resultPresentation(seat1Win, 'seat1').score, '最終月影　あなた 12 ／ 対手 7');
  const seat2Win = { ...seat1Win, result: { type: 'completed', outcome: 'seat2', moonShadow: { seat1: 7, seat2: 12 } } };
  assert.deepEqual(
    [resultPresentation(seat2Win, 'seat1').kind, resultPresentation(seat2Win, 'seat2').kind],
    ['lose', 'win'],
  );
  const draw = { ...seat1Win, result: { type: 'completed', outcome: 'draw', moonShadow: { seat1: 10, seat2: 10 } } };
  assert.equal(resultPresentation(draw, 'seat1').kind, 'draw');
  assert.equal(resultPresentation(draw, 'seat2').kind, 'draw');
  assert.equal(resultPresentation(draw, 'seat2').image.src, 'moon-scale-duel/assets/images/results/result-draw.webp');
  const aborted = resultPresentation({ phase: 'aborted', moonShadow: { seat1: 10, seat2: 10 }, result: { type: 'aborted', reason: 'next-round-timeout' } }, 'seat1');
  assert.equal(aborted.kind, 'aborted');
  assert.equal(aborted.image, null);
  assert.match(aborted.reason, /中断/);
});

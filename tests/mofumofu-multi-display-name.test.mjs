import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const contract = require('./mofumofu-multi/contract.js');
const presence = require('./mofumofu-multi/presence.js');
const core = await import('../toybox/mofumofu-gathering/online/multi/multi-core.js');
const client = fs.readFileSync(new URL('../toybox/mofumofu-gathering/online/multi/script.js', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../toybox/mofumofu-gathering/online/multi/index.html', import.meta.url), 'utf8');

test('表示名: 空欄・旧client・1/12文字・不正型・13文字', () => {
  assert.equal(contract.normalizeDisplayName(undefined), null);
  assert.equal(contract.normalizeDisplayName('  '), null);
  assert.equal(contract.normalizeDisplayName('猫'), '猫');
  assert.equal(contract.normalizeDisplayName(' あいうえおかきくけこさし '), 'あいうえおかきくけこさし');
  assert.equal(contract.normalizeDisplayName('🐱'.repeat(12)), '🐱'.repeat(12));
  for (const value of ['あ'.repeat(13), null, 3, [], {}]) {
    assert.throws(() => contract.normalizeDisplayName(value), (error) => error.code === 'invalid-argument');
  }
});

test('表示名: 公開playersだけに保存し、各人数・同名・旧roomに対応', () => {
  for (const count of [3, 4, 5, 6]) {
    const room = contract.initialRoomFields({ roomId: 'room', hostUid: 'host', now: 1000, deleteAt: 999999, displayName: 'もふ' });
    for (let i = 2; i <= count; i += 1) {
      const seat = `S${i}`;
      const update = contract.joinRoomUpdate(room, seat, `uid-${i}`, 1000, i === 2 ? 'もふ' : null);
      for (const [path, value] of Object.entries(update)) {
        if (path.includes('.')) {
          const [field, key] = path.split('.');
          room[field][key] = value;
        } else room[path] = value;
      }
    }
    assert.equal(room.players.S1.displayName, 'もふ');
    assert.equal(room.players.S2.displayName, 'もふ');
    assert.deepEqual(contract.publicRoomViolations(room), []);
    assert.equal('privateHands' in room, false);
    assert.equal('serverState' in room, false);
    const restored = presence.publicRoomView(room);
    assert.equal(restored.players.S1.displayName, 'もふ');
    assert.equal(restored.players.S2.displayName, 'もふ');
    assert.equal(core.lobbyView(restored, 'S1').seats[0].label, 'あなた（もふ）');
    assert.equal(core.lobbyView(restored, 'S1').seats[1].label, 'もふ');
    assert.equal(core.lobbyView(restored, 'S1').seats[2].label, 'あいて2');
    const playing = { ...restored, status: 'playing', turnState: 'awaitingOffer', currentTurnPlayerId: 'S2' };
    const view = core.gameView(playing, 'S1');
    assert.equal(view.self.label, 'あなた（もふ）');
    assert.equal(view.others[0].label, 'もふ');
    assert.equal(view.turnText, 'もふの番');
    const finished = { ...playing, status: 'finished', finalResult: { players: room.seatOrder.map((seatId) => ({ seatId, handCount: 0 })) } };
    const result = core.resultView(finished, 'S1');
    assert.equal(result.players[0].label, 'あなた（もふ）');
    assert.equal(result.players[1].label, 'もふ');
    assert.equal(result.players[2].label, 'あいて2');
    for (const screen of [core.lobbyView(restored, 'S1'), view, result]) {
      const labels = screen.seats || screen.players || [screen.self, ...screen.others];
      assert.ok(labels.every(({ label }) => !/^S[1-6]$/.test(label)));
    }
  }
});

test('表示名: 入力は任意、表示は文字列としてDOMへ設定する', () => {
  assert.match(page, /id="display-name"[^>]*maxlength="24"/);
  assert.match(client, /Array\.from\(event\.target\.value\)\.slice\(0, 12\)/);
  assert.match(client, /displayName: \$\('display-name'\)\.value\.trim\(\)/);
  assert.equal(client.includes('innerHTML'), false);
  assert.equal(core.seatDisplayName({ seatOrder: ['S1', 'S2'], players: { S2: { displayName: '<img src=x onerror=alert(1)>' } } }, 'S2', 'S1'), '<img src=x onerror=alert(1)>');
});

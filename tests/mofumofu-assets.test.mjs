import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = 'assets/mofumofu-gathering';

const expected = {
  'bear.png': [1254, 1254],
  'cat.png': [1254, 1254],
  'chick.png': [1254, 1254],
  'fox.png': [1254, 1254],
  'mofumofu-logo.png': [1536, 1024],
  'panda.png': [1254, 1254],
  'penguin.png': [1254, 1254],
  'polar-bear.png': [1254, 1254],
  'rabbit.png': [1254, 1254],
};

test('正式素材は9枚・英数字名・破損なし・alpha透過維持', () => {
  assert.deepEqual(readdirSync(join(root, dir)).sort(), Object.keys(expected).sort());
  for (const [name, [width, height]] of Object.entries(expected)) {
    const bytes = readFileSync(join(root, dir, name));
    assert.ok(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `${name} must be a PNG`);
    assert.equal(bytes.readUInt32BE(16), width, `${name} width`);
    assert.equal(bytes.readUInt32BE(20), height, `${name} height`);
    assert.equal(bytes[25], 6, `${name} must keep alpha (RGBA color type)`);
  }
});

test('animal IDと正式画像の対応は表示層だけで行い、3モードで同じassetを使う', () => {
  const solo = readFileSync(join(root, 'toybox/mofumofu-gathering/script.js'), 'utf8');
  const online = readFileSync(join(root, 'toybox/mofumofu-gathering/online/script.js'), 'utf8');
  assert.ok(solo.includes('polar:"polar-bear.png"'), 'solo mapping must cover polar');
  assert.ok(online.includes("polar: 'polar-bear.png'"), 'online mapping must cover polar');
  assert.ok(solo.includes('"../../assets/mofumofu-gathering/"'), 'solo must reference the shared asset dir');
  assert.ok(online.includes("'../../../assets/mofumofu-gathering/'"), 'online must reference the same shared asset dir');
  for (const animalId of ['cat', 'rabbit', 'chick', 'bear', 'polar', 'fox', 'penguin', 'panda']) {
    assert.ok(solo.includes(`${animalId}:"`), `solo mapping must cover ${animalId}`);
    assert.ok(online.includes(`${animalId}: '`), `online mapping must cover ${animalId}`);
  }
  assert.ok(!/[\u3040-\u30ff\u4e00-\u9fff]/.test(JSON.stringify(readdirSync(join(root, dir)))), 'no Japanese filenames in the repo');
});

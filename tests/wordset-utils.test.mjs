import test from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeHTML,
  normalizeIcon,
  normalizeWordList,
  normalizeWordSet,
} from '../wordset-utils.js';

test('legacy object arrays are normalized to string arrays', () => {
  const poem = normalizeWordSet({
    type: 'poem',
    words: [{ text: '夏', author: 'A', id: '1' }, '海', { invalid: true }, '  空  '],
  });
  const haiku = normalizeWordSet({
    type: 'haiku',
    words5: [{ text: '夏の海' }, '  夕焼け  '],
    words7: [{ text: '波の音かな' }, null],
  });

  assert.deepEqual(poem.words, ['夏', '海', '空']);
  assert.deepEqual(haiku.words5, ['夏の海', '夕焼け']);
  assert.deepEqual(haiku.words7, ['波の音かな']);
});

test('canonical string arrays remain usable without legacy metadata', () => {
  assert.deepEqual(normalizeWordList(['春', '  花  ', '', undefined]), ['春', '花']);
});

test('icons are stored as short text and escaped before HTML rendering', () => {
  assert.equal(normalizeIcon('  💗✨  '), '💗✨');
  assert.equal(normalizeIcon(''), null);
  assert.equal(escapeHTML('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
});

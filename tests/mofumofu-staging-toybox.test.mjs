import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../toybox/mofumofu-gathering/online/', import.meta.url);
const hosting = JSON.parse(readFileSync(new URL('../firebase.json', import.meta.url))).hosting;
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const choice = read('toybox/index.html');
const pages = [read('index.html'), read('multi/index.html')];

test('Hosting root contains all three routes even with trailingSlash false', () => {
  assert.equal(hosting.site, 'wa-awesome-mofumofu-stg');
  assert.equal(hosting.public, 'toybox/mofumofu-gathering/online');
  assert.equal(hosting.trailingSlash, false);
  for (const path of ['index.html', 'multi/index.html', 'toybox/index.html']) {
    assert.ok(existsSync(new URL(path, root)), path);
  }
  for (const url of ['/toybox/', '/toybox']) {
    const file = new URL(`${url.replace(/^\//, '').replace(/\/$/, '')}/index.html`, root);
    assert.ok(existsSync(file), url);
  }
});

test('staging choice offers real two-player and multi routes', () => {
  const links = [...choice.matchAll(/<a href="([^"]+)"><strong>([^<]+)<\/strong>/g)]
    .map(([, href, label]) => ({ href, label }));
  assert.deepEqual(links, [
    { href: '/', label: '2人＋こはる' },
    { href: '/multi', label: '3〜6人' },
  ]);
  for (const { href } of links) {
    const file = new URL(`${href.replace(/^\//, '').replace(/\/$/, '')}${href === '/' ? '' : '/'}index.html`, root);
    assert.ok(existsSync(file), href);
  }
});

test('online modes return only to the Mofumofu title; toybox exit lives on the title page', () => {
  assert.match(pages[0], /<a href="\.\.\/">← もふもふ大集合！へ戻る<\/a>/);
  assert.match(pages[1], /<a href="\.\.\/\.\.\/">← もふもふ大集合！へ戻る<\/a>/);
  for (const page of pages) {
    assert.doesNotMatch(page, /id="toybox-return"/);
    assert.doesNotMatch(page, /おもちゃ箱へ戻る/);
    assert.doesNotMatch(page, /2人＋こはるのオンライン版へ/);
  }
  const title = readFileSync(new URL('../toybox/mofumofu-gathering/index.html', import.meta.url), 'utf8');
  assert.match(title, /<a class="secondary big title-return-link" href="\.\.\/">おもちゃ箱へ戻る<\/a>/);
});

test('PR #313 production gate and multi display-name input remain present', () => {
  const entry = readFileSync(new URL('../toybox/mofumofu-gathering/multi-entry.js', import.meta.url), 'utf8');
  assert.match(entry, /hostname === 'wa-awesome-mofumofu-stg\.web\.app'/);
  assert.match(read('multi/index.html'), /id="display-name"/);
  assert.match(read('index.html'), /id="create-room"/);
});

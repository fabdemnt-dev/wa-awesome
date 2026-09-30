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

test('both online pages return to the correct production or staging toybox', () => {
  for (const [index, page] of pages.entries()) {
    const initialHref = page.match(/<a id="toybox-return" href="([^"]+)">おもちゃ箱へ戻る<\/a>/)?.[1];
    assert.equal(initialHref, index === 0 ? '../../../toybox/' : '/wa-awesome/toybox/');
    const script = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)]
      .map((match) => match[1]).find((body) => body.includes("getElementById('toybox-return')"));
    assert.ok(script);
    for (const hostname of ['wa-awesome-mofumofu-stg.web.app', 'fabdemnt-dev.github.io']) {
      const link = { href: initialHref };
      vm.runInNewContext(script, { globalThis: { location: { hostname } }, document: { getElementById: () => link } });
      const pageUrl = hostname === 'fabdemnt-dev.github.io'
        ? `https://${hostname}/wa-awesome/toybox/mofumofu-gathering/online/${index === 0 ? '' : 'multi/'}`
        : `https://${hostname}/${index === 0 ? '' : 'multi'}`;
      assert.equal(new URL(link.href, pageUrl).pathname,
        hostname === 'fabdemnt-dev.github.io' ? '/wa-awesome/toybox/' : '/toybox/');
    }
  }
});

test('PR #313 production gate and multi display-name input remain present', () => {
  const entry = readFileSync(new URL('../toybox/mofumofu-gathering/multi-entry.js', import.meta.url), 'utf8');
  assert.match(entry, /hostname === 'wa-awesome-mofumofu-stg\.web\.app'/);
  assert.match(read('multi/index.html'), /id="display-name"/);
  assert.match(read('index.html'), /id="create-room"/);
});

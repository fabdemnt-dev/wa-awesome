import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pagePath = new URL('../toybox/mofumofu-gathering/online/multi/index.html', import.meta.url);
const page = readFileSync(pagePath, 'utf8');
const publicRoot = new URL('../toybox/mofumofu-gathering/online/', import.meta.url);
const repositoryRoot = new URL('../', import.meta.url);
const multiRoot = new URL('multi/', publicRoot);
const origins = ['https://wa-awesome-mofumofu-stg.web.app/multi', 'https://wa-awesome-mofumofu-stg.web.app/multi/'];
const hostingConfig = JSON.parse(readFileSync(new URL('../firebase.json', import.meta.url), 'utf8')).hosting;

function attribute(tag, name) {
  return tag.match(new RegExp(`${name}="([^"]+)"`))?.[1] ?? '';
}

function localAsset(urlPath) {
  return new URL(urlPath.replace(/^\//, ''), publicRoot);
}

test('multi page resolves its stylesheet and entry module identically with or without a trailing slash', () => {
  const stylesheetTag = page.match(/<link[^>]+rel="stylesheet"[^>]*>/)?.[0] ?? '';
  const moduleTag = page.match(/<script[^>]+type="module"[^>]*><\/script>/)?.[0] ?? '';
  const stylesheet = attribute(stylesheetTag, 'href');
  const module = attribute(moduleTag, 'src');

  assert.equal(stylesheet, '../multi/style.css?v=20260926-2');
  assert.equal(module, '../multi/script.js?v=20260927-1');
  for (const origin of origins) {
    assert.equal(new URL(stylesheet, origin).pathname, '/multi/style.css');
    assert.equal(new URL(module, origin).pathname, '/multi/script.js');
    assert.notEqual(new URL(module, origin).pathname, '/script.js');
  }
});

test('normalized /multi HTML is revalidated instead of retaining a stale entry module', () => {
  assert.equal(hostingConfig.trailingSlash, false);
  const rule = hostingConfig.headers.find(({ source }) => source === '/multi');
  assert.deepEqual(rule?.headers, [
    { key: 'Cache-Control', value: 'no-cache, max-age=0, must-revalidate' },
  ]);
});

test('multi module graph resolves under /multi and every local module exists', () => {
  const client = readFileSync(new URL('script.js', multiRoot), 'utf8');
  const localImports = [...client.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)].map((match) => match[1]);
  assert.deepEqual(localImports.sort(), [
    './firebase-config.js?v=20260926-1',
    './multi-core.js?v=20260926-1',
    './multi-resume.js?v=20260926-1',
  ]);
  for (const specifier of localImports) {
    const url = new URL(specifier, 'https://wa-awesome-mofumofu-stg.web.app/multi/script.js');
    assert.equal(url.pathname.startsWith('/multi/'), true);
    assert.equal(existsSync(localAsset(url.pathname)), true, `${url.pathname} is missing`);
  }

  const resume = readFileSync(new URL('multi-resume.js', multiRoot), 'utf8');
  assert.match(resume, /from '\.\/multi-core\.js'/);
  assert.equal(existsSync(new URL('multi-core.js', multiRoot)), true);
  assert.equal(existsSync(new URL('firebase-config.js', multiRoot)), true);
});

test('formal card and logo assets resolve for both URL forms and exist', async () => {
  const core = await import('../toybox/mofumofu-gathering/online/multi/multi-core.js');
  const logo = attribute(page.match(/<img[^>]+mofumofu-logo\.png[^>]*>/)?.[0] ?? '', 'src');
  const assetPaths = [logo, core.LOGO_PATH, ...core.ANIMALS.map((animal) => core.cardImagePath(animal))];

  for (const origin of origins) {
    for (const assetPath of assetPaths) {
      const resolved = new URL(assetPath, origin);
      assert.equal(resolved.pathname.startsWith('/assets/mofumofu-gathering/'), true);
      const repositoryAsset = new URL(resolved.pathname.replace(/^\//, ''), repositoryRoot);
      assert.equal(existsSync(repositoryAsset), true, `${fileURLToPath(repositoryAsset)} is missing`);
      assert.equal(existsSync(localAsset(resolved.pathname)), true, `${resolved.pathname} is outside the Hosting public tree`);
    }
  }
});

test('public gates and existing two-player entry remain unchanged', async () => {
  const core = await import('../toybox/mofumofu-gathering/online/multi/multi-core.js');
  const existingEntry = readFileSync(new URL('../toybox/mofumofu-gathering/online-entry.js', import.meta.url), 'utf8');
  const existingPage = readFileSync(new URL('../toybox/mofumofu-gathering/online/index.html', import.meta.url), 'utf8');
  assert.equal(core.MULTI_ONLINE_PUBLIC_ENABLED, false);
  assert.match(existingEntry, /const ONLINE_PUBLIC_ENABLED = true;/);
  assert.match(existingPage, /<script type="module" src="\.\/script\.js\?v=20260925-4"><\/script>/);
});

test('every statically referenced UI id exists before the multi client starts', () => {
  const client = readFileSync(new URL('script.js', multiRoot), 'utf8');
  const referencedIds = new Set([...client.matchAll(/\$\(['"]([^'"]+)['"]\)/g)].map((match) => match[1]));
  const pageIds = new Set([...page.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
  assert.deepEqual([...referencedIds].filter((id) => !pageIds.has(id)), []);
});

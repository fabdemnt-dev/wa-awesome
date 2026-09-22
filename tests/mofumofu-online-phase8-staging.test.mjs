import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const backend = require('../functions/mofumofu-online');
const configUrl = pathToFileURL(new URL('../toybox/mofumofu-gathering/online/firebase-config.js', import.meta.url).pathname);
const html = await readFile(new URL('../toybox/mofumofu-gathering/online/index.html', import.meta.url), 'utf8');
const firebaseJson = JSON.parse(await readFile(new URL('../firebase.json', import.meta.url), 'utf8'));

const productionOrigin = 'https://fabdemnt-dev.github.io';
const stagingOrigin = 'https://wa-awesome-mofumofu-stg.web.app';
const stagingConfig = {
  environment: 'staging',
  hostname: 'wa-awesome-mofumofu-stg.web.app',
  firebase: {
    apiKey: 'AIzaSyB1oIhZWMryuWZV9r2-nO9X4W6LuqXVvlo',
    authDomain: 'wa-awesome-mofumofu-stg.firebaseapp.com',
    projectId: 'wa-awesome-mofumofu-stg',
    storageBucket: 'wa-awesome-mofumofu-stg.firebasestorage.app',
    messagingSenderId: '481875415725',
    appId: '1:481875415725:web:e16ec434ac7cddd117ec24',
    databaseURL: 'https://wa-awesome-mofumofu-stg-default-rtdb.asia-southeast1.firebasedatabase.app',
  },
  appCheckSiteKey: '6LfWOsgtAAAAAIuboWvU-f8EEAh2olIFiGDk_f1X',
};

async function resolve(hostname, injected = {}) {
  globalThis.location = { hostname };
  globalThis.MOFUMOFU_ONLINE_CONFIG = injected;
  const module = await import(`${configUrl.href}?case=${encodeURIComponent(hostname)}-${Math.random()}`);
  return module.resolveEnvironment();
}

test('CORSはprojectごとの単一origin allowlistでfail-closed', () => {
  const { corsOriginsForProject } = backend._test;
  assert.deepEqual(corsOriginsForProject('wa-awesome'), [productionOrigin]);
  assert.ok(!corsOriginsForProject('wa-awesome').includes(stagingOrigin));
  assert.deepEqual(corsOriginsForProject('wa-awesome-mofumofu-stg'), [stagingOrigin]);
  assert.ok(!corsOriginsForProject('wa-awesome-mofumofu-stg').includes(productionOrigin));
  assert.deepEqual(corsOriginsForProject('unknown-project'), []);
  assert.ok(!corsOriginsForProject('wa-awesome').includes('*'));
  assert.ok(!corsOriginsForProject('wa-awesome-mofumofu-stg').includes('*'));
});

test('production hostnameはproduction configだけを選ぶ', async () => {
  const environment = await resolve('fabdemnt-dev.github.io', { databaseURL: 'https://production.example', appCheckSiteKey: 'production-key' });
  assert.equal(environment.name, 'production');
  assert.equal(environment.firebase.projectId, 'wa-awesome');
  assert.notEqual(environment.firebase.projectId, stagingConfig.firebase.projectId);
});

test('staging hostnameは検証済みstaging configだけを選ぶ', async () => {
  const environment = await resolve('wa-awesome-mofumofu-stg.web.app', stagingConfig);
  assert.equal(environment.name, 'staging');
  assert.equal(environment.firebase.appId, '1:481875415725:web:e16ec434ac7cddd117ec24');
  assert.equal(environment.firebase.projectId, 'wa-awesome-mofumofu-stg');
  assert.equal(environment.firebase.authDomain, 'wa-awesome-mofumofu-stg.firebaseapp.com');
  assert.equal(environment.firebase.databaseURL, 'https://wa-awesome-mofumofu-stg-default-rtdb.asia-southeast1.firebasedatabase.app');
  assert.equal(environment.appCheck.siteKey, '6LfWOsgtAAAAAIuboWvU-f8EEAh2olIFiGDk_f1X');
  assert.notEqual(environment.firebase.projectId, 'wa-awesome');
});

test('未知hostnameはstagingを自動選択しない', async () => {
  await assert.rejects(() => resolve('unknown.example', stagingConfig), /このホストではオンライン版を起動できません/);
});

test('staging runtime configの不足・不一致を拒否する', async () => {
  await assert.rejects(() => resolve('wa-awesome-mofumofu-stg.web.app', {}), /staging runtime configが正しくありません/);
  const wrong = structuredClone(stagingConfig);
  wrong.firebase.projectId = 'wa-awesome';
  await assert.rejects(() => resolve('wa-awesome-mofumofu-stg.web.app', wrong), /staging project IDが正しくありません/);
});

test('HTMLは正確なstaging hostnameでmodule前にconfigを注入する', () => {
  assert.match(html, /location\.hostname === 'wa-awesome-mofumofu-stg\.web\.app'/);
  assert.ok(html.indexOf('MOFUMOFU_ONLINE_CONFIG') < html.indexOf('type="module"'));
});

test('Hostingはstaging siteとオンライン版ディレクトリだけを対象にする', () => {
  assert.equal(firebaseJson.hosting.site, 'wa-awesome-mofumofu-stg');
  assert.equal(firebaseJson.hosting.public, 'toybox/mofumofu-gathering/online');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const configUrl = pathToFileURL(new URL('toybox/mofumofu-gathering/online/firebase-config.js', root).pathname);
const production = Object.freeze({ environment: 'production', hostname: 'fabdemnt-dev.github.io', databaseURL: 'https://wa-awesome-default-rtdb.asia-southeast1.firebasedatabase.app', appCheckSiteKey: '6LeU8sstAAAAAOEyP56nWLD633TiAWaLmvcskE6e' });
const staging = Object.freeze({
  environment: 'staging', hostname: 'wa-awesome-mofumofu-stg.web.app',
  firebase: Object.freeze({ apiKey: 'AIzaSyB1oIhZWMryuWZV9r2-nO9X4W6LuqXVvlo', authDomain: 'wa-awesome-mofumofu-stg.firebaseapp.com', projectId: 'wa-awesome-mofumofu-stg', storageBucket: 'wa-awesome-mofumofu-stg.firebasestorage.app', messagingSenderId: '481875415725', appId: '1:481875415725:web:e16ec434ac7cddd117ec24', databaseURL: 'https://wa-awesome-mofumofu-stg-default-rtdb.asia-southeast1.firebasedatabase.app' }),
  appCheckSiteKey: '6LfWOsgtAAAAAIuboWvU-f8EEAh2olIFiGDk_f1X',
});

async function resolve(hostname, injected = {}) {
  globalThis.location = { hostname }; globalThis.MOFUMOFU_ONLINE_CONFIG = injected;
  return (await import(`${configUrl.href}?phase9=${Math.random()}`)).resolveEnvironment();
}

test('production hostは検証済みproduction値だけを選ぶ', async () => {
  const value = await resolve('fabdemnt-dev.github.io', production);
  assert.equal(value.name, 'production'); assert.equal(value.firebase.projectId, 'wa-awesome');
  assert.equal(value.firebase.databaseURL, production.databaseURL); assert.equal(value.appCheck.siteKey, production.appCheckSiteKey);
  assert.notEqual(value.firebase.projectId, staging.firebase.projectId);
});

test('staging hostはstaging値、localhostはEmulator値だけを選ぶ', async () => {
  const stagingValue = await resolve('wa-awesome-mofumofu-stg.web.app', staging);
  assert.equal(stagingValue.name, 'staging'); assert.equal(stagingValue.firebase.projectId, 'wa-awesome-mofumofu-stg');
  const localValue = await resolve('localhost', production);
  assert.equal(localValue.name, 'emulator'); assert.equal(localValue.firebase.projectId, 'mofumofu-local'); assert.equal(localValue.appCheck.debug, true);
});

test('production必須値欠損・staging/Emulator fallback・未知hostをfail-closedにする', async () => {
  await assert.rejects(() => resolve('fabdemnt-dev.github.io', { ...production, databaseURL: '' }), /production RTDB URL/);
  await assert.rejects(() => resolve('fabdemnt-dev.github.io', { ...production, appCheckSiteKey: '' }), /production App Check site key/);
  await assert.rejects(() => resolve('fabdemnt-dev.github.io', staging), /production runtime config/);
  await assert.rejects(() => resolve('fabdemnt-dev.github.io', { ...production, databaseURL: 'http://localhost' }), /production RTDB URL/);
  await assert.rejects(() => resolve('unknown.example', production), /このホストではオンライン版を起動できません/);
});

test('productionでdebug provider/tokenを使わず秘密情報を成果物へ含めない', async () => {
  const [config, client, html] = await Promise.all([read('toybox/mofumofu-gathering/online/firebase-config.js'), read('toybox/mofumofu-gathering/online/script.js'), read('toybox/mofumofu-gathering/online/index.html')]);
  const combined = `${config}\n${client}\n${html}`;
  assert.match(config, /name: 'production'[\s\S]*appCheck: \{ siteKey:/);
  assert.doesNotMatch(combined, /BEGIN PRIVATE KEY|private_key|refresh[_ -]?token|access[_ -]?token|id[_ -]?token|MOFUMOFU_ONLINE_IP_HMAC_KEY/i);
  assert.doesNotMatch(combined, /FIREBASE_APPCHECK_DEBUG_TOKEN\s*=\s*['"][^'"]+['"]/);
  assert.match(client, /if \(environment\.appCheck\.debug\).*FIREBASE_APPCHECK_DEBUG_TOKEN = true/);
});

test('オンラインUIは戻り導線、説明Dialog、live region、44px、重要操作busy guardを備える', async () => {
  const [html, css, client, entry] = await Promise.all([read('toybox/mofumofu-gathering/online/index.html'), read('toybox/mofumofu-gathering/online/style.css'), read('toybox/mofumofu-gathering/online/script.js'), read('toybox/mofumofu-gathering/online-entry.js')]);
  assert.match(html, /もふもふ大集合！へ戻る/); assert.match(html, /おもちゃ箱へ戻る/); assert.match(html, /<dialog id="help-dialog" aria-labelledby="help-title">/); assert.match(html, /招待コード.*8文字/s);
  assert.ok((html.match(/aria-live=/g) || []).length >= 4); assert.match(css, /min-height: 44px/); assert.match(css, /max-width: 340px/); assert.match(css, /max-width: 100%/);
  assert.match(client, /create-room'[\s\S]*button\.disabled/); assert.match(client, /join-room'[\s\S]*button\.disabled/); assert.match(client, /state\.makeBusy[\s\S]*button\.disabled = true/); assert.match(client, /state\.judgeBusy[\s\S]*buttons\.forEach/);
  assert.match(entry, /ONLINE_PUBLIC_ENABLED = false/);
});

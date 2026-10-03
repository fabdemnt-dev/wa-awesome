// Real Chromium UI, but every request is fulfilled/aborted locally. App Check and
// Auth are synthetic. This never contacts Google or claims real attestation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { extname } from 'node:path';
import { CONNECTION_CSP } from '../scripts/deploy-floating-garden-connection-template.mjs';
import { chromium } from './e2e/node_modules/playwright/index.mjs';
const ORIGIN = 'https://wa-awesome-garden-stg.web.app';
const URL = `${ORIGIN}/connection-check/`;
const NOW = Date.parse('2026-10-03T03:00:00Z');
const runtime = { schemaVersion: 1, projectId: 'wa-awesome-garden-stg', origin: ORIGIN,
  startsAtMillis: NOW - 1000, expiresAtMillis: NOW + 86400000,
  firebase: { apiKey: 'AIzaSyCfa04hxQzY0T6gsVLsvTxIhB2zAB0v874', appId: '1:120030709276:web:015f4e996b7c42a4e801d9', authDomain: 'wa-awesome-garden-stg.firebaseapp.com', projectId: 'wa-awesome-garden-stg' },
  appCheck: { provider: 'recaptcha-enterprise', siteKey: '6Lc_LNwtAAAAADRAHvq10FwxirR3c5jZlxS9QpYw' } };
const modules = {
  'firebase-app.js': `const apps=[]; export function getApps(){return apps;} export function initializeApp(options,name){ const a={options,name}; apps.push(a); return a;} export async function deleteApp(a){const i=apps.indexOf(a);if(i>=0)apps.splice(i,1);}`,
  'firebase-app-check.js': `export class ReCaptchaEnterpriseProvider {constructor(k){this.key=k;}} export function initializeAppCheck(a,o){return {a,o};} export function setTokenAutoRefreshEnabled(){} export async function getToken(){return {token:'synthetic-proof-not-for-display'};}`,
  'firebase-auth.js': `export const browserLocalPersistence={}; const k='synthetic-ui-auth'; export function initializeAuth(){const uid=localStorage.getItem(k);return {currentUser:uid?{uid,isAnonymous:true}:null,authStateReady:async()=>{}};} export async function setPersistence(){} export async function signInAnonymously(a){const count=Number(localStorage.getItem('synthetic-sign-in-count')||'0')+1;localStorage.setItem('synthetic-sign-in-count',String(count));const uid='browser-fixture-anonymous-uid-'+count;localStorage.setItem(k,uid);a.currentUser={uid,isAnonymous:true};return {user:a.currentUser};}`,
};
const mimes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

test('connection page mobile layout, no pre-start SDK, one-shot Auth, reload persistence and expired denial in real browser with fully synthetic networking', { timeout: 60000 }, async (t) => {
  const options = process.env.GARDEN_CHROMIUM_EXECUTABLE ? { executablePath: process.env.GARDEN_CHROMIUM_EXECUTABLE } : {};
  const browser = await chromium.launch({ headless: true, ...options }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.addInitScript((time) => { Date.now = () => time; }, NOW);
  const sdkRequests = [], blocked = [];
  const headers = { 'content-security-policy': CONNECTION_CSP, 'cache-control': 'no-store' };
  await context.route('**/*', async (route) => {
    const address = new globalThis.URL(route.request().url());
    if (address.origin === 'https://www.gstatic.com' && address.pathname.startsWith('/firebasejs/10.8.0/')) {
      const name = address.pathname.split('/').pop(); sdkRequests.push(name);
      if (modules[name]) return route.fulfill({ status: 200, contentType: 'text/javascript', body: modules[name], headers: { 'access-control-allow-origin': '*' } });
    }
    if ([ORIGIN, 'https://wrong-origin.invalid'].includes(address.origin)) {
      const name = address.pathname === '/connection-check/' ? 'index.html' : address.pathname.startsWith('/connection-check/') ? address.pathname.slice('/connection-check/'.length) : '';
      if (name === 'connection-runtime.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: `export default ${JSON.stringify(runtime)};`, headers });
      if (['index.html', 'app.js', 'connection.js', 'style.css'].includes(name)) {
        const body = await readFile(new globalThis.URL(`../lab/floating-garden/connection-check/${name}`, import.meta.url));
        return route.fulfill({ status: 200, contentType: mimes[extname(name)], body, headers });
      }
      if (address.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' });
    }
    blocked.push(address.origin + address.pathname); await route.abort();
  });
  const page = await context.newPage();
  await page.goto(URL); await page.getByRole('button', { name: '接続確認を開始' }).waitFor({ state: 'visible' });
  assert.equal(sdkRequests.length, 0);
  assert.ok((await page.locator('#connection-expiry').innerText()).includes('2026'));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.getByRole('button', { name: '接続確認を開始' }).click();
  await page.getByText('接続確認が完了しました', { exact: true }).waitFor();
  assert.equal(await page.locator('#connection-uid').innerText(), 'browser-fixture-anonymous-uid-1');
  assert.equal(await page.getByRole('button', { name: '接続確認を開始' }).isDisabled(), true);
  assert.deepEqual([...sdkRequests].sort(), Object.keys(modules).sort());
  assert.ok(!(await page.locator('body').innerText()).includes('synthetic-proof'));
  const output = process.env.GARDEN_CONNECTION_SCREENSHOTS;
  if (output) { await mkdir(output, { recursive: true }); await page.screenshot({ path: `${output}/connection-mobile-synthetic-success.png`, fullPage: true }); }
  await page.reload(); await page.getByRole('button', { name: '接続確認を開始' }).click();
  await page.getByText('接続確認が完了しました', { exact: true }).waitFor();
  assert.equal(await page.locator('#connection-uid').innerText(), 'browser-fixture-anonymous-uid-1');
  assert.equal(await page.evaluate(() => localStorage.getItem('synthetic-sign-in-count')), '1');
  const count = sdkRequests.length;
  await page.goto('https://wrong-origin.invalid/connection-check/');
  await page.getByText('配信元・設定・有効期間を確認できません', { exact: true }).waitFor();
  assert.equal(sdkRequests.length, count);
  const expired = await context.newPage();
  await expired.addInitScript((time) => { Date.now = () => time; }, runtime.expiresAtMillis);
  await expired.goto(URL); await expired.getByText('配信元・設定・有効期間を確認できません', { exact: true }).waitFor();
  assert.equal(sdkRequests.length, count);
  assert.deepEqual(blocked, []);
});

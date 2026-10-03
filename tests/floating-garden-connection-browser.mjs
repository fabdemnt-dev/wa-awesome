// Real Chromium UI, but every request is fulfilled/aborted locally. App Check and
// Auth are synthetic. This never contacts Google or claims real attestation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { extname } from 'node:path';
import { CONNECTION_CSP, runtimeConfig } from '../scripts/deploy-floating-garden-connection-template.mjs';
import { chromium } from './e2e/node_modules/playwright/index.mjs';
import { IDENTITY_ATTEMPT_KEY } from '../lab/floating-garden/connection-check/connection.js';
import { SDK_BASE, APP_CHECK_ORIGIN, AUTH_ORIGIN, UID, TOKENS, RECAPTCHA_PROOF, RECAPTCHA_SCRIPT, loadOfficialSdk, syntheticResponse, legacyCsp } from './fixtures/firebase-10.8.0/fixture.mjs';
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

// Unlike the preceding intentionally synthetic SDK/UI test, these scenarios
// evaluate the official CDN modules byte-for-byte. Only reCAPTCHA/platform and
// endpoint responses are fake. Chromium enforces the actual response CSP.
test('exact Firebase 10.8.0 SDK regression: old CSP fails before Auth; publisher CSP succeeds without duplicate identities or token DOM', { timeout: 150000 }, async (t) => {
  const officialModules = await loadOfficialSdk();
  const options = process.env.GARDEN_CHROMIUM_EXECUTABLE ? { executablePath: process.env.GARDEN_CHROMIUM_EXECUTABLE } : {};
  const browser = await chromium.launch({ headless: true, ...options });
  t.after(() => browser.close());
  for (const [mode, csp, fault] of [
    ['old-csp', legacyCsp(CONNECTION_CSP), null], ['publisher-csp', CONNECTION_CSP, null],
    ['app-check-403', CONNECTION_CSP, { stage: 'app-check-request', code: 'appCheck/throttled', signup: 0, lookup: 0 }],
    ['signup-disabled', CONNECTION_CSP, { stage: 'anonymous-signup', code: 'auth/operation-not-allowed', signup: 1, lookup: 0 }],
    ['lookup-invalid', CONNECTION_CSP, { stage: 'anonymous-signup', code: 'auth/invalid-user-token', signup: 1, lookup: 1 }],
  ]) {
    await t.test(mode, async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
      try {
        const requests = [], unexpected = [], pageErrors = [];
        await context.addInitScript((time) => {
          Date.now = () => time;
          window.__connectionCspViolations = [];
          window.__connectionStatusHistory = [];
          document.addEventListener('securitypolicyviolation', (event) => {
            window.__connectionCspViolations.push({ directive: event.effectiveDirective, blocked: event.blockedURI });
          });
          document.addEventListener('DOMContentLoaded', () => {
            const status = document.getElementById('connection-status');
            window.__connectionStatusHistory.push(status.textContent);
            new MutationObserver((mutations) => {
              for (const mutation of mutations) {
                for (const node of mutation.addedNodes) window.__connectionStatusHistory.push(node.textContent);
              }
            }).observe(status, { childList: true });
          });
        }, NOW);
        const headers = { 'content-security-policy': csp, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
        await context.route('**/*', async (route) => {
          const request = route.request();
          const address = new globalThis.URL(request.url());
          const endpoint = address.origin + address.pathname;
          const method = request.method();
          requests.push({ endpoint, method });
          // Every request is explicitly fulfilled or aborted. No live transport,
          // fallback route, service worker, route.fetch, or route.continue exists.
          if (address.origin === ORIGIN && method === 'GET') {
            const name = address.pathname === '/connection-check/' ? 'index.html' : address.pathname.startsWith('/connection-check/') ? address.pathname.slice('/connection-check/'.length) : '';
            if (name === 'connection-runtime.js') return route.fulfill({ status: 200, contentType: 'text/javascript', headers, body: `export default ${JSON.stringify(runtimeConfig())};` });
            if (['index.html', 'app.js', 'connection.js', 'style.css'].includes(name)) {
              return route.fulfill({ status: 200, contentType: mimes[extname(name)], headers, body: await readFile(new globalThis.URL(`../lab/floating-garden/connection-check/${name}`, import.meta.url)) });
            }
            if (address.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' });
          }
          if (method === 'GET' && officialModules.has(request.url())) {
            return route.fulfill({ status: 200, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: officialModules.get(request.url()) });
          }
          if (method === 'GET' && address.origin === 'https://www.google.com' && address.pathname === '/recaptcha/enterprise.js') {
            return route.fulfill({ status: 200, contentType: 'text/javascript', body: RECAPTCHA_SCRIPT });
          }
          const response = syntheticResponse(request.url());
          if (response && method === 'OPTIONS') {
            return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': ORIGIN, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': request.headers()['access-control-request-headers'] || '*' }, body: '' });
          }
          if (response && method === 'POST') {
            const body = request.postDataJSON();
            if (address.origin === APP_CHECK_ORIGIN) assert.equal(body.recaptcha_enterprise_token, RECAPTCHA_PROOF);
            if (address.pathname === '/v1/accounts:signUp') assert.equal(body.returnSecureToken, true);
            const rejection = mode === 'app-check-403' && address.origin === APP_CHECK_ORIGIN ? { status: 403, message: 'PERMISSION_DENIED' } :
              mode === 'signup-disabled' && address.pathname === '/v1/accounts:signUp' ? { status: 400, message: 'OPERATION_NOT_ALLOWED' } :
              mode === 'lookup-invalid' && address.pathname === '/v1/accounts:lookup' ? { status: 400, message: 'INVALID_ID_TOKEN' } : null;
            const data = rejection ? { error: { message: rejection.message, code: rejection.status, details: 'synthetic-private-error-detail-not-for-display' } } : response;
            return route.fulfill({ status: rejection?.status ?? 200, contentType: 'application/json', headers: { 'access-control-allow-origin': ORIGIN }, body: JSON.stringify(data) });
          }
          unexpected.push(endpoint);
          await route.abort('blockedbyclient');
        });
        const page = await context.newPage();
        page.on('pageerror', (error) => pageErrors.push(error.name));
        const startButton = page.getByRole('button', { name: '接続確認を開始' });
        await page.goto(URL);
        await startButton.waitFor({ state: 'visible' });
        assert.equal(requests.some((request) => !request.endpoint.startsWith(ORIGIN + '/')), false, 'no SDK, attestation or Auth before Start');
        assert.equal(await page.evaluate((key) => localStorage.getItem(key), IDENTITY_ATTEMPT_KEY), null);
        // Deliver duplicate events in the same turn, including a programmatic
        // event despite the disabled button, to exercise the client one-shot guard.
        await startButton.evaluate((button) => {
          button.click();
          button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        const expected = mode === 'old-csp' || fault ? '接続を確認できませんでした' : '接続確認が完了しました';
        await page.getByText(expected, { exact: true }).waitFor({ timeout: 20000 });
        const inspect = () => page.evaluate((key) => ({
          status: document.getElementById('connection-status').textContent,
          uid: document.getElementById('connection-uid').textContent,
          diagnostic: document.getElementById('connection-diagnostic').textContent,
          guard: localStorage.getItem(key),
          violations: window.__connectionCspViolations,
          states: window.__connectionStatusHistory,
          html: document.documentElement.outerHTML,
        }), IDENTITY_ATTEMPT_KEY);
        const initial = await inspect();
        assert.equal(await startButton.isDisabled(), true);
        for (const token of [...TOKENS, 'synthetic-private-error-detail-not-for-display']) assert.equal(initial.html.includes(token), false, 'tokens and raw errors must never appear in visible or hidden DOM');
        assert.deepEqual(requests.filter((request) => request.endpoint.startsWith(SDK_BASE)).map((request) => request.endpoint).sort(), [...officialModules.keys()].sort());
        if (mode === 'old-csp') {
          assert.equal(initial.uid, '未確認');
          assert.equal(initial.guard, null);
          assert.equal(initial.states.includes('匿名認証を確認しています'), false);
          assert.ok(initial.violations.some((violation) => violation.directive === 'connect-src' && new globalThis.URL(violation.blocked).origin === APP_CHECK_ORIGIN), 'Chromium must report the actual SDK App Check host blocked by connect-src');
          assert.equal(requests.some((request) => request.endpoint.startsWith(AUTH_ORIGIN)), false);
          assert.equal(requests.some((request) => request.endpoint.startsWith(APP_CHECK_ORIGIN)), false, 'CSP blocks exchange before routing/transport');
          const beforeDuplicate = requests.length;
          await startButton.dispatchEvent('click');
          assert.equal(await page.locator('#connection-status').innerText(), expected);
          assert.equal(requests.length, beforeDuplicate, 'terminal failed click cannot retry the exchange');
        } else if (fault) {
          assert.equal(initial.uid, '未確認');
          assert.ok(initial.diagnostic.includes(fault.stage));
          assert.ok(initial.diagnostic.includes(fault.code));
          assert.equal(initial.guard, fault.signup ? 'attempted' : null);
          assert.deepEqual(initial.violations, []);
          const count = (path) => requests.filter((request) => request.method === 'POST' && request.endpoint === `${AUTH_ORIGIN}/v1/accounts:${path}`).length;
          assert.equal(count('signUp'), fault.signup);
          assert.equal(count('lookup'), fault.lookup);
          const beforeRepeat = requests.length;
          await startButton.dispatchEvent('click');
          assert.deepEqual(await inspect(), initial, 'failure and diagnostic stay terminal after another click');
          assert.equal(requests.length, beforeRepeat, 'diagnostic display must not retry a failed operation');
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
          const output = process.env.GARDEN_CONNECTION_SCREENSHOTS;
          if (output) {
            await mkdir(output, { recursive: true });
            await page.screenshot({ path: `${output}/connection-mobile-diagnostic-${mode}.png`, fullPage: true });
          }
        } else {
          assert.equal(initial.uid, UID);
          assert.equal(initial.guard, 'attempted');
          assert.deepEqual(initial.violations, []);
          assert.ok(initial.states.includes('接続を確認しています'));
          assert.ok(initial.states.includes('匿名認証を確認しています'));
          assert.ok(initial.states.includes('接続確認が完了しました'));
          const signups = () => requests.filter((request) => request.method === 'POST' && request.endpoint === `${AUTH_ORIGIN}/v1/accounts:signUp`).length;
          assert.equal(signups(), 1);
          await startButton.dispatchEvent('click');
          assert.equal(await page.locator('#connection-uid').innerText(), UID);
          assert.equal(signups(), 1);
          const output = process.env.GARDEN_CONNECTION_SCREENSHOTS;
          if (output) {
            await mkdir(output, { recursive: true });
            await page.screenshot({ path: `${output}/connection-mobile-official-sdk-synthetic-success.png`, fullPage: true });
          }
          const lookups = () => requests.filter((request) => request.method === 'POST' && request.endpoint === `${AUTH_ORIGIN}/v1/accounts:lookup`).length;
          const beforeReloadLookups = lookups();
          await page.reload();
          await startButton.waitFor({ state: 'visible' });
          assert.equal(signups(), 1, 'reload alone cannot create an identity');
          await startButton.click();
          await page.getByText(expected, { exact: true }).waitFor({ timeout: 20000 });
          const reloaded = await inspect();
          assert.equal(reloaded.uid, UID);
          assert.equal(reloaded.guard, 'attempted');
          assert.equal(signups(), 1, 'official browserLocalPersistence must reuse the same identity after reload');
          assert.equal(lookups(), beforeReloadLookups + 1, 'reload validates the persisted SDK user rather than signing up again');
          assert.deepEqual(reloaded.violations, []);
          for (const token of TOKENS) assert.equal(reloaded.html.includes(token), false);
        }
        assert.deepEqual(unexpected, [], 'unexpected requests are blocked and fail this regression');
        assert.deepEqual(pageErrors, []);
      } finally { await context.close(); }
    });
  }
});

// Chromium enforces the generated Hosting CSP. All transport is synthetic;
// no live SDK, attestation, authentication, credentials, or identities are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from './e2e/node_modules/playwright/index.mjs';
import { prepareTrialBundle, FUNCTION_NAMES } from '../scripts/prepare-floating-garden-trial.mjs';
import { FIXED_TRIAL_PROJECT as PROJECT, FIXED_TRIAL_ORIGIN as ORIGIN } from '../lab/floating-garden/trial/config.js';

test('fixed game Hosting CSP allows reviewed transports and the exact style hash, blocking other routes before transport', { timeout: 60000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'garden-trial-csp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'bundle'), start = Date.parse('2026-10-02T00:00:00Z');
  const config = { schemaVersion: 1, enabled: true, projectId: PROJECT, previewOrigin: ORIGIN,
    startsAtMillis: start, endsAtMillis: start + 7 * 86400000, region: 'asia-northeast1', maxTesters: 2, maxRooms: 20,
    firebase: { apiKey: 'AIza' + 'a'.repeat(35), authDomain: `${PROJECT}.firebaseapp.com`, projectId: PROJECT, appId: '1:123456789:web:abcdef0123456789' },
    appCheck: { provider: 'recaptcha-enterprise', siteKey: '6L' + 'a'.repeat(38), verified: true } };
  await prepareTrialBundle({ config, output, now: start });
  const full = JSON.parse(await readFile(join(output, 'firebase.trial.json'), 'utf8')).hosting;
  const hosting = JSON.parse(await readFile(join(output, 'firebase.hosting-only.json'), 'utf8')).hosting;
  assert.deepEqual(hosting, full);
  assert.equal(hosting.headers.length, 1); assert.equal(hosting.headers[0].source, '**');
  const headers = Object.fromEntries(hosting.headers[0].headers.map(({ key, value }) => [key.toLowerCase(), value]));
  assert.ok(headers['content-security-policy'], 'use the actual generated policy without additions or overrides');
  const view = await readFile(join(output, 'public/lab/floating-garden/online/view.js'), 'utf8');
  const styles = [...view.matchAll(/\bstyle="([^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual(styles, ['--opponent-count:1']);

  const sdk = 'https://www.gstatic.com/firebasejs/10.8.0/';
  const exchange = `https://content-firebaseappcheck.googleapis.com/v1/projects/${PROJECT}/apps/${config.firebase.appId}:exchangeRecaptchaEnterpriseToken`;
  const functions = `https://asia-northeast1-${PROJECT}.cloudfunctions.net/`;
  const firestore = 'https://firestore.googleapis.com/';
  const listen = `${firestore}google.firestore.v1.Firestore/Listen/channel?database=projects%2F${PROJECT}%2Fdatabases%2F(default)`;
  const allowedScripts = [...['app', 'app-check', 'auth', 'firestore', 'functions'].map((name) => `${sdk}firebase-${name}.js`),
    'https://www.google.com/recaptcha/enterprise.js', 'https://www.gstatic.com/recaptcha/releases/local-fixture/recaptcha.js'];
  const allowedConnections = [exchange, 'https://identitytoolkit.googleapis.com/v1/accounts:signUp',
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup', 'https://securetoken.googleapis.com/v1/token', listen,
    ...FUNCTION_NAMES.map((name) => functions + name), 'https://www.google.com/recaptcha/enterprise/reload'];
  const allowedFrames = ['https://www.google.com/recaptcha/enterprise/anchor', 'https://recaptcha.google.com/recaptcha/enterprise/bframe'];
  const forbiddenFrame = 'https://www.google.com/unrelated-frame';
  const forbiddenScripts = [sdk.replace('10.8.0', '10.9.0') + 'firebase-app.js', sdk + 'firebase-storage.js',
    sdk + 'firebase-app.js/extra', 'https://www.google.com/unrelated.js', 'https://www.gstatic.com/recaptcha-other/recaptcha.js'];
  const forbiddenConnections = [exchange.replace(PROJECT, 'other-garden-project'),
    exchange.replace(config.firebase.appId, '1:987654321:web:abcdef0123456789'),
    exchange.replace('exchangeRecaptchaEnterpriseToken', 'exchangeDebugToken'),
    exchange.replace('content-firebaseappcheck', 'firebaseappcheck'),
    'https://identitytoolkit.googleapis.com/v1/accounts:delete', 'https://securetoken.googleapis.com/v1/other',
    `${firestore}google.firestore.v1.Firestore/Write/channel`, `${firestore}v1/projects/${PROJECT}/databases/(default)/documents:commit`,
    functions + 'otherFunction', functions + FUNCTION_NAMES[0] + 'Extra', functions + FUNCTION_NAMES[0] + '/extra',
    functions.replace(PROJECT, 'other-garden-project') + FUNCTION_NAMES[0],
    functions.replace('asia-northeast1', 'us-central1') + FUNCTION_NAMES[0], `${ORIGIN}/unexpected-connect`,
    'https://www.google.com/recaptcha-other/reload', 'https://example.invalid/collect'];
  // Listen carries its database in the query; CSP cannot constrain query values.
  // Project/data authorization still belongs to the trial gates and Firestore rules.
  const probes = [
    ...allowedScripts.map((url) => ({ kind: 'script', url, allowed: true })),
    ...allowedConnections.map((url) => ({ kind: 'connect', url, method: 'POST', allowed: true })),
    { kind: 'connect', url: listen, method: 'GET', allowed: true },
    ...forbiddenScripts.map((url) => ({ kind: 'script', url, allowed: false })),
    ...forbiddenConnections.map((url) => ({ kind: 'connect', url, method: 'POST', allowed: false })),
  ];
  const driver = `
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', e => window.__cspViolations.push(e.effectiveDirective));
    document.body.insertAdjacentHTML('beforeend', '<div id="allowed" style="${styles[0]}"></div><div id="changed" style="--opponent-count:2"></div><div id="local-style"></div>');
    const injected = document.createElement('div'); injected.id = 'injected';
    injected.setAttribute('style', '${styles[0]};color:rgb(1, 2, 3)'); document.body.append(injected);
    const inline = document.createElement('style'); inline.textContent = '#local-style { --injected: yes }'; document.head.append(inline);
    const before = document.body.style.overflow; document.body.style.overflow = 'hidden';
    window.__cspModalStyle = [getComputedStyle(document.body).overflow]; document.body.style.overflow = before;
    window.__cspModalStyle.push(document.body.style.overflow);
    await Promise.all(${JSON.stringify(allowedFrames)}.map(url => new Promise(resolve => {
      const frame = document.createElement('iframe'); frame.onload = resolve; frame.src = url; document.body.append(frame);
    })));
    const deniedFrame = document.createElement('iframe'); deniedFrame.src = ${JSON.stringify(forbiddenFrame)}; document.body.append(deniedFrame);
    const results = [];
    for (const probe of ${JSON.stringify(probes)}) {
      let ok = false;
      try {
        if (probe.kind === 'script') ok = (await import(probe.url)).default === probe.url;
        else {
          const response = await fetch(probe.url, { method: probe.method, credentials: 'omit', redirect: 'error', ...(probe.method === 'POST' ? { body: '{}' } : {}) });
          ok = response.ok && await response.text() === 'local-response';
        }
      } catch {}
      results.push(ok);
    }
    window.__cspResults = results;
  `;
  const options = process.env.GARDEN_CHROMIUM_EXECUTABLE ? { executablePath: process.env.GARDEN_CHROMIUM_EXECUTABLE } : {};
  const browser = await chromium.launch({ headless: true, ...options }); t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const requests = [], unexpected = [], errors = [];
  await context.route('**/*', async (route) => {
    const request = route.request(), url = request.url(), method = request.method();
    requests.push(`${method} ${url}`);
    // Exhaustive interception: every request is fulfilled locally or aborted.
    if (method === 'GET' && url === `${ORIGIN}/csp-probe.html`) return route.fulfill({ headers, contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/probe.css"></head><body><script type="module" src="/probe.js"></script></body></html>' });
    if (method === 'GET' && url === `${ORIGIN}/probe.js`) return route.fulfill({ headers, contentType: 'text/javascript', body: driver });
    if (method === 'GET' && url === `${ORIGIN}/probe.css`) return route.fulfill({ headers, contentType: 'text/css', body: '#local-style { color: rgb(4, 5, 6) }' });
    if (method === 'GET' && url === `${ORIGIN}/favicon.ico`) return route.fulfill({ status: 204, body: '' });
    if (method === 'GET' && allowedScripts.includes(url)) return route.fulfill({ contentType: 'text/javascript', headers: { 'access-control-allow-origin': ORIGIN }, body: `export default ${JSON.stringify(url)};` });
    if (method === 'GET' && allowedFrames.includes(url)) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>local-frame</body></html>' });
    if (allowedConnections.includes(url) && (method === 'POST' || (method === 'GET' && url === listen))) {
      assert.equal(request.headers().authorization, undefined); assert.equal(request.headers().cookie, undefined);
      assert.equal(request.postData(), method === 'POST' ? '{}' : null);
      return route.fulfill({ contentType: 'text/plain', headers: { 'access-control-allow-origin': ORIGIN }, body: 'local-response' });
    }
    unexpected.push(`${method} ${url}`); await route.abort('blockedbyclient');
  });
  const page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${ORIGIN}/csp-probe.html`);
  await page.waitForFunction(() => window.__cspResults, null, { timeout: 20000 });
  assert.deepEqual(unexpected, [], 'forbidden requests must be blocked by CSP before reaching any mocked route');
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.__cspResults), probes.map(({ allowed }) => allowed));
  for (const probe of probes.filter(({ allowed }) => allowed)) assert.ok(requests.includes(`${probe.method || 'GET'} ${probe.url}`), `allowed request executed: ${probe.url}`);
  for (const url of allowedFrames) assert.ok(requests.includes(`GET ${url}`), `allowed frame executed: ${url}`);
  assert.deepEqual(await page.evaluate(() => window.__cspModalStyle), ['hidden', '']);
  assert.deepEqual(await page.evaluate(() => ['allowed', 'changed', 'injected'].map((id) => getComputedStyle(document.getElementById(id)).getPropertyValue('--opponent-count'))), ['1', '', '']);
  assert.equal(await page.locator('#local-style').evaluate((node) => getComputedStyle(node).color), 'rgb(4, 5, 6)');
  assert.equal(await page.locator('#local-style').evaluate((node) => getComputedStyle(node).getPropertyValue('--injected')), '');
  await page.waitForFunction(() => ['connect-src', 'script-src-elem', 'style-src-attr', 'style-src-elem', 'frame-src'].every((name) => window.__cspViolations.includes(name)), null, { timeout: 5000 });
});

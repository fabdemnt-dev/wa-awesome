// Generated trial app/bootstrap/config/firebase are served byte-for-byte. Real
// anonymous SDK Auth, callable HTTP, trial guards, transactions and rules execute
// against demo emulators. Explicit test-only SDK endpoint/attestation and Functions
// entry fixtures bridge live-only deployment gates. This is NOT live App Check,
// real Hosting/TLS, production Functions entry, IAM or Secret Manager validation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { chromium } from './e2e/node_modules/playwright/index.mjs';
import { emulatorConfig } from './helpers/floating-garden-emulators.mjs';
import { abortDeniedBrowserRequest } from './helpers/floating-garden-browser-network.mjs';
import { trialSdkFixture, trialEmulatorRoute, isTrialRelayNavigationCancellation, sanitizeTrialRelayFailure } from './helpers/floating-garden-trial-sdk-fixture.mjs';
import { ONLINE_SAVE_KEY } from '../lab/floating-garden/online/controller.js';
import { legalActions, getDecision, rankMatch, applyMatchAction } from '../lab/floating-garden/match-engine.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = emulatorConfig({ authAndFunctions: true });
assert.equal(config.projectId, 'demo-floating-garden-trial');
assert.equal(process.env.FLOATING_GARDEN_TRIAL_EMULATOR_FIXTURE, '1');
assert.ok(process.env.FLOATING_GARDEN_TRIAL_FIXTURE, 'Run the pure fixture preparation helper first');
const fixtureRoot = resolve(process.env.FLOATING_GARDEN_TRIAL_FIXTURE);
const fixture = JSON.parse(await readFile(resolve(fixtureRoot, 'emulator-fixture.json'), 'utf8'));
assert.equal(fixture.kind, 'floating-garden-trial-browser-emulator-only-v1');
assert.equal(fixture.projectId, config.projectId);
const EMULATOR_PORTS = fixture.ports;
const SAVE_KEY = `floating-garden-trial:${fixture.runtime.projectId}:${ONLINE_SAVE_KEY}`;
const APP_NAME = `floating-garden-trial-${fixture.runtime.projectId}`;
for (const kind of ['auth', 'firestore', 'functions']) {
  assert.equal(config[kind].port, EMULATOR_PORTS[kind], `the ${kind} emulator must use the actual app port`);
}
const require = createRequire(new URL('../functions/floating-garden-trial/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const sdkOrigin = 'https://www.gstatic.com';
const sdkPrefix = '/firebasejs/10.8.0/';
const entryPath = '/lab/floating-garden/trial/index.html';
const callablePath = '/';
const output = resolve(process.env.FLOATING_GARDEN_BROWSER_ARTIFACTS || '/tmp/floating-garden-trial-browser-emulator-qa');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

// The HTTPS preview origin is a browser routing fixture only. Requests are always
// fulfilled from the generated public graph, never sent to Firebase Hosting.
async function serveTrialAsset(route, served) {
  const request = route.request(), url = new URL(request.url());
  const publicRoot = resolve(fixtureRoot, 'public');
  const path = resolve(publicRoot, `.${decodeURIComponent(url.pathname)}`);
  if (!['GET', 'HEAD'].includes(request.method()) || !path.startsWith(publicRoot + '/') || !['.html', '.js', '.css'].includes(extname(path))) {
    await route.fulfill({ status: 404, body: '' }); return 404;
  }
  try {
    const bytes = await readFile(path); served.set(url.pathname, digest(bytes));
    await route.fulfill({ status: 200, body: bytes, headers: { 'content-type': { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }[extname(path)], 'cache-control': 'no-store' } });
    return 200;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await route.fulfill({ status: 404, body: '' });
    return 404;
  }
}

async function until(read, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${description}`);
}
const recovery = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || 'null'), SAVE_KEY);
const ready = (page) => page.waitForFunction((key) => {
  const status = document.querySelector('.online-connection > [role="status"]');
  const saved = JSON.parse(localStorage.getItem(key) || 'null');
  return (status?.textContent === 'サーバーと同期済み' || status?.textContent.startsWith('匿名認証済み')) && !saved?.pending;
}, SAVE_KEY);
const domRevision = (page) => page.evaluate(() => Number(document.querySelector('.shared-table > .demo-note')?.textContent.match(/確定操作 (\d+)回/)?.[1] ?? -1));
const waitRevision = (page, revision) => page.waitForFunction((expected) => {
  const text = document.querySelector('.shared-table > .demo-note')?.textContent || '';
  return Number(text.match(/確定操作 (\d+)回/)?.[1] ?? -1) === expected;
}, revision);
async function authUid(page) {
  // Observe the SDK instance initialized by firebase.js; do not create/sign in a
  // replacement app, read/write auth storage, or provide a synthetic identity.
  return page.evaluate(async (appName) => {
    const [{ getApp }, { getAuth }] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js'),
    ]);
    return getAuth(getApp(appName)).currentUser?.uid;
  }, APP_NAME);
}
// Security probes share the app's real authenticated SDK instance. They do not
// invoke handlers, forge Auth, edit persistence, or substitute a game transport.
async function clientProbe(page, operation) {
  return page.evaluate(async ({ appName, region, operation }) => {
    const [{ getApp }, fs, fn, { getAuth }] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js'),
      import('https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js'),
      import('https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js'),
    ]);
    const app = getApp(appName), db = fs.getFirestore(app);
    try {
      if (operation.kind === 'call') return { ok: true, value: (await fn.httpsCallable(fn.getFunctions(app, region), operation.name)(operation.data)).data };
      if (operation.kind === 'read') return { ok: true, value: (await fs.getDocFromServer(fs.doc(db, operation.path))).data() };
      if (operation.kind === 'fresh-read') {
        const user = getAuth(app).currentUser;
        if (!user?.isAnonymous) throw new Error('Real anonymous identity required for fresh read');
        // The token stays inside this browser request header. Never return it or
        // record request headers, full request errors, query strings or bodies.
        const response = await fetch(`/v1/projects/demo-floating-garden-trial/databases/(default)/documents/${operation.path.split('/').map(encodeURIComponent).join('/')}`, {
          method: 'GET', cache: 'no-store', headers: { authorization: `Bearer ${await user.getIdToken()}` },
        });
        return { ok: response.ok, status: response.status, code: response.status === 403 ? 'permission-denied' : response.status === 401 ? 'unauthenticated' : 'unexpected-http-status' };
      }
      if (operation.kind === 'list') return { ok: true, count: (await fs.getDocsFromServer(fs.collection(db, operation.path))).size };
      if (operation.kind === 'write') { await fs.setDoc(fs.doc(db, operation.path), { forged: true }); return { ok: true }; }
      throw new Error('Unknown security probe');
    } catch (error) { return { ok: false, code: error.code, reason: error.details?.reason }; }
  }, { appName: APP_NAME, region: fixture.config.region, operation });
}
async function deniedProbe(page, operation, reason) {
  // getDocFromServer can reuse an active, already-current watch target. For a
  // revocation assertion require a new HTTP authorization decision every time.
  const result = await clientProbe(page, operation.kind === 'read' ? { ...operation, kind: 'fresh-read' } : operation);
  assert.equal(result.ok, false, `unexpectedly allowed ${operation.kind} ${operation.path || operation.name}`);
  assert.match(result.code, /(?:permission-denied|unauthenticated|failed-precondition)$/);
  if (operation.kind === 'read') assert.equal(result.status, 403, 'fresh authenticated Firestore document read is denied by rules');
  if (reason) assert.equal(result.reason, reason);
  return result;
}
async function beginRevocationWatch(page, roomPath, canaryExpiry) {
  await page.evaluate(async ({ appName, path, canaryExpiry }) => {
    const [{ getApp }, fs] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js'),
    ]);
    const state = { ready: false, denied: null, canarySeen: false };
    globalThis.__trialRevocationWatch = state;
    state.stop = fs.onSnapshot(fs.doc(fs.getFirestore(getApp(appName)), path), (snapshot) => {
      if (snapshot.metadata.fromCache) return;
      state.ready = true;
      if (snapshot.data()?.expiresAtMillis === canaryExpiry) state.canarySeen = true;
    }, (error) => { state.denied = error.code; });
  }, { appName: APP_NAME, path: roomPath, canaryExpiry });
  await page.waitForFunction(() => globalThis.__trialRevocationWatch?.ready === true);
}
function publicOnly(room) {
  assert.deepEqual(Object.keys(room).sort(), ['id', 'status', 'hostSeat', 'playerCount', 'gameId', 'revision', 'rulesVersion', 'expiresAtMillis', 'players', 'match', 'scores'].sort());
  const forbidden = new Set(['deck', 'deckCursor', 'seed', 'initialState', 'serverState', 'commands', 'uid', 'hostUid', 'playerUids', 'inviteCode', 'inviteMac', 'verifier', 'secret', 'payloadHash', 'receipt']);
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) { assert.ok(!forbidden.has(key), `private field exposed: ${key}`); visit(child); }
  }
  visit(room);
}

test('trial app: two enrolled real anonymous browsers play and recover against emulator callables/rules; authorization fails closed', { timeout: 600000 }, async () => {
  let browser, admin, db;
  const contexts = [], pages = [], observed = [], pageErrors = [], blocked = [], deniedConnectivityProbes = [], routeErrors = [], sameOriginMisses = [];
  const interruptedSeats = new Set(), offlineSeats = new Set(), activeRelays = new Map();
  let closing = false;
  async function setOffline(seat, offline) {
    if (offline) offlineSeats.add(seat); else offlineSeats.delete(seat);
    await contexts[seat].setOffline(offline);
    if (offline) await Promise.all([...activeRelays].filter(([, entry]) => entry.seat === seat).map(async ([route, entry]) => {
      entry.cancelled = true; await route.abort('internetdisconnected').catch(() => {});
    }));
  }
  const transcript = [], captures = new Set();
  let roomId = null, stage = 'initialization', drop = null;
  await mkdir(output, { recursive: true });
  try {
    const origin = fixture.runtime.previewOrigin, served = new Map();
    admin = initializeApp({ projectId: config.projectId }, `garden-trial-browser-observer-${randomUUID()}`);
    db = getFirestore(admin);
    const room = async () => { const snapshot = await db.doc(`floatingGardenRooms/${roomId}`).get(); assert.ok(snapshot.exists); return snapshot.data(); };
    const serverGame = async () => { const current = await room(); return (await db.doc(`floatingGardenRooms/${roomId}/serverGames/${current.gameId}`).get()).data(); };
    const executablePath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
    browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const allowedLocalOrigins = new Set(['auth', 'firestore', 'functions'].map((kind) => `http://127.0.0.1:${EMULATOR_PORTS[kind]}`));
    for (const [seat, viewport] of [{ width: 1180, height: 900 }, { width: 390, height: 844 }].entries()) {
      const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
      contexts.push(context);
      const observation = { seat, authRequests: 0, firestoreRequests: 0, calls: [], snapshots: [], console: [] };
      observed.push(observation);
      await context.route('**/*', async (route) => {
        const request = route.request(), url = new URL(request.url());
        const target = trialEmulatorRoute(request.url(), request.method(), fixture);
        if (target) {
          if (offlineSeats.has(seat)) return route.abort('internetdisconnected');
          const relay = { seat, request, kind: target.kind, cancelled: false }; activeRelays.set(route, relay);
          const attempt = drop && !drop.intercepted && drop.seat === seat && target.kind === 'functions'
            && url.pathname === `${callablePath}floatingGardenSubmitAction` ? drop : null;
          let responseStatus = null;
          if (attempt) { attempt.intercepted = true; attempt.payload = request.postDataJSON().data; }
          try {
            // Same-origin reverse proxy: forward the original method, headers,
            // Auth token and body. No browser security flags/permissions change.
            // Responses are real emulator responses, and redirects are forbidden.
            const response = await route.fetch({ url: target.url, maxRedirects: 0, timeout: 30000 });
            responseStatus = response.status();
            assert.ok(response.status() < 300 || response.status() >= 400, 'emulator relay must never follow redirects');
            if (relay.cancelled || closing) return;
            if (offlineSeats.has(seat)) { relay.cancelled = true; await route.abort('internetdisconnected'); return; }
            if (attempt) {
              const body = await response.json();
              assert.equal(response.status(), 200);
              assert.ok(body.result?.room, 'the dropped response must be a real committed success');
              attempt.result = body.result;
              await route.abort('failed');
            } else await route.fulfill({ response });
          } catch (error) {
            if (isTrialRelayNavigationCancellation(target.kind, request.failure())) relay.cancelled = true;
            if (!relay.cancelled && !closing) {
              routeErrors.push(sanitizeTrialRelayFailure({ kind: target.kind, url: request.url(), error, status: responseStatus }));
              await route.abort('failed').catch(() => {});
            }
          } finally { activeRelays.delete(route); if (attempt) attempt.done = true; }
          return;
        }
        if (url.origin === origin) {
          const status = await serveTrialAsset(route, served);
          if (status === 404) sameOriginMisses.push({ seat, path: url.pathname, method: request.method(), status });
          return;
        }
        if (url.origin === sdkOrigin && url.pathname.startsWith(sdkPrefix) && !url.search) {
          const source = trialSdkFixture(url.pathname.slice(sdkPrefix.length), fixture);
          if (source) return route.fulfill({ status: 200, body: source, headers: { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' } });
        }
        const allowed = url.origin === sdkOrigin && url.pathname.startsWith(sdkPrefix) && url.pathname.endsWith('.js') && request.method() === 'GET';
        if (!allowed) {
          // Raw browser requests to loopback are blocked as well. Only the
          // allowlisted server-side relay above reaches emulator network ports.
          const diagnostic = await abortDeniedBrowserRequest(route, { offlineExercised: interruptedSeats.has(seat) });
          (diagnostic ? deniedConnectivityProbes : blocked).push({ seat, origin: url.origin, path: url.pathname, method: request.method(), resourceType: request.resourceType() });
          return;
        }
        await route.continue();
      });
      const page = await context.newPage(); pages.push(page);
      page.setDefaultTimeout(20000);
      page.setDefaultNavigationTimeout(60000);
      page.on('pageerror', (error) => pageErrors.push({ seat, message: error.message }));
      page.on('requestfailed', (request) => {
        for (const relay of activeRelays.values()) {
          if (relay.request === request && isTrialRelayNavigationCancellation(relay.kind, request.failure())) relay.cancelled = true;
        }
      });
      page.on('console', (message) => { if (['error', 'warning'].includes(message.type())) observation.console.push(message.text()); });
      page.on('request', (request) => {
        const url = new URL(request.url());
        const target = trialEmulatorRoute(request.url(), request.method(), fixture);
        if (target?.kind === 'auth') observation.authRequests += 1;
        if (target?.kind === 'firestore') observation.firestoreRequests += 1;
        if (target?.kind === 'functions' && request.method() === 'POST') {
          observation.calls.push({ method: url.pathname.split('/').pop(), payload: request.postDataJSON()?.data });
        }
      });
      page.on('response', (response) => {
        const url = new URL(response.url());
        if (url.origin !== origin || !url.pathname.endsWith('/floatingGardenGetSnapshot') || response.request().method() !== 'POST' || response.status() !== 200) return;
        const capture = response.json().then((body) => { if (body.result) observation.snapshots.push(body.result); }).catch(() => {}).finally(() => captures.delete(capture));
        captures.add(capture);
      });
    }

    stage = 'real SDK authentication';
    await Promise.all(pages.map((page) => page.goto(origin + entryPath)));
    await Promise.all(pages.map(ready));
    const uids = await Promise.all(pages.map(authUid));
    assert.ok(uids.every((uid) => typeof uid === 'string' && uid.length > 0));
    assert.notEqual(uids[0], uids[1], 'separate browser storage produces independent anonymous Auth identities');
    // Observe the pinned browser SDK's actual URL constructor, rather than assume
    // it preserves custom-domain path segments as newer installed SDKs do.
    const callableNames = ['CreateRoom', 'JoinRoom', 'StartMatch', 'GetSnapshot', 'SubmitAction'].map((suffix) => `floatingGarden${suffix}`);
    for (const page of pages) {
      const endpoints = await page.evaluate(async ({ appName, region, names }) => {
        const [{ getApp }, { getFunctions }] = await Promise.all([
          import('https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js'),
          import('https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js'),
        ]);
        const functions = getFunctions(getApp(appName), region);
        return names.map((name) => functions._url(name));
      }, { appName: APP_NAME, region: fixture.config.region, names: callableNames });
      assert.deepEqual(endpoints, callableNames.map((name) => `${origin}/${name}`));
      endpoints.forEach((url) => assert.equal(trialEmulatorRoute(url, 'POST', fixture)?.kind, 'functions'));
    }
    assert.deepEqual(await Promise.all(pages.map(recovery)), [null, null], 'fresh contexts have no preseeded recovery record');
    for (const asset of [entryPath, ...['app.js', 'bootstrap.js', 'config.js', 'firebase.js'].map((name) => `/lab/floating-garden/trial/${name}`)]) {
      assert.equal(served.get(asset), digest(await readFile(resolve(root, `.${asset}`))), `${asset} is served unchanged from the generated trial bundle`);
    }

    stage = 'real anonymous Auth alone grants no trial access';
    await pages[0].locator('#online-name').fill('月の庭');
    const rejectedCreate = pages[0].waitForResponse((response) => response.url().endsWith('/floatingGardenCreateRoom') && response.request().method() === 'POST');
    await pages[0].locator('[data-action="create"]').click();
    const rejectedBody = await (await rejectedCreate).json();
    assert.equal(rejectedBody.error?.details?.reason, 'trial-disabled');
    await pages[0].locator('.online-connection .error').waitFor();
    const preEnrollmentPending = (await recovery(pages[0])).pending;
    assert.equal(preEnrollmentPending.kind, 'create');
    assert.equal((await db.collection('floatingGardenRooms').get()).size, 0);
    assert.match(await pages[0].locator('#trial-status').innerText(), /拒否/);

    // Only admin test setup enrolls the genuine UIDs after SDK authentication.
    await db.doc('floatingGardenTrial/config').set({ ...fixture.config, testerUids: uids });
    await db.doc('floatingGardenTrial/usage').set({ projectId: fixture.config.projectId, startsAtMillis: fixture.config.startsAtMillis,
      endsAtMillis: fixture.config.endsAtMillis, maxRooms: 20, createdRoomCount: 0 });
    await Promise.all(uids.map((uid) => db.doc(`floatingGardenTrialTesters/${uid}`).set({ active: true, expiresAtMillis: fixture.config.endsAtMillis })));

    stage = 'create, join, and start through DOM';
    await pages[0].reload();
    await pages[0].locator('#room-invite').waitFor(); await ready(pages[0]);
    const invitation = await pages[0].locator('#room-invite').inputValue();
    assert.match(invitation, /^FG1-/);
    roomId = (await recovery(pages[0])).roomId;
    assert.ok(roomId);
    const roomPath = `floatingGardenRooms/${roomId}`;
    assert.equal((await db.doc('floatingGardenTrial/usage').get()).data().createdRoomCount, 1);
    const creationCalls = observed[0].calls.filter((call) => call.method === 'floatingGardenCreateRoom');
    assert.equal(creationCalls.length, 2);
    creationCalls.forEach((call) => assert.deepEqual(call.payload, preEnrollmentPending.payload));
    await deniedProbe(pages[1], { kind: 'call', name: 'floatingGardenGetSnapshot', data: { roomId } });
    await deniedProbe(pages[1], { kind: 'read', path: roomPath });
    await deniedProbe(pages[1], { kind: 'read', path: `${roomPath}/members/${uids[0]}` });
    await pages[1].locator('#online-name').fill('星の庭');
    await pages[1].locator('#online-code').fill(invitation);
    await pages[1].locator('[data-action="join"]').click();
    await pages[1].locator('.online-lobby').waitFor(); await ready(pages[1]);
    assert.equal((await recovery(pages[1])).roomId, roomId);
    await pages[0].locator('[data-action="start"]').click();
    await Promise.all(pages.map((page) => waitRevision(page, 0)));
    await Promise.all(pages.map(ready));
    const members = await db.collection(`floatingGardenRooms/${roomId}/members`).get();
    assert.equal(members.size, 2);
    uids.forEach((uid, seat) => assert.equal(members.docs.find((doc) => doc.id === uid)?.data().seat, seat));

    const covered = new Set();
    async function clickAction(action, { previewChecks = false } = {}) {
      const page = pages[action.seat];
      await ready(page);
      const click = (name) => page.locator(`[data-action="${name}"]`).click();
      if (action.type === 'place') {
        const cell = page.locator(`[data-action="cell"][data-index="${action.index}"]`);
        if (previewChecks) {
          await cell.focus(); await page.keyboard.press('Enter');
          await page.locator('[data-action="commit"]').waitFor();
          assert.equal((await room()).match.revision, action.revision, 'keyboard preview never commits');
          await page.keyboard.press('Escape');
          assert.equal(await page.locator('[data-action="commit"]').count(), 0, 'Escape cancels preview');
          await cell.click(); await click('cancel');
          assert.equal((await room()).match.revision, action.revision, 'Cancel never commits');
        }
        await cell.click();
        for (let rotation = 0; rotation < action.rotation; rotation += 1) {
          await page.locator('[data-action="rotate"]').focus(); await page.keyboard.press('Space');
        }
        await click('commit');
      } else if (action.type === 'stone') {
        await click(`stone-${action.stone}`);
        await page.locator(`[data-action="cell"][data-index="${action.index}"]`).click(); await click('commit');
      } else await click(action.type === 'offer' ? `offer-${action.target}` : `command-${action.type}`);
    }
    async function perform(action, { waitSeats = [0, 1], ...options } = {}) {
      const before = await room();
      assert.equal(action.revision, before.match.revision);
      transcript.push({ revision: action.revision, seat: action.seat, type: action.type });
      await clickAction(action, options);
      await Promise.all(waitSeats.map((seat) => waitRevision(pages[seat], action.revision + 1)));
      const after = await room();
      assert.equal(after.match.revision, action.revision + 1);
      assert.equal(after.revision, before.revision + 1);
      covered.add(action.type);
      if (action.type === 'store') covered.add(before.match.players[action.seat].storage ? 'store-swap' : 'store-empty');
      if (before.match.phase === 'final-stone') covered.add(`final-${action.type}`);
      return after;
    }
    async function act(type, extras = {}, options = {}) {
      const state = (await room()).match;
      const action = legalActions(state).find((candidate) => candidate.type === type && Object.entries(extras).every(([key, value]) => candidate[key] === value));
      assert.ok(action, `${type} is legal at ${state.round}/${state.activeSeat}/${state.step}`);
      return perform(action, options);
    }

    stage = 'offline active player is read-only';
    const offlineBefore = await room();
    interruptedSeats.add(0);
    await setOffline(0, true);
    await pages[0].waitForFunction(() => !navigator.onLine && document.querySelector('.online-connection > [role="status"]')?.textContent.includes('オフライン'));
    assert.equal(await pages[0].locator('[data-action="command-draw"]').isDisabled(), true);
    assert.equal((await recovery(pages[0])).pending, null);
    assert.deepEqual(await room(), offlineBefore, 'disconnect never supplies a move for the player');
    await setOffline(0, false); await ready(pages[0]);
    assert.equal(await authUid(pages[0]), uids[0]);

    stage = 'server commits, response is lost, reload retries the exact saved request';
    drop = { seat: 0, intercepted: false, done: false };
    await act('draw');
    await until(() => drop.done, 'the real successful callable response was discarded');
    assert.deepEqual(routeErrors, []);
    await pages[0].locator('.online-connection .error').waitFor();
    const pending = (await recovery(pages[0])).pending;
    assert.equal(pending.kind, 'submit');
    assert.deepEqual(pending.payload, drop.payload);
    assert.equal(pending.uid, uids[0]);
    assert.equal(await pages[0].locator('[data-action="command-self"]').isDisabled(), true, 'new actions are blocked while the old result is uncertain');
    const committed = await room(), beforeRetry = await serverGame();
    assert.equal((await clientProbe(pages[0], { kind: 'fresh-read', path: roomPath })).status, 200, 'real member token allows a fresh read before revocation');
    const canaryExpiry = committed.expiresAtMillis - 1;
    assert.ok(canaryExpiry > Date.now() + 60000, 'listener canary must remain a valid future room expiry');
    await beginRevocationWatch(pages[0], roomPath, canaryExpiry);
    stage = 'revoked and expired tester cannot read or replay a committed pending action';
    for (const [label, tester] of [
      ['revoked', { active: false, expiresAtMillis: fixture.config.endsAtMillis }],
      ['expired', { active: true, expiresAtMillis: Date.now() - 1000 }],
    ]) {
      await db.doc(`floatingGardenTrialTesters/${uids[0]}`).set(tester);
      await deniedProbe(pages[0], { kind: 'read', path: roomPath });
      if (label === 'revoked') {
        // Cached, previously authorized data may remain visible. A NEW document
        // update after revocation must never be delivered by the existing watch.
        await db.doc(roomPath).update({ expiresAtMillis: canaryExpiry });
        await pages[0].waitForFunction(() => globalThis.__trialRevocationWatch?.denied === 'permission-denied');
        assert.equal(await pages[0].evaluate(() => globalThis.__trialRevocationWatch.canarySeen), false);
        await pages[0].evaluate(() => globalThis.__trialRevocationWatch.stop());
        await db.doc(roomPath).set(committed);
      }
      await deniedProbe(pages[0], { kind: 'call', name: 'floatingGardenGetSnapshot', data: { roomId } }, 'trial-tester-not-enrolled');
      const deniedRetry = pages[0].waitForResponse((response) => response.url().endsWith('/floatingGardenSubmitAction') && response.request().method() === 'POST');
      await pages[0].reload();
      assert.equal((await (await deniedRetry).json()).error?.details?.reason, 'trial-tester-not-enrolled', label);
      await pages[0].locator('.online-connection .error').waitFor();
      assert.deepEqual((await recovery(pages[0])).pending, pending, `${label} retains the exact uncertain request`);
      assert.equal(await authUid(pages[0]), uids[0]);
      assert.deepEqual(await room(), committed);
      assert.deepEqual((await serverGame()).commands, beforeRetry.commands);
    }
    await db.doc(`floatingGardenTrialTesters/${uids[0]}`).set({ active: true, expiresAtMillis: fixture.config.endsAtMillis });
    stage = 're-enrollment permits the original receipt replay without a second action';
    const lost = drop; drop = null;
    await pages[0].reload(); await ready(pages[0]); await waitRevision(pages[0], committed.match.revision);
    assert.equal((await clientProbe(pages[0], { kind: 'fresh-read', path: roomPath })).status, 200, 'the same real member token allows a fresh read after re-enrollment');
    assert.equal(await authUid(pages[0]), uids[0], 'reload retains real Auth persistence');
    assert.equal((await recovery(pages[0])).pending, null);
    const retryCalls = observed[0].calls.filter((call) => call.method === 'floatingGardenSubmitAction' && call.payload.requestId === pending.payload.requestId);
    assert.equal(retryCalls.length, 4, 'one original, two authorization-denied retries and one same-ID successful retry');
    retryCalls.forEach((call) => assert.deepEqual(call.payload, pending.payload));
    assert.deepEqual(await room(), committed, 'same-ID retry does not advance the room again');
    assert.deepEqual((await serverGame()).commands, beforeRetry.commands, 'same-ID retry records no second command');
    const receipt = await db.doc(`floatingGardenActionRequests/${digest(uids[0])}_${pending.payload.requestId}`).get();
    assert.deepEqual(receipt.data().result, lost.result);

    stage = 'gift acceptance, same-UID guest reload, rotation and cancellation';
    await act('offer', { target: 1 }); await act('accept');
    const guestBefore = await room();
    await pages[1].reload(); await ready(pages[1]); await waitRevision(pages[1], guestBefore.match.revision);
    assert.equal(await authUid(pages[1]), uids[1]);
    assert.equal((await recovery(pages[1])).uid, uids[1]);
    await act('place', { rotation: 3 }, { previewChecks: true }); await act('place'); await act('meditate');

    stage = 'opponent makes progress while other browser is offline';
    const disconnectedRevision = (await room()).match.revision;
    await setOffline(0, true);
    await pages[0].waitForFunction(() => navigator.onLine === false);
    await act('draw', {}, { waitSeats: [1] });
    assert.equal(await domRevision(pages[0]), disconnectedRevision, 'offline browser does not receive the peer update');
    await setOffline(0, false);
    await ready(pages[0]); await waitRevision(pages[0], disconnectedRevision + 1);
    assert.equal(await authUid(pages[0]), uids[0]);
    await act('self'); await act('request-invite'); await act('yield');
    await act('place'); await act('place'); await act('meditate');

    stage = 'native comparison dialog, keyboard focus, and remote updates';
    const inspect = pages[1].locator('[data-action="inspect"][data-seat="0"]');
    await inspect.focus(); await pages[1].keyboard.press('Enter');
    await pages[1].locator('#online-comparison[open]').waitFor();
    await pages[1].locator('[data-action="compare-pair"]').click();
    assert.equal(await pages[1].locator('#online-comparison .comparison-garden').count(), 2);
    await pages[1].keyboard.press('Tab');
    assert.equal(await pages[1].evaluate(() => document.querySelector('#online-comparison').contains(document.activeElement)), true, 'Tab remains within the native modal');
    await act('draw');
    assert.equal(await pages[1].locator('#online-comparison').evaluate((dialog) => dialog.open), true, 'peer update preserves comparison');
    await pages[1].keyboard.press('Escape');
    assert.equal(await pages[1].locator('#online-comparison').count(), 0);
    assert.equal(await pages[1].evaluate(() => document.activeElement?.dataset.focus), 'inspect-0', 'Escape restores focus to the comparison opener');
    assert.equal(await pages[1].evaluate(() => document.body.style.overflow), '');

    stage = 'real layout at narrow widths and 200 percent zoom';
    for (const width of [320, 390, 768, 1180]) {
      await pages[0].setViewportSize({ width, height: 900 });
      assert.equal(await pages[0].evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `no document overflow at ${width}px`);
      if ([390, 1180].includes(width)) await pages[0].screenshot({ path: resolve(output, `${width}px.png`), fullPage: true });
    }
    await pages[0].evaluate(() => { document.documentElement.style.zoom = '200%'; });
    assert.equal(await pages[0].evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'no document overflow at 200% zoom');
    await pages[0].screenshot({ path: resolve(output, 'zoom-200.png'), fullPage: true });
    await pages[0].evaluate(() => { document.documentElement.style.zoom = ''; });

    stage = 'welcome, declined gift, empty/full storage, stored source and stones';
    await act('self'); await act('request-invite'); await act('welcome'); await act('place'); await act('meditate');
    await act('draw'); await act('offer', { target: 0 }); await act('decline');
    await act('store'); await act('place'); await act('meditate');
    await act('draw'); await act('store'); await act('place'); await act('meditate');
    await act('draw'); await act('store');
    while ((await room()).match.step === 'invite-response') await act('pass-invite');
    await act('place'); await act('meditate');
    await act('use-storage'); await act('self');
    while ((await room()).match.step === 'invite-response') await act('pass-invite');
    await act('place'); await act('stone', { stone: 'moon' });

    stage = 'complete game, compare both real DOMs, and recover final scores';
    let remaining = 400;
    while ((await room()).match.phase !== 'finished') {
      assert.ok(remaining-- > 0, 'the real two-browser match must terminate');
      const state = (await room()).match, choices = legalActions(state);
      const preferred = state.phase === 'final-stone' ? (getDecision(state).seat === 0 ? 'stone' : 'pass-final') : { source: 'draw', choose: 'self', 'invite-response': 'pass-invite', place: 'place', care: 'meditate' }[state.step];
      await perform(choices.find((action) => action.type === preferred) || choices[0]);
    }
    const finished = await room();
    assert.equal(finished.status, 'finished');
    assert.ok(finished.match.players.every((player) => player.garden.filter(Boolean).length === 16));
    assert.equal(new Set(finished.match.players.map((player) => player.careCount)).size, 1);
    assert.deepEqual(finished.scores, rankMatch(finished.match)); publicOnly(finished);
    const canonical = await serverGame();
    assert.equal(canonical.commands.length, finished.match.revision);
    const replayed = canonical.commands.reduce((state, command) => applyMatchAction(state, command), canonical.initialState);
    assert.deepEqual(replayed, canonical.state); assert.deepEqual(rankMatch(replayed), finished.scores);
    const results = await Promise.all(pages.map((page) => page.locator('.match-results ol').innerText()));
    assert.equal(results[0], results[1]);
    const boards = await Promise.all(pages.map((page) => page.evaluate(() => ({
      own: [...document.querySelectorAll('.garden-section .board .cell')].map((cell) => cell.getAttribute('aria-label')),
      other: [...document.querySelectorAll('.opponent-card .board .cell')].map((cell) => cell.getAttribute('aria-label')),
    }))));
    assert.equal(boards[0].own.length, 16); assert.equal(boards[1].own.length, 16);
    assert.deepEqual(boards[0].own, boards[1].other); assert.deepEqual(boards[1].own, boards[0].other);
    for (const [seat, page] of pages.entries()) {
      await page.screenshot({ path: resolve(output, `finished-seat-${seat}.png`), fullPage: true });
      await page.reload(); await ready(page); await waitRevision(page, finished.match.revision);
      assert.equal(await authUid(page), uids[seat]);
      assert.equal(await page.locator('.match-results ol').innerText(), results[seat]);
    }
    await Promise.all([...captures]);
    for (const observation of observed) {
      assert.ok(observation.authRequests > 0, `seat ${observation.seat} used the real Auth emulator`);
      assert.ok(observation.firestoreRequests > 0, `seat ${observation.seat} used the real Firestore emulator listener`);
      assert.ok(observation.snapshots.length > 0);
      observation.snapshots.forEach((snapshot) => { publicOnly(snapshot.room); assert.equal(snapshot.self.seat, observation.seat); });
      assert.deepEqual(observation.snapshots.at(-1).room, finished, 'each reloaded browser received the same authoritative final room');
    }
    stage = 'browser Firestore privacy, denied writes, enrollment and room expiry';
    publicOnly((await clientProbe(pages[0], { kind: 'read', path: roomPath })).value);
    assert.equal((await clientProbe(pages[0], { kind: 'read', path: `${roomPath}/members/${uids[0]}` })).ok, true);
    for (const path of ['floatingGardenTrial/config', 'floatingGardenTrial/usage', `floatingGardenTrialTesters/${uids[0]}`,
      `${roomPath}/members/${uids[1]}`, `${roomPath}/serverGames/${finished.gameId}`,
      `floatingGardenActionRequests/${digest(uids[0])}_${pending.payload.requestId}`]) {
      await deniedProbe(pages[0], { kind: 'read', path });
      await deniedProbe(pages[0], { kind: 'write', path });
    }
    for (const path of ['floatingGardenRooms', `${roomPath}/members`, `${roomPath}/serverGames`, 'floatingGardenTrialTesters']) await deniedProbe(pages[0], { kind: 'list', path });
    await deniedProbe(pages[0], { kind: 'write', path: roomPath });
    await deniedProbe(pages[0], { kind: 'write', path: `${roomPath}/members/${uids[0]}` });
    // An active tester document alone cannot compensate for roster removal.
    await db.doc('floatingGardenTrial/config').set({ ...fixture.config, testerUids: [uids[1], 'unenrolled-placeholder'] });
    await deniedProbe(pages[0], { kind: 'read', path: roomPath });
    await deniedProbe(pages[0], { kind: 'call', name: 'floatingGardenGetSnapshot', data: { roomId } }, 'trial-tester-not-enrolled');
    await db.doc('floatingGardenTrial/config').set({ ...fixture.config, testerUids: uids });
    await db.doc(roomPath).update({ expiresAtMillis: Date.now() - 1000 });
    await deniedProbe(pages[0], { kind: 'read', path: roomPath });
    await deniedProbe(pages[0], { kind: 'call', name: 'floatingGardenGetSnapshot', data: { roomId } }, 'room-expired');
    await db.doc(roomPath).set(finished);
    await db.doc('floatingGardenTrial/config').update({ enabled: false });
    await deniedProbe(pages[0], { kind: 'read', path: roomPath });
    await deniedProbe(pages[0], { kind: 'call', name: 'floatingGardenGetSnapshot', data: { roomId } }, 'trial-disabled');
    const called = new Set(observed.flatMap((observation) => observation.calls.map((call) => call.method)));
    for (const suffix of ['CreateRoom', 'JoinRoom', 'StartMatch', 'GetSnapshot', 'SubmitAction']) assert.ok(called.has(`floatingGarden${suffix}`));
    for (const type of ['draw', 'offer', 'accept', 'decline', 'place', 'self', 'store-empty', 'store-swap', 'use-storage', 'request-invite', 'pass-invite', 'yield', 'welcome', 'meditate', 'stone', 'final-stone', 'final-pass-final']) assert.ok(covered.has(type), `missing browser branch: ${type}`);
    assert.deepEqual(blocked, [], 'no unexpected denied destination; known SDK connectivity probes also remain blocked');
    assert.deepEqual(pageErrors, []); assert.deepEqual(routeErrors, []); assert.deepEqual(sameOriginMisses, [], 'all same-origin requests must resolve to actual assets or an allowlisted emulator route');
    await writeFile(resolve(output, 'summary.json'), JSON.stringify({ projectId: config.projectId, status: 'passed', actions: finished.match.revision, branches: [...covered], independentAuthUsers: 2, sameIdRetry: true, offlineReconnect: true, freshAuthorizationReads: 'real browser Auth token over new Firestore REST GETs; active SDK watch cache is not treated as a fresh authorization check', revokedListenerFutureUpdatesDenied: true, gateChecks: ['unenrolled initial create', 'enrolled nonmember', 'revoked tester', 'expired tester', 'roster removed', 'expired room', 'disabled gate', 'private reads/lists/writes denied'], unchangedTrialPublicGraph: true, fixtureBoundaries: fixture.boundaries, liveAppCheckValidated: false, relayTargets: [...allowedLocalOrigins], browserNetworkOrigins: [origin, sdkOrigin], deniedConnectivityProbes }, null, 2));
    console.log(`Trial-app emulator browser QA passed: ${finished.match.revision} committed actions; artifacts ${output}`);
  } catch (error) {
    // Test-only demo identities/room state only. Never record Auth tokens, headers,
    // browser storage dumps, or traces containing authentication responses.
    await Promise.allSettled(pages.flatMap((page, seat) => [
      page.screenshot({ path: resolve(output, `failure-seat-${seat}.png`), fullPage: true, timeout: 5000 }),
      page.content().then((html) => writeFile(resolve(output, `failure-seat-${seat}.html`), html)),
    ]));
    await writeFile(resolve(output, 'failure.json'), JSON.stringify({ stage, error: error.stack || error.message, roomId, transcript, pageErrors, blocked, deniedConnectivityProbes, routeErrors, sameOriginMisses, observations: observed.map(({ seat, authRequests, firestoreRequests, calls, console }) => ({ seat, authRequests, firestoreRequests, console, calls: calls.map(({ method, payload }) => ({ method, requestId: payload?.requestId, expectedRevision: payload?.expectedRevision, command: payload?.command })) })) }, null, 2));
    throw error;
  } finally {
    closing = true;
    await Promise.allSettled(contexts.map((context) => context.close()));
    await browser?.close();
    if (db) await db.terminate();
    if (admin) await deleteApp(admin);
  }
});

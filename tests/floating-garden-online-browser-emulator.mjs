// Browser -> the UNMODIFIED app.js/firebase.js -> real Auth/Callable/Firestore emulators.
// The fixture browser test is deliberately separate: no injected controller, fake UID,
// transport replacement, direct handler, or in-memory store is used by this suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { chromium } from './e2e/node_modules/playwright/index.mjs';
import { emulatorConfig } from './helpers/floating-garden-emulators.mjs';
import { abortDeniedBrowserRequest } from './helpers/floating-garden-browser-network.mjs';
import { sanitizeTrialSnapshotRevisions } from './helpers/floating-garden-trial-sdk-fixture.mjs';
import { FIRESTORE_DIAGNOSTIC_SOURCE, isOnlineDiagnosticFirestoreRequest, loadTrialDiagnosticFirestoreSdk, collectTrialSdkWatchDiagnostics } from './helpers/floating-garden-trial-sdk-discard-fixture.mjs';
import { EMULATOR_CONFIG, EMULATOR_PORTS } from '../lab/floating-garden/online/config.js';
import { ONLINE_SAVE_KEY } from '../lab/floating-garden/online/controller.js';
import { legalActions, getDecision, rankMatch, applyMatchAction } from '../lab/floating-garden/match-engine.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = emulatorConfig({ authAndFunctions: true });
assert.equal(config.projectId, EMULATOR_CONFIG.projectId, 'only demo-floating-garden is supported by the actual app');
for (const kind of ['auth', 'firestore', 'functions']) {
  assert.equal(config[kind].port, EMULATOR_PORTS[kind], `the ${kind} emulator must use the actual app port`);
}
const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const sdkOrigin = 'https://www.gstatic.com';
const sdkPrefix = '/firebasejs/10.8.0/';
const entryPath = '/lab/floating-garden/online/index.html';
const callablePath = `/demo-floating-garden/asia-northeast1/`;
const output = resolve(process.env.FLOATING_GARDEN_BROWSER_ARTIFACTS || '/tmp/floating-garden-online-browser-emulator-qa');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sdkDiagnosticInstrumentation = { source: FIRESTORE_DIAGNOSTIC_SOURCE, eventLimit: 256,
  boundary: 'test-only Listen-arrival and LocalStore-discard observers; unchanged game/app sources, original SDK comparisons/logging/callbacks and native emulator networking' };

async function serveActualApp() {
  const served = new Map();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
      // Serve only public garden assets, byte-for-byte. Never expose server files,
      // repository metadata, credentials, or a test-only API endpoint.
      if (!['GET', 'HEAD'].includes(request.method) || !path.startsWith(resolve(root, 'lab/floating-garden') + '/') || !['.html', '.js', '.css'].includes(extname(path))) {
        response.writeHead(404); response.end(); return;
      }
      const bytes = await readFile(path);
      served.set(url.pathname, digest(bytes));
      response.writeHead(200, { 'content-type': { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }[extname(path)], 'cache-control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500); response.end();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, served, origin: `http://127.0.0.1:${server.address().port}` };
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
const recovery = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || 'null'), ONLINE_SAVE_KEY);
const ready = (page) => page.waitForFunction((key) => {
  const status = document.querySelector('.online-connection > [role="status"]');
  const saved = JSON.parse(localStorage.getItem(key) || 'null');
  return status?.textContent === 'サーバーと同期済み' && !saved?.pending;
}, ONLINE_SAVE_KEY);
const domRevision = (page) => page.evaluate(() => Number(document.querySelector('.shared-table > .demo-note')?.textContent.match(/確定操作 (\d+)回/)?.[1] ?? -1));
const waitRevision = (page, revision) => page.waitForFunction((expected) => {
  const text = document.querySelector('.shared-table > .demo-note')?.textContent || '';
  return Number(text.match(/確定操作 (\d+)回/)?.[1] ?? -1) === expected;
}, revision);
async function authUid(page) {
  // Observe the SDK instance initialized by firebase.js; do not create/sign in a
  // replacement app, read/write auth storage, or provide a synthetic identity.
  return page.evaluate(async () => {
    const [{ getApp }, { getAuth }] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js'),
    ]);
    return getAuth(getApp('floating-garden-online-local')).currentUser?.uid;
  });
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

test('actual app: two isolated Chromium contexts use Firebase emulators through scoring, lost-response recovery, offline/reconnect, and keyboard/layout checks', { timeout: 600000 }, async () => {
  let server, browser, admin, db;
  const contexts = [], pages = [], observed = [], pageErrors = [], blocked = [], deniedConnectivityProbes = [], routeErrors = [];
  const interruptedSeats = new Set();
  const transcript = [], captures = new Set();
  let completedMatchSdkWatchDiagnostics = [];
  const collectWatchObservations = () => Promise.all(pages.map(async (page, seat) => {
    const revision = await domRevision(page).catch(() => null);
    return { seat, domRevision: Number.isSafeInteger(revision) && revision >= 0 ? revision : null,
      sdkWatchDiagnostics: await collectTrialSdkWatchDiagnostics(page),
      completedMatchSdkWatchDiagnostics: completedMatchSdkWatchDiagnostics[seat] || null,
      snapshotRevisions: observed[seat].snapshots.slice(-256).map(sanitizeTrialSnapshotRevisions) };
  }));
  let roomId = null, stage = 'initialization', drop = null;
  await mkdir(output, { recursive: true });
  try {
    const diagnosticFirestoreSdk = await loadTrialDiagnosticFirestoreSdk();
    const hosted = await serveActualApp();
    server = hosted.server;
    const { origin, served } = hosted;
    admin = initializeApp({ projectId: config.projectId }, `garden-browser-observer-${randomUUID()}`);
    db = getFirestore(admin);
    const room = async () => { const snapshot = await db.doc(`floatingGardenRooms/${roomId}`).get(); assert.ok(snapshot.exists); return snapshot.data(); };
    const serverGame = async () => { const current = await room(); return (await db.doc(`floatingGardenRooms/${roomId}/serverGames/${current.gameId}`).get()).data(); };
    const executablePath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
    browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const allowedLocalOrigins = new Set([origin, ...['auth', 'firestore', 'functions'].map((kind) => `http://127.0.0.1:${EMULATOR_PORTS[kind]}`)]);
    for (const [seat, viewport] of [{ width: 1180, height: 900 }, { width: 390, height: 844 }].entries()) {
      const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
      contexts.push(context);
      const observation = { seat, authRequests: 0, firestoreRequests: 0, calls: [], snapshots: [], console: [] };
      observed.push(observation);
      await context.route('**/*', async (route) => {
        const request = route.request(), url = new URL(request.url());
        if (isOnlineDiagnosticFirestoreRequest(request.url(), request.method())) {
          return route.fulfill({ status: 200, body: diagnosticFirestoreSdk, headers: { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' } });
        }
        const allowed = allowedLocalOrigins.has(url.origin) || (url.origin === sdkOrigin && url.pathname.startsWith(sdkPrefix) && url.pathname.endsWith('.js'));
        if (!allowed) {
          // Even this known SDK diagnostic stays blocked. No response is mocked,
          // and nothing beyond localhost/public Firebase SDK modules may leave.
          const diagnostic = await abortDeniedBrowserRequest(route, { offlineExercised: interruptedSeats.has(seat) });
          (diagnostic ? deniedConnectivityProbes : blocked).push({ seat, origin: url.origin, path: url.pathname, method: request.method(), resourceType: request.resourceType() });
          return;
        }
        if (drop && !drop.intercepted && drop.seat === seat && request.method() === 'POST' && url.origin === `http://127.0.0.1:${EMULATOR_PORTS.functions}` && url.pathname === `${callablePath}floatingGardenSubmitAction`) {
          const attempt = drop;
          attempt.intercepted = true;
          try {
            attempt.payload = request.postDataJSON().data;
            // Forward the ORIGINAL authenticated SDK request. Only its response is
            // lost, after the real callable and Firestore transaction have succeeded.
            const response = await route.fetch({ maxRedirects: 0, timeout: 30000 });
            const body = await response.json();
            assert.equal(response.status(), 200);
            assert.ok(body.result?.room, 'the dropped response must be a real committed success');
            attempt.result = body.result;
            await route.abort('failed');
          } catch (error) { routeErrors.push(error.message); await route.abort('failed').catch(() => {}); }
          finally { attempt.done = true; }
          return;
        }
        await route.continue();
      });
      const page = await context.newPage(); pages.push(page);
      page.setDefaultTimeout(20000);
      page.setDefaultNavigationTimeout(60000);
      page.on('pageerror', (error) => pageErrors.push({ seat, message: error.message }));
      page.on('console', (message) => { if (['error', 'warning'].includes(message.type())) observation.console.push(message.text()); });
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.origin === `http://127.0.0.1:${EMULATOR_PORTS.auth}`) observation.authRequests += 1;
        if (url.origin === `http://127.0.0.1:${EMULATOR_PORTS.firestore}`) observation.firestoreRequests += 1;
        if (url.origin === `http://127.0.0.1:${EMULATOR_PORTS.functions}` && request.method() === 'POST') {
          observation.calls.push({ method: url.pathname.split('/').pop(), payload: request.postDataJSON()?.data });
        }
      });
      page.on('response', (response) => {
        const url = new URL(response.url());
        if (url.origin !== `http://127.0.0.1:${EMULATOR_PORTS.functions}` || !url.pathname.endsWith('/floatingGardenGetSnapshot') || response.request().method() !== 'POST' || response.status() !== 200) return;
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
    assert.deepEqual(await Promise.all(pages.map(recovery)), [null, null], 'fresh contexts have no preseeded recovery record');
    for (const asset of [entryPath, '/lab/floating-garden/online/app.js', '/lab/floating-garden/online/firebase.js']) {
      assert.equal(served.get(asset), digest(await readFile(resolve(root, `.${asset}`))), `${asset} is served unchanged`);
    }

    stage = 'create, join, and start through DOM';
    await pages[0].locator('#online-name').fill('月の庭');
    await pages[0].locator('[data-action="create"]').click();
    await pages[0].locator('#room-invite').waitFor(); await ready(pages[0]);
    const invitation = await pages[0].locator('#room-invite').inputValue();
    assert.match(invitation, /^FG1-/);
    roomId = (await recovery(pages[0])).roomId;
    assert.ok(roomId);
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
    await contexts[0].setOffline(true);
    await pages[0].waitForFunction(() => !navigator.onLine && document.querySelector('.online-connection > [role="status"]')?.textContent.includes('オフライン'));
    assert.equal(await pages[0].locator('[data-action="command-draw"]').isDisabled(), true);
    assert.equal((await recovery(pages[0])).pending, null);
    assert.deepEqual(await room(), offlineBefore, 'disconnect never supplies a move for the player');
    await contexts[0].setOffline(false); await ready(pages[0]);
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
    const lost = drop; drop = null;
    await pages[0].reload(); await ready(pages[0]); await waitRevision(pages[0], committed.match.revision);
    assert.equal(await authUid(pages[0]), uids[0], 'reload retains real Auth persistence');
    assert.equal((await recovery(pages[0])).pending, null);
    const retryCalls = observed[0].calls.filter((call) => call.method === 'floatingGardenSubmitAction' && call.payload.requestId === pending.payload.requestId);
    assert.equal(retryCalls.length, 2, 'one original request and one same-ID retry');
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
    await contexts[0].setOffline(true);
    await pages[0].waitForFunction(() => navigator.onLine === false);
    await act('draw', {}, { waitSeats: [1] });
    assert.equal(await domRevision(pages[0]), disconnectedRevision, 'offline browser does not receive the peer update');
    await contexts[0].setOffline(false);
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
    // Reload starts a new SDK recorder; retain the completed gameplay evidence.
    completedMatchSdkWatchDiagnostics = await Promise.all(pages.map(collectTrialSdkWatchDiagnostics));
    for (const [seat, diagnostics] of completedMatchSdkWatchDiagnostics.entries()) {
      assert.ok(diagnostics, `seat ${seat} loaded the pinned test-only Firestore diagnostic recorder`);
      assert.ok(Number.isSafeInteger(diagnostics.counts.listenDocumentChange) && diagnostics.counts.listenDocumentChange > 0,
        `seat ${seat} recorded at least one real Listen document arrival during gameplay`);
    }
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
    const called = new Set(observed.flatMap((observation) => observation.calls.map((call) => call.method)));
    for (const suffix of ['CreateRoom', 'JoinRoom', 'StartMatch', 'GetSnapshot', 'SubmitAction']) assert.ok(called.has(`floatingGarden${suffix}`));
    for (const type of ['draw', 'offer', 'accept', 'decline', 'place', 'self', 'store-empty', 'store-swap', 'use-storage', 'request-invite', 'pass-invite', 'yield', 'welcome', 'meditate', 'stone', 'final-stone', 'final-pass-final']) assert.ok(covered.has(type), `missing browser branch: ${type}`);
    assert.deepEqual(blocked, [], 'no unexpected denied destination; known SDK connectivity probes also remain blocked');
    assert.deepEqual(pageErrors, []); assert.deepEqual(routeErrors, []);
    const watchObservations = await collectWatchObservations();
    await writeFile(resolve(output, 'summary.json'), JSON.stringify({ projectId: config.projectId, status: 'passed', actions: finished.match.revision, branches: [...covered], independentAuthUsers: 2, sameIdRetry: true, offlineReconnect: true, unchangedEntryAndTransport: true, networkOrigins: [...allowedLocalOrigins, sdkOrigin], deniedConnectivityProbes, sdkDiagnosticInstrumentation, watchObservations }, null, 2));
    console.log(`Actual-app emulator browser QA passed: ${finished.match.revision} committed actions; artifacts ${output}`);
  } catch (error) {
    // Test-only demo identities/room state only. Never record Auth tokens, headers,
    // browser storage dumps, or traces containing authentication responses.
    const watchObservations = await collectWatchObservations();
    await Promise.allSettled(pages.flatMap((page, seat) => [
      page.screenshot({ path: resolve(output, `failure-seat-${seat}.png`), fullPage: true, timeout: 5000 }),
      page.content().then((html) => writeFile(resolve(output, `failure-seat-${seat}.html`), html)),
    ]));
    await writeFile(resolve(output, 'failure.json'), JSON.stringify({ stage, error: error.stack || error.message, roomId, transcript, pageErrors, blocked, deniedConnectivityProbes, routeErrors, sdkDiagnosticInstrumentation, observations: observed.map(({ seat, authRequests, firestoreRequests, calls, console }) => ({ seat, authRequests, firestoreRequests, console, ...watchObservations[seat], calls: calls.map(({ method, payload }) => ({ method, requestId: payload?.requestId, expectedRevision: payload?.expectedRevision, command: payload?.command })) })) }, null, 2));
    throw error;
  } finally {
    await Promise.allSettled(contexts.map((context) => context.close()));
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    if (db) await db.terminate();
    if (admin) await deleteApp(admin);
  }
});

// Real Chromium rendering/clicks against the real transaction handlers with a local
// in-memory database. The separate Firebase integration suite tests Auth/Rules/transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from './e2e/node_modules/playwright/index.mjs';
import { createMemoryStore } from './helpers/floating-garden-store.mjs';
import { getDecision, legalActions } from '../lab/floating-garden/match-engine.js';
const require = createRequire(import.meta.url);
const { createHandlers, RATE_LIMITS } = require('../functions/floating-garden-online/handlers.js');
const root = fileURLToPath(new URL('../', import.meta.url));
const methods = { create: 'floatingGardenCreateRoom', join: 'floatingGardenJoinRoom', start: 'floatingGardenStartMatch', getSnapshot: 'floatingGardenGetSnapshot', submit: 'floatingGardenSubmitAction' };
const fixtureKey = 'browser-test-only-invitation-key-not-for-production';

function fixtureScript(uid) {
  return `<script type="module">
import { createOnlineController } from './controller.js';
import { mountOnline } from './mount.js';
const uid = ${JSON.stringify(uid)};
const api = Object.fromEntries(${JSON.stringify(Object.keys(methods))}.map(kind => [kind, async payload => {
  const response = await fetch('/__garden_test_api/' + uid, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind,payload})});
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.message); Object.assign(error,result); throw error; }
  return result;
}]));
const subscribe = (roomId,next,error) => {
  let alive=true, previous=null, timer;
  const refresh = async () => {
    try { const value=await api.getSnapshot({roomId}); if(alive && value.room.revision!==previous){ previous=value.room.revision; next({room:value.room,fromCache:false});} }
    catch(failure) { if(alive) error(failure); }
    if(alive) timer=setTimeout(refresh,80);
  };
  void refresh(); return () => {alive=false;clearTimeout(timer);};
};
window.garden = mountOnline(document.querySelector('#online-app'), {controller:createOnlineController({api,ensureUser:async()=>({uid}),subscribe,storage:localStorage,isOnline:()=>navigator.onLine})});
await window.garden.ready;
</script>`;
}

async function runServer() {
  const db = createMemoryStore();
  const rateLimits = Object.fromEntries(Object.entries(RATE_LIMITS).map(([kind, policy]) => [kind, { ...policy, limit: 100000, ...(policy.ipLimit ? { ipLimit: 100000 } : {}) }]));
  const handlers = createHandlers({ db, inviteSecret: () => fixtureKey, rateLimits });
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/__garden_test_api/')) {
        const uid = url.pathname.split('/').pop();
        if (request.method !== 'POST' || !['browser-alice', 'browser-bob'].includes(uid)) throw new Error('Invalid fixture request');
        let text = ''; for await (const part of request) { text += part; if (text.length > 8192) throw new Error('Oversize fixture request'); }
        const { kind, payload } = JSON.parse(text);
        if (!methods[kind]) throw new Error('Unknown fixture method');
        try {
          const result = await handlers[methods[kind]]({ auth: { uid }, data: payload, rawRequest: { ip: '127.0.0.1' } });
          response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
        } catch (error) { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ code: error.code, message: error.message, details: error.details })); }
        return;
      }
      // Only garden public assets are served; never expose .git, credentials, or server files.
      const path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
      if (!path.startsWith(resolve(root, 'lab/floating-garden') + '/') || !['.html', '.js', '.css'].includes(extname(path))) { response.writeHead(404); response.end(); return; }
      let content = await readFile(path, 'utf8');
      if (url.pathname === '/lab/floating-garden/online/index.html') {
        const uid = url.searchParams.get('fixture');
        if (!['browser-alice', 'browser-bob'].includes(uid)) throw new Error('Fixture user required');
        content = content.replace(/<script type="module" src="\.\/app\.js[^\"]*"><\/script>/, fixtureScript(uid));
      }
      response.writeHead(200, { 'content-type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' })[extname(path)], 'cache-control': 'no-store' }); response.end(content);
    } catch (error) { response.writeHead(500); response.end(error.message); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

test('real Chromium: two independent clients click through gifts/invites/scoring, reload, comparison, and narrow layouts', { timeout: 240000 }, async () => {
  const { server, origin } = await runServer();
  const executablePath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  let browser;
  const failures = [];
  try {
    browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const contexts = await Promise.all([browser.newContext({ viewport: { width: 1180, height: 900 } }), browser.newContext({ viewport: { width: 390, height: 844 } })]);
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    for (const page of pages) page.on('pageerror', (error) => failures.push(error.message));
    await Promise.all(pages.map((page, seat) => page.goto(`${origin}/lab/floating-garden/online/index.html?fixture=${seat ? 'browser-bob' : 'browser-alice'}`)));
    const ready = (page) => page.waitForFunction(() => window.garden?.controller.getState().canConfirm);
    const read = (page) => page.evaluate(() => window.garden.controller.getState());
    await Promise.all(pages.map(ready));
    await pages[0].locator('#online-name').fill('月の庭'); await pages[0].locator('[data-action="create"]').click();
    await pages[0].locator('#room-invite').waitFor();
    const code = await pages[0].locator('#room-invite').inputValue();
    await pages[1].locator('#online-name').fill('星の庭'); await pages[1].locator('#online-code').fill(code); await pages[1].locator('[data-action="join"]').click();
    await pages[0].waitForFunction(() => window.garden.controller.getState().room?.players.length === 2);
    await ready(pages[0]); await pages[0].locator('[data-action="start"]').click();
    await Promise.all(pages.map((page) => page.waitForFunction(() => window.garden.controller.getState().room?.match?.revision === 0)));
    const click = async (seat, action) => { await ready(pages[seat]); await pages[seat].locator(`[data-action="${action}"]`).click(); };
    const waitRevision = async (revision) => Promise.all(pages.map((page) => page.waitForFunction((target) => window.garden.controller.getState().room?.match?.revision === target, revision)));
    const perform = async (action) => {
      const seat = action.seat, revision = action.revision;
      await ready(pages[seat]);
      if (action.type === 'place') {
        await pages[seat].locator(`[data-action="cell"][data-index="${action.index}"]`).click();
        // Cancel and reselect a real preview once; committed state must remain unchanged.
        if (revision < 6) { await click(seat, 'cancel'); assert.equal((await read(pages[seat])).room.match.revision, revision); await pages[seat].locator(`[data-action="cell"][data-index="${action.index}"]`).click(); }
        for (let rotation = 0; rotation < action.rotation; rotation += 1) await click(seat, 'rotate');
        await click(seat, 'commit');
      } else if (action.type === 'stone') {
        await click(seat, `stone-${action.stone}`); await pages[seat].locator(`[data-action="cell"][data-index="${action.index}"]`).click(); await click(seat, 'commit');
      } else await click(seat, action.type === 'offer' ? `offer-${action.target}` : `command-${action.type}`);
      await waitRevision(revision + 1);
    };
    const act = async (type, extras = {}) => {
      const state = (await read(pages[0])).room.match;
      const action = legalActions(state).find((candidate) => candidate.type === type && Object.entries(extras).every(([key, value]) => candidate[key] === value));
      assert.ok(action, `${type} is legal at ${state.step}`); await perform(action);
    };
    await act('draw'); await act('offer', { target: 1 }); await act('accept');
    const beforeReload = await read(pages[1]); await pages[1].reload(); await ready(pages[1]);
    assert.deepEqual((await read(pages[1])).room.match, beforeReload.room.match);
    assert.equal((await read(pages[1])).self.seat, 1);
    await act('place'); await act('place'); await act('meditate');
    await act('draw'); await act('self'); await act('request-invite'); await act('yield'); await act('place'); await act('place'); await act('meditate');
    // The guest compares seat 0 (a CPU-view assumption previously excluded this seat).
    await pages[1].locator('[data-action="inspect"][data-seat="0"]').click();
    await pages[1].locator('#online-comparison[open]').waitFor();
    await pages[1].locator('[data-action="compare-pair"]').click();
    const comparisonRevision = (await read(pages[0])).room.match.revision;
    await act('draw');
    assert.equal((await read(pages[1])).room.match.revision, comparisonRevision + 1);
    assert.equal(await pages[1].locator('#online-comparison').evaluate((dialog) => dialog.open), true);
    await pages[1].keyboard.press('Escape'); assert.equal(await pages[1].locator('#online-comparison').count(), 0);

    const screenshots = '/tmp/floating-garden-online-browser-qa'; await mkdir(screenshots, { recursive: true });
    for (const width of [320, 390, 768, 1180]) {
      await pages[0].setViewportSize({ width, height: 900 });
      assert.equal(await pages[0].evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `no horizontal overflow at ${width}px`);
      if ([390, 1180].includes(width)) await pages[0].screenshot({ path: `${screenshots}/${width}px.png`, fullPage: true });
    }
    await pages[0].setViewportSize({ width: 1180, height: 900 });
    await pages[0].evaluate(() => { document.documentElement.style.zoom = '200%'; });
    assert.equal(await pages[0].evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'no horizontal overflow at 200% zoom');
    await pages[0].evaluate(() => { document.documentElement.style.zoom = ''; });

    const covered = new Set(['draw', 'offer', 'accept', 'request-invite', 'yield', 'place', 'meditate']);
    let turns = 0;
    while (true) {
      const match = (await read(pages[0])).room.match;
      if (match.phase === 'finished') break;
      assert.ok(++turns < 400, 'match completes in bounded legal actions');
      const actions = legalActions(match);
      const preferred = ['use-storage', 'store', 'decline', 'welcome', 'stone', 'pass-invite', 'pass-final'];
      let action = preferred.filter((type) => !covered.has(type)).map((type) => actions.find((candidate) => candidate.type === type)).find(Boolean);
      action ||= actions.find((candidate) => candidate.type === 'self') || actions.find((candidate) => candidate.type === 'pass-invite') || actions.find((candidate) => candidate.type === 'meditate') || actions[0];
      covered.add(action.type); await perform(action);
    }
    const [alice, bob] = await Promise.all(pages.map(read));
    assert.deepEqual(alice.room, bob.room);
    assert.equal(alice.room.status, 'finished');
    assert.equal(alice.room.scores.length, 2);
    assert.ok(alice.room.match.players.every((player) => player.garden.filter(Boolean).length === 16));
    assert.equal(new Set(alice.room.match.players.map((player) => player.careCount)).size, 1);
    assert.equal(Object.hasOwn(alice.room.match, 'deck'), false); assert.equal(Object.hasOwn(alice.room.match, 'seed'), false);
    assert.ok(covered.has('stone') && covered.has('store') && covered.has('use-storage'));
    assert.equal(await pages[0].locator('.match-results').count(), 1);
    await pages[0].screenshot({ path: `${screenshots}/finished.png`, fullPage: true });
    await pages[0].reload(); await ready(pages[0]); assert.deepEqual((await read(pages[0])).room.scores, alice.room.scores);
    assert.deepEqual(failures, []);
    console.log(`Browser QA passed: ${alice.room.match.revision} committed actions, coverage ${[...covered].join(', ')}, screenshots ${screenshots}`);
  } finally { await browser?.close(); await new Promise((done) => server.close(done)); }
});

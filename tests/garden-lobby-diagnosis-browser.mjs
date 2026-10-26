// Local Chromium/CDP runner. Does not require Playwright install or credentials.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../', import.meta.url));
const pause = ms => new Promise(r => setTimeout(r, ms));
const profile = await mkdtemp(resolve(tmpdir(), 'garden-seat-assist-'));
const html = `<!doctype html><meta charset="utf-8"><title>Offline synthetic Garden seats</title><link rel="stylesheet" href="/floating-garden/style.css"><link rel="stylesheet" href="/floating-garden/match-style.css"><link rel="stylesheet" href="/floating-garden/limited-trial/online/style.css"><div id="seat0"></div><div id="seat1"></div><script type="module">const timer=window.setTimeout;window.setTimeout=(fn,ms,...args)=>timer(fn,ms===350?8:ms,...args);window.fetch=()=>{throw Error('external fetch forbidden')};import {reset,verifyStoppedRuntime} from '/tests/helpers/garden-lobby-diagnosis.js';window.stoppedVerified=await verifyStoppedRuntime();window.reset=async(...args)=>window.h=await reset(...args);await window.reset();window.ready=true;</script>`;
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html); return; }
    const path = resolve(repo, '.' + new URL(req.url, 'http://local').pathname);
    if (!path.startsWith(repo)) { res.writeHead(403); res.end(); return; }
    res.setHeader('Content-Type', extname(path) === '.js' ? 'text/javascript' : extname(path) === '.css' ? 'text/css' : 'application/octet-stream'); res.end(await readFile(path));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const chromium = spawn(process.env.CHROMIUM || '/usr/bin/chromium', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-component-update', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
let ws;
const results = [], errors = [], pending = new Map(); let serial = 0;
try {
  let port;
  for (let i = 0; i < 100; i++) { try { port = (await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await pause(50); } }
  assert.ok(port, 'Chromium starts');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = event => { const msg = JSON.parse(event.data); if (msg.id) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(Error(JSON.stringify(msg.error))) : p.resolve(msg.result); } else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text + ':' + (msg.params.exceptionDetails.exception?.description || '')); };
  const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const r = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value; };
  const until = async (expression, timeout = 25000) => { const until = Date.now() + timeout; while (Date.now() < until) { if (await evaluate(expression)) return; await pause(30); } throw Error(`timeout: ${expression}`); };
  const check = async (name, fn) => { await fn(); results.push({ name, passed: true }); console.log('PASS', name); };
  await command('Runtime.enable'); await command('Network.enable'); await command('Network.setBlockedURLs', { urls: ['https://*'] });
  await command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  await until('window.ready === true');
  await check('exact stopped runtime rejects before SDK load',async()=>{assert.equal(await evaluate('window.stoppedVerified'),true);});
  await check('real transport auth deadline clears native lock and returns retry in no-room DOM', async()=>{
    await until('h.timers.size===1'); assert.equal(await evaluate('h.state().busy'),true);
    await evaluate('h.tick()');await until('!h.state().busy');
    assert.equal(await evaluate('h.state().connection'),'error');
    assert.equal(await evaluate("!!h.root.querySelector('[data-action=resume]')"),true);
    assert.deepEqual(await evaluate('h.counts()'),{signins:0,calls:0,writes:0,readyCalls:1});
    await evaluate('h.click()');await until('h.timers.size===1');await evaluate('h.tick()');await until('!h.state().busy');
    assert.equal(await evaluate('h.counts().readyCalls'),1);
    await evaluate('h.release()');await pause(50);await evaluate('h.click()');await until("h.state().connection==='ready'&&!h.state().busy");
    assert.equal(await evaluate('h.counts().signins'),1);
  });
  await check('retained pending anonymous sign-in never duplicates after two caller deadlines',async()=>{
    await evaluate("reset('signing')");await until('h.counts().signins===1');
    await evaluate('h.tick()');await until('!h.state().busy');await evaluate('h.click()');await until('h.timers.size===1');await evaluate('h.tick()');await until('!h.state().busy');
    assert.equal(await evaluate('h.counts().signins'),1);
  });
  await check('pagehide/pageshow during auth leaves syncing but retry is available after deadline',async()=>{
    await evaluate("reset();");await until('h.timers.size===1');
    await evaluate("dispatchEvent(new Event('pagehide'));dispatchEvent(new Event('pageshow'));h.tick()");await until('!h.state().busy');
    assert.equal(await evaluate('h.state().connection'),'syncing');assert.equal(await evaluate("!!h.root.querySelector('[data-action=resume]')"),true);
    await evaluate('h.release()');await pause(40);await evaluate('h.click()');await until("h.state().connection==='ready'&&!h.state().busy");
  });
  await check('visibility-only transition retains original deadline',async()=>{
    await evaluate('reset()');await until('h.timers.size===1');
    await evaluate("Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'));h.tick()");await until('!h.state().busy');assert.equal(await evaluate('h.state().connection'),'error');
  });
  await check('storage failure exits busy and preserves no writes',async()=>{
    await evaluate('reset()');await until('h.timers.size===1');await evaluate('h.failStorage();h.release()');await until('!h.state().busy');
    assert.ok(await evaluate('h.state().storageIssue'));assert.equal(await evaluate('h.counts().writes'),0);
  });
  await check('injected stalled Web Locks request times out before auth and fences late delivery',async()=>{
    await evaluate("reset('pending','pending')");await pause(40);await evaluate('h.tick(60000)');
    assert.equal(await evaluate('h.state().busy'),false);assert.equal(await evaluate('h.timers.size'),0);assert.equal(await evaluate('h.counts().readyCalls'),0);assert.equal(await evaluate('h.controller.getDiagnostics().lock'),'timed-out');await evaluate('h.deliverLock()');assert.equal(await evaluate('h.counts().readyCalls'),0);
  });
  await check('one-shot observer error cleans busy with native lock and mounted DOM',async()=>{
    await evaluate("reset('ready')");await until("h.state().connection==='ready'&&!h.state().busy");
    await evaluate("window.injected=false;h.controller.observe(()=>{if(h.state().connection==='syncing'&&!window.injected){window.injected=true;throw Error('offline-render-injection');}});h.controller.resume()");
    await until('!h.state().busy');assert.equal(await evaluate('window.injected'),true);
    assert.equal(await evaluate('h.state().connection'),'error');assert.equal(await evaluate("!!h.root.querySelector('[data-action=resume]')"),true);
    assert.equal(await evaluate('h.counts().writes'),0);assert.equal(await evaluate('h.counts().calls'),0);
  });
  await check('callable deadline remains 15 seconds, without automatic retry',async()=>{
    await evaluate("reset('ready')");await until("h.state().connection==='ready'&&!h.state().busy");
    await evaluate("window.callResult=null;h.transport.api.create({requestId:'fake-only'}).catch(e=>window.callResult=e.details.reason);void 0");
    await evaluate('h.tick(12000)');assert.equal(await evaluate('window.callResult'),null);
    await evaluate('h.tick(15000)');await until("window.callResult==='callable-timeout'");assert.equal(await evaluate('h.counts().calls'),1);
  });
  await check('mobile viewport visibility cancellation blocks pageshow replay and stale callback',async()=>{
    await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:3,mobile:true});
    await command('Emulation.setTouchEmulationEnabled',{enabled:true});
    await evaluate("reset('ready','pending')");await until('h.lockCount()===1');
    await evaluate("Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'));dispatchEvent(new Event('pageshow'))");
    await pause(30);assert.equal(await evaluate('h.lockCount()'),1);assert.equal(await evaluate('h.state().busy'),false);assert.equal(await evaluate('h.controller.getDiagnostics().lock'),'cancelled');
    await evaluate('h.click()');await until('h.lockCount()===2');await evaluate('h.deliverLock(0)');assert.equal(await evaluate('h.counts().readyCalls'),0);assert.equal(await evaluate('h.state().busy'),true);
    await evaluate('h.deliverLock(1)');await until("h.state().connection==='ready'&&!h.state().busy");assert.equal(await evaluate('h.counts().signins'),1);
  });
  await check('mobile pagehide/freeze/active/pageshow does not replay stopped acquisition',async()=>{
    await evaluate("reset('ready','pending')");await until('h.lockCount()===1');await evaluate("dispatchEvent(new Event('pagehide'))");
    await command('Page.setWebLifecycleState',{state:'frozen'});await command('Page.setWebLifecycleState',{state:'active'});
    await evaluate("dispatchEvent(new Event('pageshow'))");await pause(30);assert.equal(await evaluate('h.lockCount()'),1);await evaluate('h.deliverLock()');assert.equal(await evaluate('h.counts().readyCalls'),0);assert.equal(await evaluate('h.controller.getDiagnostics().lock'),'suspended');
  });
  await check('final render exception retains diagnostic after native lock release',async()=>{
    await evaluate("reset('ready')");await until("h.state().connection==='ready'&&!h.state().busy");
    await evaluate("window.finalThrown=false;h.controller.observe(()=>{if(!window.finalThrown&&h.controller.getDiagnostics().lock==='settled'){window.finalThrown=true;throw Error('synthetic-final-render');}});h.controller.resume()");
    assert.equal(await evaluate('h.state().busy'),false);assert.equal(await evaluate('h.controller.getDiagnostics().render'),'failed');assert.equal(await evaluate('h.controller.resume()'),false);
  });
  await check('teardown fences late callback and clears acquisition timer',async()=>{
    await evaluate("reset('ready','pending')");await until('h.lockCount()===1');await evaluate('h.dispose();h.deliverLock()');assert.equal(await evaluate('h.counts().readyCalls'),0);assert.equal(await evaluate('h.timers.size'),0);
  });
  assert.deepEqual(errors, []);
  const output={passed:true,browser:await command('Browser.getVersion'),tests:results,scope:'Exact published modules, fake SDK/auth/timers/storage, loopback Chromium only; owner cause unconfirmed'};
  await writeFile(process.argv[2] || '/tmp/garden-lobby-browser-results.json',JSON.stringify(output,null,2)+'\n');
} finally { ws?.close(); chromium.kill(); server.close(); await pause(200); await rm(profile,{recursive:true,force:true}); }

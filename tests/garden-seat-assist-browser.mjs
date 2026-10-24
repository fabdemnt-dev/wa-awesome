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
const html = `<!doctype html><meta charset="utf-8"><title>Offline synthetic Garden seats</title><link rel="stylesheet" href="/floating-garden/style.css"><link rel="stylesheet" href="/floating-garden/match-style.css"><link rel="stylesheet" href="/floating-garden/limited-trial/online/style.css"><div id="seat0"></div><div id="seat1"></div><script type="module">const timer=window.setTimeout;window.setTimeout=(fn,ms,...args)=>timer(fn,ms===350?8:ms,...args);window.fetch=()=>{throw Error('external fetch forbidden')};import {reset} from '/tests/helpers/garden-seat-assist-harness.js';window.reset=async()=>window.h=await reset();await window.reset();window.ready=true;</script>`;
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
  await check('no automatic start; B waits on A; stop cancels queued timer', async () => {
    await pause(100); assert.equal(await evaluate('h.calls.length'), 0);
    await evaluate("h.click(1,'seat-assist-start')"); await pause(100); assert.equal(await evaluate('h.calls.length'), 0);
    await evaluate("h.click(1,'seat-assist-stop');h.click(0,'seat-assist-start');h.click(0,'seat-assist-stop')"); await pause(100); assert.equal(await evaluate('h.calls.length'), 0);
  });
  await check('single flight during delayed send; stop survives completion', async () => {
    await evaluate("h.flags.delay=200;h.click(0,'seat-assist-start')"); await until('h.calls.length===1');
    await pause(80); assert.equal(await evaluate('h.calls.length'), 1);
    await evaluate("h.click(0,'seat-assist-stop')"); await pause(300); assert.equal(await evaluate('h.calls.length'), 1);
    assert.match(await evaluate('h.status(0)'), /停止/);
  });
  await check('manual preview is not auto-committed; resume needs explicit start', async () => {
    await evaluate('reset()');
    await evaluate("h.click(0,'command-draw')"); await until("h.state(0).canConfirm && h.room.match.step==='choose'");
    await evaluate("h.click(0,'command-self')"); await until("h.state(0).canConfirm && h.room.match.step==='invite-response'");
    await evaluate("h.click(1,'command-pass-invite')");
    await until('h.room.match.step === "place"');
    const before = await evaluate('h.room.match.revision');
    await pause(100); assert.equal(await evaluate('h.room.match.revision'), before);
    // Explicit manual selection, then start must stay disabled until cancelled.
    await evaluate("h.roots[0].querySelector('.workbench .garden-section button[data-action=cell]:not(:disabled)').click()");
    assert.equal(await evaluate("h.roots[0].querySelector('[data-action=seat-assist-start]').disabled"), true);
  });
  await check('uncertain response stops; manual recovery reuses ID without restarting', async () => {
    await evaluate("reset()"); await evaluate("h.flags.lose=true;h.click(0,'seat-assist-start')"); await until("h.state(0).connection==='uncertain'");
    await pause(100); assert.equal(await evaluate('h.calls.length'), 1); assert.match(await evaluate('h.status(0)'), /停止/);
    await evaluate("h.click(0,'resume')"); await until("h.state(0).connection==='ready'"); await pause(100);
    assert.equal(await evaluate('h.calls.length'), 2); assert.equal(await evaluate('h.calls[0].requestId===h.calls[1].requestId'), true); assert.equal(await evaluate('h.room.match.revision'), 1);
  });
  await check('hidden and pagehide stop; visibility restoration never restarts', async () => {
    await evaluate('reset()'); await evaluate("h.click(1,'seat-assist-start');Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'))");
    assert.match(await evaluate('h.status(1)'), /非表示/);
    await evaluate("Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'))"); await pause(100); assert.equal(await evaluate('h.calls.length'), 0);
    await evaluate("h.click(0,'seat-assist-start');dispatchEvent(new Event('pagehide'));dispatchEvent(new Event('pageshow'))"); await pause(100); assert.equal(await evaluate('h.calls.length'), 0);
  });
  await check('definitive rejection stops without resubmission', async () => {
    await evaluate('reset()'); await evaluate("h.flags.reject=true;h.click(0,'seat-assist-start')");
    await until('h.calls.length===1'); await pause(150);
    assert.equal(await evaluate('h.calls.length'), 1); assert.equal(await evaluate('h.room.match.revision'), 0); assert.match(await evaluate('h.status(0)'), /停止/);
  });
  await check('reload clears active state and retains same seat', async () => {
    await evaluate('reset()'); await evaluate("h.click(1,'seat-assist-start');h.reload(1)"); await pause(100);
    assert.equal(await evaluate('h.calls.length'), 0); assert.equal(await evaluate('h.state(1).self.seat'), 1); assert.match(await evaluate('h.status(1)'), /停止/);
  });
  await check('old epoch and disabled buttons cannot send', async () => {
    await evaluate('reset()'); await evaluate("const b=h.roots[0].querySelector('[data-action=command-draw]');b.dataset.epoch='-1';b.click();b.dataset.epoch='1';b.disabled=true;b.click()");
    assert.equal(await evaluate('h.calls.length'), 0);
  });
  await check('actual page reload does not restore helper activation', async () => {
    await evaluate('reset()'); await evaluate("h.click(1,'seat-assist-start')");
    await command('Page.reload'); await pause(150); await until('window.ready===true'); await pause(100);
    assert.equal(await evaluate('h.calls.length'), 0); assert.match(await evaluate('h.status(1)'), /停止/);
  });
  await check('full two-synthetic-seat match through real DOM buttons ends at 138/141', async () => {
    await evaluate('reset()'); await evaluate("h.click(0,'seat-assist-start');h.click(1,'seat-assist-start')");
    await until("h.room.status==='finished'", 60000);
    assert.equal(await evaluate('h.calls.length'), 138); assert.equal(await evaluate('h.room.match.revision'), 138); assert.equal(await evaluate('h.room.revision'), 141);
    assert.deepEqual(await evaluate('h.room.match.players.map(p=>[p.garden.filter(Boolean).length,p.careCount])'), [[16,16],[16,16]]);
    assert.equal(await evaluate('JSON.stringify(h.state(0).room.scores)===JSON.stringify(h.state(1).room.scores)'), true);
    assert.match(await evaluate('h.status(0)'), /終了/); assert.match(await evaluate('h.status(1)'), /終了/);
    assert.equal(await evaluate('new Set(h.calls.map(c=>c.requestId)).size'), 138);
    assert.deepEqual(await evaluate('h.calls.map(c=>c.expectedRevision)'), Array.from({length:138},(_,i)=>i));
    assert.equal(await evaluate('h.roots.every(r=>!!r.querySelector(".match-results"))'), true);
    await evaluate('h.reload(0)'); await pause(100); assert.equal(await evaluate('h.calls.length'), 138); assert.equal(await evaluate('h.state(0).terminal'), 'finished');
  });
  assert.deepEqual(errors, []);
  const output = { passed: true, browser: await command('Browser.getVersion'), tests: results, runtimeErrors: errors, scope: 'Chromium real DOM + main controller/engine with synthetic in-memory transport. NOT live Auth/Rules/SDK/handler.', timerDelayInFixture: '350ms -> 8ms' };
  await writeFile(process.argv[2] || '/tmp/garden-seat-assist-browser.json', JSON.stringify(output, null, 2) + '\n');
} finally { ws?.close(); chromium.kill(); server.close(); await pause(200); await rm(profile, { recursive: true, force: true }); }

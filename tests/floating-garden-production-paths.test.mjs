import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modeRoute, parseEntryMode } from '../floating-garden/online/entry-mode.js';
import { bootstrapTrial } from '../floating-garden/play/bootstrap.js';
import runtime from '../floating-garden/play/trialruntime.js';
import * as oldSave from '../lab/floating-garden/match-save.js';
import * as newSave from '../floating-garden/match-save.js';
import { createMatch } from '../floating-garden/match-engine.js';

const root = new URL('../floating-garden/', import.meta.url);
const oldRoot = new URL('../lab/floating-garden/', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const modes = ['2-0','2-1','2-2','3-0','3-1','4-0'];
const mapping = Object.fromEntries([
  ...['match.html','match-app.js','match-engine.js','match-view.js','match-style.css','style.css','engine.js','view.js','session.js','cpu.js','match-save.js','match-assist.js','match-rule-examples.js'].map(p => [p,p]),
  ...['index.html','entrance.js','entrance.css','entry-navigation.css','motion-policy.js','assets/garden-night.png','assets/garden-night.mp4','assets/garden-serif.woff'].map(p => [p,'entrance/'+p]),
  ...['controller.js','entry-mode.js','modes.js','mount.js','runtime-modes.js','style.css','view.js'].map(p => ['online/'+p,'online/'+p]),
  ...['app.js','bootstrap.js','config.js','firebase.js','index.html','public-origins.js','public-policy.js','style.css','trialruntime.js'].map(p => ['play/'+p,'trial/'+p]),
]);
const replacements = {
  'index.html': [['href="../match.html"','href="./match.html"'],['href="../trial/index.html#mode=2-0"','href="./play/index.html#mode=2-0"'],['href="https://fabdemnt-dev.github.io/wa-awesome/toybox/"','href="../toybox/"']],
  'entrance.js': [["from '../online/entry-mode.js'","from './online/entry-mode.js'"]],
  'online/entry-mode.js': [['`../trial/index.html#mode=${mode.id}`','`./play/index.html#mode=${mode.id}`']],
  'match.html': [['href="./entrance/index.html"','href="./index.html"'],['href="./index.html">自由配置・4人表示デモへ','href="../lab/floating-garden/index.html">自由配置・4人表示デモへ']],
  'play/index.html': [['href="../entrance/index.html"','href="../index.html"']],
};
test('production tree is exactly 37 files, with only five path-only changes from preserved lab sources', async () => {
  const files = [];
  async function walk(prefix = '') { for (const item of await readdir(new URL(prefix, root), {withFileTypes:true})) { if (item.isDirectory()) await walk(prefix+item.name+'/'); else files.push(prefix+item.name); } }
  await walk(); assert.deepEqual(files.sort(), Object.keys(mapping).sort());
  for (const [path, source] of Object.entries(mapping)) {
    let expected = await readFile(new URL(source, oldRoot));
    if (replacements[path]) {
      let text = expected.toString();
      for (const [from,to] of replacements[path]) { assert.equal(text.split(from).length, 2, path); text = text.replace(from,to); }
      expected = Buffer.from(text);
    }
    assert.deepEqual(await readFile(new URL(path, root)), expected, path);
  }
});
test('all HTML/CSS/static-module resource dependencies resolve inside production Garden', async () => {
  const pending = ['index.html','match.html','play/index.html'], seen = new Set();
  while (pending.length) {
    const path = pending.pop(); if (seen.has(path)) continue; seen.add(path);
    const url = new URL(path, root); await stat(url);
    const extension = extname(url.pathname); if (!['.js','.html','.css'].includes(extension)) continue;
    const text = await readFile(url,'utf8'), refs = [];
    if (extension === '.js') for (const [,spec] of text.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) { assert.ok(spec.startsWith('.'),spec); refs.push(spec); }
    if (extension === '.html') {
      for (const [,spec] of text.matchAll(/(?:src|data-src)="([^"]+)"/g)) refs.push(spec);
      for (const [,spec] of text.matchAll(/<link\b[^>]*href="([^"]+)"/g)) refs.push(spec);
    }
    if (extension === '.css') for (const [,spec] of text.matchAll(/url\(['"]?([^'"\)]+)['"]?\)/g)) if (!spec.startsWith('data:')) refs.push(spec);
    for (const spec of refs) {
      const target = new URL(spec,url); target.search=''; target.hash='';
      assert.ok(target.href.startsWith(root.href),`${path}: ${spec}`);
      pending.push(target.href.slice(root.href.length));
    }
  }
  assert.equal(seen.size,37);
});
test('entrance, solo, online and legacy navigation use intentional exact destinations', async () => {
  const entrance=await read('index.html'), solo=await read('match.html'), online=await read('play/index.html');
  assert.match(entrance,/id="solo-link" href="\.\/match.html"/);
  assert.match(entrance,/id="online-entry" href="\.\/play\/index.html#mode=2-0"/);
  assert.match(entrance,/href="\.\.\/toybox\/"/);
  assert.match(solo,/href="\.\/index.html">入口へ/);
  assert.match(solo,/href="\.\.\/lab\/floating-garden\/index.html">自由配置・4人表示デモへ/);
  assert.match(online,/href="\.\.\/index.html">← 人数の選択へ戻る/);
  for (const html of [entrance,online]) {
    assert.equal((html.match(/href="https:\/\/wa-awesome-garden-stg\.web\.app\/lab\/floating-garden\/trial\/index.html"/g)||[]).length,1);
    assert.match(html,/元の端末とブラウザー/); assert.match(html,/オンライン.*(?:無効|準備中)/);
    assert.doesNotMatch(html,/<meta[^>]*http-equiv="refresh"|location\.replace/);
  }
});
test('six exact modes route under production path, while malformed modes fail closed', () => {
  for (const id of modes) {
    const [h,n]=id.split('-').map(Number), url=new URL(modeRoute(h,n),'https://fabdemnt-dev.github.io/wa-awesome/floating-garden/');
    assert.equal(url.pathname,'/wa-awesome/floating-garden/play/index.html'); assert.equal(parseEntryMode(url.hash).id,id);
  }
  for (const hash of ['#mode=4-1','#mode=3-2','#mode=1-0','#mode=03-1','#mode=3-1&enabled=true']) assert.throws(()=>parseEntryMode(hash));
});
test('CPU save format/key/lock and existing saved game remain mutually compatible', () => {
  assert.equal(newSave.SAVE_KEY,'floating-garden-cpu-match'); assert.equal(newSave.SAVE_LOCK,'floating-garden-cpu-match-writer');
  assert.equal(newSave.SAVE_KEY,oldSave.SAVE_KEY); assert.equal(newSave.SAVE_LOCK,oldSave.SAVE_LOCK); assert.equal(newSave.SAVE_VERSION,oldSave.SAVE_VERSION);
  const state=createMatch({playerCount:3,seed:'placement-check',humanSeat:0});
  const raw=oldSave.encodeMatchSave({state,actions:[],savedAt:1});
  assert.deepEqual(newSave.decodeMatchSave(raw),oldSave.decodeMatchSave(raw));
  assert.equal(newSave.encodeMatchSave({state,actions:[],savedAt:1}),raw);
});
test('activation gates remain disabled, and separate CSP/guard candidate is not imported', async () => {
  assert.equal(runtime.enabled,false);
  assert.match(await read('play/public-policy.js'),/"enabled": false/);
  const modes=await read('online/runtime-modes.js'); assert.match(modes,/THREE_HUMAN_MODES_READY = false/); assert.match(modes,/FOUR_HUMAN_MODES_READY = false/);
  for (const path of ['play/app.js','play/bootstrap.js','play/firebase.js','play/index.html']) assert.doesNotMatch(await read(path),/context-guard|assertTopLevelContext|Content-Security-Policy/);
  assert.match(await read('index.html'),/connect-src 'none'/);
});
for (const id of modes) test(`disabled production bootstrap ${id} does not touch transport/storage/controller`, async () => {
  await assert.rejects(()=>bootstrapTrial({},null,runtime,{location:`https://fabdemnt-dev.github.io/wa-awesome/floating-garden/play/index.html#mode=${id}`,transportFactory:()=>assert.fail('transport'),makeController:()=>assert.fail('controller'),mount:()=>assert.fail('mount')}));
});
async function withGlobals(values,run) {
  const previous=new Map();
  try { for(const [key,descriptor] of Object.entries(values)) { previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key)); Object.defineProperty(globalThis,key,{configurable:true,...descriptor}); } await run(); }
  finally { for(const [key,descriptor] of previous) { if(descriptor) Object.defineProperty(globalThis,key,descriptor); else delete globalThis[key]; } }
}
for (const id of modes) test(`actual disabled app ${id} displays selection and unavailable state with no SDK/network/storage`, async () => {
  const root={innerHTML:'',get ownerDocument(){assert.fail('disabled controller access');}}, selection={}; const calls=[];
  const values={document:{value:{querySelector:s=>s==='#online-app'?root:s==='#entry-selection'?selection:{}}},location:{value:new URL(`https://fabdemnt-dev.github.io/wa-awesome/floating-garden/play/index.html#mode=${id}`)}};
  for(const name of ['fetch','XMLHttpRequest','WebSocket','EventSource']) values[name]={value:()=>{calls.push(name);throw Error(name);}};
  for(const name of ['localStorage','sessionStorage','indexedDB','caches']) values[name]={get(){calls.push(name);throw Error(name);}};
  await withGlobals(values,()=>import(new URL(`../floating-garden/play/app.js?test=${id}`,import.meta.url)));
  assert.deepEqual(calls,[]); assert.match(selection.textContent,/選択した構成/); assert.match(root.innerHTML,/有効になっていません/); assert.doesNotMatch(root.innerHTML,/<button|data-public-connect/);
});
test('actual relocated selector creates six production URLs without network or storage', async () => {
  const nodes=new Map(),calls=[];
  function node(id) { if(nodes.has(id))return nodes.get(id); const events={}; const n={hidden:false,value:id==='#human-count'?'2':'0',dataset:{src:'./assets/garden-night.mp4'},classList:{add(){},remove(){}},setAttribute(){},getAttribute(){return null;},addEventListener(k,fn){events[k]=fn;},emit(k){events[k]?.();},pause(){},play(){return Promise.resolve();}};nodes.set(id,n);return n; }
  const values={document:{value:{hidden:false,querySelector:node,addEventListener(){}}},window:{value:{matchMedia:()=>({matches:true,addEventListener(){}}),addEventListener(){}}},navigator:{value:{connection:{saveData:true,addEventListener(){}}}}};
  for(const name of ['fetch','localStorage','sessionStorage','indexedDB']) values[name]={get(){calls.push(name);throw Error(name);}};
  await withGlobals(values,async()=>{
    await import(new URL('../floating-garden/entrance.js',import.meta.url));
    for(const id of modes) {const [h,n]=id.split('-');node('#human-count').value=h;node('#npc-count').value=n;node('#human-count').emit('change');assert.equal(node('#online-entry').href,`./play/index.html#mode=${id}`);}
    node('#human-count').value='4';node('#npc-count').value='2';node('#human-count').emit('change');assert.equal(node('#online-entry').href,'./play/index.html#mode=4-0');
  });
  assert.deepEqual(calls,[]);
});
test('toybox remains unlisted for Garden', async () => {
  const toybox=await readFile(new URL('../toybox/index.html',import.meta.url),'utf8'); assert.doesNotMatch(toybox,/floating-garden|浮遊庭園/);
});

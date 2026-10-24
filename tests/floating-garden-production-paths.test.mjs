import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modeRoute, parseEntryMode } from '../floating-garden/online/entry-mode.js';
import { bootstrapTrial } from '../floating-garden/play/bootstrap.js';
import runtime from '../floating-garden/play/trialruntime.js';
import limitedRuntime from '../floating-garden/limited-trial/play/trialruntime.js';
// Disabled profile remains an offline fixture for the stop guard.
const stoppedLimitedRuntime = Object.freeze({...limitedRuntime, enabled:false});
import { PUBLIC_POLICY as LIMITED_POLICY } from '../floating-garden/limited-trial/play/public-policy.js';
import { resolvePublicEnvironment as resolveLimitedEnvironment, PRODUCTION_AUTH_APP_NAME } from '../floating-garden/limited-trial/play/config.js';
import { bootstrapTrial as bootstrapLimitedTrial, createPublicStorage as createLimitedStorage, publicRecoveryKey as limitedRecoveryKey } from '../floating-garden/limited-trial/play/bootstrap.js';
import { createTrialFirebaseTransport as createLimitedTransport } from '../floating-garden/limited-trial/play/firebase.js';
import { THREE_HUMAN_MODES_READY as LIMITED_THREE_READY, FOUR_HUMAN_MODES_READY as LIMITED_FOUR_READY } from '../floating-garden/limited-trial/online/runtime-modes.js';
import { validateEntryMode as validateLimitedMode, parseEntryMode as parseLimitedMode } from '../floating-garden/limited-trial/online/entry-mode.js';
import { ONLINE_SAVE_KEY as LIMITED_SAVE_KEY } from '../floating-garden/limited-trial/online/controller.js';
import * as oldSave from '../lab/floating-garden/match-save.js';
import * as newSave from '../floating-garden/match-save.js';
import { createMatch, MATCH_VERSION, SOLO_MATCH_VERSION } from '../floating-garden/match-engine.js';

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
// Exact reviewed production-binding source files copied for this isolated trial.
// Reverse only the enumerated relocation, trial wording, and activation differences,
// then compare original bytes by SHA-256. No external preparation tree is required.
const limitedTrialSourceHashes = {
  "play/app.js": "887d88f18d8567bc8fc161aa316bbf36f6c433fb4a7aede8a824bb71834ea54d",
  "play/bootstrap.js": "0614e70a5b6a6617a105e21f5b366e5ddb931584f7f2f786b4fd7aad42760990",
  "play/config.js": "61bdfcdb1fb9948fd0ce4f00517f4fd212d25a593b00d3ff6692038210156bb3",
  "play/firebase.js": "7bd8e0e09e2e67c106b39ab06a8836ef9397b70e00d97240af35251985b42499",
  "play/index.html": "53b04ac4da4cde32782b9447a93b940868dc15a8330356dd8ce7b34205ba9c62",
  "play/public-origins.js": "0278c439a4f3a455dad5655dd40ab5577517d7d65ece441b4d0dc75447043da6",
  "play/public-policy.js": "3384cfbb7a33c412f9a9f8b96a79b2d57992a3a3de02e1d6013d726554da8f19",
  "play/style.css": "f251f0864aa15ec8dfa4e18e7e1dba370d694150272e3a104374de22fb1a4619",
  "play/trialruntime.js": "b4eefdda4eb80cd5b2287a70767b78b57df32c7c1d4dc3a016f571f3092aa0b2",
  "online/controller.js": "a2831bd1cae7e04acc9411e78a9f589adb35ff86b42c5ba003e0e49229b3234c",
  "online/entry-mode.js": "ba4195bf8ec3c71919968823bd72f4f468c6919e35d67d1bdbc18ad74884b195",
  "online/modes.js": "9e5f4ec3547425d094bdcae785510a346573625c0e6023d24cdbff25739c50c6",
  "online/mount.js": "5a9c53ae5739c1379362a1e9d87107df8b4770de5b2e32fbee801aaf7f47fe29",
  "online/runtime-modes.js": "ac6d9221704be56dce9fc3f125f8da32e376e8034d576254dbed95f14031f32e",
  "online/style.css": "c7536c7b7ac6ef2f4fb816bc3d2fd243d759bbaca4cd1cf8f3701dd3bae88573",
  "online/view.js": "ceb21f9c91518f0c251ffab0bfb5d8e627cedd4508c6d7ee5f4169bb332fd63c"
};
const limitedTrialTransforms = {
  "play/index.html": [
    [
      "href=\"../style.css?",
      "href=\"../../style.css?"
    ],
    [
      "href=\"../match-style.css?",
      "href=\"../../match-style.css?"
    ],
    [
      "href=\"../index.html\"",
      "href=\"../../index.html\""
    ],
    [
      "星詠みの浮遊庭園 — オンライン統合準備版",
      "星詠みの浮遊庭園 — 限定オンライン試験"
    ],
    [
      "統合準備版です。オンライン接続は無効で、部屋作成・参加はできません。",
      "限定オンライン試験用の画面です。サーバー側の試験準備が整うまでは接続できません。"
    ],
    [
      "<a href=\"../../index.html\">← 人数の選択へ戻る</a><p><a href=\"https://wa-awesome-garden-stg.web.app/lab/floating-garden/trial/index.html\">現在のオンライン版・前の部屋を開く →</a></p><p>人間2人＋NPC 0〜2人用。前の部屋は、作成・参加した元の端末とブラウザーで開いてください。このGitHub Pages版へログイン状態や部屋の情報は引き継がれません。</p>",
      "<a href=\"../../index.html\">← 通常の入口へ戻る（オンライン停止中）</a><p>人間2人＋NPC 0〜2人の限定試験です。通常の入口からこの試験画面への案内はありませんが、URLの非掲載はアクセス制限ではありません。認証条件を満たす第三者もAPIを利用でき、通信・保存などの料金が発生する場合があります。</p><p>試験終了後は接続を停止します。同じ席への復帰には、この試験で作成・参加した元の端末とブラウザーを使い、保存情報を消さないでください。別の配信元で作成した前の部屋の情報は引き継ぎません。</p>"
    ]
  ],
  "play/app.js": [
    [
      "現在は接続を停止しています。このGitHub Pages版はオンライン接続の準備中です。接続設定の確認が終わるまでは、上のリンクから現在のオンライン版をご利用ください。",
      "この限定試験の接続設定または配信元を確認できません。URLの追加設定は使えません。保存情報を消さず、試験担当者の確認を待ってください。"
    ]
  ],
  "play/bootstrap.js": [
    [
      "<h2>招待で遊ぶ浮遊庭園</h2>",
      "<h2>浮遊庭園の限定オンライン試験</h2>"
    ],
    [
      "部屋は作成から24時間利用できます。公開用の新規枠は20部屋で、過去の試用枠とは別です。受付停止後も既存の部屋は期限まで利用できます（緊急停止時を除く）。",
      "試験用の新規枠は20部屋、部屋の期限は作成から24時間です。試験終了後は接続を停止するため、期限内でも継続できない場合があります。"
    ],
    [
      "同じ席に戻るには同じブラウザーを使ってください。保存情報を消すと復帰できなくなる場合があります。公開7日後は運用確認の目安であり、一律の終了日ではありません。",
      "同じ席に戻るには同じブラウザーを使ってください。保存情報を消すと復帰できなくなる場合があります。URLの非掲載はアクセス制限ではなく、認証条件を満たす第三者もAPIを利用できる場合があります。"
    ]
  ],
  "play/config.js": [
    [
      "// Runtime flags alone cannot activate this locally prepared, unapproved source.",
      "// Both immutable source policy and exact runtime flags must permit this limited trial."
    ]
  ],
  "play/public-policy.js": [
    [
      "// Shared-production candidate only. Source gate stays disabled until separately approved.",
      "// Limited trial source only. Normal entry and normal play remain disabled."
    ],
    [
      "\"enabled\": false",
      "\"enabled\": true"
    ]
  ],
  "play/trialruntime.js": [
    [
      "// Public identifiers copied explicitly from reviewed main, never imported from its resolver.\n// Existing App Check key registration matches, but domain allowlist and token issuance are\n// unverified for this Garden profile. No anonymous Auth or SDK load is allowed while disabled.",
      "// Public identifiers copied explicitly from reviewed main, never imported from its resolver.\n// Enabled only for this isolated limited-trial source. Publication and live testing remain\n// separately gated; this local flag is not proof of a successful live App Check or Auth test."
    ],
    [
      "\"enabled\": false",
      "\"enabled\": true"
    ],
    [
      "\"verified\": false",
      "\"verified\": true"
    ]
  ],
  "online/controller.js": [
    [
      "from '../engine.js?",
      "from '../../engine.js?"
    ],
    [
      "from '../match-engine.js?",
      "from '../../match-engine.js?"
    ]
  ],
  "online/view.js": [
    [
      "from '../engine.js?",
      "from '../../engine.js?"
    ],
    [
      "from '../match-engine.js?",
      "from '../../match-engine.js?"
    ],
    [
      "from '../session.js?",
      "from '../../session.js?"
    ],
    [
      "from '../view.js?",
      "from '../../view.js?"
    ],
    [
      "from '../match-rule-examples.js?",
      "from '../../match-rule-examples.js?"
    ]
  ]
};
// Local, isolated seat-assist exception. Original binding hashes above stay intact.
// No controller, transport, policy, runtime or normal-screen exception is allowed.
const limitedTrialAssistHashes = {
  "online/mount.js": "d9178750ce8025baae91301731bbf947532d95334d90ea73947134cbcbedb0cc",
  "online/seat-assist.js": "3896a947cfaab145e040db65e0e82256fd8b3ec6733c7987166d59ee38fda1a0",
};
const limitedTrialFiles = [...new Set([...Object.keys(limitedTrialSourceHashes), ...Object.keys(limitedTrialAssistHashes)])].map(path => 'limited-trial/' + path);
const unchangedNormalHashes = {
  "index.html": "aabbae9b6067318b8b7cf81ad5aecbc3bcecc176652bfa01a78b4f7a30735ec1",
  "entrance.js": "32f9757bc9ebe6acc8c73e8a843840155fdb785a37412e717e8d3d4d06653ab4",
  "play/app.js": "f22dd58ce2ca47d4894695265c3b113d8b5d4ea276fa281ea97fefe0ce2e4786",
  "play/bootstrap.js": "fa3167334e1408c08ba2ce9e144ddd36c098c4ba985929aaa11ba974ba76ebda",
  "play/config.js": "c958021d13e5ce716648cd6252bc832f3c72df952b341c5ea0b0308d9e6e54f0",
  "play/firebase.js": "8098290ff419fe427620b2ee4526a5b8d8140b8486f045991a47bb1d953299ac",
  "play/index.html": "21947410708bb9d0c6d490df154abad95dd23f56fb72c410e4f4fc60f7ae3dbc",
  "play/public-origins.js": "21f7b82b1b482316e8e128a1e738cb49ce25791d9a522f450cc1b6374166530d",
  "play/public-policy.js": "dea6800e53e7177c6e538cb4ac91a5774eae84bace1ebcd2b77005f69e00ba43",
  "play/style.css": "f251f0864aa15ec8dfa4e18e7e1dba370d694150272e3a104374de22fb1a4619",
  "play/trialruntime.js": "f51de322229a5bee15f608ab6ea47befd629628d44335b7e5ddbe5d372bfcb02"
};
const soloChanged = new Set(['engine.js','match-engine.js','cpu.js','match-save.js','view.js','match-view.js','style.css','match.html','match-app.js','session.js','match-assist.js','match-rule-examples.js','match-style.css','index.html']);
test('production tree adds only exact diagnostic and isolated limited-trial files; original game files preserve their lab mapping', async () => {
  const files = [];
  async function walk(prefix = '') { for (const item of await readdir(new URL(prefix, root), {withFileTypes:true})) { if (item.isDirectory()) await walk(prefix+item.name+'/'); else files.push(prefix+item.name); } }
  await walk(); assert.deepEqual(files.sort(), [...Object.keys(mapping), 'diagnostics/stopped.html', 'diagnostics/stopped.js', ...limitedTrialFiles].sort());
  for (const [path, source] of Object.entries(mapping)) {
    let expected = await readFile(new URL(source, oldRoot));
    if (replacements[path]) {
      let text = expected.toString();
      for (const [from,to] of replacements[path]) { assert.equal(text.split(from).length, 2, path); text = text.replace(from,to); }
      expected = Buffer.from(text);
    }
    if (!soloChanged.has(path)) assert.deepEqual(await readFile(new URL(path, root)), expected, path);
  }
});
test('all HTML/CSS/static-module resource dependencies resolve inside production Garden', async () => {
  const pending = ['index.html','match.html','play/index.html','limited-trial/play/index.html'], seen = new Set();
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
  assert.equal(seen.size,54); // One isolated limited-trial seat-assist module.
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
test('CPU save key and lock stay shared; v1 resumes unchanged while new solo games use v2', () => {
  assert.equal(newSave.SAVE_KEY,'floating-garden-cpu-match'); assert.equal(newSave.SAVE_LOCK,'floating-garden-cpu-match-writer');
  assert.equal(newSave.SAVE_KEY,oldSave.SAVE_KEY); assert.equal(newSave.SAVE_LOCK,oldSave.SAVE_LOCK);
  assert.equal(newSave.LEGACY_SAVE_VERSION,oldSave.SAVE_VERSION);
  const state=createMatch({playerCount:3,seed:'placement-check',humanSeat:0,legacy:true});
  const raw=oldSave.encodeMatchSave({state,actions:[],savedAt:1});
  assert.deepEqual(newSave.decodeMatchSave(raw),oldSave.decodeMatchSave(raw));
  assert.equal(newSave.encodeMatchSave({state,actions:[],savedAt:1}),raw);
  const fresh=createMatch({playerCount:3,seed:'placement-check',humanSeat:0});
  assert.equal(state.version,MATCH_VERSION); assert.equal(fresh.version,SOLO_MATCH_VERSION);
  const freshRaw=newSave.encodeMatchSave({state:fresh,actions:[],savedAt:1});
  assert.equal(newSave.decodeMatchSave(freshRaw).state.objective.id,fresh.objective.id);
  assert.throws(()=>oldSave.decodeMatchSave(freshRaw));
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

test('limited trial preserves reviewed bindings with only the explicit local seat-assist exception', async () => {
  assert.equal(Object.keys(limitedTrialSourceHashes).filter(path => path.startsWith('play/')).length, 9);
  assert.equal(Object.keys(limitedTrialSourceHashes).filter(path => path.startsWith('online/')).length, 7);
  assert.deepEqual(Object.keys(limitedTrialAssistHashes).sort(), ['online/mount.js', 'online/seat-assist.js']);
  for (const [path, hash] of Object.entries(limitedTrialAssistHashes)) assert.equal(createHash('sha256').update(await read('limited-trial/' + path)).digest('hex'), hash, path);
  for (const [path, expectedHash] of Object.entries(limitedTrialSourceHashes)) {
    if (path === 'online/mount.js') continue; // Exact new mount hash asserted above.
    let original = await read('limited-trial/' + path);
    for (const [before, after] of [...(limitedTrialTransforms[path] || [])].reverse()) {
      assert.equal(original.split(after).length, 2, `${path}: exact allowed replacement`);
      original = original.replace(after, before);
    }
    assert.equal(createHash('sha256').update(original).digest('hex'), expectedHash, path);
  }
});

test('normal entrance and disabled play bytes remain unchanged and no normal page links to the trial', async () => {
  for (const [path, expectedHash] of Object.entries(unchangedNormalHashes)) {
    assert.equal(createHash('sha256').update(await readFile(new URL(path, root))).digest('hex'), expectedHash, path);
  }
  for (const path of [...Object.keys(mapping), 'diagnostics/stopped.html', 'diagnostics/stopped.js']) {
    if (['.html', '.js', '.css'].includes(extname(path))) assert.doesNotMatch(await read(path), /limited-trial/);
  }
  assert.equal(runtime.enabled, false);
  assert.equal(limitedRuntime.enabled, true);
  assert.equal(LIMITED_POLICY.enabled, true);
  assert.equal(limitedRuntime.appCheck.verified, true);
  assert.equal(LIMITED_THREE_READY, false);
  assert.equal(LIMITED_FOUR_READY, false);
});

const limitedUrl = 'https://fabdemnt-dev.github.io/wa-awesome/floating-garden/limited-trial/play/index.html';
test('limited trial uses exact production profile, Auth namespace and recovery scope without URL overrides', () => {
  const config = resolveLimitedEnvironment(limitedRuntime, limitedUrl + '#mode=2-0');
  assert.equal(config.projectId, 'wa-awesome');
  assert.equal(config.projectNumber, '1074804319870');
  assert.equal(config.origin, 'https://fabdemnt-dev.github.io');
  assert.equal(config.epochId, 'public-production-20261023-v1');
  assert.equal(PRODUCTION_AUTH_APP_NAME, 'floating-garden-production-wa-awesome');
  assert.equal(config.maxRooms, 20);
  assert.equal(config.roomTtlMillis, 86400000);
  assert.equal(config.retentionMillis, 604800000);
  assert.equal(config.region, 'asia-northeast1');
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.firebase), true);
  assert.equal(Object.isFrozen(config.appCheck), true);
  for (const url of [limitedUrl + '?', limitedUrl + '?enabled=true', limitedUrl + '?projectId=other#mode=2-0', limitedUrl.replace('https:', 'http:'), limitedUrl.replace('.io/', '.io:443/'), limitedUrl.replace('fabdemnt-dev.github.io', 'wa-awesome-garden-stg.web.app'), limitedUrl.replace('fabdemnt-dev.github.io', 'fabdemnt-dev.github.io.example.com')]) {
    assert.throws(() => resolveLimitedEnvironment(limitedRuntime, url));
  }
  for (const change of [{enabled:false}, {projectId:'wa-awesome-garden-stg'}, {epochId:'other'}, {projectNumber:'123'}, {maxRooms:21}, {origin:'https://wa-awesome-garden-stg.web.app'}, {firebase:{...limitedRuntime.firebase, apiKey:'changed'}}, {appCheck:{...limitedRuntime.appCheck, verified:false}}, {extra:true}]) {
    assert.throws(() => resolveLimitedEnvironment({...limitedRuntime, ...change}, limitedUrl));
  }
  assert.equal(limitedRecoveryKey('wa-awesome', limitedRuntime.epochId), `floating-garden-public:wa-awesome:public-production-20261023-v1:${LIMITED_SAVE_KEY}`);
  assert.throws(() => limitedRecoveryKey('wa-awesome-garden-stg', limitedRuntime.epochId));
  assert.throws(() => limitedRecoveryKey('wa-awesome', 'other'));
  const calls = [], storage = createLimitedStorage({getItem:key => { calls.push(['get', key]); return null; }, setItem:(key, value) => calls.push(['set', key, value])}, 'wa-awesome', limitedRuntime.epochId);
  storage.getItem(LIMITED_SAVE_KEY); storage.setItem(LIMITED_SAVE_KEY, 'saved');
  assert.deepEqual(calls, [['get', limitedRecoveryKey('wa-awesome', limitedRuntime.epochId)], ['set', limitedRecoveryKey('wa-awesome', limitedRuntime.epochId), 'saved']]);
  assert.throws(() => storage.getItem('floating-garden-cpu-match'));
  assert.throws(() => storage.setItem('unrelated', 'saved'));
});

test('limited trial retains the existing SDK/Auth transport and adds no administrator or alternate-auth path', async () => {
  const source = await read('limited-trial/play/firebase.js');
  const sdkImports = [...source.matchAll(/import\('([^']+)'\)/g)].map(match => match[1]);
  assert.deepEqual(sdkImports, ['app','app-check','auth','firestore','functions'].map(sdk => `https://www.gstatic.com/firebasejs/10.8.0/firebase-${sdk}.js`));
  assert.match(source, /const appName = PRODUCTION_AUTH_APP_NAME;/);
  assert.match(source, /authSdk\.setPersistence\(auth, authSdk\.browserLocalPersistence\)/);
  assert.match(source, /auth\.currentUser \|\| \(await authSdk\.signInAnonymously\(auth\)\)\.user/);
  assert.match(source, /auth\.authStateReady\(\)/);
  assert.match(source, /httpsCallable\(functions, name/);
  assert.doesNotMatch(source, /firebase-database|connect\w+Emulator|signInWith|customToken|admin|fetch\(|XMLHttpRequest|serviceWorker\.register/);
  assert.equal(source.indexOf('appCheckSdk.getToken(appCheck, false)') < source.indexOf('authSdk.getAuth(app)'), true);
});

test('limited trial invalid configuration or URL cannot reach even an injected offline SDK', async () => {
  for (const [profile, url] of [[{...limitedRuntime, enabled:false}, limitedUrl], [{...limitedRuntime, appCheck:{...limitedRuntime.appCheck, verified:false}}, limitedUrl], [limitedRuntime, limitedUrl + '?enabled=true'], [limitedRuntime, limitedUrl.replace('.io/', '.io:443/')]]) {
    await assert.rejects(() => createLimitedTransport(profile, url, {loadSdk:() => assert.fail('invalid input loaded SDK')}));
  }
  await assert.rejects(() => createLimitedTransport(limitedRuntime, limitedUrl, {environment:{FIREBASE_APPCHECK_DEBUG_TOKEN:false}, loadSdk:() => assert.fail('debug provider loaded SDK')}));
});

test('limited trial advertises two human seats only and labels nonlisting as no access restriction', async () => {
  const html = await read('limited-trial/play/index.html'), bootstrap = await read('limited-trial/play/bootstrap.js');
  assert.match(html, /限定オンライン試験/);
  assert.match(html, /人間2人＋NPC 0〜2人/);
  assert.match(html, /URLの非掲載はアクセス制限ではありません/);
  assert.match(html, /認証条件を満たす第三者もAPIを利用/);
  assert.match(html, /料金が発生/);
  assert.match(html, /試験終了後は接続を停止/);
  assert.match(html, /href="\.\.\/\.\.\/index.html">← 通常の入口へ戻る（オンライン停止中）/);
  assert.doesNotMatch(html, /現在のオンライン版|wa-awesome-garden-stg|オンライン統合準備版|統合準備版です/);
  assert.match(bootstrap, /試験終了後は接続を停止するため、期限内でも継続できない場合/);
  for (const mode of ['2-0', '2-1', '2-2']) assert.equal(validateLimitedMode(parseLimitedMode('#mode=' + mode), {threeHumanModesReady:LIMITED_THREE_READY, fourHumanModesReady:LIMITED_FOUR_READY}).id, mode);
  for (const mode of ['3-0', '3-1', '4-0']) assert.throws(() => validateLimitedMode(parseLimitedMode('#mode=' + mode), {threeHumanModesReady:LIMITED_THREE_READY, fourHumanModesReady:LIMITED_FOUR_READY}));
  for (const hash of ['#mode=2-0&enabled=true', '#mode=4-1', '#mode=1-0', '#projectId=other']) assert.throws(() => parseLimitedMode(hash));
});

function limitedTrialPage() {
  const events = new Map();
  const page = {navigator:{onLine:true}, addEventListener(){}, removeEventListener(){}, get localStorage() { assert.fail('idle page accessed storage'); }};
  const root = {innerHTML:'', ownerDocument:{defaultView:page}, addEventListener:(name, listener) => events.set(name, listener), removeEventListener:name => events.delete(name), setAttribute(){}};
  return {root, page, events, status:{innerHTML:''}};
}
for (const mode of ['2-0', '2-1', '2-2']) test(`limited trial actual app ${mode} remains idle until explicit connection without SDK/network/storage`, async () => {
  const {root, status, events} = limitedTrialPage(), selection = {}, touched = [];
  const values = {document:{value:{querySelector:selector => selector === '#online-app' ? root : selector === '#trial-status' ? status : selection}}, location:{value:new URL(limitedUrl + '#mode=' + mode)}};
  for (const name of ['fetch','XMLHttpRequest','WebSocket','EventSource']) values[name] = {value:() => { touched.push(name); assert.fail('idle ' + name); }};
  for (const name of ['localStorage','sessionStorage','indexedDB','caches']) values[name] = {get(){ touched.push(name); assert.fail('idle ' + name); }};
  await withGlobals(values, () => import(new URL(`../floating-garden/limited-trial/play/app.js?offline-test=${mode}`, import.meta.url)));
  assert.deepEqual(touched, []);
  assert.match(selection.textContent, /選択した構成/);
  assert.match(root.innerHTML, /data-public-connect/);
  assert.match(status.innerHTML, /限定オンライン試験/);
  assert.equal(events.size, 1);
});

test('disabled trial runtime fixture blocks bootstrap and SDK before authentication or storage', async () => {
  assert.equal(stoppedLimitedRuntime.enabled, false);
  assert.throws(() => resolveLimitedEnvironment(stoppedLimitedRuntime, limitedUrl));
  await assert.rejects(() => createLimitedTransport(stoppedLimitedRuntime, limitedUrl, {loadSdk:() => assert.fail('stopped runtime loaded SDK')}));
  const {root, status, events} = limitedTrialPage();
  await assert.rejects(() => bootstrapLimitedTrial(root, status, stoppedLimitedRuntime, {location:limitedUrl, transportFactory:() => assert.fail('stopped runtime reached transport')}));
  assert.equal(events.size, 0);
  assert.equal(root.innerHTML, '');
});

test('limited trial offline connection is single-flight, uses exact source config and preserves existing mode gates', async () => {
  const {root, status, page, events} = limitedTrialPage(), calls = [];
  Object.defineProperty(page, 'localStorage', {value:{getItem:() => null, setItem(){}}});
  const transport = {isActive:() => true, dispose:() => calls.push('dispose')};
  const controller = {suspend(){}, storageChanged(){}};
  const instance = await bootstrapLimitedTrial(root, status, limitedRuntime, {
    location:limitedUrl + '#mode=2-2',
    transportFactory:async (config, url) => { assert.deepEqual(config, limitedRuntime); assert.equal(url, limitedUrl + '#mode=2-2'); calls.push('transport'); return transport; },
    makeController:options => { assert.equal(options.threeHumanModesReady, false); assert.equal(options.fourHumanModesReady, false); calls.push('controller'); return controller; },
    mount:(_root, options) => { assert.equal(options.initialMode.id, '2-2'); assert.equal(options.controller, controller); calls.push('mount'); return {ready:Promise.resolve(), unmount:() => calls.push('unmount')}; },
  });
  assert.deepEqual(calls, []);
  const first = instance.connect();
  assert.equal(instance.connect(), first);
  assert.equal(await first, controller);
  assert.deepEqual(calls, ['transport', 'controller', 'mount']);
  instance.unmount();
  assert.equal(events.size, 0);
  assert.equal(await instance.connect(), null);
  assert.deepEqual(calls, ['transport', 'controller', 'mount', 'unmount', 'dispose']);
});

// Fixed stop-response diagnostic tests are offline: no provider SDK or real request is used.
import * as stopped from '../floating-garden/diagnostics/stopped.js';
const diagnosticKeys = new Set(['schemaVersion', 'testId', 'stage', 'startedAt', 'finishedAt', 'submitted', 'outcome', 'httpStatus', 'reason']);
const secretFixture = 'PRIVATE_TEST_ONLY_NEVER_PERSIST';
const stopBody = () => ({error:{status:'FAILED_PRECONDITION', details:{reason:'public-disabled'}, message:secretFixture}});
const stopRecord = (fields = {}) => ({schemaVersion:1, testId:stopped.ATTEMPT_KEY, stage:'reserved', startedAt:1000, submitted:false, outcome:'pending', ...fields});
function assertSafeDiagnostic(record) {
  assert.ok(record && typeof record === 'object');
  for (const key of Object.keys(record)) assert.ok(diagnosticKeys.has(key), `Unexpected persisted field: ${key}`);
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE_TEST_ONLY_NEVER_PERSIST|<script|Bearer /);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.testId, stopped.ATTEMPT_KEY);
}
function memoryDiagnosticStore(initial = null) {
  let value = initial && structuredClone(initial);
  const writes = [];
  return {
    writes,
    async read() { return value && structuredClone(value); },
    async claim(record) { if (value) return false; value = structuredClone(record); writes.push(structuredClone(record)); return true; },
    async save(record) { value = structuredClone(record); writes.push(structuredClone(record)); },
  };
}
function diagnosticOptions(store, extra = {}) {
  return {store, now:() => 1001, getToken:async () => secretFixture, send:async () => ({status:400, body:stopBody()}), ...extra};
}
/** Event-driven IndexedDB double with serialized transactions and rollback, not a claim mock. */
function diagnosticIndexedDB({openFailure = false, abortWrite = false} = {}) {
  let records = new Map(), exists = false, running = false;
  const pending = [], trace = [];
  const process = () => {
    if (running || !pending.length) return;
    running = true;
    const entry = pending.shift();
    setImmediate(() => {
      const copy = new Map(records), {tx, request, method, value} = entry;
      let prevented = false;
      if (method === 'add' && copy.has(value.testId)) {
        request.error = {name:'ConstraintError', message:secretFixture};
        request.onerror?.({preventDefault() { prevented = true; }, stopPropagation() {}});
        if (!prevented) { running = false; tx.onabort?.(); process(); return; }
      } else {
        request.result = method === 'get' ? copy.get(value) : value.testId;
        if (method !== 'get') copy.set(value.testId, structuredClone(value));
        trace.push(`${method}:success`);
        request.onsuccess?.();
      }
      setImmediate(() => {
        if (abortWrite && method !== 'get') { trace.push(`${method}:abort`); tx.onabort?.(); }
        else { records = copy; trace.push(`${method}:complete`); tx.oncomplete?.(); }
        running = false; process();
      });
    });
  };
  const db = {
    objectStoreNames:{contains:() => exists},
    createObjectStore(name, options) { assert.equal(name, 'attempts'); assert.equal(options.keyPath, 'testId'); exists = true; },
    close() {},
    transaction(name, mode, options) {
      assert.equal(name, 'attempts');
      if (mode === 'readwrite') assert.deepEqual(options, {durability:'strict'});
      const tx = {objectStore(storeName) {
        assert.equal(storeName, 'attempts');
        return Object.fromEntries(['get', 'add', 'put'].map(method => [method, value => {
          const request = {};
          pending.push({tx, request, method, value}); process(); return request;
        }]));
      }};
      return tx;
    },
  };
  return {
    trace,
    open(name, version) {
      assert.equal(name, 'floating-garden-stop-diagnostic'); assert.equal(version, 1);
      const request = {};
      queueMicrotask(() => {
        if (openFailure) { request.error = new Error(secretFixture); request.onerror?.(); return; }
        request.result = db;
        if (!exists) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
    seed(record) { records.set(stopped.ATTEMPT_KEY, structuredClone(record)); },
    stored() { return records.get(stopped.ATTEMPT_KEY); },
  };
}
function diagnosticPage(indexedDB, href = 'https://fabdemnt-dev.github.io/wa-awesome/floating-garden/diagnostics/stopped.html') {
  const nodes = new Map(['run-check', 'status', 'result'].map(id => [id, {disabled:id === 'run-check', textContent:'', listeners:new Map(), addEventListener(type, listener) { this.listeners.set(type, listener); }}]));
  return {location:new URL(href), navigator:{}, indexedDB, document:{getElementById:id => nodes.get(id)}, fetch:() => assert.fail('Unrequested production request'), nodes};
}

test('stop diagnostic pins its production target and accepts only the exact disabled response', () => {
  assert.deepEqual(stopped.TARGET, {projectId:'wa-awesome', region:'asia-northeast1', name:'floatingGardenGetSnapshot', epochId:'public-production-20261023-v1', url:'https://asia-northeast1-wa-awesome.cloudfunctions.net/floatingGardenGetSnapshot'});
  assert.ok(Object.isFrozen(stopped.TARGET));
  assert.equal(stopped.ATTEMPT_KEY, 'garden-stop-response-20261023-v1');
  assert.deepEqual(stopped.classifyResponse(400, stopBody()), {outcome:'stopped_verified', httpStatus:400, reason:'public-disabled'});
  for (const [status, body] of [
    [200, stopBody()], [401, stopBody()], [403, stopBody()], [500, stopBody()], ['400', stopBody()],
    [400, {error:{status:'FAILED_PRECONDITION', details:{reason:'public-closed'}}}],
    [400, {error:{status:'UNAUTHENTICATED', details:{reason:'public-disabled'}}}],
    [400, {error:{status:'failed_precondition', details:{reason:'public-disabled'}}}],
    [400, {result:{reason:'public-disabled'}}], [400, null], [400, secretFixture], [0, {}], [Infinity, {}],
  ]) {
    const result = stopped.classifyResponse(status, body);
    assert.notEqual(result.outcome, 'stopped_verified');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TEST_ONLY_NEVER_PERSIST/);
  }
});

test('stop diagnostic atomically claims IndexedDB before proceeding and sanitizes stored records', async () => {
  const idb = diagnosticIndexedDB(), one = stopped.createRecordStore(idb), two = stopped.createRecordStore(idb);
  assert.equal(await one.read(), null);
  const record = {...stopRecord(), token:secretFixture, rawError:{message:secretFixture}, extra:secretFixture};
  assert.deepEqual((await Promise.all([one.claim(record), two.claim(record)])).sort(), [false, true]);
  assert.equal(idb.trace.filter(event => event === 'add:success').length, 1);
  assert.ok(idb.trace.includes('add:complete'));
  assertSafeDiagnostic(idb.stored());
  await one.save({...record, stage:'finished', outcome:'unknown', submitted:true, finishedAt:2000, reason:secretFixture, httpStatus:999});
  const saved = await two.read();
  assertSafeDiagnostic(saved); assert.equal(saved.stage, 'finished'); assert.equal(saved.submitted, true);
  assert.equal(Object.hasOwn(saved, 'reason'), false); assert.equal(Object.hasOwn(saved, 'httpStatus'), false);
  assert.equal(await two.claim(record), false);
});

test('stop diagnostic storage rejects unavailable, aborted and malformed records without requests', async () => {
  assert.throws(() => stopped.createRecordStore(null), /diagnostic-unavailable/);
  assert.throws(() => stopped.createRecordStore({}), /diagnostic-unavailable/);
  for (const idb of [diagnosticIndexedDB({openFailure:true}), diagnosticIndexedDB({abortWrite:true})]) {
    const result = await stopped.runDiagnostic(diagnosticOptions(stopped.createRecordStore(idb), {getToken:() => assert.fail('Token before durable reservation'), send:() => assert.fail('Request with broken storage')}));
    assert.equal(result.outcome, 'blocked'); assert.equal(result.reason, 'storage-unavailable'); assert.equal(result.submitted, false); assertSafeDiagnostic(result);
    assert.equal(idb.stored(), undefined);
  }
  const idb = diagnosticIndexedDB(), store = stopped.createRecordStore(idb);
  for (const fields of [{schemaVersion:2}, {testId:'different-attempt'}, {stage:'retry'}, {outcome:secretFixture}, {startedAt:-1}, {startedAt:NaN}, {submitted:'true'}]) {
    await assert.rejects(store.claim(stopRecord(fields)), /diagnostic-unavailable/);
  }
  idb.seed(stopRecord({stage:'tampered', token:secretFixture}));
  await assert.rejects(store.read(), /diagnostic-unavailable/);
});

test('stop diagnostic writes reservation and submission-possible marker before its single send', async () => {
  const store = memoryDiagnosticStore(), updates = [], order = [];
  const result = await stopped.runDiagnostic(diagnosticOptions(store, {
    getToken:async () => { const saved = await store.read(); assert.equal(saved.stage, 'app-check'); assert.equal(saved.submitted, false); order.push('token'); return secretFixture; },
    send:async token => { assert.equal(token, secretFixture); const saved = await store.read(); assert.equal(saved.stage, 'request-prepared'); assert.equal(saved.submitted, true); order.push('send'); return {status:400, body:stopBody()}; },
    onUpdate:record => updates.push(structuredClone(record)),
  }));
  assert.deepEqual(order, ['token', 'send']); assert.equal(result.outcome, 'stopped_verified'); assert.equal(result.submitted, true); assert.equal(result.stage, 'finished');
  assert.equal(result.reason, 'public-disabled');
  assert.deepEqual(store.writes.map(record => record.stage), ['reserved', 'app-check', 'request-prepared', 'finished']);
  for (const record of [result, ...store.writes, ...updates]) assertSafeDiagnostic(record);
});

test('stop diagnostic concurrent runners and reload never repeat token retrieval or submission', async () => {
  const idb = diagnosticIndexedDB(); let tokens = 0, sends = 0;
  const run = () => stopped.runDiagnostic(diagnosticOptions(stopped.createRecordStore(idb), {getToken:async () => { tokens++; return secretFixture; }, send:async () => { sends++; return {status:400, body:stopBody()}; }}));
  await Promise.all([run(), run(), run()]);
  assert.equal(tokens, 1); assert.equal(sends, 1);
  const previous = await run(); assert.equal(previous.outcome, 'stopped_verified'); assert.equal(tokens, 1); assert.equal(sends, 1);
  for (const saved of [stopRecord(), stopRecord({stage:'app-check'}), stopRecord({stage:'request-prepared', submitted:true}), stopRecord({stage:'finished', submitted:true, outcome:'unknown', finishedAt:1001})]) {
    const result = await stopped.runDiagnostic(diagnosticOptions(memoryDiagnosticStore({...saved, token:secretFixture}), {getToken:() => assert.fail('Reload obtained a token'), send:() => assert.fail('Reload repeated request')}));
    assertSafeDiagnostic(result); assert.equal(result.stage, saved.stage); assert.equal(result.submitted, saved.submitted);
  }
});

test('stop diagnostic fails closed on each pre-send storage failure', async () => {
  for (const failureAt of ['claim', 'app-check', 'request-prepared', 'duplicate-read']) {
    const original = memoryDiagnosticStore(); let tokens = 0, sends = 0;
    const store = {...original,
      async claim(record) { if (failureAt === 'claim') throw new Error(secretFixture); return failureAt === 'duplicate-read' ? false : original.claim(record); },
      async read() { if (failureAt === 'duplicate-read') throw new Error(secretFixture); return original.read(); },
      async save(record) { if (record.stage === failureAt) throw new Error(secretFixture); return original.save(record); },
    };
    const result = await stopped.runDiagnostic(diagnosticOptions(store, {getToken:async () => { tokens++; return secretFixture; }, send:async () => { sends++; return {status:400, body:stopBody()}; }}));
    assert.equal(result.outcome, 'blocked', failureAt); assert.equal(result.submitted, false, failureAt); assert.equal(sends, 0, failureAt);
    assert.equal(tokens, failureAt === 'request-prepared' ? 1 : 0, failureAt); assertSafeDiagnostic(result);
  }
});

test('stop diagnostic token errors and invalid tokens remain redacted and never reach send', async () => {
  for (const getToken of [async () => { throw Object.assign(new Error(secretFixture), {token:secretFixture, customData:{raw:secretFixture}}); }, async () => '', async () => null, async () => ({token:secretFixture}), async () => 'x'.repeat(16385)]) {
    const store = memoryDiagnosticStore(), updates = [];
    const result = await stopped.runDiagnostic(diagnosticOptions(store, {getToken, send:() => assert.fail('Invalid token was sent'), onUpdate:record => updates.push(record)}));
    assert.equal(result.outcome, 'blocked'); assert.equal(result.reason, 'app-check-unavailable'); assert.equal(result.submitted, false);
    for (const record of [result, ...store.writes, ...updates]) assertSafeDiagnostic(record);
    assertSafeDiagnostic(await stopped.runDiagnostic(diagnosticOptions(store, {getToken:() => assert.fail('Blocked attempt retried')})));
  }
});

test('stop diagnostic unknown response, network error and failed final save never authorize retry', async () => {
  for (const mode of ['network', 'unexpected', 'finish-save']) {
    const original = memoryDiagnosticStore(); let sends = 0;
    const store = {...original, async save(record) { if (mode === 'finish-save' && record.stage === 'finished') throw new Error(secretFixture); return original.save(record); }};
    const options = diagnosticOptions(store, {send:async () => { sends++; if (mode === 'network') throw Object.assign(new Error(secretFixture), {response:{raw:secretFixture}}); return {status:mode === 'unexpected' ? 200 : 400, body:{...stopBody(), token:secretFixture}}; }, onUpdate:() => { throw new Error(secretFixture); }});
    const result = await stopped.runDiagnostic(options);
    assert.equal(result.outcome, mode === 'unexpected' ? 'unexpected' : 'unknown'); assert.equal(result.submitted, true); assertSafeDiagnostic(result);
    await stopped.runDiagnostic(options); assert.equal(sends, 1);
    for (const record of original.writes) assertSafeDiagnostic(record);
    if (mode === 'finish-save') assert.equal((await original.read()).stage, 'request-prepared');
  }
});

test('stop diagnostic transport fixes URL, payload, App Check header and omits credentials', async () => {
  const calls = [];
  const post = stopped.createOneShotPost(async (...args) => { calls.push(args); return new Response(JSON.stringify(stopBody()), {status:400}); });
  const response = await post(secretFixture);
  assert.equal(response.status, 400); assert.equal(stopped.classifyResponse(response.status, response.body).outcome, 'stopped_verified');
  assert.equal(calls.length, 1);
  const [url, options] = calls[0]; assert.equal(url, stopped.TARGET.url);
  assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
  assert.deepEqual(options.headers, {'Content-Type':'application/json', 'X-Firebase-AppCheck':secretFixture});
  assert.deepEqual(JSON.parse(options.body), {data:{epochId:'public-production-20261023-v1'}});
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(Object.keys(options.headers).some(key => /authorization|cookie/i.test(key)), false);
  await assert.rejects(post(secretFixture), /diagnostic-unavailable/); assert.equal(calls.length, 1);
});

test('stop diagnostic transport consumes its allowance on invalid token, concurrent call or network failure', async () => {
  for (const token of ['', null, {}, 'x'.repeat(16385)]) {
    let calls = 0; const post = stopped.createOneShotPost(async () => { calls++; assert.fail('Invalid token request'); });
    await assert.rejects(post(token)); await assert.rejects(post(secretFixture)); assert.equal(calls, 0);
  }
  let calls = 0;
  const post = stopped.createOneShotPost(async () => { calls++; throw new Error(secretFixture); });
  const results = await Promise.allSettled([post(secretFixture), post(secretFixture), post(secretFixture)]);
  assert.ok(results.every(result => result.status === 'rejected')); assert.equal(calls, 1);
});

test('stop diagnostic bounded response rejects opaque, oversized and non-JSON bodies without retry', async () => {
  const responses = [
    () => ({status:0, body:null}),
    () => new Response(secretFixture, {status:502}),
    () => new Response(JSON.stringify({raw:'x'.repeat(8193)}), {status:400}),
    () => ({status:400, body:{getReader:() => ({read:async () => { throw new Error(secretFixture); }})}}),
  ];
  for (const makeResponse of responses) {
    let calls = 0;
    const store = memoryDiagnosticStore(), post = stopped.createOneShotPost(async () => { calls++; return makeResponse(); });
    const options = diagnosticOptions(store, {send:post});
    const result = await stopped.runDiagnostic(options);
    assert.equal(result.outcome, 'unknown'); assert.equal(result.submitted, true); assertSafeDiagnostic(result);
    await stopped.runDiagnostic(options); await assert.rejects(post(secretFixture)); assert.equal(calls, 1);
    for (const record of store.writes) assertSafeDiagnostic(record);
  }
});

test('stop diagnostic timeout aborts once, retains unknown status and does not retry after reload', async () => {
  let calls = 0, aborts = 0;
  const post = stopped.createOneShotPost((_url, {signal}) => new Promise((_resolve, reject) => {
    calls++; signal.addEventListener('abort', () => { aborts++; reject(Object.assign(new Error(secretFixture), {name:'AbortError'})); }, {once:true});
  }), 5);
  const store = memoryDiagnosticStore(), options = diagnosticOptions(store, {send:post});
  const result = await stopped.runDiagnostic(options);
  assert.equal(result.outcome, 'unknown'); assert.equal(result.reason, 'network-or-timeout'); assert.equal(result.submitted, true); assertSafeDiagnostic(result);
  await stopped.runDiagnostic(options); await assert.rejects(post(secretFixture));
  assert.equal(calls, 1); assert.equal(aborts, 1);
});

test('stop diagnostic mounting is idle, and reloading any reserved or terminal state remains disabled', async () => {
  const page = diagnosticPage(diagnosticIndexedDB());
  await stopped.mountDiagnostic(page);
  assert.equal(page.nodes.get('run-check').disabled, false);
  assert.equal(page.nodes.get('run-check').listeners.size, 1);
  assert.equal(page.indexedDB.stored(), undefined);
  for (const record of [stopRecord(), stopRecord({stage:'app-check'}), stopRecord({stage:'request-prepared', submitted:true}), stopRecord({stage:'finished', submitted:true, outcome:'unknown'}), stopRecord({stage:'finished', submitted:true, outcome:'stopped_verified', reason:'public-disabled'})]) {
    const idb = diagnosticIndexedDB(); idb.seed({...record, token:secretFixture});
    const loaded = diagnosticPage(idb); await stopped.mountDiagnostic(loaded);
    assert.equal(loaded.nodes.get('run-check').disabled, true); assert.equal(loaded.nodes.get('run-check').listeners.size, 0);
    assertSafeDiagnostic(JSON.parse(loaded.nodes.get('result').textContent));
  }
});

test('stop diagnostic page refuses changed origin, path, query, hash, debug mode or service worker', async () => {
  for (const href of [
    'http://fabdemnt-dev.github.io/wa-awesome/floating-garden/diagnostics/stopped.html',
    'https://wa-awesome-garden-stg.web.app/wa-awesome/floating-garden/diagnostics/stopped.html',
    'https://fabdemnt-dev.github.io/wa-awesome/floating-garden/play/index.html',
    'https://fabdemnt-dev.github.io/wa-awesome/floating-garden/diagnostics/stopped.html?projectId=other',
    'https://fabdemnt-dev.github.io/wa-awesome/floating-garden/diagnostics/stopped.html#run',
    'https://fabdemnt-dev.github.io/wa-awesome/floating-garden/diagnostics/stopped.html?',
    'https://fabdemnt-dev.github.io/wa-awesome/floating-garden/diagnostics/stopped.html#',
  ]) {
    const page = diagnosticPage({open:() => assert.fail('Disallowed context used storage')}, href);
    await stopped.mountDiagnostic(page); assert.equal(page.nodes.get('run-check').disabled, true); assert.equal(page.nodes.get('run-check').listeners.size, 0);
  }
  for (const mutate of [page => { page.FIREBASE_APPCHECK_DEBUG_TOKEN = false; }, page => { Object.setPrototypeOf(page, {FIREBASE_APPCHECK_DEBUG_TOKEN:undefined}); }, page => { page.navigator.serviceWorker = {controller:{}}; }]) {
    const page = diagnosticPage({open:() => assert.fail('Disallowed context used storage')}); mutate(page);
    await stopped.mountDiagnostic(page); assert.equal(page.nodes.get('run-check').disabled, true); assert.equal(page.nodes.get('run-check').listeners.size, 0);
  }
});

test('stop diagnostic actual click locks immediately and repeated clicks cannot create a second attempt', async () => {
  const page = diagnosticPage(diagnosticIndexedDB()); await stopped.mountDiagnostic(page);
  const button = page.nodes.get('run-check'), click = button.listeners.get('click');
  // Make the context invalid after mount, preventing real SDK loading while exercising the real click listener.
  page.location.hash = '#invalid-after-mount';
  const first = click(); assert.equal(button.disabled, true);
  await Promise.all([first, click(), click()]);
  assert.equal(page.indexedDB.trace.filter(event => event === 'add:success').length, 1);
  assert.equal(page.indexedDB.stored().outcome, 'blocked'); assert.equal(page.indexedDB.stored().submitted, false);
  assertSafeDiagnostic(JSON.parse(page.nodes.get('result').textContent));
  await click(); assert.equal(page.indexedDB.trace.filter(event => event === 'add:success').length, 1);
});

test('stop diagnostic is an isolated two-file page with no automatic token/send, Auth, Firestore or config override', async () => {
  const html = await read('diagnostics/stopped.html'), source = await read('diagnostics/stopped.js');
  assert.deepEqual((await readdir(new URL('diagnostics/', root))).sort(), ['stopped.html', 'stopped.js']);
  assert.match(html, /<button\b[^>]*id="run-check"[^>]*disabled/);
  assert.match(html, /<script type="module" src="\.\/stopped\.js"><\/script>/);
  assert.equal((html.match(/<script\b/g) || []).length, 1);
  assert.match(html, /name="referrer" content="no-referrer"/);
  assert.match(html, /結果不明・中断時も再実行しません/);
  assert.doesNotMatch(html, /<form\b|<input\b|<textarea\b|<iframe\b|http-equiv="refresh"|onclick=/i);
  assert.match(source, /firebasejs\/10\.8\.0\/firebase-app\.js/);
  assert.match(source, /firebasejs\/10\.8\.0\/firebase-app-check\.js/);
  assert.match(source, /getLimitedUseToken\(check\)/);
  assert.match(source, /isTokenAutoRefreshEnabled:false/);
  assert.match(source, /setTokenAutoRefreshEnabled\(check, false\)/);
  assert.doesNotMatch(source, /firebase-(?:auth|firestore|functions)|signIn|httpsCallable|getFirestore|setDoc|addDoc|connect\w+Emulator|console\.|innerHTML|localStorage|sessionStorage|URLSearchParams|location\.search|serviceWorker\.register/);
  assert.doesNotMatch(source, /FIREBASE_APPCHECK_DEBUG_TOKEN\s*=/);
  assert.doesNotMatch(source, /checks\.getToken\(/);
  assert.doesNotMatch(source, /wa-awesome-garden-stg|public-20261022-v1/);
  for (const path of ['index.html', 'entrance.js', 'play/index.html', 'play/app.js']) assert.doesNotMatch(await read(path), /diagnostics\/stopped|stopped\.js/);
});

test('stop diagnostic UI leaves the button disabled for blocked or malformed storage', async () => {
  const malformed = diagnosticIndexedDB(); malformed.seed(stopRecord({stage:'invalid', token:secretFixture}));
  for (const idb of [null, diagnosticIndexedDB({openFailure:true}), malformed]) {
    const page = diagnosticPage(idb); await stopped.mountDiagnostic(page);
    assert.equal(page.nodes.get('run-check').disabled, true);
    assert.equal(page.nodes.get('run-check').listeners.size, 0);
    assert.doesNotMatch(page.nodes.get('result').textContent + page.nodes.get('status').textContent, /PRIVATE_TEST_ONLY_NEVER_PERSIST/);
  }
});

test('stop diagnostic missing or invalid duplicate record fails closed without replacing it', async () => {
  for (const existing of [null, stopRecord({testId:'other-test'}), stopRecord({stage:'invalid'})]) {
    const store = {claim:async () => false, read:async () => existing, save:() => assert.fail('Replaced a prior reservation')};
    const result = await stopped.runDiagnostic(diagnosticOptions(store, {getToken:() => assert.fail('Read failure fetched token'), send:() => assert.fail('Read failure sent request')}));
    assert.equal(result.outcome, 'blocked'); assert.equal(result.reason, 'storage-unavailable'); assert.equal(result.submitted, false); assertSafeDiagnostic(result);
  }
});

test('stop diagnostic display updates are detached from the durable request decision', async () => {
  const store = memoryDiagnosticStore(); let sends = 0;
  const result = await stopped.runDiagnostic(diagnosticOptions(store, {
    onUpdate:record => { record.stage = 'bad'; record.token = secretFixture; record.submitted = false; },
    send:async () => { sends++; const durable = await store.read(); assert.equal(durable.stage, 'request-prepared'); assert.equal(durable.submitted, true); return {status:400, body:stopBody()}; },
  }));
  assert.equal(result.outcome, 'stopped_verified'); assert.equal(sends, 1); assertSafeDiagnostic(result);
  for (const record of store.writes) assertSafeDiagnostic(record);
});

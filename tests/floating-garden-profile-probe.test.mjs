import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {KEY, DB, markerStore, classify, mount} from '../floating-garden/profile-probe/probe.mjs';

function fixtures(localValue=null, idbValue=undefined) {
  const calls = [];
  const local = {
    getItem(k) { calls.push(['getItem',k]); return localValue; },
    setItem(k,v) { calls.push(['setItem',k,v]); localValue=v; }
  };
  const indexed = {open(name,version) {
    calls.push(['open',name,version]);
    const req = {};
    queueMicrotask(() => {
      req.result = {
        close() { calls.push(['close']); },
        transaction(store, mode) {
          calls.push(['transaction',store,mode]);
          let aborted=false;
          const tx = {
            abort() { aborted=true; queueMicrotask(()=>tx.onabort?.()); },
            objectStore(name) {
              calls.push(['objectStore',name]);
              return {
                get(k) {
                  calls.push(['get',k]);
                  const row={};
                  queueMicrotask(()=>{
                    row.result=idbValue; row.onsuccess?.();
                    if(!aborted)queueMicrotask(()=>tx.oncomplete?.());
                  });
                  return row;
                },
                add(v,k) {
                  calls.push(['add',v,k]);
                  if(idbValue!==undefined)throw Error('EXISTS');
                  idbValue=v;
                }
              };
            }
          };
          return tx;
        }
      };
      req.onsuccess?.();
    });
    return req;
  }};
  return {local,indexed,calls};
}

test('only exact synthetic namespace is read',async()=>{
  const f=fixtures(); const store=markerStore(f.local,f.indexed);
  assert.deepEqual(f.calls,[]);
  assert.deepEqual(await store.read(),{local:null,indexed:null});
  assert.ok(f.calls.some(x=>x[0]==='open' && x[1]===DB));
  assert.deepEqual(f.calls.filter(x=>x[0]==='getItem'),[['getItem',KEY]]);
  assert.deepEqual(f.calls.filter(x=>x[0]==='get'),[['get','seat']]);
  assert.ok(!f.calls.some(x=>['setItem','add'].includes(x[0])));
});
for(const seat of ['A','B'])test(`empty self namespace saves ${seat}`,async()=>{
  const f=fixtures(); const store=markerStore(f.local,f.indexed);
  assert.deepEqual(await store.write(seat),{local:seat,indexed:seat});
  assert.deepEqual(f.calls.filter(x=>x[0]==='add'),[['add',seat,'seat']]);
  assert.deepEqual(f.calls.filter(x=>x[0]==='setItem'),[['setItem',KEY,seat]]);
  assert.deepEqual(await store.read(),{local:seat,indexed:seat});
});
for(const prior of [['A','A'],['B','B'],['A',undefined],[null,'B']])test(`refuses existing or mismatched self marker ${JSON.stringify(prior)}`,async()=>{
  const f=fixtures(...prior); const store=markerStore(f.local,f.indexed);
  await assert.rejects(store.write('B'),/NOT_EMPTY/);
  assert.ok(!f.calls.some(x=>['setItem','add'].includes(x[0])));
});
test('invalid seat does not access either store',async()=>{
  const f=fixtures(); await assert.rejects(markerStore(f.local,f.indexed).write('C'),/INVALID_SEAT/);
  assert.deepEqual(f.calls,[]);
});
test('unexpected synthetic value is not exposed or overwritten',async()=>{
  const f=fixtures('arbitrary',undefined);
  await assert.rejects(markerStore(f.local,f.indexed).read(),/UNAVAILABLE/);
  assert.equal(f.calls.length,1);
});
test('storage exception fails closed without indexed access',async()=>{
  const f=fixtures(); f.local.getItem=()=>{throw Error('blocked');};
  await assert.rejects(markerStore(f.local,f.indexed).write('A'));
  assert.deepEqual(f.calls,[]);
});
test('classifies empty, matching, mismatched, unavailable',()=>{
  assert.equal(classify({local:null,indexed:null}),'empty');
  assert.equal(classify({local:'A',indexed:'A'}),'A');
  assert.equal(classify({local:'B',indexed:'B'}),'B');
  for(const state of [{local:'A',indexed:'B'},{local:null,indexed:'A'}])assert.equal(classify(state),'mismatch');
  for(const state of [null,{}, {local:'other',indexed:'A'}])assert.equal(classify(state),'unknown');
});
test('render is inert until an explicit button event',()=>{
  const doc={defaultView:{addEventListener(){}},createElement(){return{setAttribute(){},addEventListener(){}};}};
  let reads=0,writes=0;
  mount({ownerDocument:doc,replaceChildren(){}},{read(){reads++;},write(){writes++;}});
  assert.equal(reads,0); assert.equal(writes,0);
});
test('static bundle has no SDK or backend and denies connections',async()=>{
  const html=await readFile(new URL('../floating-garden/profile-probe/index.html',import.meta.url),'utf8');
  const js=(await Promise.all(['entry.mjs','probe.mjs'].map(p=>readFile(new URL('../floating-garden/profile-probe/'+p,import.meta.url),'utf8')))).join('\n');
  assert.match(html,/connect-src 'none'/);
  assert.match(html,/form-action 'none'/);
  assert.doesNotMatch(js,/fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|signInAnonymously|https?:\/\//);
  assert.doesNotMatch(js,/\.clear\s*\(|\.removeItem\s*\(|deleteDatabase|document\.cookie|localStorage\.key/);
});

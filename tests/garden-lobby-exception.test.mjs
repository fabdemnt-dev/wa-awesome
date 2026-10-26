import test from 'node:test';
import assert from 'node:assert/strict';
import {createOnlineController} from '../floating-garden/limited-trial/online/controller.js';
for (const withLocks of [false,true]) test(`resume observer exception must not strand busy (locks=${withLocks})`,async()=>{
 let calls=0, writes=0, injected=false;
 const c=createOnlineController({locks:withLocks?{request:async(n,o,fn)=>{await Promise.resolve();return fn({name:n});}}:null,storage:{getItem:()=>null,setItem:()=>writes++},ensureUser:async()=>{calls++;return {uid:'fake'};},api:{}});
 c.observe(()=>{if(c.getState().connection==='syncing'&&!injected){injected=true;throw Error('synthetic render failure');}});
 let rejected=false;try{await c.resume();}catch{rejected=true;}
 assert.equal(injected,true);assert.equal(c.getState().busy,false);assert.equal(writes,0);assert.equal(calls,0);assert.equal(rejected,false);
 c.dispose();
});
test('render failure preserves exact previously pending request without replay',async()=>{
 const raw=JSON.stringify({version:1,uid:'fake',roomId:null,pending:{kind:'create',uid:'fake',payload:{requestId:'original-id',displayName:'fake'}}});let calls=0,writes=0,thrown=false;
 const c=createOnlineController({locks:null,storage:{getItem:key=>key.endsWith('recovery-v1')?raw:null,setItem:()=>writes++},ensureUser:async()=>{calls++;return {uid:'fake'};},api:{create:async()=>{calls++;}}});
 c.observe(()=>{if(!thrown){thrown=true;throw Error('render');}});
 assert.equal(await c.resume(),false);assert.equal(c.getState().busy,false);assert.equal(calls,0);assert.equal(writes,0);
 c.dispose();
});
test('persistent observer exception still clears internal busy without authentication',async()=>{
 let calls=0;const c=createOnlineController({locks:null,storage:{getItem:()=>null},ensureUser:async()=>{calls++;return {uid:'fake'};},api:{}});
 c.observe(()=>{throw Error('persistent-render');});assert.equal(await c.resume(),false);assert.equal(c.getDiagnostics().render,'failed');assert.equal(c.getState().busy,false);assert.equal(calls,0);c.dispose();
});

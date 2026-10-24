import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createOnlineController,ONLINE_SAVE_KEY,ONLINE_PARKED_KEY} from '../floating-garden/limited-trial/online/controller.js';
import {createMatch} from '../floating-garden/match-engine.js';
function lockManager(){let held=false;return {async request(_name,_options,fn){if(held)return fn(null);held=true;try{return await fn({name:_name});}finally{held=false;}}};}
const next=()=>new Promise(r=>setImmediate(r));
function fixture({locks=lockManager(),initial,storage:shared}={}){
 const match=createMatch({playerCount:2,humanSeat:-1,seed:'room-switch',legacy:true});match.players.forEach(p=>p.isHuman=true);
 const room={id:'old-room',status:'playing',hostSeat:0,playerCount:2,gameId:'game',revision:13,rulesVersion:match.version,expiresAtMillis:1900000000000,players:match.players.map(p=>({seat:p.seat,name:p.name})),match,scores:[]};
 const record=initial??JSON.stringify({version:1,uid:'same-user',roomId:room.id,pending:null});
 const map=shared??new Map([[ONLINE_SAVE_KEY,record]]);let fail=false,user='same-user',delay=null;
 const writes=[],calls=[],listeners=[];
 const storage={getItem:k=>map.get(k)??null,setItem(k,v){if(fail)throw Error('quota');map.set(k,v);writes.push(v);}};
 const c=createOnlineController({locks,storage,ensureUser:async()=>{if(delay)await delay;return {uid:user};},subscribe:(id,fn)=>{listeners.push(fn);return()=>{};},api:{getSnapshot:async({roomId})=>({room:{...structuredClone(room),id:roomId},self:{seat:1,isHost:false}}),join:async p=>{calls.push(p);return {roomId:'new-room',seat:1};},submit:async p=>{calls.push(p);throw Object.assign(Error('lost'),{code:'unavailable'});}},requestId:()=>crypto.randomUUID()});
 return {c,room,map,record,writes,calls,listeners,locks,setUser:v=>user=v,fail:()=>fail=true,delay:p=>delay=p};
}
test('participant explicitly parks, cancels, restores same UID and keeps both recovery records',async()=>{
 const f=fixture();await f.c.resume();assert.equal(f.c.getState().self.seat,1);assert.equal(f.c.create('x') instanceof Promise,true);
 assert.equal(f.c.requestSwitch(),true);f.c.cancelReturn();assert.equal(await f.c.confirmSwitch(),false);assert.equal(f.map.get(ONLINE_SAVE_KEY),f.record);
 f.c.requestSwitch();const a=f.c.confirmSwitch(),b=f.c.confirmSwitch();assert.equal(await a,true);assert.equal(await b,false);
 const parked=JSON.parse(f.map.get(ONLINE_SAVE_KEY));assert.deepEqual(JSON.parse(parked.parked[0]),JSON.parse(f.record));assert.equal(parked.uid,'same-user');assert.equal(parked.roomId,null);assert.equal(f.calls.length,0);
 assert.equal(await f.c.join('code','name'),true);assert.equal(f.c.getState().room.id,'new-room');
 assert.equal(f.c.requestSwitch('old-room'),true);assert.equal(await f.c.confirmSwitch(),true);assert.equal(f.c.getState().room.id,'old-room');assert.equal(f.c.getState().uid,'same-user');assert.equal(f.c.getState().parkedRooms[0].roomId,'new-room');
 f.listeners[0]({room:{...f.room,revision:99}});assert.equal(f.c.getState().room.revision,13);f.c.dispose();
});
test('reload lists parked recovery and rejects changed UID without overwriting',async()=>{
 const f=fixture();await f.c.resume();f.c.requestSwitch();await f.c.confirmSwitch();const raw=f.map.get(ONLINE_SAVE_KEY);
 const g=fixture({initial:raw});g.setUser('different-user');assert.equal(await g.c.resume(),false);assert.equal(g.c.getState().connection,'identity-mismatch');assert.equal(g.c.requestSwitch('old-room'),false);assert.equal(g.map.get(ONLINE_SAVE_KEY),raw);
 const h=fixture({initial:raw});await h.c.resume();assert.equal(h.c.requestSwitch('old-room'),true);await h.c.confirmSwitch();assert.equal(h.c.getState().self.seat,1);
});
test('failed save leaves the original durable recovery and current room untouched',async()=>{
 const f=fixture();await f.c.resume();f.c.requestSwitch();f.fail();assert.equal(await f.c.confirmSwitch(),false);assert.equal(f.map.get(ONLINE_SAVE_KEY),f.record);assert.equal(f.c.getState().room.id,'old-room');assert.ok(f.c.getState().storageIssue);assert.equal(f.calls.length,0);
});
test('pending unknown response cannot be parked or replaced',async()=>{
 const f=fixture({initial:JSON.stringify({version:1,uid:'same-user',roomId:'old-room',pending:{kind:'submit',uid:'same-user',payload:{roomId:'old-room',requestId:'same-id-0001'}}})});
 await f.c.resume();assert.equal(f.c.getState().connection,'uncertain');const raw=f.map.get(ONLINE_SAVE_KEY);assert.equal(f.c.requestSwitch(),false);assert.equal(await f.c.join('x','y'),false);assert.equal(f.map.get(ONLINE_SAVE_KEY),raw);assert.equal(f.calls.length,1);
});
test('auth yield, hidden/suspend and stale callback cancel switch without writes',async()=>{
 const f=fixture();await f.c.resume();let release;f.delay(new Promise(r=>release=r));f.c.requestSwitch();const p=f.c.confirmSwitch();await next();f.c.suspend();release();assert.equal(await p,false);assert.equal(f.map.get(ONLINE_SAVE_KEY),f.record);assert.equal(f.calls.length,0);
});
test('shared tab lock rejects concurrency; later stale tab cannot overwrite recovery',async()=>{
 const f=fixture();await f.c.resume();const g=fixture({locks:f.locks,storage:f.map});await g.c.resume();let release;f.delay(new Promise(r=>release=r));f.c.requestSwitch();g.c.requestSwitch();const p=f.c.confirmSwitch();await next();assert.equal(await g.c.confirmSwitch(),false);release();assert.equal(await p,true);const raw=f.map.get(ONLINE_SAVE_KEY);assert.equal(await g.c.resume(),false);assert.equal(g.c.getState().connection,'conflict');assert.equal(f.map.get(ONLINE_SAVE_KEY),raw);
});
test('missing locks, malformed history, changed or removed storage fail closed',async()=>{
 const f=fixture({locks:null});await f.c.resume();assert.equal(f.c.requestSwitch(),false);
 for(const raw of ['null',JSON.stringify({version:1,uid:'same-user',roomId:null,pending:null,parked:['{}']})]){const g=fixture({initial:raw});assert.equal(await g.c.resume(),false);assert.equal(g.c.requestSwitch(),false);}
 const h=fixture();await h.c.resume();h.c.requestSwitch();h.map.delete(ONLINE_SAVE_KEY);assert.equal(await h.c.confirmSwitch(),false);assert.equal(h.writes.length,0);
});
test('joining the same retained room deduplicates recovery and reload succeeds',async()=>{
 const f=fixture();await f.c.resume();f.c.requestSwitch();await f.c.confirmSwitch();await f.c.join('code','name'); // new-room
 f.c.requestSwitch();await f.c.confirmSwitch();await f.c.join('same-code','name'); // same new-room
 const raw=f.map.get(ONLINE_SAVE_KEY),d=JSON.parse(raw);assert.equal(d.roomId,'new-room');assert.equal(d.parked.length,1);assert.equal(JSON.parse(d.parked[0]).roomId,'old-room');
 const g=fixture({initial:raw});assert.equal(await g.c.resume(),true);assert.equal(g.c.getState().room.id,'new-room');assert.equal(g.c.getState().storageIssue,null);
});
test('server-confirmed terminal return also acquires the shared recovery lock',async()=>{
 const f=fixture();f.room.status='finished';await f.c.resume();assert.equal(f.c.requestReturn(),true);
 let release;const held=f.locks.request('test',{},async()=>{await new Promise(r=>release=r);});await next();
 assert.equal(await f.c.returnToEntry(),false);assert.equal(f.map.get(ONLINE_SAVE_KEY),f.record);release();await held;
});
test('storage event during switch authentication cancels before write',async()=>{
 const f=fixture();await f.c.resume();let release;f.delay(new Promise(r=>release=r));f.c.requestSwitch();const task=f.c.confirmSwitch();await next();f.c.storageChanged();release();assert.equal(await task,false);assert.equal(f.map.get(ONLINE_SAVE_KEY),f.record);assert.equal(f.calls.length,0);
});
test('in-flight resume interrupted by pagehide stops until explicit recovery',async()=>{
 const f=fixture();await f.c.resume();let release;f.delay(new Promise(r=>release=r));const task=f.c.resume();await next();f.c.suspend();const visible=f.c.resume();release();await task;await visible;
 assert.equal(f.c.getState().connection,'syncing');assert.equal(f.c.getState().canSwitch,false);f.delay(null);await f.c.resume();assert.equal(f.c.getState().connection,'ready');
});
test('terminal return cancelled while lock acquisition yields cannot erase recovery',async()=>{
 let blocked=false,release;
 const locks={async request(name,options,fn){if(blocked)await new Promise(r=>release=r);return fn({name});}};
 const f=fixture({locks});f.room.status='finished';await f.c.resume();f.c.requestReturn();blocked=true;
 const task=f.c.returnToEntry();await next();f.c.cancelReturn();release();assert.equal(await task,false);assert.equal(f.map.get(ONLINE_SAVE_KEY),f.record);assert.equal(f.c.getState().room.id,'old-room');
});
test('first park retains the original recovery bytes including whitespace',async()=>{
 const raw=JSON.stringify({version:1,uid:'same-user',roomId:'old-room',pending:null},null,2)+'\n';const f=fixture({initial:raw});await f.c.resume();f.c.requestSwitch();await f.c.confirmSwitch();assert.equal(JSON.parse(f.map.get(ONLINE_SAVE_KEY)).parked[0],raw);
});
test('retained-only storage restores same UID after legacy active-pointer overwrite',async()=>{
 const f=fixture();await f.c.resume();f.c.requestSwitch();await f.c.confirmSwitch();
 f.map.set(ONLINE_SAVE_KEY,JSON.stringify({version:1,uid:'same-user',roomId:null,inviteCode:null,pending:null}));
 const g=fixture({storage:f.map});await g.c.resume();assert.equal(g.c.getState().parkedRooms[0].roomId,'old-room');g.c.requestSwitch('old-room');assert.equal(await g.c.confirmSwitch(),true);assert.equal(g.c.getState().room.id,'old-room');
});
test('archive-first partial write failure preserves both recovery paths after reload',async()=>{
 const f=fixture();await f.c.resume();let rejectActive=false;
 const storage={getItem:k=>f.map.get(k)??null,setItem(k,v){if(rejectActive&&k===ONLINE_SAVE_KEY)throw Error('quota-active');f.map.set(k,v);}};
 const c=createOnlineController({storage,locks:f.locks,ensureUser:async()=>({uid:'same-user'}),api:{getSnapshot:async()=>({room:f.room,self:{seat:1,isHost:false}})}});
 await c.resume();c.requestSwitch();rejectActive=true;assert.equal(await c.confirmSwitch(),false);assert.equal(f.map.get(ONLINE_SAVE_KEY),f.record);
 assert.equal(JSON.parse(f.map.get(ONLINE_PARKED_KEY)).rooms[0],f.record);
 const g=fixture({storage:f.map});await g.c.resume();assert.equal(g.c.getState().room.id,'old-room');assert.equal(g.c.getState().storageIssue,null);
});
test('v0 inline history migrates before pointer replacement and survives legacy overwrite',async()=>{
 const old=JSON.stringify({version:1,uid:'same-user',roomId:'archived-v0',pending:null});
 const f=fixture({initial:JSON.stringify({version:1,uid:'same-user',roomId:'old-room',pending:null,parked:[old]})});await f.c.resume();f.c.requestSwitch();assert.equal(await f.c.confirmSwitch(),true);
 f.map.set(ONLINE_SAVE_KEY,JSON.stringify({version:1,uid:'same-user',roomId:null,pending:null}));
 const g=fixture({storage:f.map});await g.c.resume();assert.deepEqual(g.c.getState().parkedRooms.map(r=>r.roomId).sort(),['archived-v0','old-room']);
});
test('retained archive wrong UID, corruption, or concurrent edit fails closed',async()=>{
 for(const raw of ['null',JSON.stringify({version:1,uid:'other-user',rooms:[]})]){const f=fixture();f.map.set(ONLINE_PARKED_KEY,raw);const g=fixture({storage:f.map});assert.equal(await g.c.resume(),false);assert.equal(g.c.getState().canSwitch,false);assert.equal(f.map.get(ONLINE_PARKED_KEY),raw);}
 const f=fixture();await f.c.resume();f.c.requestSwitch();f.map.set(ONLINE_PARKED_KEY,JSON.stringify({version:1,uid:'same-user',rooms:[]}));assert.equal(await f.c.confirmSwitch(),false);assert.equal(f.map.get(ONLINE_SAVE_KEY),f.record);
});
test('v0 inline archive is retained on same-UID resume before legacy terminal overwrite',async()=>{
 const old=JSON.stringify({version:1,uid:'same-user',roomId:'archived-v0',pending:null});
 const f=fixture({initial:JSON.stringify({version:1,uid:'same-user',roomId:'old-room',pending:null,parked:[old]})});f.room.status='finished';await f.c.resume();assert.equal(JSON.parse(f.map.get(ONLINE_PARKED_KEY)).rooms[0],old);
 f.c.requestReturn();await f.c.returnToEntry();f.map.set(ONLINE_SAVE_KEY,JSON.stringify({version:1,uid:'same-user',roomId:null,pending:null}));
 const g=fixture({storage:f.map});await g.c.resume();assert.equal(g.c.getState().parkedRooms[0].roomId,'archived-v0');
});

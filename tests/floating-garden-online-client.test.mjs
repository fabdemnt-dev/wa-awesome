import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createOnlineController, ONLINE_SAVE_KEY } from '../lab/floating-garden/online/controller.js';
import { createTrialStorage, trialRecoveryKey } from '../lab/floating-garden/trial/bootstrap.js';
import { renderOnline } from '../lab/floating-garden/online/view.js';
import { localTestAllowed, EMULATOR_CONFIG, EMULATOR_PORTS } from '../lab/floating-garden/online/config.js';
import { createMatch, applyMatchAction, legalActions, getDecision, publicMatch, rankMatch, MATCH_VERSION } from '../lab/floating-garden/match-engine.js';
const clone = (value) => structuredClone(value);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const error = (code, reason) => Object.assign(new Error(code), { code: `functions/${code}`, details: { reason } });
function memoryStorage(initial = null) { const map = new Map(initial ? [[ONLINE_SAVE_KEY, initial]] : []); return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), map }; }
function server() {
  let room = null, match = null, members = new Map(), receipts = new Map();
  const listeners = new Set(), listenersByUid = new Map(), subscriptions = [], calls = [];
  const publish = () => { for (const fn of listeners) fn({ room: clone(room), fromCache: false }); };
  const publicState = () => { const value = publicMatch(match); for (const p of value.players) { delete p.isHuman; delete p.tileIds; } return value; };
  const snapshot = (uid) => { if (!room) throw error('not-found'); if (!members.has(uid)) throw error('permission-denied'); return { room: clone(room), self: { seat: members.get(uid), isHost: members.get(uid) === 0 } }; };
  const update = () => { room.match = publicState(); room.status = match.phase === 'finished' ? 'finished' : 'playing'; room.scores = room.status === 'finished' ? rankMatch(match) : []; room.revision += 1; publish(); };
  function client(uid, options = {}) {
    const storage = options.storage || memoryStorage(); let counter = 0;
    const api = Object.fromEntries(['create','join','start','submit'].map((kind) => [kind, async (payload) => {
      calls.push({ uid, kind, payload: clone(payload) });
      const key = `${uid}:${payload.requestId}`;
      if (receipts.has(key)) return clone(receipts.get(key));
      let result;
      if (kind === 'create') {
        room = { id: 'room-1', status: 'waiting', hostSeat: 0, playerCount: 2, gameId: null, revision: 0, rulesVersion: MATCH_VERSION, expiresAtMillis: Date.now() + 86400000, players: [{seat:0,name:payload.displayName}], match: null, scores: [] }; members.set(uid, 0); result = { roomId: room.id, seat: 0, inviteCode: 'GARDEN-test' };
      } else if (kind === 'join') { members.set(uid, 1); room.players.push({ seat:1,name:payload.displayName }); room.revision += 1; result = {roomId: room.id,seat:1}; publish(); }
      else if (kind === 'start') {
        if (room.revision !== payload.expectedRevision) throw error('failed-precondition','stale-revision');
        match = createMatch({playerCount:2,seed:'online-client',humanSeat:-1}); match.players.forEach((p,i) => p.name = room.players[i].name); room.gameId = 'game-1'; update(); result = snapshot(uid);
      } else {
        assert.equal(payload.rulesVersion, MATCH_VERSION); assert.equal(payload.gameId, room.gameId);
        if (match.revision !== payload.expectedRevision) throw error('failed-precondition','stale-revision');
        if (getDecision(match).seat !== members.get(uid)) throw error('permission-denied');
        match = applyMatchAction(match, {...payload.command,seat:members.get(uid),revision:payload.expectedRevision}); update(); result = snapshot(uid);
      }
      receipts.set(key, clone(result)); return result;
    }]));
    api.getSnapshot = async () => { calls.push({uid,kind:'getSnapshot'}); return snapshot(uid); };
    const controller = createOnlineController({api,ensureUser:async()=>({uid}),subscribe:(roomId,next,fail) => {
      const watch = { uid, roomId, next, fail, stops: 0 }; subscriptions.push(watch);
      listeners.add(next); listenersByUid.set(uid,next);
      return () => { watch.stops += 1; listeners.delete(next); };
    },storage,requestId:()=>`${uid}-request-${++counter}`,isOnline:options.isOnline || (()=>true),...options});
    return { controller, storage, api };
  }
  return { client, calls, snapshot, publish, update, listeners, listenersByUid, subscriptions, get room(){return room;}, get match(){return match;}, set match(value){match=value; update();} };
}
async function playing() { const service = server(), a = service.client('a'), b = service.client('b'); await a.controller.resume(); await a.controller.create('Host'); await b.controller.resume(); await b.controller.join('GARDEN-test','Guest'); await a.controller.start(); return {service,a,b}; }

 test('create/join/start use explicit seats, no private state, and durable original requests', async () => {
  const {service,a,b}=await playing();
  assert.equal(a.controller.getState().self.seat,0); assert.equal(b.controller.getState().self.seat,1);
  assert.equal(b.controller.getState().room.match.players[0].isHuman,undefined);
  assert.equal(a.controller.getState().canConfirm,true);
  const html=renderOnline(b.controller.getState()); assert.match(html,/あなたの庭 <small>P2 Guest/); assert.match(html,/data-seat="0"/); assert.doesNotMatch(html,/CPU|残数アシスト|deckCursor/);
  assert.match(html,/<p>次の選択を待っています<\/p>/); assert.doesNotMatch(html,/庭づくりが完了しました/);
  assert.equal(a.storage.map.has('floating-garden-match-save-v1'),false);
  assert.deepEqual(Object.keys(service.calls.find(call=>call.kind==='start').payload).sort(),['expectedRevision','requestId','roomId']);
 });
 test('ordinary successes and definitive command refusals retain the same healthy room watches', async () => {
  const {service,a,b}=await playing(),watches=[...service.subscriptions];
  assert.equal(watches.length,2,'start retains the lobby watch');
  const snapshots=service.calls.filter(call=>call.kind==='getSnapshot').length;
  await a.controller.submit('draw');await a.controller.submit('self');await b.controller.submit('pass-invite');
  const original=a.api.submit;
  for(const code of ['failed-precondition','invalid-argument']) {
    a.api.submit=async()=>{throw error(code);};
    assert.equal(await a.controller.submit('place',{index:0,rotation:0}),false);
    assert.equal(a.controller.getState().pending,null);assert.equal(a.controller.getState().canConfirm,true);
  }
  a.api.submit=original;
  assert.equal(await a.controller.submit('place',{index:0,rotation:0}),true);
  assert.equal(service.calls.filter(call=>call.kind==='getSnapshot').length,snapshots+6,'every outcome still refreshes authoritative data');
  assert.deepEqual(service.subscriptions,watches);assert.ok(watches.every(watch=>watch.stops===0));
  assert.deepEqual(a.controller.getState().room,b.controller.getState().room);
  a.controller.dispose();b.controller.dispose();assert.ok(watches.every(watch=>watch.stops===1));
 });
 test('newer live progress overtaking an older refresh keeps the authoritative state ready without restarting', async () => {
  const {service,a,b}=await playing();await a.controller.submit('draw');
  const fetching=deferred(),release=deferred(),original=a.api.getSnapshot,snapshots=service.calls.filter(call=>call.kind==='getSnapshot').length;
  a.api.getSnapshot=async payload=>{const captured=await original(payload);fetching.resolve();await release.promise;return captured;};
  const sending=a.controller.submit('self');await fetching.promise;await b.controller.submit('pass-invite');
  const newer=a.controller.getState().room;assert.equal(newer.match.revision,3);assert.equal(a.controller.getState().connection,'ready');
  release.resolve();assert.equal(await sending,true);assert.deepEqual(a.controller.getState().room,newer);assert.equal(a.controller.getState().canConfirm,true);
  assert.equal(service.subscriptions.length,2);assert.ok(service.subscriptions.every(watch=>watch.stops===0));
  assert.equal(service.calls.filter(call=>call.kind==='getSnapshot').length,snapshots+2);
  a.controller.dispose();b.controller.dispose();
 });
 test('superseded refresh never accepts malformed, mismatched, or inconsistent replies over newer live data', async () => {
  const cases={
    'negative room':snapshot=>{snapshot.room.revision=-1;},
    'negative match':snapshot=>{snapshot.room.match.revision=-1;},
    'missing match':snapshot=>{snapshot.room.match=null;},
    'wrong room':snapshot=>{snapshot.room.id='another-room';},
    'wrong game':snapshot=>{snapshot.room.gameId='another-game';},
    'wrong seat':snapshot=>{snapshot.self.seat=1;},
    'wrong rules':snapshot=>{snapshot.room.rulesVersion='another-version';},
    'wrong match version':snapshot=>{snapshot.room.match.version='another-version';},
    'invalid players':snapshot=>{snapshot.room.players={};},
    'invalid revision':snapshot=>{snapshot.room.match.revision=NaN;},
    'newer match in older room':snapshot=>{snapshot.room.match.revision+=100;},
    'newer room with older match':snapshot=>{snapshot.room.revision+=100;},
  };
  for(const [name,change] of Object.entries(cases)) {
    const {service,a,b}=await playing();await a.controller.submit('draw');
    const fetching=deferred(),release=deferred(),original=a.api.getSnapshot;
    a.api.getSnapshot=async payload=>{const captured=await original(payload);change(captured);fetching.resolve();await release.promise;return captured;};
    const sending=a.controller.submit('self');await fetching.promise;await b.controller.submit('pass-invite');const newer=a.controller.getState().room;
    release.resolve();await sending;assert.deepEqual(a.controller.getState().room,newer,name);assert.equal(a.controller.getState().connection,'syncing',name);assert.equal(a.controller.getState().canConfirm,false,name);
    assert.equal(service.subscriptions.length,2);a.controller.dispose();b.controller.dispose();
  }
 });
 test('an older refresh cannot restore readiness from cache or stronger blockers', async () => {
  for(const mode of ['cache','offline','conflict']) {
    const {service,a,b}=await playing();await a.controller.submit('draw');
    const fetching=deferred(),release=deferred(),original=a.api.getSnapshot;
    a.api.getSnapshot=async payload=>{const captured=await original(payload);fetching.resolve();await release.promise;return captured;};
    const sending=a.controller.submit('self');await fetching.promise;await b.controller.submit('pass-invite');
    if(mode==='cache')service.listenersByUid.get('a')({room:clone(service.room),fromCache:true});
    if(mode==='offline')a.controller.offline();
    if(mode==='conflict')a.controller.storageChanged();
    assert.equal(a.controller.getState().connection,mode);
    release.resolve();await sending;assert.equal(a.controller.getState().connection,'syncing');assert.equal(a.controller.getState().canConfirm,false);
    assert.equal(service.subscriptions.length,2);a.controller.dispose();b.controller.dispose();
  }
 });
 test('a failed watch is retired and its callbacks cannot affect a replacement in the same generation', async () => {
  const {service,a,b}=await playing(),old=service.subscriptions.find(watch=>watch.uid==='a');
  const fetching=deferred(),release=deferred(),original=a.api.getSnapshot;
  a.api.getSnapshot=async payload=>{fetching.resolve();await release.promise;return original(payload);};
  const sending=a.controller.submit('draw');await fetching.promise;
  old.fail(error('unavailable'));assert.equal(old.stops,1);assert.equal(a.controller.getState().connection,'error');
  release.resolve();assert.equal(await sending,true);
  const replacement=service.subscriptions.at(-1);assert.notEqual(replacement,old);assert.equal(replacement.uid,'a');
  assert.equal(service.subscriptions.length,3);assert.equal(a.controller.getState().canConfirm,true);
  const before=a.controller.getState(),newer=clone(service.room);newer.revision+=100;newer.match.revision+=100;
  old.next({room:newer,fromCache:false});old.next({room:null});old.fail(error('permission-denied'));
  assert.deepEqual(a.controller.getState(),before);assert.equal(replacement.stops,0);
  a.controller.dispose();a.controller.dispose();b.controller.dispose();assert.equal(old.stops,1);assert.equal(replacement.stops,1);
 });
 test('resume, suspend, and dispose replace watches once and ignore retired next and error callbacks', async () => {
  const {service,a,b}=await playing(),first=service.subscriptions.find(watch=>watch.uid==='a');
  await a.controller.resume();const second=service.subscriptions.at(-1);
  assert.equal(first.stops,1);assert.equal(second.stops,0);assert.notEqual(first,second);
  const resumed=a.controller.getState();first.next({room:null});first.fail(error('unavailable'));assert.deepEqual(a.controller.getState(),resumed);
  a.controller.suspend();a.controller.suspend();assert.equal(second.stops,1);
  const suspended=a.controller.getState();second.next({room:clone(service.room)});second.fail(error('unavailable'));assert.deepEqual(a.controller.getState(),suspended);
  await a.controller.resume();const third=service.subscriptions.at(-1);assert.equal(service.subscriptions.length,4);
  a.controller.dispose();b.controller.dispose();const disposed=a.controller.getState();third.next({room:null});third.fail(error('unavailable'));
  assert.deepEqual(a.controller.getState(),disposed);assert.ok(service.subscriptions.every(watch=>watch.stops===1));
 });
 test('interrupted definitive-error refresh cannot reinstall an obsolete watcher or overwrite suspension', async () => {
  for(const rejected of [false,true]) {
    const {service,a,b}=await playing(),old=service.subscriptions.find(watch=>watch.uid==='a'),fetching=deferred(),release=deferred(),original=a.api.getSnapshot;
    let first=true;
    a.api.submit=async()=>{throw error('failed-precondition');};
    a.api.getSnapshot=async payload=>{if(first){first=false;fetching.resolve();await release.promise;if(rejected)throw error('unavailable');}return original(payload);};
    const sending=a.controller.submit('draw');await fetching.promise;a.controller.suspend();
    const suspended=a.controller.getState();release.resolve();await sending;
    assert.deepEqual(a.controller.getState(),suspended);assert.equal(service.subscriptions.length,2);assert.equal(old.stops,1);
    await a.controller.resume();assert.equal(service.subscriptions.length,3);assert.equal(a.controller.getState().canConfirm,true);
    a.controller.dispose();b.controller.dispose();assert.ok(service.subscriptions.every(watch=>watch.stops===1));
  }
 });
 test('synchronous subscribe failures stay visible, reject late callbacks, and allow a fresh watch', async () => {
  for(const mode of ['throw','error']) {
    const service=server(),watches=[];
    const a=service.client('a',{subscribe(roomId,next,fail){
      const watch={roomId,next,fail,stops:0};watches.push(watch);
      if(watches.length===1){if(mode==='throw')throw error('unavailable');fail(error('unavailable'));}
      return()=>{watch.stops+=1;next({room:null});fail(error('permission-denied'));};
    }});
    await a.controller.resume();await a.controller.create('Host');
    const failed=a.controller.getState();assert.equal(failed.connection,'error',mode);assert.equal(failed.error,true);assert.ok(failed.notice);assert.equal(failed.pending,null);
    const first=watches[0];assert.equal(first.stops,mode==='throw'?0:1);
    first.next({room:{...service.room,revision:100}});first.fail(error('permission-denied'));assert.deepEqual(a.controller.getState(),failed);
    await a.controller.resume();assert.equal(watches.length,2);assert.equal(a.controller.getState().canConfirm,true);
    const resumed=a.controller.getState();first.next({room:null});first.fail(error('unavailable'));assert.deepEqual(a.controller.getState(),resumed);
    a.controller.dispose();a.controller.dispose();assert.equal(watches[1].stops,1);assert.equal(first.stops,mode==='throw'?0:1);
  }
 });
 test('an initially missing cached room keeps its watch for the following server document', async () => {
  const service=server();let next,stops=0,subscriptions=0;
  const a=service.client('a',{subscribe(_roomId,onNext){subscriptions+=1;next=onNext;next({room:null,fromCache:true});return()=>{stops+=1;};}});
  await a.controller.resume();await a.controller.create('Host');assert.equal(a.controller.getState().connection,'error');assert.equal(stops,0);
  next({room:clone(service.room),fromCache:false});assert.equal(a.controller.getState().canConfirm,true);assert.equal(subscriptions,1);
  a.controller.dispose();assert.equal(stops,1);
 });
 test('synchronous next callback reentrancy cleans the returned subscription after suspend or dispose', async () => {
  for(const mode of ['suspend','dispose']) {
    const service=server(),watches=[];let insideSubscribe=false,interrupted=false;
    const a=service.client('a',{subscribe(roomId,next,fail){
      const watch={roomId,next,fail,stops:0};watches.push(watch);
      insideSubscribe=true;try{next({room:clone(service.room),fromCache:false});}finally{insideSubscribe=false;}
      return()=>{watch.stops+=1;};
    }});
    a.controller.observe(()=>{if(insideSubscribe&&!interrupted){interrupted=true;a.controller[mode]();}});
    await a.controller.resume();await a.controller.create('Host');assert.equal(watches.length,1);assert.equal(watches[0].stops,1,mode);
    const stopped=a.controller.getState();watches[0].next({room:null});watches[0].fail(error('unavailable'));assert.deepEqual(a.controller.getState(),stopped);
    await a.controller.resume();assert.equal(watches.length,mode==='dispose'?1:2);
    if(mode==='suspend')assert.equal(a.controller.getState().canConfirm,true);
    a.controller.dispose();assert.ok(watches.every(watch=>watch.stops===1));
  }
 });
 test('returning from a terminal room retires its watcher before a different room is created', async () => {
  const service=server(),a=service.client('a');await a.controller.resume();await a.controller.create('Host');
  const old=service.subscriptions[0],finished={...service.room,status:'finished',revision:1};old.next({room:finished,fromCache:false});
  assert.equal(a.controller.requestReturn(),true);assert.equal(a.controller.returnToEntry(),true);assert.equal(old.stops,1);
  const original=a.api.create;a.api.create=async payload=>{const result=await original(payload);service.room.id='room-2';return {...result,roomId:'room-2'};};
  await a.controller.create('Host');assert.equal(service.subscriptions.length,2);assert.equal(service.subscriptions[1].roomId,'room-2');
  const current=a.controller.getState();old.next({room:finished});old.fail(error('unavailable'));assert.deepEqual(a.controller.getState(),current);
  a.controller.dispose();assert.ok(service.subscriptions.every(watch=>watch.stops===1));
 });
async function lobby(options = {}) {
  const service = server(), a = service.client('a', options);
  await a.controller.resume(); await a.controller.create('Host');
  return { service, a };
}
 test('solitary host explicitly returns locally with the same UID and without changing the server room', async () => {
  let authentications=0;
  const {service,a}=await lobby({ensureUser:async()=>{authentications++;return {uid:'a'};}});
  const before=clone(service.room),calls=service.calls.length,authCount=authentications,watch=service.subscriptions[0];
  assert.equal(a.controller.getState().canReturnToEntry,true);
  assert.match(renderOnline(a.controller.getState()),/入口へ戻って別の部屋に参加/);
  assert.equal(await a.controller.returnToEntry(),false);
  assert.equal(a.controller.requestReturn(),true);
  const html=renderOnline(a.controller.getState());
  assert.match(html,/このブラウザーの復帰先だけを解除/);assert.match(html,/匿名認証（UID）は変わりません/);
  assert.match(html,/サーバー上の部屋・参加情報・招待コードは変更しません/);
  assert.equal(await a.controller.returnToEntry(),true);
  assert.deepEqual(JSON.parse(a.storage.getItem(ONLINE_SAVE_KEY)),{version:1,uid:'a',roomId:null,inviteCode:null,pending:null});
  assert.equal(a.controller.getState().uid,'a');assert.equal(a.controller.getState().room,null);assert.equal(a.controller.getState().self,null);
  assert.equal(a.controller.getState().canConfirm,true);assert.equal(a.controller.getState().canReturnToEntry,false);
  assert.equal(authentications,authCount+1,'confirmation rechecks the existing identity');
  assert.equal(service.calls.length,calls,'return calls no room API, including getSnapshot');assert.deepEqual(service.room,before);
  assert.equal(watch.stops,1);assert.equal(await a.controller.returnToEntry(),false);
  const cleared=a.controller.getState();watch.next({room:before});watch.fail(error('unavailable'));assert.deepEqual(a.controller.getState(),cleared);
  const reloaded=service.client('a',{storage:a.storage});await reloaded.controller.resume();
  assert.equal(reloaded.controller.getState().uid,'a');assert.equal(reloaded.controller.getState().room,null);assert.equal(service.calls.length,calls);
  a.controller.dispose();reloaded.controller.dispose();
 });
 test('lobby return writes only the existing trial-namespaced recovery key', async () => {
  const raw=memoryStorage('untouched-emulator-recovery'),project='isolated-garden-trial';
  raw.map.set('firebase:authUser:existing-app','unchanged-auth');raw.map.set('floating-garden-cpu-match','unchanged-cpu');
  raw.map.set(trialRecoveryKey('other-trial'),'unchanged-other-trial');
  const wrapped=createTrialStorage(raw,project),{service,a}=await lobby({storage:wrapped});
  const others=[...raw.map].filter(([key])=>key!==trialRecoveryKey(project)),calls=service.calls.length;
  assert.equal(a.controller.requestReturn(),true);assert.equal(await a.controller.returnToEntry(),true);
  assert.deepEqual([...raw.map].filter(([key])=>key!==trialRecoveryKey(project)),others);
  assert.deepEqual(JSON.parse(raw.getItem(trialRecoveryKey(project))),{version:1,uid:'a',roomId:null,inviteCode:null,pending:null});
  assert.equal(service.calls.length,calls);a.controller.dispose();
 });
 test('canceling a lobby confirmation preserves recovery, room, identity, and its live listener', async () => {
  const {service,a}=await lobby(),before=a.controller.getState(),raw=a.storage.getItem(ONLINE_SAVE_KEY),calls=service.calls.length;
  assert.equal(a.controller.requestReturn(),true);a.controller.cancelReturn();
  assert.equal(await a.controller.returnToEntry(),false);assert.deepEqual(a.controller.getState(),before);
  assert.equal(a.storage.getItem(ONLINE_SAVE_KEY),raw);assert.equal(service.calls.length,calls);assert.equal(service.subscriptions[0].stops,0);
  a.controller.dispose();
 });
 test('lobby return requires confirmed online, settled, error-free state and a single self-host', async () => {
  const cases={
    cache:({service})=>service.listenersByUid.get('a')({room:clone(service.room),fromCache:true}),
    offline:({a})=>a.controller.offline(),
    suspended:({a})=>a.controller.suspend(),
    conflict:({a})=>a.controller.storageChanged(),
    error:({service})=>service.subscriptions[0].fail(error('unavailable')),
    disposed:({a})=>a.controller.dispose(),
    'two players':({service})=>{service.room.players.push({seat:1,name:'Guest'});service.room.revision++;service.publish();},
    'wrong host':({service})=>{service.room.hostSeat=1;service.publish();},
    'started ID':({service})=>{service.room.gameId='game-started';service.publish();},
    'playing status':({service})=>{service.room.status='playing';service.publish();},
    'existing match':({service})=>{service.room.match=publicMatch(createMatch({playerCount:2,seed:'return-guard',humanSeat:-1}));service.publish();},
    'negative revision':({service,a})=>{a.api.getSnapshot=async()=>({...service.snapshot('a'),room:{...service.room,revision:-1}});return a.controller.resume();},
    'not host':({service,a})=>{a.api.getSnapshot=async()=>({...service.snapshot('a'),self:{seat:0,isHost:false}});return a.controller.resume();},
  };
  for(const [name,change] of Object.entries(cases)) {
    const fixture=await lobby();await change(fixture);const {service,a}=fixture,raw=a.storage.getItem(ONLINE_SAVE_KEY),calls=service.calls.length;
    assert.equal(a.controller.getState().canReturnToEntry,false,name);assert.equal(a.controller.requestReturn(),false,name);
    assert.equal(await a.controller.returnToEntry(),false,name);assert.doesNotMatch(renderOnline(a.controller.getState()),/data-action="return-entry"/,name);
    assert.equal(a.storage.getItem(ONLINE_SAVE_KEY),raw,name);assert.equal(service.calls.length,calls,name);a.controller.dispose();
  }
  let online=true;const {a}=await lobby({isOnline:()=>online});online=false;
  assert.equal(a.controller.getState().connection,'ready');assert.equal(a.controller.requestReturn(),false,'network predicate wins before an offline event');a.controller.dispose();
 });
 test('any changed lobby cancels the old confirmation, even before match start or at the same revision', async () => {
  const changes={
    participant:room=>room.players.push({seat:1,name:'Guest'}),
    revision:room=>room.revision++,
    name:room=>{room.players[0].name='Changed host';},
    started:room=>{room.status='playing';room.gameId='new-game';},
    terminal:room=>{room.status='finished';room.revision++;},
  };
  for(const [name,change] of Object.entries(changes)) {
    const {service,a}=await lobby(),raw=a.storage.getItem(ONLINE_SAVE_KEY),calls=service.calls.length;
    assert.equal(a.controller.requestReturn(),true);change(service.room);service.publish();
    assert.equal(a.controller.getState().ui.returnConfirm,false,name);assert.equal(await a.controller.returnToEntry(),false,name);
    assert.equal(a.storage.getItem(ONLINE_SAVE_KEY),raw,name);assert.equal(service.calls.length,calls,name);a.controller.dispose();
  }
 });
 test('identity changes and auth failures during lobby confirmation preserve the original recovery', async () => {
  for(const outcome of ['different','missing','failure']) {
    let verifying=false;const entered=deferred(),released=deferred();
    const {service,a}=await lobby({ensureUser:async()=>{if(!verifying)return {uid:'a'};entered.resolve();return released.promise;}});
    const raw=a.storage.getItem(ONLINE_SAVE_KEY),calls=service.calls.length;verifying=true;a.controller.requestReturn();
    const returning=a.controller.returnToEntry();await entered.promise;
    assert.equal(a.controller.getState().busy,true);assert.equal(a.controller.getState().canConfirm,false);assert.equal(a.controller.getState().canReturnToEntry,false);
    assert.equal(a.controller.returnToEntry(),false,'double confirm is single flight');assert.equal(a.controller.requestReturn(),false);
    if(outcome==='failure')released.reject(error('unavailable'));else released.resolve(outcome==='different'?{uid:'b'}:null);
    assert.equal(await returning,false,outcome);assert.equal(a.storage.getItem(ONLINE_SAVE_KEY),raw);assert.equal(a.controller.getState().uid,'a');
    assert.equal(a.controller.getState().room.id,'room-1');assert.equal(a.controller.getState().connection,outcome==='failure'?'error':'identity-mismatch');
    assert.equal(a.controller.getState().busy,false);assert.equal(service.calls.length,calls);a.controller.dispose();
  }
 });
 test('a lobby confirmation rechecks every asynchronous auth race without losing recovery', async () => {
  const changes={
    participant:({service})=>{service.room.players.push({seat:1,name:'Guest'});service.room.revision++;service.publish();},
    started:({service})=>{service.room.status='playing';service.room.gameId='new-game';service.publish();},
    revised:({service})=>{service.room.revision++;service.publish();},
    cache:({service})=>service.listenersByUid.get('a')({room:clone(service.room),fromCache:true}),
    offline:({a})=>a.controller.offline(),
    conflict:({a})=>a.controller.storageChanged(),
    cancel:({a})=>a.controller.cancelReturn(),
    suspend:({a})=>a.controller.suspend(),
    dispose:({a})=>a.controller.dispose(),
  };
  for(const [name,change] of Object.entries(changes)) {
    let verifying=false;const entered=deferred(),released=deferred();
    const fixture=await lobby({ensureUser:async()=>{if(verifying){entered.resolve();await released.promise;}return {uid:'a'};}});
    const {service,a}=fixture,raw=a.storage.getItem(ONLINE_SAVE_KEY),calls=service.calls.length;
    verifying=true;assert.equal(a.controller.requestReturn(),true);const returning=a.controller.returnToEntry();await entered.promise;
    change(fixture);released.resolve();assert.equal(await returning,false,name);
    assert.equal(a.storage.getItem(ONLINE_SAVE_KEY),raw,name);assert.equal(a.controller.getState().room.id,'room-1',name);
    assert.equal(service.calls.length,calls,name);a.controller.dispose();
  }
 });
 test('lobby recovery is reread before confirmation and after authentication, including undelivered storage events', async () => {
  const changes={
    identity:value=>({...value,uid:'other'}),room:value=>({...value,roomId:'different-room'}),
    invite:value=>({...value,inviteCode:'changed-code'}),
    pending:value=>({...value,pending:{uid:'a',kind:'start',payload:{roomId:value.roomId,requestId:'other-tab-request'}}}),
    deleted:()=>null,corrupt:()=>'{bad',
  };
  for(const moment of ['before request','before confirm','during auth'])for(const [name,change] of Object.entries(changes)) {
    let verifying=false;const entered=deferred(),released=deferred();
    const {service,a}=await lobby({ensureUser:async()=>{if(verifying){entered.resolve();await released.promise;}return {uid:'a'};}});
    const calls=service.calls.length,changed=change(JSON.parse(a.storage.getItem(ONLINE_SAVE_KEY))),raw=typeof changed==='string'?changed:changed&&JSON.stringify(changed);
    const apply=()=>{if(raw===null)a.storage.map.delete(ONLINE_SAVE_KEY);else a.storage.setItem(ONLINE_SAVE_KEY,raw);};
    if(moment==='before request'){apply();assert.equal(a.controller.requestReturn(),false,`${moment}/${name}`);}
    else {
      assert.equal(a.controller.requestReturn(),true);
      if(moment==='before confirm'){apply();assert.equal(await a.controller.returnToEntry(),false,`${moment}/${name}`);}
      else {verifying=true;const returning=a.controller.returnToEntry();await entered.promise;apply();released.resolve();assert.equal(await returning,false,`${moment}/${name}`);}
    }
    assert.equal(a.storage.getItem(ONLINE_SAVE_KEY),raw,`${moment}/${name}`);assert.equal(a.controller.getState().room.id,'room-1');
    assert.equal(a.controller.getState().canReturnToEntry,false);assert.equal(service.calls.length,calls);a.controller.dispose();
  }
 });
 test('failed lobby recovery reads or writes fail closed without clearing the room or retiring its watcher', async () => {
  for(const mode of ['read','write']) {
    const {service,a}=await lobby(),raw=a.storage.getItem(ONLINE_SAVE_KEY),calls=service.calls.length;
    assert.equal(a.controller.requestReturn(),true);
    a.storage[mode==='read'?'getItem':'setItem']=()=>{throw new Error('storage denied');};
    assert.equal(await a.controller.returnToEntry(),false,mode);assert.equal(a.storage.map.get(ONLINE_SAVE_KEY),raw);
    assert.equal(a.controller.getState().room.id,'room-1');assert.ok(a.controller.getState().storageIssue);assert.equal(a.controller.getState().canReturnToEntry,false);
    assert.equal(service.subscriptions[0].stops,0);assert.equal(service.calls.length,calls);a.controller.dispose();
  }
 });
 test('an unconfirmed create and an in-flight refresh cannot authorize lobby return', async () => {
  const service=server(),a=service.client('a');await a.controller.resume();const created=deferred(),release=deferred(),original=a.api.create;
  a.api.create=async payload=>{await original(payload);created.resolve();await release.promise;throw error('unavailable');};
  const creating=a.controller.create('Host');await created.promise;const raw=a.storage.getItem(ONLINE_SAVE_KEY);
  assert.equal(a.controller.requestReturn(),false);assert.equal(await a.controller.returnToEntry(),false);
  release.resolve();await creating;assert.ok(a.controller.getState().pending);assert.equal(a.controller.requestReturn(),false);assert.equal(a.storage.getItem(ONLINE_SAVE_KEY),raw);
  a.api.create=original;await a.controller.resume();assert.equal(a.controller.getState().canReturnToEntry,true);
  assert.equal(a.controller.requestReturn(),true);const fetched=deferred(),finish=deferred(),getSnapshot=a.api.getSnapshot;
  a.api.getSnapshot=async payload=>{fetched.resolve();await finish.promise;return getSnapshot(payload);};
  const resuming=a.controller.resume();await fetched.promise;assert.equal(a.controller.getState().ui.returnConfirm,false);assert.equal(a.controller.requestReturn(),false);
  assert.equal(await a.controller.returnToEntry(),false);finish.resolve();await resuming;assert.equal(a.controller.getState().canReturnToEntry,true);a.controller.dispose();
 });
 test('suspending lobby confirmation queues safe resume, and canceled auth cannot authorize a later confirmation', async () => {
  let verifying=false;const entered=deferred(),released=deferred();
  const {a}=await lobby({ensureUser:async()=>{if(verifying){entered.resolve();await released.promise;}return {uid:'a'};}});
  a.controller.requestReturn();verifying=true;const returning=a.controller.returnToEntry();await entered.promise;
  a.controller.suspend();const resuming=a.controller.resume();released.resolve();assert.equal(await returning,false);await resuming;
  assert.equal(a.controller.getState().room.id,'room-1');assert.equal(a.controller.getState().canReturnToEntry,true);assert.equal(a.controller.getState().ui.returnConfirm,false);
  assert.equal(a.controller.requestReturn(),true);a.controller.cancelReturn();assert.equal(await a.controller.returnToEntry(),false);
  assert.equal(a.controller.requestReturn(),true);assert.equal(await a.controller.returnToEntry(),true);a.controller.dispose();
 });
 test('terminal returns preserve their offline, synchronous local-only behavior and labels', async () => {
  for(const terminal of ['finished','expired']) {
    let auth=0;const {service,a}=await lobby({ensureUser:async()=>{auth++;return {uid:'a'};}});
    if(terminal==='finished'){service.room.status='finished';service.room.revision++;service.publish();}
    else {a.api.getSnapshot=async()=>{throw error('not-found');};await a.controller.resume();}
    a.controller.offline();const calls=service.calls.length,authCount=auth;
    assert.equal(a.controller.requestReturn(),true);const html=renderOnline(a.controller.getState());
    assert.match(html,terminal==='finished'?/結果画面への自動復帰が解除/:/期限切れ・削除済みの部屋への復帰情報/);
    assert.doesNotMatch(html,/入口へ戻って別の部屋に参加/);assert.equal(a.controller.returnToEntry(),true);
    assert.equal(a.controller.getState().uid,'a');assert.equal(service.calls.length,calls);assert.equal(auth,authCount);a.controller.dispose();
  }
 });
 test('confirmed draw is never applied optimistically and double clicks are single-flight', async () => {
  const {a}=await playing(), waiting=deferred(), api=a.api.submit;
  a.api.submit=async payload=>{await waiting.promise;return api(payload);};
  const before=a.controller.getState().room.match.revision;
  const first=a.controller.submit('draw'); const pending=JSON.parse(a.storage.getItem(ONLINE_SAVE_KEY)).pending;
  assert.equal(pending.payload.command.type,'draw');assert.equal(a.controller.getState().room.match.revision,before);assert.equal(a.controller.getState().canConfirm,false);
  assert.equal(await a.controller.submit('draw'),false);waiting.resolve();await first;
  assert.equal(a.controller.getState().room.match.revision,before+1);
 });
 test('lost success response retains immutable payload, blocks new action, retries exact ID once', async () => {
  const {a,service}=await playing(), api=a.api.submit;
  let lose=true;a.api.submit=async payload=>{const value=await api(payload);if(lose){lose=false;throw error('deadline-exceeded');}return value;};
  await a.controller.submit('draw'); const original=clone(a.controller.getState().pending);
  assert.equal(service.match.revision,1);assert.equal(a.controller.getState().canConfirm,false);assert.equal(await a.controller.submit('self'),false);
  await a.controller.resume(); const submits=service.calls.filter(call=>call.kind==='submit');
  assert.deepEqual(submits[0].payload,submits[1].payload);assert.deepEqual(original.payload,submits[1].payload);assert.equal(service.match.revision,1);assert.equal(a.controller.getState().pending,null);assert.equal(a.controller.getState().canConfirm,true);
 });
 test('reload recovers uncertain command using same UID and request payload', async () => {
  const {a,service}=await playing(), original=a.api.submit;
  a.api.submit=async payload=>{await original(payload);throw error('unavailable');};await a.controller.submit('draw');const payload=clone(a.controller.getState().pending.payload);a.controller.dispose();
  const reloaded=service.client('a',{storage:a.storage});await reloaded.controller.resume();
  assert.equal(service.match.revision,1);assert.deepEqual(service.calls.filter(c=>c.kind==='submit').at(-1).payload,payload);assert.equal(reloaded.controller.getState().self.seat,0);
 });
 test('same UID resumes finished/lobby state, different UID cannot transfer or overwrite', async () => {
  const service=server(),a=service.client('a');await a.controller.resume();await a.controller.create('Host');a.controller.dispose();
  const raw=a.storage.getItem(ONLINE_SAVE_KEY),wrong=service.client('different',{storage:a.storage});await wrong.controller.resume();
  assert.equal(wrong.controller.getState().connection,'identity-mismatch');assert.equal(wrong.controller.getState().canConfirm,false);assert.equal(a.storage.getItem(ONLINE_SAVE_KEY),raw);
  const again=service.client('a',{storage:a.storage});await again.controller.resume();assert.equal(again.controller.getState().room.status,'waiting');assert.equal(again.controller.getState().inviteCode,'GARDEN-test');
 });
 test('unknown create result survives reload before roomId is known', async () => {
  const service=server(), a=service.client('a');await a.controller.resume();const original=a.api.create;
  a.api.create=async p=>{await original(p);throw error('unavailable');};await a.controller.create('Host');assert.equal(a.controller.getState().room,null);a.controller.dispose();
  const b=service.client('a',{storage:a.storage});await b.controller.resume();assert.equal(b.controller.getState().room.players.length,1);assert.equal(b.controller.getState().inviteCode,'GARDEN-test');
 });
 test('older snapshot and obsolete listener generation never roll state backward', async () => {
  const {a,service}=await playing(),old=service.snapshot('a'),listener=service.listenersByUid.get('a');await a.controller.submit('draw');
  listener({room:old.room,fromCache:false});assert.equal(a.controller.getState().room.match.revision,1);
  await a.controller.resume(); const newer=clone(service.room);newer.revision+=100;newer.match.revision+=100;listener({room:newer,fromCache:false});assert.equal(a.controller.getState().room.match.revision,1);
 });
 test('cached snapshots and offline states cannot confirm; successful resume restores', async () => {
  let online=true;const {a,service}=await playing();const listener=service.listenersByUid.get('a');listener({room:clone(service.room),fromCache:true});assert.equal(a.controller.getState().connection,'cache');assert.equal(await a.controller.submit('draw'),false);
  a.controller.offline();assert.equal(a.controller.getState().canConfirm,false);await a.controller.resume();assert.equal(a.controller.getState().canConfirm,true);
  const b=service.client('a',{storage:a.storage,isOnline:()=>online});online=false;await b.controller.resume();assert.equal(b.controller.getState().connection,'offline');
 });
 test('older cached room data preserves confirmed progress but blocks new commands until current server data', async () => {
  const {a,service}=await playing(),old=service.snapshot('a').room;
  await a.controller.submit('draw');
  a.controller.compare(1,true);
  const before=a.controller.getState(),listener=service.listenersByUid.get('a'),calls=service.calls.length,observed=[];
  a.controller.observe(state=>observed.push(state.connection));
  listener({room:old,fromCache:true});
  const cached=a.controller.getState();
  assert.deepEqual(cached.room,before.room);assert.deepEqual(cached.self,before.self);assert.deepEqual(cached.ui,before.ui);
  assert.equal(cached.connection,'cache');assert.equal(cached.canConfirm,false);
  assert.deepEqual(observed,['cache']);
  assert.equal(await a.controller.submit('self'),false);assert.equal(service.calls.length,calls);
  listener({room:old,fromCache:false});assert.equal(a.controller.getState().connection,'cache','older server data cannot restore readiness');
  listener({room:before.room,fromCache:false});assert.equal(a.controller.getState().connection,'ready');assert.equal(a.controller.getState().canConfirm,true);
  const roomOnlyOlder=clone(before.room);roomOnlyOlder.revision-=1;
  const matchOnlyOlder=clone(before.room);matchOnlyOlder.revision+=1;matchOnlyOlder.match.revision-=1;
  for(const room of [roomOnlyOlder,matchOnlyOlder]) {
    listener({room,fromCache:true});assert.equal(a.controller.getState().connection,'cache');assert.deepEqual(a.controller.getState().room,before.room);
    listener({room:before.room,fromCache:false});assert.equal(a.controller.getState().connection,'ready');
  }
 });
 test('invalid or retired older cached events cannot change connection confidence', async () => {
  const {a,service}=await playing(),old=service.snapshot('a').room;
  await a.controller.submit('draw');
  const listener=service.listenersByUid.get('a'),before=a.controller.getState();
  const invalid=[{...old,id:'another-room'},{...old,gameId:'another-game'},{...old,rulesVersion:'another-version'},
    {...old,players:[{seat:1}]},{...old,players:{}},{...old,revision:-1},{...old,match:null},{...old,match:{...old.match,version:'another-version'}},{...old,match:{...old.match,revision:NaN}},{...old,match:{...old.match,revision:-1}}];
  for (const room of invalid) {listener({room,fromCache:true});assert.deepEqual(a.controller.getState(),before);}
  await a.controller.resume();const resumed=a.controller.getState();
  listener({room:old,fromCache:true});assert.deepEqual(a.controller.getState(),resumed,'obsolete listener generation is ignored');
 });
 test('older cached events preserve stronger blockers and uncertain recovery', async () => {
  for (const mode of ['offline','conflict','uncertain','identity-mismatch']) {
    let uid='a';const service=server(),a=service.client('a',{ensureUser:async()=>({uid})}),b=service.client('b');
    await a.controller.resume();await a.controller.create('Host');await b.controller.resume();await b.controller.join('GARDEN-test','Guest');await a.controller.start();
    const old=service.snapshot('a').room;await a.controller.submit('draw');
    const listener=service.listenersByUid.get('a');
    if(mode==='offline')a.controller.offline();
    if(mode==='conflict')a.controller.storageChanged();
    if(mode==='uncertain'){a.api.submit=async()=>{throw error('unavailable');};await a.controller.submit('self');}
    if(mode==='identity-mismatch'){uid='changed-identity';await a.controller.submit('self');}
    const before=a.controller.getState(),saved=a.storage.getItem(ONLINE_SAVE_KEY),calls=service.calls.length;
    assert.equal(before.connection,mode);
    listener({room:old,fromCache:true});
    assert.deepEqual(a.controller.getState(),before,mode);assert.equal(a.storage.getItem(ONLINE_SAVE_KEY),saved);assert.equal(service.calls.length,calls);
  }
 });
 test('older cached data cannot undo confirmed terminal state', async () => {
  const {a,service}=await playing(),old=service.snapshot('a').room;
  const finished=clone(old);finished.status='finished';finished.revision+=1;
  const listener=service.listenersByUid.get('a');listener({room:finished,fromCache:false});
  const before=a.controller.getState();assert.equal(before.terminal,'finished');
  listener({room:old,fromCache:true});const cached=a.controller.getState();
  assert.equal(cached.connection,'cache');assert.equal(cached.terminal,'finished');assert.deepEqual(cached.room,before.room);assert.deepEqual(cached.ui,before.ui);
 });
 test('older same-lobby cache preserves participants and prevents starting from stale listener state', async () => {
  const service=server(),a=service.client('a'),b=service.client('b');await a.controller.resume();await a.controller.create('Host');
  const old=service.snapshot('a').room;await b.controller.resume();await b.controller.join('GARDEN-test','Guest');
  const before=a.controller.getState(),listener=service.listenersByUid.get('a'),calls=service.calls.length;
  assert.equal(before.room.players.length,2);assert.equal(before.canConfirm,true);
  listener({room:old,fromCache:true});assert.deepEqual(a.controller.getState().room,before.room);assert.equal(a.controller.getState().connection,'cache');
  assert.equal(await a.controller.start(),false);assert.equal(service.calls.length,calls);
  listener({room:before.room,fromCache:false});assert.equal(a.controller.getState().canConfirm,true);
 });
 test('storage unavailable or corrupted is fail-closed and no network calls occur', async () => {
  for (const storage of [null,{getItem(){throw new Error('denied');}},memoryStorage('{bad')]) {
    let calls=0;const c=createOnlineController({storage,api:{},ensureUser:async()=>{calls++;return {uid:'a'};}});assert.equal(await c.resume(),false);assert.equal(c.getState().canConfirm,false);assert.equal(calls,0);assert.ok(c.getState().storageIssue);
  }
 });
 test('persist failure blocks transmission of new command', async () => {
  const {a,service}=await playing();a.storage.setItem=()=>{throw new Error('quota');};const count=service.calls.length;
  assert.equal(await a.controller.submit('draw'),false);assert.equal(service.calls.length,count);assert.equal(service.match.revision,0);assert.ok(a.controller.getState().storageIssue);
 });
 test('illegal actor and stale revision never reach API', async () => {
  const {a,b,service}=await playing();const count=service.calls.length;assert.equal(await b.controller.submit('draw'),false);assert.equal(await a.controller.submit('draw',{},99),false);assert.equal(service.calls.length,count);
  await a.controller.submit('draw');assert.equal(await a.controller.submit('self',{},0),false);
 });
 test('server definitive stale refusal clears pending and refreshes authoritative state', async () => {
  const {a}=await playing();a.api.submit=async()=>{throw error('failed-precondition','stale-revision');};await a.controller.submit('draw');assert.equal(a.controller.getState().pending,null);assert.equal(a.controller.getState().canConfirm,true);assert.equal(a.controller.getState().room.match.revision,0);
 });
 test('preview and rotation are local; commit strips seat and revision from command', async () => {
  const {a,b,service}=await playing();await a.controller.submit('draw');await a.controller.submit('self');await b.controller.submit('pass-invite');
  const count=service.calls.length;assert.equal(a.controller.preview('cell',0),true);a.controller.preview('rotate');assert.equal(service.calls.length,count);assert.equal(service.match.players[0].garden[0],null);
  assert.equal(a.controller.getState().ui.pending.tile.rotation,1);await a.controller.commit();assert.equal(service.match.players[0].garden[0].rotation,1);assert.equal(a.controller.getState().ui.pending,null);
  const payload=service.calls.filter(c=>c.kind==='submit').at(-1).payload;assert.deepEqual(payload.command,{type:'place',index:0,rotation:1});
 });
 test('comparison for seat zero stays open and follows updates without pausing opponent', async () => {
  const {a,b}=await playing();b.controller.compare(0,true);const before=b.controller.getState().room.match.revision;await a.controller.submit('draw');
  assert.equal(b.controller.getState().room.match.revision,before+1);assert.deepEqual(b.controller.getState().ui.comparison,{seat:0,pair:true});const html=renderOnline(b.controller.getState());assert.match(html,/比較中も相手は操作できます/);assert.match(html,/online-comparison/);
 });
 test('new revision invalidates pending placement while preserving comparison', async () => {
  const {a,b,service}=await playing();await a.controller.submit('draw');await a.controller.submit('self');await b.controller.submit('pass-invite');a.controller.preview('cell',0);a.controller.compare(1,true);
  service.match=applyMatchAction(service.match,legalActions(service.match).find(a=>a.type==='place'));assert.equal(a.controller.getState().ui.pending,null);assert.ok(a.controller.getState().ui.comparison);
 });
 test('pagehide during in-flight action ignores obsolete response and pageshow recovers once', async () => {
  const {a,service}=await playing();const wait=deferred(),original=a.api.submit;let first=true;
  a.api.submit=async payload=>{const value=await original(payload);if(first){first=false;await wait.promise;}return value;};
  const sending=a.controller.submit('draw');await Promise.resolve();a.controller.suspend();const resuming=a.controller.resume();wait.resolve();await sending;await resuming;
  assert.equal(service.match.revision,1);assert.equal(a.controller.getState().pending,null);assert.equal(a.controller.getState().canConfirm,true);
 });
 test('pagehide during snapshot fetch ignores old result and resumes with fresh generation', async () => {
  const {a}=await playing();const wait=deferred(),original=a.api.getSnapshot;let first=true;
  a.api.getSnapshot=async p=>{const value=await original(p);if(first){first=false;await wait.promise;}return value;};
  const old=a.controller.resume();await Promise.resolve();await Promise.resolve();a.controller.suspend();const fresh=a.controller.resume();wait.resolve();await old;await fresh;assert.equal(a.controller.getState().canConfirm,true);
 });
 test('unmount ignores late auth and snapshot without writes or subscription', async () => {
  const wait=deferred();let subscribed=0;const storage=memoryStorage();const c=createOnlineController({api:{},storage,ensureUser:()=>wait.promise,subscribe:()=>{subscribed++;return()=>{};}});const task=c.resume();await Promise.resolve();c.dispose();wait.resolve({uid:'a'});await task;assert.equal(subscribed,0);assert.equal(storage.getItem(ONLINE_SAVE_KEY),null);
 });
 test('same browser storage conflict blocks confirmations without clearing room or pending', async () => {
  const {a}=await playing();const saved=JSON.parse(a.storage.getItem(ONLINE_SAVE_KEY));saved.pending={uid:'a',kind:'submit',payload:{requestId:'another'}};a.storage.setItem(ONLINE_SAVE_KEY,JSON.stringify(saved));assert.equal(await a.controller.submit('draw'),false);assert.equal(a.controller.getState().connection,'conflict');assert.equal(a.controller.getState().room.id,'room-1');
 });
 test('full two-human games cover choice branches, final stones and equal authoritative scores', async () => {
  const seen=new Set();
  for(let seed=0;seed<5;seed++) {
    const {a,b,service}=await playing(), clients=[a.controller,b.controller]; let n=0;
    while(service.match.phase!=='finished') {
      assert.ok(++n<500);const match=service.match, actions=legalActions(match), c=clients[getDecision(match).seat];let action;
      const pick=type=>actions.find(a=>a.type===type);
      if(match.step==='source') action=(seed%2?pick('use-storage'):null)||pick('draw');
      else if(match.step==='choose') action=(match.round%3===1?pick('offer'):match.round%3===2?pick('store'):pick('self'))||actions[0];
      else if(match.step==='offer-response') action=pick((match.round+seed)%2?'accept':'decline');
      else if(match.step==='invite-response') action=pick((match.round+seed)%3?'request-invite':'pass-invite');
      else if(match.step==='welcome') action=pick((match.round+seed)%2?'welcome':'yield')||pick('yield');
      else if(match.step==='place') action=actions[(n*7)%actions.length];
      else if(match.step==='care') action=(n%3===0?pick('stone'):null)||pick('meditate');
      else action=(seed%2?pick('stone'):null)||pick('pass-final');
      seen.add(action.type);const {type,seat,revision,...extra}=action;assert.equal(await c.submit(type,extra,revision),true);
    }
    assert.deepEqual(a.controller.getState().room,b.controller.getState().room);assert.deepEqual(a.controller.getState().room.scores,rankMatch(service.match));assert.ok(service.match.players.every(p=>p.garden.every(Boolean)));assert.equal(service.match.players[0].careCount,service.match.players[1].careCount);
    for (const client of clients) {
      const html = renderOnline(client.getState());
      assert.match(html,/サーバーで確定した共通の結果/);
      assert.match(html,/<p>庭づくりが完了しました<\/p>/);
      assert.doesNotMatch(html,/次の選択を待っています/);
    }
    assert.equal(a.controller.requestReturn(),true);assert.equal(a.controller.returnToEntry(),true);assert.equal(a.controller.getState().room,null);assert.equal(a.controller.getState().uid,'a');assert.equal(b.controller.getState().room.status,'finished');
  }
  for(const type of ['draw','use-storage','self','store','offer','accept','decline','request-invite','pass-invite','welcome','yield','place','meditate','stone','pass-final']) assert.ok(seen.has(type),`missing ${type}`);
 });
 test('return to entry is forbidden during play/uncertainty; confirmed expiry permits explicit local-only reset', async () => {
  const {a}=await playing();assert.equal(a.controller.requestReturn(),false);assert.equal(a.controller.returnToEntry(),false);
  a.api.getSnapshot=async()=>{throw error('failed-precondition','room-expired');};await a.controller.resume();assert.equal(a.controller.getState().terminal,'expired');assert.equal(a.controller.returnToEntry(),false);assert.equal(a.controller.requestReturn(),true);a.controller.cancelReturn();assert.equal(a.controller.returnToEntry(),false);a.controller.requestReturn();assert.equal(a.controller.returnToEntry(),true);
 });
 test('names are escaped everywhere and rule examples remain available', async () => {
  const {a,service}=await playing();const match=clone(service.match);match.players[0].name='<script>x</script>';service.match=match;const html=renderOnline(a.controller.getState());assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);assert.match(html,/rule-example/);
 });
 test('production gate cannot be enabled by query flags and demo ports are explicit', async () => {
  assert.equal(localTestAllowed({hostname:'wa-awesome.web.app',protocol:'https:',search:'?emulator=1'}),false);assert.equal(localTestAllowed({hostname:'localhost',protocol:'http:'}),true);assert.equal(localTestAllowed({hostname:'localhost.evil.test',protocol:'http:'}),false);assert.equal(EMULATOR_CONFIG.projectId,'demo-floating-garden');assert.deepEqual(EMULATOR_PORTS,{auth:9099,firestore:8182,functions:5103});
  const firebase=await readFile(new URL('../lab/floating-garden/online/firebase.js',import.meta.url),'utf8');assert.doesNotMatch(firebase,/firebase-config\.js|wa-awesome\.firebaseapp/);assert.ok(firebase.indexOf('if (!localTestAllowed')<firebase.indexOf("import('https://"));
 });
 test('preview/cancel is safe on the entry and lobby before a match exists', async () => {
  const s=server(),a=s.client('a');await a.controller.resume();assert.equal(a.controller.preview('cancel'),false);await a.controller.create('Host');assert.equal(a.controller.preview('cell',0),false);
 });
 test('live identity changes are checked again before transmitting any command', async () => {
  const {a,service}=await playing();const raw=a.storage.getItem(ONLINE_SAVE_KEY);a.controller.dispose();let uid='a';
  const next=service.client('a',{storage:a.storage,ensureUser:async()=>({uid})});await next.controller.resume();uid='b';const count=service.calls.filter(c=>c.kind==='submit').length;await next.controller.submit('draw');assert.equal(service.calls.filter(c=>c.kind==='submit').length,count);assert.equal(next.controller.getState().connection,'identity-mismatch');assert.ok(next.controller.getState().pending);assert.notEqual(a.storage.getItem(ONLINE_SAVE_KEY),raw);
 });
 test('a cached terminal snapshot cannot authorize forgetting a live room', async () => {
  const {a,service}=await playing();const room=clone(service.room);room.status='finished';room.revision+=1;service.listenersByUid.get('a')({room,fromCache:true});assert.equal(a.controller.getState().terminal,null);assert.equal(a.controller.requestReturn(),false);
 });
 test('older game IDs and lower match revisions are discarded even with higher room revisions', async () => {
  const {a,service}=await playing();await a.controller.submit('draw');const before=a.controller.getState().room;const other=clone(before);other.revision+=20;other.gameId='other';service.listenersByUid.get('a')({room:other});assert.deepEqual(a.controller.getState().room,before);other.gameId=before.gameId;other.match.revision=0;service.listenersByUid.get('a')({room:other});assert.deepEqual(a.controller.getState().room,before);
 });
 test('concurrent resume triggers share one auth and snapshot request', async () => {
  const {a,service}=await playing();const wait=deferred(),original=a.api.getSnapshot;let count=0;a.api.getSnapshot=async p=>{count++;await wait.promise;return original(p);};const tasks=[a.controller.resume(),a.controller.resume(),a.controller.resume()];assert.equal(tasks[0],tasks[1]);await Promise.resolve();await Promise.resolve();wait.resolve();await Promise.all(tasks);assert.equal(count,1);assert.equal(a.controller.getState().canConfirm,true);
 });
 test('malformed cross-room saved pending action never transmits', async () => {
  let called=0;const storage=memoryStorage(JSON.stringify({version:1,uid:'a',roomId:'one',pending:{kind:'submit',uid:'a',payload:{requestId:'x',roomId:'two'}}}));const c=createOnlineController({storage,ensureUser:async()=>{called++;return {uid:'a'};},api:{}});await c.resume();assert.equal(called,0);assert.ok(c.getState().storageIssue);
 });

// Exercise the real event binding without a browser dependency. Chromium layout/visual
// verification is separately maintained in floating-garden-online-browser.mjs.
import { mountOnline } from '../lab/floating-garden/online/mount.js';
function mounted(controller) {
  const listeners=new Map(),pageListeners=new Map(),documentListeners=new Map();let buttons=[],details=[],dialog=null,html='';
  const page={scrollX:0,scrollY:210,addEventListener(type,fn){pageListeners.set(type,fn);},removeEventListener(type){pageListeners.delete(type);},scrollTo(x,y){this.scrollX=x;this.scrollY=y;}};
  const document={activeElement:null,body:{style:{overflow:'auto'}},defaultView:page,visibilityState:'visible',addEventListener(type,fn){documentListeners.set(type,fn);},removeEventListener(type){documentListeners.delete(type);}};
  const root={ownerDocument:document,
    set innerHTML(value){html=value;dialog=value.includes('<dialog ') ? {id:'online-comparison',open:false,showModal(){this.open=true;},close(){this.open=false;}}:null;
      buttons=[...value.matchAll(/<button\b([^>]*)>[\s\S]*?<\/button>/g)].map(([,attrs])=>({dataset:Object.fromEntries([...attrs.matchAll(/data-([\w-]+)="([^"]*)"/g)].map(([,key,text])=>[key.replace(/-([a-z])/g,(_,v)=>v.toUpperCase()),text])),disabled:/\bdisabled\b/.test(attrs),focus(){document.activeElement=this;}}));
      details=[...value.matchAll(/<details\b([^>]*)>/g)].map(([,attrs])=>({id:attrs.match(/id="([^"]+)"/)[1],open:/\bopen\b/.test(attrs)}));
    },get innerHTML(){return html;},querySelectorAll(selector){return selector==='details'?details:selector==='button[data-action]'?buttons:[];},
    querySelector(selector){if(selector==='#online-comparison')return dialog;if(selector.startsWith('#'))return details.find(item=>`#${item.id}`===selector)||null;const focus=selector.match(/^\[data-focus="([^"]+)"\]$/)?.[1];if(focus)return buttons.find(item=>item.dataset.focus===focus)||null;const action=selector.match(/^\[data-action="([^"]+)"\]$/)?.[1];return buttons.find(item=>item.dataset.action===action)||null;},
    contains(button){return buttons.includes(button);},addEventListener(type,fn){listeners.set(type,fn);},removeEventListener(type){listeners.delete(type);}
  };
  const app=mountOnline(root,{controller});
  const clickButton=button=>{document.activeElement=button;return listeners.get('click')?.({target:{closest:()=>button}});};
  return {app,root,page,listeners,pageListeners,documentListeners,button:focus=>root.querySelector(`[data-focus="${focus}"]`),clickButton,
    click(focus){const button=this.button(focus);assert.ok(button,`${focus} exists`);return clickButton(button);},
    input(id,value){listeners.get('input')?.({target:{id,value}});},escape(){listeners.get('keydown')?.({key:'Escape',preventDefault(){}});},cancel(){listeners.get('cancel')?.({target:dialog,preventDefault(){}});}
  };
}
 test('real DOM handlers create/join/start, preview, rotate, cancel, reject old buttons and restore focus', async () => {
  const service=server(),a=service.client('a'),b=service.client('b'),first=mounted(a.controller),second=mounted(b.controller);await Promise.all([first.app.ready,second.app.ready]);
  first.input('online-name','Host');await first.click('create');second.input('online-name','Guest');second.input('online-code','GARDEN-test');await second.click('join');await first.click('start');await first.click('command-draw');await first.click('command-self');await second.click('command-pass-invite');
  first.click('cell-4');first.click('rotate');assert.equal(a.controller.getState().ui.pending.tile.rotation,1);first.click('cancel');assert.equal(a.controller.getState().ui.pending,null);first.click('cell-4');const stale=first.button('commit');await first.click('commit');assert.equal(service.match.players[0].garden[4].rotation,1);assert.equal(first.root.ownerDocument.activeElement.dataset.focus,'command-meditate');const rev=service.match.revision;await first.clickButton(stale);assert.equal(service.match.revision,rev);
  first.app.unmount();second.app.unmount();assert.equal(first.listeners.size,0);assert.equal(first.pageListeners.size,0);assert.equal(first.documentListeners.size,0);
 });
 test('real DOM comparison keeps dialog/focus/scroll and details through incoming snapshots', async () => {
  const {a,b,service}=await playing(),app=mounted(b.controller);await app.app.ready;app.root.querySelector('#score-details').open=false;app.click('inspect-0');assert.equal(app.root.ownerDocument.body.style.overflow,'hidden');assert.equal(app.root.querySelector('#online-comparison').open,true);app.click('compare-pair');await a.controller.submit('draw');assert.equal(app.root.querySelector('#online-comparison').open,true);assert.equal(app.root.querySelector('#score-details').open,false);assert.equal(b.controller.getState().room.match.revision,1);
  app.page.scrollY=900;app.escape();assert.equal(app.page.scrollY,210);assert.equal(app.root.ownerDocument.body.style.overflow,'auto');assert.equal(app.root.ownerDocument.activeElement.dataset.focus,'inspect-0');app.click('inspect-0');app.cancel();assert.equal(b.controller.getState().ui.comparison,null);app.app.unmount();
 });
 test('real DOM lifecycle routes visibility/pageshow/online and blocks offline confirmation', async () => {
  const {a}=await playing(),app=mounted(a.controller);await app.app.ready;app.pageListeners.get('offline')();assert.equal(app.button('command-draw').disabled,true);await app.pageListeners.get('online')();assert.equal(app.button('command-draw').disabled,false);app.pageListeners.get('pagehide')();await app.pageListeners.get('pageshow')();assert.equal(a.controller.getState().canConfirm,true);await app.documentListeners.get('visibilitychange')();assert.equal(a.controller.getState().canConfirm,true);app.app.unmount();
 });

 test('real lobby return handlers support cancel, Escape, stale-click rejection, and joining from the entry', async () => {
  const service=server(),a=service.client('a'),app=mounted(a.controller);await app.app.ready;
  app.input('online-name','Host');await app.click('create');const raw=a.storage.getItem(ONLINE_SAVE_KEY),calls=service.calls.length;
  app.click('return-entry');const stale=app.button('confirm-return');app.click('cancel-return');await app.clickButton(stale);
  assert.equal(a.storage.getItem(ONLINE_SAVE_KEY),raw);assert.equal(a.controller.getState().ui.returnConfirm,false);
  app.click('return-entry');app.escape();assert.equal(a.controller.getState().ui.returnConfirm,false);assert.equal(a.storage.getItem(ONLINE_SAVE_KEY),raw);
  app.click('return-entry');await app.click('confirm-return');
  assert.equal(a.controller.getState().room,null);assert.equal(a.controller.getState().uid,'a');assert.equal(service.calls.length,calls);
  assert.ok(app.button('join'));assert.equal(app.button('join').disabled,false);assert.equal(app.button('return-entry'),null);
  assert.match(app.root.innerHTML,/相手から受け取った招待コード/);app.app.unmount();
 });


 test('NPC choice is bounded, preserves the legacy zero-NPC payload, and survives entry rerenders', async () => {
  for (const count of [0, 1, 2]) {
    const service=server(),a=service.client('a'),app=mounted(a.controller);await app.app.ready;
    assert.match(app.root.innerHTML, /id="online-npc-count"/);
    app.input('online-name','Host');app.input('online-npc-count',String(count));
    await a.controller.resume();
    assert.match(app.root.innerHTML,new RegExp(`<option value="${count}" selected>`));
    await app.click('create');
    const payload=service.calls.find(call=>call.kind==='create').payload;
    assert.equal(payload.npcCount,count || undefined);app.app.unmount();
  }
  const service=server(),a=service.client('a');await a.controller.resume();
  for(const count of [-1,3,1.5,'1',null,NaN]) assert.equal(await a.controller.create('Host',count),false);
  assert.equal(service.calls.some(call=>call.kind==='create'),false);a.controller.dispose();
 });
 for(const npcCount of [1,2]) test(`render ${npcCount+2} gardens, distinguish NPCs, and keep all comparison targets`,async()=>{
  const {a,service}=await playing();
  const match=createMatch({playerCount:2+npcCount,seed:'npc-view',humanSeat:-1});
  match.players.forEach((player)=>{player.isHuman=player.seat<2;player.name=player.seat<2?['Host','Guest'][player.seat]:`NPC ${player.seat-1}`;});
  const room={...service.room,revision:100,npcCount,playerCount:2+npcCount,match:publicMatch(match),players:match.players.map(({seat,name,isHuman})=>({seat,name,...(isHuman?{}:{isHuman:false})}))};
  service.listenersByUid.get('a')({room,fromCache:false});
  const html=renderOnline(a.controller.getState());
  assert.match(html,new RegExp(`${npcCount+1} GARDENS`));
  assert.match(html,new RegExp(`data-opponent-count="${npcCount+1}"`));
  assert.equal((html.match(/class="opponent-card"/g)||[]).length,npcCount+1);
  for(let seat=1;seat<2+npcCount;seat++){
    assert.equal(a.controller.compare(seat,true),true);
    assert.match(renderOnline(a.controller.getState()),new RegExp(`P${seat+1} ${seat<2?'Guest':`NPC ${seat-1}`}`));
    a.controller.closeComparison();
  }
  assert.equal(a.controller.compare(2+npcCount),false);a.controller.dispose();
 });

/** Save compatibility and tampering checks use only strings and injected in-memory storage. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as match from '../floating-garden/match-engine.js';
import * as save from '../floating-garden/match-save.js';
import { OBJECTIVE_IDS, selectObjectiveId, scoreGarden } from '../floating-garden/engine.js';
import { chooseCpuAction } from '../floating-garden/cpu.js';
import * as oldMatch from '../lab/floating-garden/match-engine.js';
import * as oldSave from '../lab/floating-garden/match-save.js';
import { chooseCpuAction as oldCpu } from '../lab/floating-garden/cpu.js';
const seedFor=id=>{for(let n=0;n<10000;n++)if(selectObjectiveId('resume-'+n)===id)return 'resume-'+n;assert.fail('objective not selected');};
function advance(state, actions, count=1) {
  for(let i=0;i<count&&state.phase!=='finished';i++) {
    const action=chooseCpuAction(match.publicMatch(state),match.legalActions(state)); actions.push(action); state=match.applyMatchAction(state,action);
  }
  return state;
}
const serialize=(state,actions,extra={})=>save.encodeMatchSave({state,actions,savedAt:123456,saveRevision:12,assist:true,...extra});
const mutate=(raw,fn)=>{const value=JSON.parse(raw);fn(value);return JSON.stringify(value);};

for(const id of OBJECTIVE_IDS)for(const playerCount of [2,3,4])test(`${id} ${playerCount}-player new save persists exactly one objective through replay and completion`,()=>{
  let state=match.createMatch({seed:seedFor(id),playerCount}),actions=[],checks=0;
  const pinned=structuredClone(state.objective);
  assert.equal(pinned.id,id);
  while(state.phase!=='finished'){
    state=advance(state,actions,23);const before=structuredClone(state),raw=serialize(state,actions),snapshot=save.decodeMatchSave(raw);
    assert.equal(snapshot.version,save.SAVE_VERSION);assert.equal(snapshot.matchVersion,match.SOLO_MATCH_VERSION);
    assert.deepEqual(snapshot.state,before);assert.deepEqual(snapshot.state.objective,pinned);
    assert.equal(snapshot.assist,true);assert.equal(snapshot.saveRevision,12);assert.equal(snapshot.savedAt,123456);
    assert.equal(serialize(snapshot.state,snapshot.actions),raw);
    state=snapshot.state;actions=snapshot.actions;checks++;
    assert.ok(actions.length<2000);
  }
  assert.ok(checks>1);assert.equal(state.phase,'finished');
  assert.deepEqual(save.decodeMatchSave(serialize(state,actions)).state.objective,pinned);
  for(const item of match.rankMatch(state))assert.equal(item.score,scoreGarden(state.players[item.seat].garden,pinned).total);
});

for(const playerCount of [2,3,4])test(`preserved original v1 bytes resume legacy ${playerCount}-player rules without migration`,()=>{
  let state=oldMatch.createMatch({seed:'old-save-fixture',playerCount}),actions=[],checked=0;
  while(state.phase!=='finished'){
    const action=oldCpu(oldMatch.publicMatch(state),oldMatch.legalActions(state));actions.push(action);state=oldMatch.applyMatchAction(state,action);
    if(actions.length%41===0||state.phase==='finished'){
      // The fixture bytes come from the preserved old implementation, not the new encoder.
      const raw=oldSave.encodeMatchSave({state,actions,savedAt:42,saveRevision:5,assist:true});
      const expected=oldSave.decodeMatchSave(raw),actual=save.decodeMatchSave(raw);
      assert.deepEqual(actual,expected);assert.equal(actual.version,save.LEGACY_SAVE_VERSION);assert.equal(actual.state.version,match.LEGACY_MATCH_VERSION);
      assert.equal(Object.hasOwn(actual.state,'objective'),false);
      assert.equal(save.encodeMatchSave({...actual,savedAt:42}),raw);
      assert.deepEqual(match.rankMatch(actual.state),oldMatch.rankMatch(state));
      if(state.phase!=='finished'){
        const decision=chooseCpuAction(match.publicMatch(actual.state),match.legalActions(actual.state));
        assert.deepEqual(decision,oldCpu(oldMatch.publicMatch(state),oldMatch.legalActions(state)));
        assert.deepEqual(match.applyMatchAction(actual.state,decision),oldMatch.applyMatchAction(state,decision));
      }
      checked++;
    }
  }
  assert.ok(checked>1);
});

test('new saves fail closed on valid objective replacement as well as malformed metadata and version downgrades',()=>{
  const actions=[],state=advance(match.createMatch({seed:'tampering-fixture'}),actions,51),raw=serialize(state,actions);
  const alternatives=OBJECTIVE_IDS.filter(id=>id!==state.objective.id);
  for(const id of alternatives)assert.throws(()=>save.decodeMatchSave(mutate(raw,v=>v.state.objective.id=id)),e=>e.code==='invalid-state');
  for(const change of [
    v=>delete v.state.objective,v=>v.state.objective=null,v=>v.state.objective.id='unknown',v=>v.state.objective.version=2,
    v=>v.state.objective.version='1',v=>v.state.objective.extra='override',v=>v.objective={id:'corners',version:1},
    v=>v.state.version=match.LEGACY_MATCH_VERSION,v=>v.matchVersion=match.LEGACY_MATCH_VERSION,v=>v.version=save.LEGACY_SAVE_VERSION,
    v=>v.state.players[0].power=6,v=>v.state.deck.reverse(),v=>v.state.seed='another-seed',v=>v.state.revision++,v=>v.actions.pop(),
    v=>v.actions[0].objectiveId='corners',v=>v.actions[0].revision++,v=>v.actions[0].type='change-objective',v=>v.state.players[0].objective={id:'corners',version:1},
  ])assert.throws(()=>save.decodeMatchSave(mutate(raw,change)));
  const old=oldMatch.createMatch({seed:'old-tamper'}),oldRaw=oldSave.encodeMatchSave({state:old,actions:[],savedAt:1});
  assert.throws(()=>save.decodeMatchSave(mutate(oldRaw,v=>v.state.objective={id:'corners',version:1})));
  assert.throws(()=>save.decodeMatchSave(mutate(oldRaw,v=>{v.version=save.SAVE_VERSION;v.matchVersion=match.SOLO_MATCH_VERSION;})));
});

test('save limits, unknown fields and invalid envelopes remain rejected',()=>{
  const raw=serialize(match.createMatch(),[]);
  for(const value of ['',null,'not json', ' '.repeat(save.MAX_SAVE_CHARS+1)])assert.throws(()=>save.decodeMatchSave(value));
  for(const change of [v=>v.extra=true,v=>v.assist='yes',v=>v.saveRevision=-1,v=>v.savedAt=-1,v=>v.savedAt=8640000000000001,
    v=>v.actions={},v=>v.actions=Array(2001).fill({}),v=>v.state.seed='s'.repeat(257),v=>v.state.players=[],v=>v.version='future',v=>v.matchVersion='future'])assert.throws(()=>save.decodeMatchSave(mutate(raw,change)));
  assert.throws(()=>save.encodeMatchSave({state:{...match.createMatch(),objective:{id:'corners',version:99}},actions:[]}));
});

test('explicit trusted overrides do not silently become local resumable seed selections',()=>{
  const seed='override-fixture',different=OBJECTIVE_IDS.find(id=>id!==selectObjectiveId(seed));
  const state=match.createMatch({seed,objectiveId:different});assert.equal(state.objective.id,different);
  assert.throws(()=>serialize(state,[]),e=>e.code==='invalid-objective');
  const valid=match.createMatch({seed,objectiveId:selectObjectiveId(seed)});assert.deepEqual(save.decodeMatchSave(serialize(valid,[])).state,valid);
});

test('read-only legacy resume does not migrate, remove or overwrite any injected storage bytes',async()=>{
  const old=oldMatch.createMatch({seed:'store-fixture'}),raw=oldSave.encodeMatchSave({state:old,actions:[],savedAt:1});
  const entries=new Map([[save.SAVE_KEY,raw],['unrelated','untouched']]),writes=[];
  const storage={getItem:key=>entries.get(key)??null,setItem(key,value){writes.push([key,value]);entries.set(key,value);},removeItem(){assert.fail('removed storage');}};
  const locks={request:(_name,_options,callback)=>callback({name:'in-memory-lock'})};
  const store=save.createMatchSaveStore({storage,locks});
  assert.equal(save.SAVE_KEY,oldSave.SAVE_KEY);assert.equal(save.SAVE_LOCK,oldSave.SAVE_LOCK);
  assert.equal(store.read().status,'valid');assert.equal(store.read().snapshot.state.version,match.LEGACY_MATCH_VERSION);
  assert.deepEqual(writes,[]);assert.equal(entries.get(save.SAVE_KEY),raw);assert.equal(entries.get('unrelated'),'untouched');
  assert.equal(store.write(raw,'not-acquired').status,'unavailable');
  assert.equal(await store.acquire(),'acquired');
  assert.equal(store.write('wrong-original','replacement').status,'conflict');assert.deepEqual(writes,[]);
  // An explicit writer may save a resumed legacy state, still in the exact old format.
  const state=match.applyMatchAction(old,match.legalActions(old)[0]);
  const next=serialize(state,[match.legalActions(old)[0]]);
  assert.equal(JSON.parse(next).version,save.LEGACY_SAVE_VERSION);
  assert.equal(store.write(raw,next).status,'saved');store.release();
  assert.equal(writes.length,1);assert.equal(entries.get('unrelated'),'untouched');
});

test('invalid objective storage is reported, retained and never auto-replaced',()=>{
  const raw=mutate(serialize(match.createMatch(),[]),v=>v.state.objective.version=3);
  const store=save.createMatchSaveStore({storage:{getItem:()=>raw,setItem(){assert.fail('wrote invalid save');}},locks:{request(){assert.fail('unrequested lock');}}});
  const result=store.read();assert.equal(result.status,'invalid');assert.equal(result.raw,raw);
});

/** Shared objective tests: pure local rules, synthetic gardens and public CPU input only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../floating-garden/engine.js';
import * as match from '../floating-garden/match-engine.js';
import { bestTilePlacement, chooseCpuAction } from '../floating-garden/cpu.js';
import * as oldEngine from '../lab/floating-garden/engine.js';
import * as oldMatch from '../lab/floating-garden/match-engine.js';
import { chooseCpuAction as oldCpu, bestTilePlacement as oldPlacement } from '../lab/floating-garden/cpu.js';
const { createGarden, createTile, scoreGarden, evaluateObjective, OBJECTIVE_IDS, OBJECTIVE_VERSION, CORNERS } = engine;
const objective = id => ({ id, version: OBJECTIVE_VERSION });
const terrain = ['cloud', 'lake', 'crystal', 'forest', 'magic'];
function garden(cells, types = 'cloud') {
  const result = createGarden();
  cells.forEach((index, offset) => { result[index] = createTile(Array.isArray(types) ? types[offset] : types); });
  return result;
}
function flowLoop() {
  const result = createGarden();
  for (const [i, shape, rotation] of [[0,'bend',1],[1,'straight',1],[2,'bend',2],[6,'bend',3],[5,'straight',1],[4,'bend',0]]) result[i] = createTile('cloud',shape,rotation);
  return result;
}
const status = (board, id) => evaluateObjective(board, objective(id));
const snapshots = {
  corners: () => garden(CORNERS, terrain),
  'terrain-cluster': () => garden([0,1,5,9]),
  'flow-chain': flowLoop,
  'diverse-line': () => garden([4,5,6,7], terrain),
};

test('objective definitions are stable public records; descriptors reject IDs, versions and extra fields', () => {
  assert.deepEqual(OBJECTIVE_IDS, ['corners','terrain-cluster','flow-chain','diverse-line']);
  assert.ok(Object.isFrozen(OBJECTIVE_IDS)); assert.ok(Object.isFrozen(engine.OBJECTIVES));
  for (const id of OBJECTIVE_IDS) {
    assert.equal(engine.validateObjective(objective(id)).id,id);
    assert.ok(Object.isFrozen(engine.OBJECTIVES[id]));
    const value = status(createGarden(), id);
    for (const key of ['id','version','name','description','target','progress','achieved','points','cells']) assert.ok(Object.hasOwn(value,key),key);
    assert.equal(value.progress,0); assert.equal(value.points,0); assert.equal(value.achieved,false); assert.deepEqual(value.cells,[]);
  }
  for (const invalid of [null,1,'corners',[],{}, {id:'unknown',version:1}, {id:'corners',version:2}, {id:'corners',version:'1'}, {id:'corners',version:1,points:4}, {...objective('corners'),[Symbol('extra')]:true}]) {
    assert.throws(() => engine.validateObjective(invalid), e => e.code === 'invalid-objective');
    assert.throws(() => evaluateObjective(createGarden(),invalid));
    assert.throws(() => scoreGarden(createGarden(),invalid));
  }
  const accessor = {version:1}; Object.defineProperty(accessor,'id',{enumerable:true,get(){assert.fail('getter executed');}});
  assert.throws(() => engine.validateObjective(accessor),e=>e.code==='invalid-objective');
  for(const key of ['id','version']) {
    const hidden=objective('corners');Object.defineProperty(hidden,key,{enumerable:false});
    assert.throws(()=>engine.validateObjective(hidden),e=>e.code==='invalid-objective');
  }
  const custom=Object.assign(Object.create({extra:true}),objective('corners'));
  assert.throws(()=>engine.validateObjective(custom),e=>e.code==='invalid-objective');
  const nullPrototype=Object.assign(Object.create(null),objective('corners'));
  assert.equal(engine.validateObjective(nullPrototype),nullPrototype);
});

test('corners require all four and four distinct terrains, not merely four tiles or different diagonals', () => {
  const win = snapshots.corners();
  assert.equal(status(win,'corners').points,4); assert.deepEqual(status(win,'corners').corners,CORNERS);
  for (const absent of CORNERS) { const board=structuredClone(win); board[absent]=null; assert.equal(status(board,'corners').points,0); assert.equal(status(board,'corners').progress,3); }
  const duplicate = structuredClone(win); duplicate[15]=createTile('cloud');
  assert.equal(status(duplicate,'corners').points,0); assert.equal(status(duplicate,'corners').progress,3);
  assert.equal(status(garden([0,5,10,15],terrain),'corners').points,0);
  assert.equal(scoreGarden(win).objective.points,4); // Undefined remains the old rule.
});

for (const type of terrain) test(`same-terrain objective accepts connected group of four ${type} tiles`, () => {
  const board=garden([0,1,5,9],type), value=status(board,'terrain-cluster');
  assert.equal(value.points,4); assert.equal(value.progress,4); assert.deepEqual(value.cells,[0,1,5,9]);
  board[13]=createTile(type); assert.equal(status(board,'terrain-cluster').points,4); assert.equal(status(board,'terrain-cluster').progress,4);
});
test('same-terrain objective rejects three, diagonal contact, row wrap and disconnected totals', () => {
  for (const cells of [[0,1,5],[0,5,10,15],[2,3,4,5],[0,1,10,11]]) assert.equal(status(garden(cells),'terrain-cluster').points,0,cells.join(','));
  assert.equal(status(garden([0,1,5,9],['cloud','cloud','cloud','lake']),'terrain-cluster').points,0);
  const board=garden([0,1,4,5,10,11,14,15]);
  assert.equal(status(board,'terrain-cluster').points,4,'two qualifying groups still award just four');
});

test('flow objective counts six distinct reciprocally connected tiles in paths and loops', () => {
  const loop=flowLoop(), value=status(loop,'flow-chain');
  assert.equal(value.progress,6); assert.equal(value.points,4); assert.deepEqual(value.cells,[0,1,2,4,5,6]);
  assert.equal(scoreGarden(loop,objective('flow-chain')).connectionPoints,6);
  const path=structuredClone(loop); path[0]=createTile('cloud','straight',1); path[4]=createTile('lake','straight',1);
  assert.equal(status(path,'flow-chain').points,4); assert.equal(scoreGarden(path,objective('flow-chain')).connectionPoints,5);
  path[4]=createTile('lake','bend',1); path[8]=createTile('forest','straight',0);
  assert.equal(status(path,'flow-chain').points,4); assert.equal(status(path,'flow-chain').progress,6); assert.equal(status(path,'flow-chain').cells.length,7);
});
test('flow objective rejects five, shorter loops, nonreciprocal contact, diagonals and row wrap', () => {
  const five=flowLoop(); five[4]=null; assert.equal(status(five,'flow-chain').progress,5); assert.equal(status(five,'flow-chain').points,0);
  const short=createGarden(); for (const [i,r]of [[0,1],[1,2],[5,3],[4,0]]) short[i]=createTile('cloud','bend',r);
  assert.equal(scoreGarden(short,objective('flow-chain')).connectionPoints,4); assert.equal(status(short,'flow-chain').progress,4); assert.equal(status(short,'flow-chain').points,0);
  const broken=flowLoop(); broken[0]=createTile('cloud','bend',3); broken[4]=createTile('cloud','straight',1);
  assert.equal(status(broken,'flow-chain').points,0);
  assert.equal(status(garden([0,5,10,15]),'flow-chain').progress,1);
  const wrap=garden([2,3,4,5,6,7]); for (const tile of wrap.filter(Boolean)) tile.rotation=1;
  assert.equal(status(wrap,'flow-chain').progress,4); assert.equal(status(wrap,'flow-chain').points,0);
});

for (let line=0;line<8;line++) test(`diverse line accepts fully occupied ${line<4?'row':'column'} ${line%4+1}`, () => {
  const cells=Array.from({length:4},(_,n)=>line<4?line*4+n:n*4+line-4);
  const board=garden(cells,terrain);
  assert.equal(status(board,'diverse-line').points,4); assert.equal(status(board,'diverse-line').progress,4); assert.deepEqual(status(board,'diverse-line').cells,cells);
  const duplicate=structuredClone(board);duplicate[cells[3]]=createTile('cloud');assert.equal(status(duplicate,'diverse-line').points,0);
  for (const absent of cells) {const partial=structuredClone(board); partial[absent]=null; assert.equal(status(partial,'diverse-line').points,0);}
});
test('diverse line rejects diagonal/row-wrap collections and never multiplies multiple completed lines', () => {
  for (const cells of [[0,5,10,15],[2,3,4,5]]) assert.equal(status(garden(cells,terrain),'diverse-line').points,0);
  const board=Array.from({length:16},(_,i)=>createTile(terrain[(Math.floor(i/4)+i%4)%5]));
  assert.equal(status(board,'diverse-line').points,4);
});

for (const id of OBJECTIVE_IDS) test(`${id}: stable repeated scoring, same four points for every achiever, no placement mutation`, () => {
  const board=snapshots[id](), before=structuredClone(board);
  for(let i=0;i<5;i++) assert.equal(scoreGarden(board,objective(id)).objective.points,4);
  assert.deepEqual(board,before);
  const state=match.createMatch({objectiveId:id}); state.players.forEach(p=>{p.garden=structuredClone(board);});
  const ranks=match.rankMatch(state); assert.deepEqual(ranks.map(r=>r.rank),[1,1,1,1]);
  ranks.forEach(r=>assert.equal(r.score,scoreGarden(board,objective(id)).total));
});

test('all other scoring and stone 2-per-condition / cap-6 rules remain identical', () => {
  const boards=[oldEngine.createExampleGarden(),garden([0,1,2,3],'lake')];boards[1][1].stone='moon';
  const wind=garden([1,4,5,6,9]);wind[5].stone='wind';boards.push(wind);
  const color=garden([1,4,5,6,9],['cloud','lake','magic','crystal','forest']);color[5].stone='color';boards.push(color);
  for (const board of boards) for (const id of OBJECTIVE_IDS) {
    const old=oldEngine.scoreGarden(board), current=scoreGarden(board,objective(id));
    for(const key of ['connectionPoints','stonePoints','connections','stones','filled']) assert.deepEqual(current[key],old[key],key);
    assert.equal(current.total,old.connectionPoints+old.stonePoints+current.objective.points);
  }
  for(const board of boards.slice(1)){const stone=scoreGarden(board).stones[0];assert.equal(stone.rawPoints,8);assert.equal(stone.points,6);assert.equal(stone.capped,true);}
});

test('selected objective changes ranking while the identical legacy boards keep corner-only ranking', () => {
  const state=match.createMatch({playerCount:2,objectiveId:'terrain-cluster'});
  state.players[0].garden=snapshots['terrain-cluster']();state.players[1].garden=snapshots.corners();
  assert.deepEqual(match.rankMatch(state).map(({seat,score,rank})=>({seat,score,rank})),[
    {seat:0,score:6,rank:1},{seat:1,score:0,rank:2},
  ]);
  const legacy=structuredClone(state);legacy.version=match.LEGACY_MATCH_VERSION;delete legacy.objective;
  assert.deepEqual(match.rankMatch(legacy).map(({seat,score,rank})=>({seat,score,rank})),[
    {seat:1,score:4,rank:1},{seat:0,score:2,rank:2},
  ]);
});

test('seeded objective is deterministic, separately namespaced and never alters the shuffled deck', () => {
  const found=new Set();
  for(let seed=0;seed<100;seed++) {
    const a=match.createMatch({seed}), b=match.createMatch({seed:String(seed)}), old=oldMatch.createMatch({seed});
    assert.deepEqual(a,b);assert.deepEqual(a.deck,old.deck); assert.equal(a.objective.id,engine.selectObjectiveId(seed));found.add(a.objective.id);
    for(const id of OBJECTIVE_IDS) assert.deepEqual(match.createMatch({seed,objectiveId:id}).deck,old.deck);
  }
  assert.deepEqual([...found].sort(),[...OBJECTIVE_IDS].sort());
  for(const seed of [null,{},NaN,Infinity])assert.throws(()=>engine.selectObjectiveId(seed));
  assert.throws(()=>match.createMatch({objectiveId:'invalid'}));assert.throws(()=>match.createMatch({legacy:true,objectiveId:'corners'}));
});

test('match invariants reject missing, extra, invalid objective metadata and unknown match versions', () => {
  const state=match.createMatch();
  for(const mutate of [s=>delete s.objective,s=>s.objective=null,s=>s.objective.id='bad',s=>s.objective.version=2,s=>s.objective.extra=true,s=>s.version='unknown',s=>s.version=match.LEGACY_MATCH_VERSION]){
    const changed=structuredClone(state);mutate(changed);assert.throws(()=>match.assertMatchInvariants(changed));assert.throws(()=>match.rankMatch(changed));
  }
  const old=match.createMatch({legacy:true});old.objective=undefined;assert.throws(()=>match.assertMatchInvariants(old));
  assert.equal(Object.hasOwn(match.publicMatch(state),'objective'),true);
  for(const key of ['seed','deck','deckCursor'])assert.equal(Object.hasOwn(match.publicMatch(state),key),false);
});

test('CPU placement evaluates the active shared objective rather than always corners', () => {
  for (const id of OBJECTIVE_IDS) {
    const board=snapshots[id](); const missing=id==='corners'?15:id==='terrain-cluster'?9:id==='flow-chain'?4:7;
    const tile=board[missing];board[missing]=null;
    const best=bestTilePlacement(board,tile,objective(id));
    const placed=engine.placeTile(board,best.index,createTile(tile.terrain,tile.shape,best.rotation));
    assert.equal(status(placed,id).achieved,true,id);
    const visible={step:'place',objective:objective(id),players:[{garden:board}],drawn:{tile}};
    for(const secret of ['seed','deck','deckCursor'])Object.defineProperty(visible,secret,{get(){assert.fail('hidden '+secret+' read');}});
    const legal=board.flatMap((cell,index)=>cell?[]:Array.from({length:4},(_,rotation)=>({type:'place',seat:0,index,rotation,revision:0})));
    assert.deepEqual(chooseCpuAction(visible,legal),legal.find(a=>a.index===best.index&&a.rotation===best.rotation));
  }
});

for (const playerCount of [2,3,4]) test(`legacy ${playerCount}-player state and CPU behavior exactly match the preserved implementation`, () => {
  let state=match.createMatch({playerCount,seed:'legacy-objective-fixture',legacy:true}), old=oldMatch.createMatch({playerCount,seed:'legacy-objective-fixture'});
  assert.deepEqual(state,old);let actions=0;
  while(state.phase!=='finished'){
    const decision=chooseCpuAction(match.publicMatch(state),match.legalActions(state));
    assert.deepEqual(decision,oldCpu(oldMatch.publicMatch(old),oldMatch.legalActions(old)));
    state=match.applyMatchAction(state,decision);old=oldMatch.applyMatchAction(old,decision);assert.deepEqual(state,old);assert.ok(++actions<2000);
  }
  assert.deepEqual(match.rankMatch(state),oldMatch.rankMatch(old));
  assert.deepEqual(bestTilePlacement(createGarden(),createTile('cloud')),oldPlacement(createGarden(),createTile('cloud')));
});

for(const id of OBJECTIVE_IDS)test(`${id}: four-player all-CPU match terminates with fixed public objective and legal actions`,()=>{
  let state=match.createMatch({playerCount:4,seed:'all-cpu-'+id,humanSeat:-1,objectiveId:id}), steps=0;
  while(state.phase!=='finished'){
    const visible=match.publicMatch(state),legal=match.legalActions(state),action=chooseCpuAction(visible,legal);
    assert.ok(legal.some(a=>JSON.stringify(a)===JSON.stringify(action)));state=match.applyMatchAction(state,action);
    assert.deepEqual(state.objective,objective(id));assert.ok(++steps<2000);
  }
  assert.ok(state.players.every(p=>p.garden.every(Boolean)));assert.ok(match.assertMatchInvariants(state));
  for(const rank of match.rankMatch(state))assert.equal(rank.score,scoreGarden(state.players[rank.seat].garden,objective(id)).total);
});

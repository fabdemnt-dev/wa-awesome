/** Synthetic compatibility only: no real API, auth, browser, or online room. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMatch, publicMatch, MATCH_VERSION, SOLO_MATCH_VERSION } from '../floating-garden/match-engine.js';
import { createOnlineController, ONLINE_SAVE_KEY } from '../floating-garden/online/controller.js';
import { HUMAN4_RULES_VERSION, HUMAN3_RULES_VERSION, NPC_RULES_VERSION } from '../floating-garden/online/modes.js';
const modes=[[2,0],[2,1],[2,2],[3,0],[3,1],[4,0]];
function fixture(humans,npcs,legacy=true){
  const match=publicMatch(createMatch({playerCount:humans+npcs,seed:'offline-compatibility',legacy}));
  match.players.forEach((p,seat)=>p.isHuman=seat<humans);
  const room={id:'offline-room',revision:1,gameId:'offline-game',status:'playing',playerCount:humans+npcs,humanSeatCount:humans,npcCount:npcs,hostSeat:0,players:match.players.map(({seat,isHuman,name})=>({seat,isHuman,name})),match,rulesVersion:humans===4?HUMAN4_RULES_VERSION:humans===3?HUMAN3_RULES_VERSION:npcs?NPC_RULES_VERSION:MATCH_VERSION};
  let raw=JSON.stringify({version:1,uid:'offline-user',roomId:room.id,inviteCode:null,pending:null});
  const controller=createOnlineController({ensureUser:async()=>({uid:'offline-user'}),storage:{getItem:key=>{assert.equal(key,ONLINE_SAVE_KEY);return raw;},setItem:(key,value)=>{assert.equal(key,ONLINE_SAVE_KEY);raw=value;}},api:{getSnapshot:async()=>({room,self:{seat:0,isHost:true}})},subscribe:()=>()=>{}});
  return {controller,room};
}
for(const [humans,npcs] of modes)test(`unchanged online controller still accepts legacy ${humans}+${npcs} snapshots`,async()=>{
  const {controller,room}=fixture(humans,npcs);await controller.resume();
  assert.equal(controller.getState().connection,'ready');assert.deepEqual(controller.getState().room,room);
  assert.equal(room.match.version,'floating-garden-match-1');assert.equal(room.match.objective,undefined);
  controller.dispose();
});
test('solo v2 is not accepted as an old online protocol snapshot',async()=>{
  assert.equal(MATCH_VERSION,'floating-garden-match-1');assert.equal(SOLO_MATCH_VERSION,'floating-garden-match-2');
  const {controller}=fixture(2,0,false);await controller.resume();
  assert.equal(controller.getState().connection,'syncing');assert.equal(controller.getState().room,null);controller.dispose();
});
test('solo module import closure pins changed UI modules and unchanged game modules to their exact release tags',()=>{
  const refreshed = new Set(['match-app.js','match-view.js','match-rule-examples.js']);
  const pending=['match-app.js'],seen=new Set();
  while(pending.length){const file=pending.pop();if(seen.has(file))continue;seen.add(file);
    const text=readFileSync(new URL('../floating-garden/'+file,import.meta.url),'utf8');
    for(const [,target] of text.matchAll(/from ['"]\.\/([^'"]+)['"]/g)){
      const dependency = target.split('?')[0];
      const tag = refreshed.has(dependency) ? '20261023-rule-examples-1' : '20261023-solo-objectives-1';
      assert.equal(target, `${dependency}?v=${tag}`, `${file}: ${target}`); pending.push(dependency);
    }
  }
  assert.deepEqual([...seen].sort(),['cpu.js','engine.js','match-app.js','match-assist.js','match-engine.js','match-rule-examples.js','match-save.js','match-view.js','session.js','view.js']);
});

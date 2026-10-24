// Offline only: exact handlers over loopback; synthetic identities and storage.
import {createOnlineController,ONLINE_SAVE_KEY,ONLINE_PARKED_KEY} from '../../floating-garden/limited-trial/online/controller.js';
import {mountOnline} from '../../floating-garden/limited-trial/online/mount.js';
const rpc=async input=>{const r=await fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});const out=await r.json();if(out.error)throw Object.assign(Error(out.error.message),out.error);return out;};
let previous;
export async function reset(fresh=true){
 previous?.dispose();const initial=await rpc({method:'reset',fresh});const session=initial.session;
 const roots=[0,1].map(i=>document.querySelector('#seat'+i)),clients=[],mounts=[],watches=[],calls=[];
 let legacy=null;
 const flags={delay:0,lose:false,failSave:false,userMismatch:false,delayAuth:0};let oldCallback=null;
 const key=(i,k=ONLINE_SAVE_KEY)=>`room-switch-fixture-${session}-${i}`+(k===ONLINE_SAVE_KEY?'':':'+k);
 const records=[{version:1,uid:'offline-seat-1',roomId:initial.oldRoomId,pending:null},{version:1,uid:'offline-seat-2',roomId:initial.newRoomId,pending:null}];
 for(let i=0;i<2;i++){if(fresh)localStorage.removeItem(key(i,ONLINE_PARKED_KEY));if(fresh||!localStorage.getItem(key(i)))localStorage.setItem(key(i),JSON.stringify(records[i]));}
 const original=localStorage.getItem(key(0));
 async function publish(room){for(const w of watches)if(w.active&&w.roomId===room.id)w.fn({room:structuredClone(room)});}
 async function mount(i){
 const seat=i+1;
 const call=async(name,payload)=>{const r=await rpc({method:'call',session,seat,name,payload});if(r.room)await publish(r.room);return r;};
 clients[i]=createOnlineController({ensureUser:async()=>{if(i===0&&flags.delayAuth)await new Promise(r=>setTimeout(r,flags.delayAuth));return {uid:flags.userMismatch&&i===0?'wrong-user':'offline-seat-'+seat};},storage:{getItem:k=>localStorage.getItem(key(i,k)),setItem:(k,v)=>{if(flags.failSave&&i===0)throw Error('quota');localStorage.setItem(key(i,k),v);}},subscribe:(roomId,fn)=>{const w={roomId,fn,active:true};watches.push(w);if(i===0&&!oldCallback)oldCallback=fn;return()=>w.active=false;},api:{getSnapshot:p=>call('GetSnapshot',p),create:p=>call('CreateRoom',p),join:p=>call('JoinRoom',p),start:p=>call('StartMatch',p),submit:async p=>{calls.push({seat,...structuredClone(p)});if(flags.delay)await new Promise(r=>setTimeout(r,flags.delay));const r=await call('SubmitAction',p);if(flags.lose){flags.lose=false;throw Object.assign(Error('lost after commit'),{code:'unavailable'});}return r;}}});
 mounts[i]=mountOnline(roots[i],{controller:clients[i]});await mounts[i].ready;
 }
 for(let i=0;i<2;i++)await mount(i);
 const onStorage=event=>{for(let i=0;i<2;i++)if(event.key===key(i)||event.key===key(i,ONLINE_PARKED_KEY)||event.key===null)clients[i].storageChanged();};
 window.addEventListener('storage',onStorage);
 previous={async legacyTerminalReturn(){
 const {createOnlineController:createLegacy}=await import('/legacy-controller.js');
 // Exact legacy controller with the actual finished-room snapshot.
 legacy=createLegacy({storage:{getItem:k=>localStorage.getItem(key(0,k)),setItem:(k,v)=>localStorage.setItem(key(0,k),v)},ensureUser:async()=>({uid:'offline-seat-1'}),api:{getSnapshot:payload=>rpc({method:'call',session,seat:1,name:'GetSnapshot',payload})}});
 await legacy.resume();return legacy.requestReturn();
 },legacyReturn:()=>legacy.returnToEntry(),archive:()=>localStorage.getItem(key(0,ONLINE_PARKED_KEY)),initial,flags,clients,roots,calls,original,state:i=>clients[i].getState(),raw:i=>localStorage.getItem(key(i)),status:i=>roots[i].querySelector('[data-seat-assist-status]').textContent,click(i,a){const b=roots[i].querySelector(`[data-action="${a}"]`);if(!b||b.disabled)throw Error('unavailable '+a);b.click();},input(i,id,value){const e=roots[i].querySelector('#'+id);e.value=value;e.dispatchEvent(new Event('input',{bubbles:true}));},async reload(i){mounts[i].unmount();await mount(i);},lateOld(){oldCallback({room:{...initial.room,revision:999}});},evidence:()=>rpc({method:'evidence',session,seat:1}),dispose(){window.removeEventListener('storage',onStorage);mounts.forEach(m=>m.unmount());}};
 return previous;
}

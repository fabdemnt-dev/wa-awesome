// Offline SDK, timers and storage only. Never load Firebase SDK or contact Cloud.
import {createOnlineController} from '../../floating-garden/limited-trial/online/controller.js';
import {mountOnline} from '../../floating-garden/limited-trial/online/mount.js';
import {createTrialFirebaseTransport} from '../../floating-garden/limited-trial/play/firebase.js';
import runtime from '../../floating-garden/limited-trial/play/trialruntime.js';
export async function verifyStoppedRuntime() {
 if (runtime.enabled !== false) throw Error('STOPPED_RUNTIME_REQUIRED');
 let loads=0, rejected=false;
 try { await createTrialFirebaseTransport(runtime,{href:'https://fabdemnt-dev.github.io/wa-awesome/floating-garden/limited-trial/play/'},{loadSdk:async()=>{loads++;throw Error('SDK_MUST_NOT_LOAD');},environment:{}}); }
 catch { rejected=true; }
 if (!rejected || loads !== 0) throw Error('STOPPED_RUNTIME_NOT_BLOCKED_BEFORE_SDK');
 return true;
}
// Only this fake-SDK harness opts in; the imported distribution stays stopped.
const syntheticRuntime = {...runtime, enabled:true};
let previous;
export async function reset(mode='pending', lockMode='native') {
 previous?.dispose();
 const root=document.querySelector('#seat0'); root.innerHTML=''; root.inert=false;
 let elapsed=0; const lockRequests=[];
 let release, count=0, signins=0, calls=0, writes=0, readyCalls=0;
 const hold=new Promise(r=>release=r), timers=new Map(); let serial=0;
 const auth={currentUser:null,authStateReady:async()=>{readyCalls++;if(mode==='pending')await hold;}};
 const sdk={appSdk:{getApps:()=>[],initializeApp:()=>({}),deleteApp:async()=>{}},
 appCheckSdk:{ReCaptchaEnterpriseProvider:class{},initializeAppCheck:()=>({}),getToken:async()=>({token:'FAKE'}),setTokenAutoRefreshEnabled(){}},
 authSdk:{getAuth:()=>auth,browserLocalPersistence:{},setPersistence:async()=>{},signInAnonymously:async()=>{signins++;if(mode==='signing')await hold;return {user:auth.currentUser={uid:'fake-user',isAnonymous:true}};}},
 firestoreSdk:{initializeFirestore:()=>({}),disableNetwork:async()=>{}},
 functionsSdk:{getFunctions:()=>({}),httpsCallable:()=>async()=>{calls++;return new Promise(()=>{});}}};
 const transport=await createTrialFirebaseTransport(syntheticRuntime,{href:'https://fabdemnt-dev.github.io/wa-awesome/floating-garden/limited-trial/play/'},{loadSdk:async()=>sdk,environment:{},setTimer:(fn,ms)=>{timers.set(++serial,{fn,ms});return serial;},clearTimer:id=>timers.delete(id)});
 const map=new Map();let storageFail=false;
 const locks=lockMode==='native'?navigator.locks:lockMode==='pending'?{request:(name,options,fn)=>new Promise((resolve,reject)=>lockRequests.push({fn,resolve,reject}))}:null;
 const controller=createOnlineController({...transport,locks,clock:()=>elapsed,setTimer:(fn,ms)=>{timers.set(++serial,{fn,ms});return serial;},clearTimer:id=>timers.delete(id),storage:{getItem:k=>{if(storageFail)throw Error('fake storage');return map.get(k)??null;},setItem:(k,v)=>{writes++;map.set(k,v);}}});
 const mounted=mountOnline(root,{controller}); mounted.ready.catch(()=>{});
 previous={controller,root,timers,transport,ready:mounted.ready,release,counts:()=>({signins,calls,writes,readyCalls}),state:()=>controller.getState(),failStorage:()=>storageFail=true,
 tick(ms=12000){elapsed+=ms;for(const [id,t]of [...timers])if(t.ms<=ms){timers.delete(id);t.fn();}},
 async deliverLock(index=0){const r=lockRequests[index];try{r.resolve(await r.fn({}));}catch(e){r.reject(e);}}, lockCount:()=>lockRequests.length,
 click(){root.querySelector('[data-action=resume]')?.click();},
 dispose(){mounted.unmount();transport.dispose();}};
 return previous;
}

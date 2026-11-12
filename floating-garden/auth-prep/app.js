import runtime from './runtime.js';
import {createPreparation} from './core.js';
import {createAuthSession} from './adapter.js';
const status=document.querySelector('#status');
const existing=document.querySelector('#existing'),create=document.querySelector('#create');
// Neither SDK nor storage is touched on page load, including when controls are enabled.
const prep=createPreparation({...runtime,href:location.href,getStorage:()=>localStorage,locks:navigator.locks,loadSession:controls=>createAuthSession(controls)});
if(runtime.enabled)document.querySelector('#intro').textContent='承認された範囲で匿名認証だけを準備します。庭園の受付は開きません。';
existing.disabled=!runtime.enabled;create.disabled=!runtime.enabled||!runtime.allowCreate;
async function act(wantsCreate){existing.disabled=true;create.disabled=true;status.textContent='匿名認証だけを確認しています。庭園には接続しません。';
 try{const r=await prep.prepare({create:wantsCreate});status.textContent=r.status==='ready-created'?'匿名認証を1つ準備しました。この窓を閉じずに待ってください。':'既存の匿名認証を確認しました。この窓を閉じずに待ってください。';}
 catch(e){status.textContent=e.message;}
 // Every attempt requires human review; no auto-retry button or navigation.
}
existing.addEventListener('click',()=>void act(false));create.addEventListener('click',()=>void act(true));
document.querySelector('#stop').addEventListener('click',()=>{prep.stop();existing.disabled=true;create.disabled=true;status.textContent='中止しました。送信済みの要求を取り消せたとは限りません。窓を保ってdotへ伝えてください。';});

import runtime from './runtime.js';
import {createPreparation} from './core.js';
import {createAuthSession} from './adapter.js';
import {createExistingWindow} from './window.js';
const status=document.querySelector('#status');
const existing=document.querySelector('#existing'),create=document.querySelector('#create');
const slot=createExistingWindow(runtime);
const prep=createPreparation({enabled:slot.valid,allowCreate:false,isWindowOpen:slot.isOpen,
  href:location.href,getStorage:()=>localStorage,locks:navigator.locks,
  loadSession:controls=>createAuthSession(controls),
  onDiagnostic:d=>{document.querySelector('#diagnostic').textContent=JSON.stringify(d);}});
const outside='確認時間外です。送信済みの処理は取り消せない場合があります。';
let attempted=false,stopped=false;
function refresh(){
  const open=slot.isOpen();
  existing.disabled=!open||attempted||stopped;
  create.disabled=true;
  if(!open && attempted && prep.pending && !stopped){prep.stop();status.textContent=outside;}
}
if(slot.valid){
  document.querySelector('#intro').textContent='この時間帯は既存の匿名認証だけを確認します。新規作成・庭園への接続は行いません。';
  for(const t of [slot.startsAtMs,slot.endsAtMs]){
    const delay=t-Date.now();
    if(delay>0&&delay<=2147483647)setTimeout(refresh,delay);
  }
}
refresh();
addEventListener('pageshow',refresh);
addEventListener('focus',refresh);
document.addEventListener('visibilitychange',refresh);
existing.addEventListener('click',async()=>{
  if(stopped||attempted)return;
  if(!slot.isOpen()){refresh();status.textContent=outside;return;}
  attempted=true;refresh();status.textContent='既存の匿名認証を確認しています。庭園には接続しません。';
  try{
    const result=await prep.prepare({create:false});
    if(!stopped)status.textContent=slot.isOpen()&&result.status==='ready-existing'
      ? '既存の匿名認証を確認しました。この窓を閉じずに待ってください。' : outside;
  }catch(e){if(!stopped)status.textContent=slot.isOpen()?e.message:outside;}
});
document.querySelector('#stop').addEventListener('click',()=>{
  stopped=true;prep.stop();refresh();status.textContent='中止しました。送信済みの要求を取り消せたとは限りません。窓を保ってdotへ伝えてください。';
});

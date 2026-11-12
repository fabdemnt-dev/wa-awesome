// Pure coordinator. Construction performs no storage access, SDK loading, or network.
export const MARKER = 'floating-garden-auth-preparation:wa-awesome:v1';
export const LOCK = 'floating-garden-auth-preparation:wa-awesome';
const messages = Object.freeze({disabled:'認証の準備はまだ有効にしていません。', origin:'配信元を確認できないため停止しました。', busy:'別の確認が進んでいます。重ねて作成しません。', storage:'保存を確認できないため、新しい認証は作りません。', existing:'既存の匿名認証を確認できません。新しい認証は作っていません。', nonanonymous:'匿名認証ではないため停止しました。ログアウトや置換はしません。', attempted:'この環境は作成を試行済みです。繰り返さずdotへ伝えてください。', unknown:'結果を確認できません。作り直さず、この窓を保ったままdotへ伝えてください。', stopped:'中止しました。新しい認証は作りません。', appcheck:'App Checkを確認できません。代替方法では接続しません。'});
const problem = code => Object.assign(new Error(messages[code] || messages.unknown), {code});
export function isExpectedOrigin(href) {
  try { const u=new URL(href);return u.origin==='https://fabdemnt-dev.github.io' && href.startsWith('https://fabdemnt-dev.github.io/') && !u.username && !u.password && !u.port && !href.includes('?') && u.pathname==='/wa-awesome/floating-garden/auth-prep/'; } catch {return false;}
}
export function createPreparation({enabled=false,allowCreate=false,href='',getStorage,locks,loadSession,timeoutMs=12000,setTimer=setTimeout,clearTimer=clearTimeout}={}) {
  let flight=null,stopped=false;
  const timed = promise => new Promise((resolve,reject)=>{const timer=setTimer(()=>reject(problem('unknown')),timeoutMs);Promise.resolve(promise).then(v=>{clearTimer(timer);resolve(v);},()=>{clearTimer(timer);reject(problem('unknown'));});});
  const active=()=>{if(stopped)throw problem('stopped');};
  function prepare({create=false}={}) {
    if(!enabled || (create && !allowCreate))return Promise.reject(problem('disabled'));
    if(!isExpectedOrigin(href))return Promise.reject(problem('origin'));
    if(stopped)return Promise.reject(problem('stopped'));
    if(flight)return flight;
    if(!locks?.request)return Promise.reject(problem('storage'));
    flight=locks.request(LOCK,{mode:'exclusive',ifAvailable:true},async lock=>{
      if(!lock)throw problem('busy');active();
      let storage,session,attempted=false;
      try {
        storage=getStorage();
        const previous=storage.getItem(MARKER);
        let acceptSession=true;
        const loading=Promise.resolve().then(()=>loadSession({isCurrent:()=>acceptSession&&!stopped}));
        loading.then(s=>{if(!acceptSession)Promise.resolve(s.dispose()).catch(()=>{});},()=>{});
        try{session=await timed(loading);}catch(e){acceptSession=false;throw e;}
        active();
        await timed(session.ready());active();
        if(session.localPersistence!==true)throw problem('storage');
        const existing=session.currentUser();
        if(existing){if(existing.isAnonymous!==true || typeof existing.uid!=='string' || !existing.uid)throw problem('nonanonymous');return Object.freeze({status:'ready-existing'});}
        if(!create)throw problem('existing');
        if(previous!==null)throw problem('attempted');
        // Local persistence must be confirmed before any new account request.
        if(session.localPersistence!==true)throw problem('storage');
        storage.setItem(MARKER,'attempted');
        if(storage.getItem(MARKER)!=='attempted')throw problem('storage');
        active();attempted=true;
        const result=await timed(session.createAnonymous());active();
        const user=session.currentUser();
        if(!user || user.isAnonymous!==true || !user.uid || result?.uid!==user.uid)throw problem('unknown');
        storage.setItem(MARKER,'created');
        return Object.freeze({status:'ready-created'});
      } catch(error) {
        if(attempted){try{storage.setItem(MARKER,'unknown');}catch{};throw problem('unknown');}
        throw error?.code && Object.hasOwn(messages,error.code)?error:problem('storage');
      } finally {if(session)try{await session.dispose();}catch{}}
    }).finally(()=>{flight=null;});
    return flight;
  }
  return Object.freeze({prepare,stop(){stopped=true;},get pending(){return flight!==null;}});
}

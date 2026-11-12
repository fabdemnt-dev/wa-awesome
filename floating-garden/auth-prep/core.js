import {allowlistedCode} from './error-taxonomy.js';
// Pure coordinator. Construction performs no storage access, SDK loading, or network.
export const MARKER = 'floating-garden-auth-preparation:wa-awesome:v1';
export const LOCK = 'floating-garden-auth-preparation:wa-awesome';
const messages = Object.freeze({disabled:'認証の準備はまだ有効にしていません。', origin:'配信元を確認できないため停止しました。', busy:'別の確認が進んでいます。重ねて作成しません。', storage:'保存を確認できないため、新しい認証は作りません。', existing:'既存の匿名認証を確認できません。新しい認証は作っていません。', nonanonymous:'匿名認証ではないため停止しました。ログアウトや置換はしません。', attempted:'この環境は作成を試行済みです。繰り返さずdotへ伝えてください。', unknown:'結果を確認できません。作り直さず、この窓を保ったままdotへ伝えてください。', stopped:'中止しました。新しい認証は作りません。', appcheck:'App Checkを確認できません。代替方法では接続しません。'});
const problem = code => Object.assign(new Error(messages[code] || messages.unknown), {code});
export function isExpectedOrigin(href) {
  try { const u=new URL(href);return u.origin==='https://fabdemnt-dev.github.io' && href.startsWith('https://fabdemnt-dev.github.io/') && !u.username && !u.password && !u.port && !href.includes('?') && u.pathname==='/wa-awesome/floating-garden/auth-prep/'; } catch {return false;}
}
export function createPreparation({enabled=false,allowCreate=false,href='',getStorage,locks,loadSession,onDiagnostic=()=>{},timeoutMs=12000,setTimer=setTimeout,clearTimer=clearTimeout}={}) {
  let flight=null,stopped=false,diagnosticOpen=false;
  const stages=new Set(['preflight','storage','sdk_load','appcheck','appcheck_provider','appcheck_initialize','appcheck_token','appcheck_validate','auth_ready','persistence','existing_check','attempt_mark','create_invoked','result_check','completion_mark']);
  let stage='preflight',failure=null,createInvoked=false,sdkCode=null;
  const emit=()=>{try{Promise.resolve(onDiagnostic(Object.freeze({stage,failure,create_invoked:createInvoked,...(sdkCode===null?{}:{sdk_error_code:sdkCode})}))).catch(()=>{});}catch{}};
  const mark=value=>{if(diagnosticOpen&&stages.has(value)){stage=value;emit();}};
  const classified=(code,kind)=>Object.assign(problem(code),{failure:kind});
  const safeFailure=e=>['timeout','rejected','stopped','mismatch','storage'].includes(e?.failure)?e.failure:e?.code==='stopped'?'stopped':e?.code==='storage'||['storage','attempt_mark','completion_mark'].includes(stage)?'storage':'rejected';
  const timed = promise => new Promise((resolve,reject)=>{const timer=setTimer(()=>reject(classified('unknown','timeout')),timeoutMs);Promise.resolve(promise).then(v=>{clearTimer(timer);resolve(v);},e=>{clearTimer(timer);reject(classified(['appcheck','nonanonymous','stopped'].includes(e?.code)?e.code:'unknown',e?.code==='stopped'?'stopped':'rejected'));});});
  const active=()=>{if(stopped)throw problem('stopped');};
  const rejectBefore=code=>{if(!diagnosticOpen&&failure!==null)return Promise.reject(problem(code));failure=code==='stopped'?'stopped':code==='storage'?'storage':'rejected';emit();return Promise.reject(problem(code));};
  function prepare({create=false}={}) {
    if(!enabled || (create && !allowCreate))return rejectBefore('disabled');
    if(!isExpectedOrigin(href))return rejectBefore('origin');
    if(stopped)return rejectBefore('stopped');
    if(flight)return flight;
    if(!locks?.request)return rejectBefore('storage');
    stage='preflight';failure=null;createInvoked=false;sdkCode=null;diagnosticOpen=true;flight=Promise.resolve().then(()=>locks.request(LOCK,{mode:'exclusive',ifAvailable:true},async lock=>{
      if(!lock)throw problem('busy');active();
      let storage,session,attempted=false;
      try {
        mark('storage');storage=getStorage();
        const previous=storage.getItem(MARKER);
        let acceptSession=true;
        const loading=Promise.resolve().then(()=>loadSession({isCurrent:()=>acceptSession&&!stopped,onStage:value=>{if(acceptSession&&!stopped)mark(value);},onErrorCode:value=>{if(acceptSession&&!stopped&&diagnosticOpen)sdkCode=allowlistedCode(value);}}));
        loading.then(s=>{if(!acceptSession)Promise.resolve(s.dispose()).catch(()=>{});},()=>{});
        mark('sdk_load');try{session=await timed(loading);}catch(e){acceptSession=false;throw e;}
        active();
        mark('auth_ready');active();await timed(session.ready());active();
        if(session.localPersistence!==true)throw problem('storage');
        mark('existing_check');active();const existing=session.currentUser();
        if(existing){if(existing.isAnonymous!==true || typeof existing.uid!=='string' || !existing.uid)throw problem('nonanonymous');return Object.freeze({status:'ready-existing'});}
        if(!create)throw problem('existing');
        if(previous!==null)throw problem('attempted');
        // Local persistence must be confirmed before any new account request.
        if(session.localPersistence!==true)throw problem('storage');
        mark('attempt_mark');storage.setItem(MARKER,'attempted');
        if(storage.getItem(MARKER)!=='attempted')throw problem('storage');
        active();attempted=true;
        stage='create_invoked';createInvoked=true;const request=session.createAnonymous();emit();const result=await timed(request);active();
        mark('result_check');active();const user=session.currentUser();
        if(!user || user.isAnonymous!==true || !user.uid || result?.uid!==user.uid)throw classified('unknown','mismatch');
        mark('completion_mark');active();storage.setItem(MARKER,'created');
        return Object.freeze({status:'ready-created'});
      } catch(error) {
        if(diagnosticOpen||failure===null){failure=safeFailure(error);emit();}
        if(attempted){try{storage.setItem(MARKER,'unknown');}catch{};throw problem('unknown');}
        throw error?.code && Object.hasOwn(messages,error.code)?error:problem('storage');
      } finally {diagnosticOpen=false;if(session)try{await session.dispose();}catch{}}
    })).then(result=>{if(stopped)throw problem(createInvoked?'unknown':'stopped');return result;}).catch(error=>{
      if(failure===null){failure=safeFailure(error);emit();}
      throw problem(error?.code && Object.hasOwn(messages,error.code)?error.code:'unknown');
    }).finally(()=>{diagnosticOpen=false;flight=null;});
    return flight;
  }
  return Object.freeze({prepare,stop(){stopped=true;if(!diagnosticOpen&&failure!==null)return;diagnosticOpen=false;failure='stopped';emit();},get pending(){return flight!==null;}});
}

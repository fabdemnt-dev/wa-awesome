import {PRODUCTION_AUTH_APP_NAME,PRODUCTION_FIREBASE_CONFIG,PRODUCTION_APP_CHECK_SITE_KEY} from '../../garden-trials/garden-limited-20261109-r1/floating-garden/limited-trial/play/config.js';
// Only Auth/App Check dependencies. No Firestore or Functions SDK or game imports.
export async function loadAuthSdk(){
  const [appSdk,appCheckSdk,authSdk]=await Promise.all([
    import('https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-check.js'),
    import('https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js'),
  ]);return {appSdk,appCheckSdk,authSdk};
}
export async function createAuthSession({loadSdk=loadAuthSdk,environment=globalThis,isCurrent=()=>true,onStage=()=>{}}={}){
  const stage=value=>{try{Promise.resolve(onStage(value)).catch(()=>{});}catch{}};
  stage('sdk_load');
  if(Object.hasOwn(environment,'FIREBASE_APPCHECK_DEBUG_TOKEN'))throw Object.assign(new Error('App Checkのデバッグ設定では進めません。'),{code:'appcheck'});
  const active=()=>{if(!isCurrent())throw Object.assign(new Error('中止しました。'),{code:'stopped'});};
  active();const {appSdk,appCheckSdk,authSdk}=await loadSdk();active();
  if(appSdk.getApps().some(app=>app.name===PRODUCTION_AUTH_APP_NAME))throw new Error('既存の同名アプリがあります。');
  const app=appSdk.initializeApp(PRODUCTION_FIREBASE_CONFIG,PRODUCTION_AUTH_APP_NAME);
  let check,auth,localPersistence=false;
  const dispose=async()=>{if(check)appCheckSdk.setTokenAutoRefreshEnabled(check,false);await appSdk.deleteApp(app);};
  try{
    stage('appcheck');check=appCheckSdk.initializeAppCheck(app,{provider:new appCheckSdk.ReCaptchaEnterpriseProvider(PRODUCTION_APP_CHECK_SITE_KEY),isTokenAutoRefreshEnabled:false});
    const token=await appCheckSdk.getToken(check,false);active();
    if(typeof token?.token!=='string'||!token.token)throw Object.assign(new Error('App Checkが確認できません。'),{code:'appcheck'});
    stage('auth_ready');auth=authSdk.getAuth(app);
    await auth.authStateReady();active();
    if(auth.currentUser && auth.currentUser.isAnonymous!==true)throw Object.assign(new Error('匿名認証ではないため停止しました。'),{code:'nonanonymous'});
    stage('persistence');await authSdk.setPersistence(auth,authSdk.browserLocalPersistence);localPersistence=true;active();
    return {get localPersistence(){return localPersistence;},ready:()=>auth.authStateReady(),currentUser:()=>auth.currentUser,createAnonymous:async()=>{const result=await authSdk.signInAnonymously(auth);return result.user;},dispose};
  }catch(error){await dispose();throw error;}
}

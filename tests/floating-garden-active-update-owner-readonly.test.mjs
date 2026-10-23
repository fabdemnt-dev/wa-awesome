import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FUNCTION_NAMES } from '../scripts/prepare-floating-garden-trial.mjs';
import { ACTIVE_UPDATE_SCOPE as S, canonicalData } from '../scripts/floating-garden-active-update.mjs';
import { createActiveUpdateProvider } from '../scripts/floating-garden-active-update-provider.mjs';
import { createCloudAdapter } from '../scripts/floating-garden-trial-cloud-adapter.mjs';
import { requireCiAuthPolicy } from '../scripts/floating-garden-ci-auth-policy.mjs';
import { createOwnerReadonlyPolicy, ownerDigest, loadOwnerJournal, OWNER_JOURNAL_DIRECTORY, OWNER_JOURNAL_FILES } from '../scripts/floating-garden-owner-readonly-policy.mjs';
import { createOwnerReadonlyClients, strictOwnerJson } from '../scripts/floating-garden-owner-readonly-clients.mjs';
import { createOwnerReadonlyFirestore, decodeOwnerFirestoreValue } from '../scripts/floating-garden-owner-readonly-firestore.mjs';
import { prepareOwnerReadonlyPreflight } from '../scripts/floating-garden-active-update-owner-readonly.mjs';
const ROOT=fileURLToPath(new URL('../',import.meta.url)), NOW=S.startsAtMillis+10000, OWNER='owner@example.invalid';
const roots=[];
async function home() { const p=await mkdtemp(join(tmpdir(),'garden-owner-readonly-')); roots.push(p); return p; }
test.after(async()=>{for(const p of roots)await rm(p,{recursive:true,force:true});});
import { createSyntheticOwnerJournal } from './helpers/floating-garden-owner-journal.mjs';
const policy=env=>createOwnerReadonlyPolicy({env,ownerHash:ownerDigest(OWNER),now:()=>NOW});
test('default owner API is inert and owner/CI brands cannot be interchanged',async()=>{
  assert.deepEqual(await prepareOwnerReadonlyPreflight(),{mode:'plan',cloudReads:0,cloudWrites:0,executionAllowed:false});
  const p=policy({}); assert.throws(()=>requireCiAuthPolicy(p));
  assert.throws(()=>createActiveUpdateProvider({ownerReadonlyPolicy:{}}));
  assert.throws(()=>createActiveUpdateProvider({ownerReadonlyPolicy:p,environmentPolicy:{}}));
});
test('every provider and adapter mutation entrance rejects owner brand before I/O',async()=>{
  let calls=0; const env={},p=policy(env), io=()=>{calls++;throw Error('unexpected IO');};
  const provider=createActiveUpdateProvider({ownerReadonlyPolicy:p,env,runner:io,requestClient:{request:io},db:{},now:()=>NOW});
  for(const method of ['inspect','inspectClosed','pause','updateFunctions','updateRules','updateHosting','deployCiStage','reopen'])await assert.rejects(provider[method]());
  assert.throws(()=>provider.bindJournal({providerStep:io}));
  const adapter=createCloudAdapter({ownerReadonlyPolicy:p,env,runner:io,requestClient:{request:io},db:{}});
  for(const method of ['createStoppedAdmin','replaceStoppedWindow','updateAdmin','deployFunctions','deployRules','deployHosting'])await assert.rejects(adapter[method]());
  for(const mode of ['deploy','resume','activate','stop'])await assert.rejects(adapter.preflight(mode));
  assert.equal(calls,0);
});
test('owner environment rejects credential, transport, TLS, endpoint and debug overrides',()=>{
  for(const [key,value] of Object.entries({CI:'true',GOOGLE_APPLICATION_CREDENTIALS:'/tmp/creds',CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE:'/tmp/creds',HTTPS_PROXY:'https://proxy.invalid',NODE_OPTIONS:'--inspect',GRPC_DEFAULT_SSL_ROOTS_FILE_PATH:'/tmp/ca',CLOUDSDK_REGIONAL_ENDPOINT_MODE:'regional',GOOGLE_CLOUD_PROJECT:'foreign'}))assert.throws(()=>policy({[key]:value}));
  const p=policy({}); for(const c of [{auth:{credential_file_override:'secret'}},{proxy:{address:'proxy'}},{core:{verbosity:'debug'}},{regional:{endpoint_mode:'regional'}}])assert.throws(()=>p.validateConfiguration(c));
  assert.equal(p.validateConfiguration({auth:{access_token:null},core:{project:S.project},api_endpoint_overrides:{run:null}}),true);
});
test('owner journal binds real Python fixture/status schema and rejects changed bytes or permissions',async()=>{
  const h=await home(),pins=await createSyntheticOwnerJournal(h), j=loadOwnerJournal({home:h,pins}); j.recheck(); assert.equal(j.ownerHash,ownerDigest(OWNER));
  const path=join(h,OWNER_JOURNAL_DIRECTORY,'after.json'); await chmod(path,0o644); assert.throws(()=>j.recheck()); await chmod(path,0o600);
  await writeFile(path,'{}'); assert.throws(()=>loadOwnerJournal({home:h,pins}));
});
test('journal hash is checked before parsing and caller cannot replace pinned hashes later',async()=>{
  const h=await home(),pins=await createSyntheticOwnerJournal(h),j=loadOwnerJournal({home:h,pins});
  const path=join(h,OWNER_JOURNAL_DIRECTORY,'after.json'); await writeFile(path,'{}'); pins['after.json']=createHash('sha256').update('{}').digest('hex'); assert.throws(()=>j.recheck());
});
test('strict response JSON rejects duplicate keys, invalid UTF8 and nonfinite values',()=>{
  for(const x of ['{"a":1,"a":2}','{"a":1,"\\u0061":2}','{"n":1e999}','[1,]','\u00a0{}','\f{}'])assert.throws(()=>strictOwnerJson(Buffer.from(x)));
  assert.throws(()=>strictOwnerJson(Buffer.from([0xff]))); assert.equal(Object.is(strictOwnerJson(Buffer.from('-0')),-0),true);
});
test('Firestore decoder preserves nanoseconds, map identity and double negative zero; rejects loss',()=>{
  const stamp=decodeOwnerFirestoreValue({timestampValue:'2026-10-09T04:00:00.123456789Z'});
  assert.equal(stamp._nanoseconds,123456789); assert(canonicalData(stamp).includes('timestamp'));
  assert.notEqual(canonicalData(stamp),canonicalData({_seconds:stamp._seconds,_nanoseconds:stamp._nanoseconds}));
  assert.equal(Object.is(decodeOwnerFirestoreValue({doubleValue:-0}),-0),true);
  for(const v of [{integerValue:'9007199254740993'},{integerValue:'-0'},{doubleValue:'NaN'},{referenceValue:'foreign'},{mapValue:[]},{timestampValue:'2026-02-30T00:00:00Z'},{booleanValue:true,stringValue:'x'}])assert.throws(()=>decodeOwnerFirestoreValue(v));
});
test('Firestore facade permits only branded bounded queries and read-only transactions',async()=>{
  const calls=[], token='c3ludGhldGlj'; const db=createOwnerReadonlyFirestore(async(url,body)=>{calls.push({url,body}); if(url.endsWith(':beginTransaction'))return{transaction:token};if(url.endsWith(':rollback'))return{};if(url.endsWith(':runQuery'))return[];return{collectionIds:['floatingGardenTrial']};});
  assert.equal(db.commit,undefined);assert.equal(db.batchWrite,undefined);assert.throws(()=>db.collection('foreign'));
  assert.throws(()=>db.collection('floatingGardenRooms').limit(20000));
  await assert.rejects(db.runTransaction(()=>{}, {readOnly:false}));
  await db.runTransaction(async tx=>{assert.equal(tx.set,undefined);await assert.rejects(tx.get({}));await tx.get(db.collection('floatingGardenRooms').limit(10001));},{readOnly:true});
  assert.deepEqual(calls[0].body,{options:{readOnly:{}}});assert.deepEqual(calls.at(-1).body,{transaction:token});
});
test('Firestore facade rejects foreign document paths and incomplete collection inventories',async()=>{
  const db=createOwnerReadonlyFirestore(async(url)=>url.endsWith(':listCollectionIds')?{collectionIds:['floatingGardenRooms'],nextPageToken:'more'}:{});
  await assert.rejects(db.listCollections());
  const tx=createOwnerReadonlyFirestore(async(url)=>url.endsWith(':beginTransaction')?{transaction:'eA=='}:url.endsWith(':runQuery')?[{document:{name:'projects/foreign/databases/(default)/documents/floatingGardenRooms/x',fields:{}}}]:{});
  await assert.rejects(tx.runTransaction(t=>t.get(tx.collection('floatingGardenRooms').limit(10001)),{readOnly:true}));
});
test('SDK wrapper gates exact commands, memory-only token and manual public 302',async()=>{
  const env={},p=policy(env),calls=[];const token='SYNTHETIC_PRIVATE_TOKEN_123456789';
  const spawn=(path,args,options)=>{calls.push(args);assert(options.input.startsWith('n\n'));assert.equal(options.env.CLOUDSDK_CORE_DISABLE_PROMPTS,'false');
    let value={};if(args[0]==='version')value={'Google Cloud SDK':'587.0.0'};else if(args[0]==='auth'&&args[1]==='list')value=[{account:OWNER,status:'ACTIVE'}];else if(args[0]==='projects'&&args[1]==='describe')value={projectId:S.project,projectNumber:S.projectNumber,lifecycleState:'ACTIVE'};
    return{status:0,stdout:args[1]==='print-access-token'?token:JSON.stringify(value),stderr:''};};
  const client=await createOwnerReadonlyClients({policy:p,env,gcloudPath:'/usr/bin/true',publicPaths:['/'],now:()=>NOW,spawn,
    fetchImpl:async(url,opts)=>{assert.equal(opts.redirect,'manual');assert.equal(opts.headers.Authorization,undefined);return new Response('',{status:302,headers:{location:'/lab/floating-garden/trial/index.html'}});}});
  assert.equal((await client.fetchPublic(S.origin+'/')).status,302);
  assert(!JSON.stringify(client).includes(token));const beforeUnknown=calls.length;assert.throws(()=>client.runner('gcloud',['auth','login']));
  assert.throws(()=>client.runner('gcloud',['functions','delete','x',`--project=${S.project}`,`--billing-project=${S.project}`,'--format=json','--verbosity=error']));assert.equal(calls.length,beforeUnknown);
  await assert.rejects(client.requestClient.request({url:'https://secretmanager.googleapis.com/v1/x:access',method:'GET',responseType:'json',retry:false,maxRedirects:0}));
  client.close();await assert.rejects(client.fetchPublic(S.origin+'/'));assert.equal(calls.filter(a => a[0] === 'auth' && a[1] === 'print-access-token').length,1);
});

test('config drift into impersonation stops before token acquisition', async () => {
  const env={}, p=policy(env); let configs=0, tokenCalls=0;
  await assert.rejects(createOwnerReadonlyClients({ policy:p, env, gcloudPath:'/usr/bin/true', publicPaths:['/'], now:()=>NOW,
    spawn:(path,args)=>{let value={};
      if(args[0]==='version')value={'Google Cloud SDK':'587.0.0'};
      if(args[0]==='config' && ++configs===4)value={auth:{impersonate_service_account:'forbidden@example.invalid'}};
      if(args[0]==='auth'&&args[1]==='list')value=[{account:OWNER,status:'ACTIVE'}];
      if(args[0]==='auth'&&args[1]==='print-access-token')tokenCalls++;
      if(args[0]==='projects')value={projectId:S.project,projectNumber:S.projectNumber,lifecycleState:'ACTIVE'};
      return{status:0,stdout:JSON.stringify(value)}; },fetchImpl:()=>{throw Error('network forbidden');} }));
  assert.equal(tokenCalls,0);
});
test('inert modes ignore malformed capabilities and unknown/missing-journal mode cannot authenticate',async()=>{
  let calls=0; const bad={ mode:'plan', get env(){throw Error('must stay inert');}, spawn:()=>{calls++;}, fetchImpl:()=>{calls++;} };
  assert.equal((await prepareOwnerReadonlyPreflight(bad)).cloudReads,0);
  await assert.rejects(prepareOwnerReadonlyPreflight({mode:'apply',spawn:()=>{calls++;}}));
  const h=await home(); await assert.rejects(prepareOwnerReadonlyPreflight({mode:'inspect-owner-readonly',env:{HOME:h},execArgv:[],now:()=>NOW,spawn:()=>{calls++;},fetchImpl:()=>{calls++;}}));
  assert.equal(calls,0);
});

test('raw REST Functions inventory rejects pagination/unreachable/foreign entries without follow-up reads',async()=>{
  for(const inventory of [{functions:[],nextPageToken:'more'},{functions:[],unreachable:['foreign']},{functions:Array.from({length:5},(_,i)=>({name:'foreign'+i}))},
    {functions:FUNCTION_NAMES.map((name,i)=>({name:`projects/${S.project}/locations/${S.region}/functions/${name}`,serviceConfig:{service:`projects/${i===0?S.projectNumber:S.project}/locations/${S.region}/services/garden-${i===0?1:i}`}}))}]){
    const env={},p=policy(env);let reads=0;
    const client=await createOwnerReadonlyClients({policy:p,env,gcloudPath:'/usr/bin/true',publicPaths:['/'],now:()=>NOW,
      spawn:(path,args)=>{let v={};if(args[0]==='version')v={'Google Cloud SDK':'587.0.0'};if(args[0]==='auth'&&args[1]==='list')v=[{account:OWNER,status:'ACTIVE'}];if(args[0]==='projects')v={projectId:S.project,projectNumber:S.projectNumber,lifecycleState:'ACTIVE'};return{status:0,stdout:args[1]==='print-access-token'?'SYNTHETIC_TOKEN_1234567890':JSON.stringify(v)};},
      fetchImpl:async()=>{reads++;return new Response(JSON.stringify(inventory));}});
    await assert.rejects(client.requestClient.request({url:`https://cloudfunctions.googleapis.com/v2/projects/${S.project}/locations/-/functions?pageSize=1000`,method:'GET',responseType:'json',retry:false,maxRedirects:0}));
    assert.equal(reads,1);client.close();
  }
});

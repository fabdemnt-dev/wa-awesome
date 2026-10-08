import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, lstat, mkdtemp, mkdir, cp, symlink, link, rm, writeFile, chmod } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { validateOperationReview, publicTrialConfig, prepareTrialOperation } from '../scripts/prepare-floating-garden-trial-operation.mjs';
import { runtimeConfig } from '../scripts/deploy-floating-garden-connection-template.mjs';
import { FUNCTION_NAMES } from '../scripts/prepare-floating-garden-trial.mjs';
import { classifyDeployResult as classifyOperationResult, normalizeFailureDiagnostic,
  describeAdapterFailure, validateFunctionMetadata as operationMetadataCheck } from '../scripts/floating-garden-trial-cloud-adapter.mjs';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const NOW = 1800000000000, WEEK = 604800000;
const review = () => ({ schemaVersion: 1, startsAtMillis: NOW, endsAtMillis: NOW + WEEK, testerUids: ['SYNTHETIC_PACKAGE_TESTER_A', 'SYNTHETIC_PACKAGE_TESTER_B'], retainBuildArtifacts: false, allowInitialFunctionRecreate: false, approvePublicInvoker: false });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
async function temp(t) { const path = await mkdtemp(join(tmpdir(), 'garden-operation-local-')); t.after(() => rm(path, {recursive:true,force:true})); return path; }
async function files(dir, prefix='') { const result=[]; for (const name of await readdir(dir)) { const info=await lstat(join(dir,name)); if(info.isDirectory()) result.push(...await files(join(dir,name),prefix+name+'/')); else result.push(prefix+name); } return result.sort(); }
test('valid review deep clone is frozen and approvals may be false', () => {
 const value=review(), clone=validateOperationReview(value,{now:NOW});
 assert.deepEqual(clone,value); assert.notEqual(clone,value); assert.notEqual(clone.testerUids,value.testerUids);
 assert.ok(Object.isFrozen(clone)); assert.ok(Object.isFrozen(clone.testerUids)); value.testerUids[0]='CHANGED'; assert.notEqual(clone.testerUids[0],'CHANGED');
});
test('exact own primitive fields and array descriptor shape reject coercion and getters without invoking them', () => {
 let calls=0;
 const values=[null,[],new Date(),new Proxy(review(),{}),{...review(),extra:true},{...review(),schemaVersion:'1'},{...review(),retainBuildArtifacts:'true'},{...review(),testerUids:[{},'B']},{...review(),testerUids:['A','A']},{...review(),testerUids:['bad/uid','B']},{...review(),testerUids:['A'.repeat(129),'B']},{...review(),testerUids:['A']},{...review(),testerUids:['A','B','C']}];
 const getter=review(); Object.defineProperty(getter,'startsAtMillis',{get(){calls++;throw Error('SECRET');}}); values.push(getter);
 const arrayGetter=review(); Object.defineProperty(arrayGetter.testerUids,'0',{get(){calls++;throw Error('SECRET');}}); values.push(arrayGetter);
 const arrayExtra=review(); arrayExtra.testerUids.extra=true; values.push(arrayExtra);
 const symbol=review(); symbol[Symbol('field')]=1; values.push(symbol);
 const toJson=review(); toJson.toJSON=()=>{calls++;return {}}; values.push(toJson);
 const proxy=review(); proxy.testerUids=new Proxy(proxy.testerUids,{get(){calls++;throw Error('SECRET')}}); values.push(proxy);
 for(const value of values) assert.throws(()=>validateOperationReview(value,{now:NOW}));
 assert.equal(calls,0);
 assert.doesNotThrow(()=>validateOperationReview({...review(),testerUids:['a','b']},{now:NOW}));
});
test('exact seven-day duration and temporal bounds are enforced without numeric coercion',()=>{
 for(const change of [{startsAtMillis:0},{startsAtMillis:NaN},{startsAtMillis:'1800000000000'},{endsAtMillis:Infinity},{endsAtMillis:NOW+WEEK-1},{endsAtMillis:NOW+WEEK+1},{startsAtMillis:Number.MAX_SAFE_INTEGER,endsAtMillis:Number.MAX_SAFE_INTEGER+WEEK}]) assert.throws(()=>validateOperationReview({...review(),...change},{now:NOW}));
 for(const now of [0,-1,NaN,Infinity,'1800000000000',NOW-WEEK-1,NOW+WEEK]) assert.throws(()=>validateOperationReview(review(),{now}));
 for(const now of [NOW-WEEK,NOW,NOW+WEEK-1]) assert.doesNotThrow(()=>validateOperationReview(review(),{now}));
});
test('public projection exactly preserves current connection public Firebase and corrected App Check key',()=>{
 const value=publicTrialConfig(review()), connection=runtimeConfig();
 assert.ok(JSON.stringify(value.firebase) === JSON.stringify(connection.firebase)); assert.deepEqual({...value.appCheck,verified:undefined},{...connection.appCheck,verified:undefined});
 assert.equal(value.appCheck.verified,true); assert.equal(value.projectId,connection.projectId); assert.equal(value.previewOrigin,connection.origin);
 assert.equal(value.enabled,true); assert.equal(value.maxTesters,2); assert.equal(value.maxRooms,20);
 assert.ok(!JSON.stringify(value).includes('SYNTHETIC_PACKAGE_TESTER'));
});
test('private directory, review, exact hashes and least-scope commands; sources unchanged',async(t)=>{
 const dir=await temp(t), output=join(dir,'operation'), before=await readFile(join(ROOT,'firebase.json'));
 const result=await prepareTrialOperation({review:review(),output,now:NOW});
 assert.equal((await lstat(output)).mode&0o777,0o700); assert.equal((await lstat(result.reviewPath)).mode&0o777,0o600);
 const list=await files(output); assert.equal(list.length,result.fileCount);
 const manifest=await json(result.manifestPath), privateBytes=await readFile(result.reviewPath), plan=await json(result.planPath);
 assert.equal(manifest.reviewDigest,sha(privateBytes)); assert.equal(result.reviewDigest,manifest.reviewDigest); assert.equal(result.manifestDigest,sha(await readFile(result.manifestPath)));
 assert.deepEqual(Object.keys(manifest.files).sort(),list.filter(name=>!['private-review.json','OPERATION-MANIFEST.json'].includes(name)));
 for(const [name,digest] of Object.entries(manifest.files)) {const bytes=await readFile(join(output,name)); assert.equal(sha(bytes),digest); assert.ok(!bytes.includes(Buffer.from('SYNTHETIC_PACKAGE_TESTER')));}
 assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PACKAGE_TESTER')); assert.deepEqual(plan.functionNames,FUNCTION_NAMES); assert.equal(plan.retention.buildArtifacts,'retain'); assert.deepEqual(plan.retention.deleteCommands,[]);
 const selector=plan.commandsNotExecuted.functions.argv.at(-1); assert.deepEqual(selector.split(','),FUNCTION_NAMES.map(n=>`functions:floating-garden-trial:${n}`));
 for(const command of Object.values(plan.commandsNotExecuted)){assert.equal(command.argv[command.argv.indexOf('--project')+1],'wa-awesome-garden-stg');assert.ok(!command.argv.includes('--force'));}
 const admin=await json(join(result.gameDir,'ADMIN-RECORDS-REVIEW.json')); assert.equal(admin['floatingGardenTrial/config'].enabled,false); assert.deepEqual(admin['floatingGardenTrial/config'].testerUids,[]);
 const stopped=await readFile(join(result.stoppedDir,'public/index.html'),'utf8'); assert.ok(!/<script|https?:/i.test(stopped));
 assert.deepEqual(await readFile(join(ROOT,'firebase.json')),before);
});
test('existing/repository/symlink outputs fail without overwriting files',async(t)=>{
 const dir=await temp(t), existing=join(dir,'existing');await mkdir(existing);await writeFile(join(existing,'canary'),'KEEP');
 await assert.rejects(prepareTrialOperation({review:review(),output:existing,now:NOW})); assert.equal(await readFile(join(existing,'canary'),'utf8'),'KEEP');
 await assert.rejects(prepareTrialOperation({review:review(),output:join(ROOT,'invalid-operation-output'),now:NOW}));
 const target=join(dir,'target');await mkdir(target);const link=join(dir,'linked');await symlink(target,link);
 await assert.rejects(prepareTrialOperation({review:review(),output:join(link,'operation'),now:NOW})); assert.deepEqual(await readdir(target),[]);
 const dangling=join(dir,'dangling');await symlink(join(dir,'missing'),dangling);await assert.rejects(prepareTrialOperation({review:review(),output:dangling,now:NOW}));
});
test('repositoryRoot override is honored and symlinked source template rejected',async(t)=>{
 const dir=await temp(t),source=join(dir,'source');
 for(const part of ['lab/floating-garden','functions/floating-garden-trial','functions/floating-garden-online']) {await mkdir(dirname(join(source,part)),{recursive:true});await cp(join(ROOT,part),join(source,part),{recursive:true});}
 const result=await prepareTrialOperation({review:review(),output:join(dir,'good'),now:NOW,repositoryRoot:source}); assert.ok(await lstat(result.manifestPath));
 const template=join(source,'functions/floating-garden-trial/firestore.rules.template'),outside=join(dir,'outside.rules');await cp(template,outside);await rm(template);await symlink(outside,template);
 const bad=join(dir,'bad');await assert.rejects(prepareTrialOperation({review:review(),output:bad,now:NOW,repositoryRoot:source}));await assert.rejects(lstat(bad),{code:'ENOENT'});
});
test('local preparer has no SDK, subprocess, deploy-executor or network import/call',async()=>{
 const source=await readFile(join(ROOT,'scripts/prepare-floating-garden-trial-operation.mjs'),'utf8');
 const imports=[...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m=>m[1]);
 assert.deepEqual(imports.sort(),['node:fs/promises','node:path','node:url','node:crypto','node:util','./prepare-floating-garden-trial.mjs','../lab/floating-garden/trial/config.js'].sort());
 assert.ok(!/\b(?:fetch|execFile|spawn|execSync)\s*\(/.test(source));
});

import { approvalReady, adminRecords, adminState, operateTrial, readOperationPacket, verifyOperationPacket, createJournal, readVerifiedHostingRecovery, verifyVerifiedHostingRecovery, createActivationRecoveryJournal, ACTIVATION_RECOVERY_FILE, formatTrialJst, readActiveHostingPrior, verifyActiveHostingPrior, verifyHostingUpdatePacket, verifyPreparedHostingPacket, createHostingUpdateJournal, selectVerifiedHostingOperation, createHostingPublisher, operateHostingUpdate, HOSTING_UPDATE_FILES, parseReviewBase64, main, MAX_START_WAIT_MILLIS } from '../scripts/operate-floating-garden-trial.mjs';
const approvedReview = () => ({ ...review(), retainBuildArtifacts: true, allowInitialFunctionRecreate: true, approvePublicInvoker: true });
const clone = (value) => structuredClone(value);
function fakeOperation(value = approvedReview()) {
 let time = NOW - 10000;
 let admin = { gate:null, usage:null, testers:[null,null] };
 let hosting = { kind:'connection', version:'connection-v1', marker:'fixture' };
 const calls = [], logs = [], mutations = [];
 const journal = { begin(mode){ calls.push(`begin:${mode}`); }, issued(s){calls.push(`issued:${s}`);}, verified(s){calls.push(`verified:${s}`);}, finish(s){calls.push(`finish:${s}`);}, fail(s){calls.push(`failed:${s}`);}, snapshot(){return{};}, async flush(){ calls.push('flush');} };
 const mutate = (name, cb) => async (...args) => { calls.push(name); mutations.push(name); cb?.(...args); return {kind:'success'}; };
 const cloud = {
  async preflight(mode){calls.push(`preflight:${mode}`);},
  async readAdmin(){calls.push('readAdmin');return clone(admin);},
  async readHosting(){calls.push('readHosting');return clone(hosting);},
  async verifyHosting(kind){calls.push(`verifyHosting:${kind}`);return {verified:kind===hosting.kind};},
  async verifyFunctions(){calls.push('verifyFunctions');return {verified:true};},
  async verifyRules(){calls.push('verifyRules');return {verified:true};},
  createStoppedAdmin:mutate('createStoppedAdmin',next=>{admin=clone(next);}),
  updateAdmin:mutate('updateAdmin',next=>{admin={...clone(next),usage:admin.usage,testers:next.testers.map((v,i)=>admin.testers[i]===null?null:clone(v))};}),
  deployFunctions:mutate('deployFunctions'),deployRules:mutate('deployRules'),
  deployHosting:mutate('deployHosting',kind=>{hosting={kind,version:`${kind}-v1`,marker:'fixture'};}),
 };
 return { value, cloud, journal, calls, logs, mutations,
  get admin(){return admin;},set admin(v){admin=v;},get hosting(){return hosting;},set hosting(v){hosting=v;},get time(){return time;},set time(v){time=v;},
  async run(mode='deploy', changes={}) {return operateTrial({mode,review:value,cloud,journal,now:()=>time,wait:async ms=>{calls.push('wait');time+=ms;},log:s=>logs.push(s),checkLocal:async()=>{calls.push('local');},...changes});},
 };
}
test('operator approvals are explicit and inspection/default plan is inert',async()=>{
 assert.equal(approvalReady(review()),false);assert.equal(approvalReady(approvedReview()),true);
 for(const field of ['retainBuildArtifacts','allowInitialFunctionRecreate','approvePublicInvoker'])assert.equal(approvalReady({...approvedReview(),[field]:false}),false);
 const lines=[];assert.equal(await main([],{log:s=>lines.push(s)}),0);assert.equal(await main(['--plan'],{log:s=>lines.push(s)}),0);assert.equal(lines.length,2);assert.ok(lines.every(s=>s.startsWith('PLAN_ONLY:')));
 const op=fakeOperation(review());assert.equal((await op.run('inspect')).admin,'absent');assert.deepEqual(op.mutations,[]);
 assert.equal((await op.run('deploy')).status,'blocked');assert.deepEqual(op.mutations,[]);
});
test('deploy verifies each stage and waits for exact fixed start before activation',async()=>{
 const op=fakeOperation();const result=await op.run();assert.equal(result.status,'active');assert.equal(op.time,NOW);
 assert.deepEqual(op.mutations,['createStoppedAdmin','deployFunctions','deployRules','deployHosting','updateAdmin']);
 assert.equal(adminState(op.admin,op.value),'active');
 for(const name of op.mutations){const i=op.calls.indexOf(name);assert.equal(op.calls[i-1],'flush');assert.ok(op.calls[i-2].startsWith('issued:'));}
 assert.ok(op.calls.indexOf('verifyFunctions')<op.calls.indexOf('deployRules'));assert.ok(op.calls.indexOf('verifyRules')<op.calls.indexOf('deployHosting'));
 assert.ok(!op.logs.join('\n').includes('SYNTHETIC_PACKAGE_TESTER'));
});
test('known cleanup warning does not bypass independent function verification',async()=>{
 for(const verified of [false,true]){
  const op=fakeOperation();op.cloud.deployFunctions=async()=>({kind:'cleanup-warning'});op.cloud.verifyFunctions=async()=>({verified});
  const result=await op.run();assert.equal(result.status,verified?'active':'blocked');
  assert.equal(op.mutations.includes('deployRules'),verified);
 }
});
test('failed deployment preserves only bounded reason and never retries or prints provider data',async()=>{
 const op=fakeOperation(), raw='Missing permissions required for functions deploy. private@example.invalid SYNTHETIC_PRIVATE_TOKEN';
 op.cloud.deployFunctions=async()=>classifyOperationResult({exitCode:1,stdout:JSON.stringify({status:'error',error:raw}),stderr:'SYNTHETIC_PRIVATE_TOKEN'});
 let saved;
 op.journal.fail=(stage,diagnostic)=>{saved={stage,diagnostic};};
 const result=await op.run();
 assert.equal(result.status,'blocked');assert.equal(result.stage,'deploy-functions');
 assert.equal(result.diagnostic.reason,'permission');assert.equal(result.diagnostic.exitCode,1);
 assert.deepEqual(saved,{stage:'deploy-functions',diagnostic:result.diagnostic});
 assert.deepEqual(op.mutations,['createStoppedAdmin']);assert.ok(!op.calls.includes('verifyFunctions'));
 for(const text of [JSON.stringify(result),JSON.stringify(saved),op.logs.join('\n')]){
  assert.ok(!text.includes('private@example'));assert.ok(!text.includes('SYNTHETIC_PRIVATE_TOKEN'));
 }
 assert.match(op.logs.at(-1),/reason=permission, exit=1, timeout=false/);
});
test('adapter guard reason survives the operator catch; arbitrary Error codes never escape',async()=>{
 let expected;
 try{operationMetadataCheck(null,FUNCTION_NAMES[0]);}catch(error){expected=error;}
 const op=fakeOperation();op.cloud.preflight=async()=>{throw expected;};
 const result=await op.run();assert.deepEqual(result.diagnostic,describeAdapterFailure(expected));
 assert.notEqual(result.diagnostic.reason,'unclassified');assert.deepEqual(op.mutations,[]);
 const other=fakeOperation();other.cloud.preflight=async()=>{throw Object.assign(Error('SYNTHETIC_PRIVATE_TOKEN'),{code:'SYNTHETIC_PRIVATE_TOKEN',response:{status:403}});};
 const unknown=await other.run();assert.equal(unknown.diagnostic.reason,'unclassified');
 assert.ok(!JSON.stringify(unknown).includes('SYNTHETIC_PRIVATE_TOKEN'));assert.ok(!other.logs.join('').includes('SYNTHETIC_PRIVATE_TOKEN'));
});
test('journal retains sanitized failure details across process reload without permitting replay',async(t)=>{
 const dir=await temp(t),out=join(dir,'operation');await prepareTrialOperation({review:approvedReview(),output:out,now:NOW-1});
 const {packet}=await readOperationPacket(out);const journal=await createJournal(packet,{now:()=>NOW});
 journal.begin('deploy');journal.issued('deploy-functions');await journal.flush();
 journal.fail('deploy-functions',{reason:'permission',exitCode:1,timedOut:false,httpStatus:403,raw:'SYNTHETIC_PRIVATE_TOKEN'});await journal.flush();
 const stored=await readFile(join(out,'OPERATION-STATE.json'),'utf8');assert.ok(!stored.includes('SYNTHETIC_PRIVATE_TOKEN'));
 const restored=await createJournal(packet,{now:()=>NOW});assert.deepEqual(restored.snapshot().deploy.diagnostic,{reason:'permission',exitCode:1,timedOut:false,httpStatus:403});
 assert.throws(()=>restored.begin('deploy'));assert.throws(()=>restored.begin('activate'));
 assert.equal((await lstat(join(out,'OPERATION-STATE.json'))).mode&0o777,0o600);
});
test('unknown and malformed diagnostic fields are replaced rather than persisted verbatim',()=>{
 const value=normalizeFailureDiagnostic({reason:'SYNTHETIC_PRIVATE_TOKEN',exitCode:'1',timedOut:'true',httpStatus:999,other:'SYNTHETIC_PRIVATE_TOKEN'});
 assert.deepEqual(value,{reason:'unclassified',exitCode:null,timedOut:false});assert.ok(Object.isFrozen(value));
});
test('deployment crossing fixed start remains stopped and never shifts deadline',async()=>{
 const op=fakeOperation(),original=op.cloud.deployFunctions;op.cloud.deployFunctions=async()=>{const r=await original();op.time=NOW+1;return r;};
 const result=await op.run();assert.equal(result.reason,'start-passed');assert.equal(adminState(op.admin,op.value),'stopped');assert.ok(!op.mutations.includes('updateAdmin'));assert.equal(op.admin.gate.endsAtMillis,NOW+WEEK);
});
test('distant start and late wake remain stopped without extending window',async()=>{
 const distant=fakeOperation();distant.time=NOW-MAX_START_WAIT_MILLIS-1;assert.equal((await distant.run()).reason,'future-start');assert.equal(adminState(distant.admin,distant.value),'stopped');
 const late=fakeOperation();assert.equal((await late.run('deploy',{wait:async()=>{late.time=NOW+60001;}})).reason,'late-wake');assert.ok(!late.mutations.includes('updateAdmin'));
});
test('activation checks boundaries and rechecks time after readback work',async()=>{
 for(const time of [NOW-1,NOW+WEEK]){const op=fakeOperation();op.time=time;op.admin=adminRecords(op.value);op.hosting={kind:'game',version:'g1'};assert.equal((await op.run('activate')).status,'blocked');assert.deepEqual(op.mutations,[]);}
 const op=fakeOperation();op.time=NOW;op.admin=adminRecords(op.value);op.hosting={kind:'game',version:'g1'};op.cloud.verifyRules=async()=>{op.time=NOW+WEEK;return{verified:true};};
 assert.equal((await op.run('activate')).status,'blocked');assert.deepEqual(op.mutations,[]);
});
test('failures at every mutating or proof stage stop forward work without retries or raw diagnostics',async()=>{
 for(const method of ['createStoppedAdmin','deployFunctions','verifyFunctions','deployRules','verifyRules','deployHosting','updateAdmin']){
  const op=fakeOperation();let attempts=0;op.cloud[method]=async()=>{attempts++;throw Error('PRIVATE_DIAGNOSTIC_SHOULD_NEVER_LEAK');};
  assert.equal((await op.run()).status,'blocked');assert.equal(attempts,1);assert.ok(!op.logs.join('').includes('PRIVATE_DIAGNOSTIC'));
 }
 const op=fakeOperation();op.journal.flush=async()=>{throw Error('journal failed');};assert.equal((await op.run()).status,'blocked');assert.deepEqual(op.mutations,[]);
});
test('hosting race blocks game publication while backend remains stopped',async()=>{
 const op=fakeOperation();const original=op.cloud.deployRules;op.cloud.deployRules=async()=>{const result=await original();op.hosting.version='unexpected-v2';return result;};
 assert.equal((await op.run()).status,'blocked');assert.equal(adminState(op.admin,op.value),'stopped');assert.ok(!op.mutations.includes('deployHosting'));
});
test('stop disables only known flags before unrelated hosting failures',async()=>{
 const op=fakeOperation();op.time=NOW+WEEK+1;op.admin=adminRecords(op.value,true,7);op.cloud.readHosting=async()=>{throw Error('unrelated release');};
 assert.equal((await op.run('stop')).status,'blocked');assert.equal(adminState(op.admin,op.value),'stopped');assert.equal(op.admin.usage.createdRoomCount,7);assert.deepEqual(op.mutations,['updateAdmin']);
});
test('stop accepts missing or inactive tester subsets, preserves absence and usage, keeps activation strict',async()=>{
 for(const changes of [[null,true],[false,true],[null,null],[false,false]]){
  const op=fakeOperation();op.admin=adminRecords(op.value,true,3);op.admin.testers=changes.map(active=>active===null?null:{active,expiresAtMillis:op.value.endsAtMillis});op.hosting={kind:'game',version:'g1'};
  if(changes.some(v=>v!==true))assert.equal(adminState(op.admin,op.value),'inconsistent');
  assert.equal((await op.run('stop')).status,'stopped');assert.equal(adminState(op.admin,op.value,{forStop:true}),'stopped');assert.equal(op.admin.usage.createdRoomCount,3);
  changes.forEach((v,i)=>assert.equal(op.admin.testers[i]===null,v===null));
 }
 const op=fakeOperation();op.admin=adminRecords(op.value,false,4);op.admin.testers[1].active=true;op.hosting={kind:'stopped',version:'s1'};
 assert.equal((await op.run('stop')).status,'stopped');assert.deepEqual(op.mutations,['updateAdmin']);
});
test('stop rejects unverified hosting result and unknown admin scope without overwriting',async()=>{
 const op=fakeOperation();op.admin=adminRecords(op.value);op.hosting={kind:'game',version:'g1'};op.cloud.verifyHosting=async()=>({verified:false});assert.equal((await op.run('stop')).status,'blocked');assert.deepEqual(op.mutations,[]);
 const other=fakeOperation();other.admin=adminRecords(other.value,true);other.admin.gate.projectId='other';assert.equal((await other.run('stop')).status,'blocked');assert.deepEqual(other.mutations,[]);
});
test('packet readback detects modified, extra and linked public files and private review permissions',async(t)=>{
 const dir=await temp(t),out=join(dir,'operation');await prepareTrialOperation({review:approvedReview(),output:out,now:NOW-1});
 const {packet}=await readOperationPacket(out);await verifyOperationPacket(packet);
 const extra=join(packet.gameDir,'public/unexpected.txt');await writeFile(extra,'extra');await assert.rejects(verifyOperationPacket(packet));await rm(extra);
 const marker=join(packet.stoppedDir,'public/index.html'),bytes=await readFile(marker);await writeFile(marker,'changed');await assert.rejects(verifyOperationPacket(packet));await writeFile(marker,bytes);
 await symlink(marker,extra);await assert.rejects(verifyOperationPacket(packet));await rm(extra);
 await writeFile(packet.reviewPath,'{}');await assert.rejects(readOperationPacket(out));
});
test('journal durably blocks repeated mutations after issued failure or interruption',async(t)=>{
 const dir=await temp(t),out=join(dir,'operation');await prepareTrialOperation({review:approvedReview(),output:out,now:NOW-1});const {packet}=await readOperationPacket(out);
 const first=await createJournal(packet,{now:()=>NOW});first.begin('deploy');first.issued('create-stopped-admin');await first.flush();
 const resumed=await createJournal(packet,{now:()=>NOW});assert.throws(()=>resumed.begin('deploy'));assert.throws(()=>resumed.begin('activate'));assert.equal(resumed.snapshot().deploy.status,'running');
 resumed.begin('stop');resumed.issued('stop-admin-write');await resumed.flush();resumed.fail('stop-admin-write');await resumed.flush();
 const failed=await createJournal(packet,{now:()=>NOW});assert.throws(()=>failed.begin('stop'));assert.equal(failed.snapshot().stop.status,'failed');
 assert.equal((await lstat(join(out,'OPERATION-STATE.json'))).mode&0o777,0o600);
});
test('published-stopped journal allows exactly one explicit activation; failed begin preserves prior status',async(t)=>{
 const dir=await temp(t),out=join(dir,'operation');await prepareTrialOperation({review:approvedReview(),output:out,now:NOW-1});const {packet}=await readOperationPacket(out);
 const first=await createJournal(packet,{now:()=>NOW});first.begin('deploy');first.finish('published-stopped');await first.flush();
 const resume=await createJournal(packet,{now:()=>NOW});assert.throws(()=>resume.begin('deploy'));resume.fail('preflight');assert.equal(resume.snapshot().deploy.status,'published-stopped');resume.begin('activate');resume.finish('active');await resume.flush();
 const final=await createJournal(packet,{now:()=>NOW});assert.throws(()=>final.begin('activate'));assert.equal(final.snapshot().deploy.status,'active');
});
test('canonical private review encoding rejects malformed inputs and never requires literal credentials',()=>{
 const value=approvedReview(), encoded=Buffer.from(JSON.stringify(value)).toString('base64url');assert.deepEqual(parseReviewBase64(encoded),value);
 for(const bad of [encoded+'=',encoded+'\n','',null,'A'.repeat(11001),Buffer.from('{}').toString('base64url')])assert.throws(()=>parseReviewBase64(bad));
});
test('automatic activation marks journal running and issued durably before provider mutation',async(t)=>{
 const dir=await temp(t),out=join(dir,'operation');await prepareTrialOperation({review:approvedReview(),output:out,now:NOW-10000});const {packet}=await readOperationPacket(out);
 const journal=await createJournal(packet,{now:()=>NOW});const op=fakeOperation(),write=op.cloud.updateAdmin;
 op.cloud.updateAdmin=async(...args)=>{const restored=await createJournal(packet,{now:()=>NOW});assert.equal(restored.snapshot().deploy.status,'running');assert.throws(()=>restored.begin('activate'));return write(...args);};
 assert.equal((await op.run('deploy',{journal})).status,'active');await journal.flush();
});
test('late automatic activation verification remains stopped for later explicit review',async()=>{
 const op=fakeOperation();let proofs=0;op.cloud.verifyFunctions=async()=>{if(++proofs===2)op.time=NOW+120000;return{verified:true};};
 assert.equal((await op.run()).reason,'late-verification');assert.ok(!op.mutations.includes('updateAdmin'));
});
test('stop preserves absent gate and opaque usage while disabling exact existing tester records',async()=>{
 for(const usage of [null,{unexpected:'unchanged'},adminRecords(approvedReview()).usage]){
  const op=fakeOperation();op.admin={gate:null,usage:clone(usage),testers:[null,{active:true,expiresAtMillis:op.value.endsAtMillis}]};op.hosting={kind:'stopped',version:'s1'};
  op.cloud.updateAdmin=async(next)=>{op.mutations.push('updateAdmin');assert.equal(next.gate,null);assert.equal(next.testers[0],null);assert.deepEqual(next.usage,usage);op.admin=clone(next);return{kind:'success'};};
  assert.equal((await op.run('stop')).status,'stopped');assert.equal(op.admin.testers[1].active,false);assert.deepEqual(op.admin.usage,usage);
 }
});
test('unhashed CLI logs must still be regular nonlinked bounded files',async(t)=>{
 const dir=await temp(t),out=join(dir,'operation');await prepareTrialOperation({review:approvedReview(),output:out,now:NOW-1});const {packet}=await readOperationPacket(out);
 const log=join(packet.gameDir,'firebase-debug.log');await symlink(packet.reviewPath,log);await assert.rejects(verifyOperationPacket(packet));await rm(log);
 await writeFile(log,'private harmless synthetic diagnostics');await verifyOperationPacket(packet);
});

// Official CLI upload-cache compatibility remains narrower than a .firebase ignore.
const hostingCacheName = 'hosting.cHVibGlj.cache';
async function cachePacket(t) {
 const dir=await temp(t),out=join(dir,'operation');await prepareTrialOperation({review:approvedReview(),output:out,now:NOW-1});
 return {...await readOperationPacket(out),dir};
}
async function officialHostingCache(packet,kind='game') {
 const root=join(packet.output,kind),prefix=`${kind}/public/`,entries=new Map();
 for(const key of Object.keys(packet.manifest.files).filter(key=>key.startsWith(prefix))){
  const path=join(packet.output,key),info=await lstat(path);entries.set(key.slice(prefix.length),{mtime:info.mtime.getTime(),hash:sha(gzipSync(await readFile(path),{level:9}))});
 }
 const require=createRequire(join(ROOT,'package.json'));require('firebase-tools/lib/deploy/hosting/hashcache').dump(root,'cHVibGlj',entries);
 return join(root,'.firebase',hostingCacheName);
}
test('official CLI public upload caches are accepted at game/stopped roots without changing packet hashes',async t=>{
 const {packet}=await cachePacket(t),before=await readFile(packet.manifestPath);
 for(const kind of ['game','stopped']){const path=await officialHostingCache(packet,kind);assert((await readFile(path,'utf8')).includes(','));}
 await verifyOperationPacket(packet);assert.equal((await readOperationPacket(packet.output)).packet.manifestDigest,packet.manifestDigest);assert.deepEqual(await readFile(packet.manifestPath),before);
});
test('normal upload caches never bypass tracked-file or review integrity',async t=>{
 const {packet}=await cachePacket(t);await officialHostingCache(packet);await officialHostingCache(packet,'stopped');
 for(const path of [join(packet.gameDir,'functions/trial-config.json'),join(packet.stoppedDir,'public/index.html'),packet.reviewPath,packet.manifestPath]){
  const before=await readFile(path);await writeFile(path,Buffer.concat([before,Buffer.from('\n')]));await assert.rejects(verifyOperationPacket(packet));await writeFile(path,before);
 }
 await verifyOperationPacket(packet);
});
test('upload cache allowance rejects other names, nested locations and unrelated extras',async t=>{
 const {packet}=await cachePacket(t);await officialHostingCache(packet);
 for(const rel of ['game/.firebase/hosting.other.cache','game/.firebase/private.txt','game/.firebase/nested/hosting.cHVibGlj.cache','game/subdir/.firebase/hosting.cHVibGlj.cache','game/hosting.cHVibGlj.cache','stopped/.firebase/functions.cache']){
  const path=join(packet.output,rel);await mkdir(dirname(path),{recursive:true});await writeFile(path,'');await assert.rejects(verifyOperationPacket(packet));await rm(path);
  if(rel.includes('/nested/'))await rm(dirname(path),{recursive:true});
 }
 await verifyOperationPacket(packet);
});
test('cache directory must be canonical and cache file regular, single-link and bounded',async t=>{
 const {packet,dir}=await cachePacket(t),cacheDir=join(packet.gameDir,'.firebase'),cache=join(cacheDir,hostingCacheName),outside=join(dir,'external-cache');
 await mkdir(outside);await writeFile(join(outside,hostingCacheName),'');await symlink(outside,cacheDir);await assert.rejects(verifyOperationPacket(packet));await rm(cacheDir);await mkdir(cacheDir);
 await symlink(packet.reviewPath,cache);await assert.rejects(verifyOperationPacket(packet));await rm(cache);
 const ordinary=join(dir,'ordinary-cache');await writeFile(ordinary,'');await link(ordinary,cache);await assert.rejects(verifyOperationPacket(packet));await rm(cache);
 await mkdir(cache);await assert.rejects(verifyOperationPacket(packet));await rm(cache,{recursive:true});
 execFileSync('mkfifo',[cache]);await assert.rejects(verifyOperationPacket(packet));await rm(cache);
 await writeFile(cache,Buffer.alloc(64*1024+1));await assert.rejects(verifyOperationPacket(packet));await rm(cache);
 await officialHostingCache(packet);await verifyOperationPacket(packet);
});
test('cache rows reject malformed encoding, paths, timestamps, hashes and duplicate entries',async t=>{
 const {packet}=await cachePacket(t),cache=await officialHostingCache(packet),normal=await readFile(cache,'utf8'),first=normal.split('\n')[0],path=first.split(',')[0],hash='a'.repeat(64);
 const malformed=['unstructured text','\0','\n',`${path},1,${hash}`,`${path},-1,${hash}\n`,`${path},1.5,${hash}\n`,`${path},01,${hash}\n`,`${path},9007199254740992,${hash}\n`,`${path},1,${'a'.repeat(63)}\n`,`${path},1,${'A'.repeat(64)}\n`,`../private-review.json,1,${hash}\n`,`/absolute,1,${hash}\n`,`unknown-file,1,${hash}\n`,`${first}\n${first}\n`,`${first}\r\n`,Buffer.from([0xff,0x0a])];
 for(const value of malformed){await writeFile(cache,value);await assert.rejects(verifyOperationPacket(packet));}
 // The official CLI can clear its cache on upload failure; empty is valid.
 await writeFile(cache,'');await verifyOperationPacket(packet);await writeFile(cache,normal);await verifyOperationPacket(packet);
});
test('deployment continues after the CLI creates its cache during successful Hosting upload',async t=>{
 const {packet}=await cachePacket(t),op=fakeOperation(),deploy=op.cloud.deployHosting;
 op.cloud.deployHosting=async kind=>{const result=await deploy(kind);await officialHostingCache(packet,kind);return result;};
 assert.equal((await op.run('deploy',{checkLocal:()=>verifyOperationPacket(packet)})).status,'active');
 assert.deepEqual(op.mutations,['createStoppedAdmin','deployFunctions','deployRules','deployHosting','updateAdmin']);await verifyOperationPacket(packet);
});
test('inspect and gate-first stop remain usable after normal game/stopped CLI caches appear',async t=>{
 const {packet}=await cachePacket(t);await officialHostingCache(packet);const op=fakeOperation();op.admin=adminRecords(op.value,true);op.hosting={kind:'game',version:'g1'};
 const checkLocal=()=>verifyOperationPacket(packet);assert.equal((await op.run('inspect',{checkLocal})).admin,'active');assert.deepEqual(op.mutations,[]);
 const deploy=op.cloud.deployHosting;op.cloud.deployHosting=async kind=>{const result=await deploy(kind);await officialHostingCache(packet,'stopped');return result;};
 assert.equal((await op.run('stop',{checkLocal})).status,'stopped');assert.deepEqual(op.mutations,['updateAdmin','deployHosting']);await verifyOperationPacket(packet);
});

// A separate one-shot activation receipt recovers only the verified Hosting-cache failure.
async function hostingRecoveryFixture(t, {repositoryRoot=ROOT}={}) {
 const dir=await temp(t),oldReview={...approvedReview(),startsAtMillis:NOW-1000000,endsAtMillis:NOW-1000000+WEEK};
 const original=join(dir,'original');await prepareTrialOperation({review:oldReview,output:original,now:oldReview.startsAtMillis-10000,repositoryRoot});
 const old=await readOperationPacket(original),oldJournal=await createJournal(old.packet,{now:()=>oldReview.startsAtMillis-1000});
 oldJournal.begin('deploy');oldJournal.issued('create-stopped-admin');oldJournal.verified('create-stopped-admin');oldJournal.issued('deploy-functions');oldJournal.fail('deploy-functions');await oldJournal.flush();
 const {readPriorOperation}=await import('../scripts/operate-floating-garden-trial.mjs'),prior=await readPriorOperation(original);
 const out=join(dir,'operation');await prepareTrialOperation({review:approvedReview(),output:out,now:NOW-10000,repositoryRoot});
 const {packet,review:value}=await readOperationPacket(out),journal=await createJournal(packet,{prior,now:()=>NOW-1000});
 journal.begin('resume');for(const stage of ['replace-stopped-window','deploy-functions','deploy-rules','deploy-hosting']){journal.issued(stage);journal.verified(stage);}
 journal.fail('deploy-hosting');await journal.flush();const cache=await officialHostingCache(packet),logs=join(out,'recovery-logs');await mkdir(logs,{mode:0o700});
 for(const [stream,data] of [['stdout',JSON.stringify({status:'success',result:{}})],['stderr','']])await writeFile(join(logs,`hosting-game.${stream}.log`),data,{mode:0o600});
 return{dir,packet,review:value,prior,cache,logs,state:join(out,'OPERATION-STATE.json')};
}
async function activationHarness(f) {
 const proof=await readVerifiedHostingRecovery(f.packet,f.review),journal=await createActivationRecoveryJournal(f.packet,proof,{now:()=>NOW+120000}),op=fakeOperation();op.admin=adminRecords(op.value);op.hosting={kind:'game',version:'g1'};op.time=NOW+120000;
 const checkLocal=async()=>{await verifyVerifiedHostingRecovery(f.packet,proof);await journal.verify();};
 return{proof,journal,op,run:()=>op.run('activate',{journal,checkLocal})};
}
test('verified Hosting recovery activates late within unchanged window without any deployment or original-file rewrite',async t=>{
 const f=await hostingRecoveryFixture(t),paths=[f.state,f.packet.reviewPath,f.packet.manifestPath,join(f.prior.packet.output,'OPERATION-STATE.json'),f.cache,join(f.logs,'hosting-game.stdout.log'),join(f.logs,'hosting-game.stderr.log')],before=await Promise.all(paths.map(p=>readFile(p)));
 const h=await activationHarness(f);assert.equal((await h.run()).status,'active');await h.journal.flush();assert.deepEqual(h.op.mutations,['updateAdmin']);assert.equal(h.op.admin.gate.startsAtMillis,NOW);assert.equal(h.op.admin.gate.endsAtMillis,NOW+WEEK);assert.deepEqual(h.op.admin.gate.testerUids,f.review.testerUids);
 for(let i=0;i<paths.length;i++)assert.deepEqual(await readFile(paths[i]),before[i]);
 const receipt=await json(join(f.packet.output,ACTIVATION_RECOVERY_FILE));assert.equal(receipt.deploy.status,'active');assert.equal(receipt.recovery.originalJournalDigest,sha(before[0]));assert.deepEqual(receipt.predecessor,f.prior.predecessor);assert.deepEqual(receipt.events.map(e=>[e.stage,e.status]),[['activate-two-testers','issued'],['activate-two-testers','verified']]);
 assert.equal(h.journal.activationVerifiedAt(),NOW+120000);assert.equal(formatTrialJst(h.journal.activationVerifiedAt()),new Date(NOW+120000+9*3600000).toISOString().replace('T',' ').replace('Z',' JST'));
 assert.equal((await lstat(join(f.packet.output,ACTIVATION_RECOVERY_FILE))).mode&0o777,0o600);assert(!JSON.stringify(receipt).includes('SYNTHETIC_PACKAGE_TESTER'));
 assert.throws(()=>h.journal.begin('activate'));assert.throws(()=>h.journal.begin('stop'));await assert.rejects(createActivationRecoveryJournal(f.packet,h.proof));
});
test('Hosting recovery requires exact failed stage/diagnostic/stop and eight ordered nonactivation events',async t=>{
 const f=await hostingRecoveryFixture(t),bytes=await readFile(f.state),base=JSON.parse(bytes);
 const changes=[s=>s.deploy.status='running',s=>s.deploy.stage='deploy-functions',s=>s.deploy.diagnostic.reason='permission',s=>s.deploy.diagnostic.exitCode=0,s=>s.deploy.diagnostic.timedOut=true,s=>s.stop.status='stopped',s=>s.events.pop(),s=>s.events.push({stage:'activate-two-testers',status:'issued',atMillis:NOW}),s=>s.events[7].status='issued',s=>s.events.reverse(),s=>s.events[2].atMillis=0,s=>s.events[2].atMillis=NOW-2000,s=>delete s.predecessor,s=>s.predecessor.journalDigest='f'.repeat(64),s=>s.reviewDigest='f'.repeat(64),s=>s.extra='unknown'];
 for(const change of changes){const state=clone(base);change(state);await writeFile(f.state,JSON.stringify(state));await assert.rejects(readVerifiedHostingRecovery(f.packet,f.review));}
 await writeFile(f.state,bytes);await readVerifiedHostingRecovery(f.packet,f.review);
});
test('Hosting recovery authenticates complete gzip cache and successful private CLI log before creating a receipt',async t=>{
 const f=await hostingRecoveryFixture(t),cache=await readFile(f.cache,'utf8'),stdout=join(f.logs,'hosting-game.stdout.log'),log=await readFile(stdout);
 for(const changed of ['',cache.split('\n').slice(1).join('\n'),cache.replace(/,[0-9]+,/,',1,'),cache.replace(/[a-f0-9]{64}/,'f'.repeat(64))]){await writeFile(f.cache,changed);await assert.rejects(readVerifiedHostingRecovery(f.packet,f.review));}await writeFile(f.cache,cache);
 for(const changed of ['bad JSON',JSON.stringify({status:'error'}),JSON.stringify({status:'success',error:'failure'})]){await writeFile(stdout,changed);await assert.rejects(readVerifiedHostingRecovery(f.packet,f.review));}await writeFile(stdout,log);
 await chmod(stdout,0o640);await assert.rejects(readVerifiedHostingRecovery(f.packet,f.review));await chmod(stdout,0o600);
 await assert.rejects(lstat(join(f.packet.output,ACTIVATION_RECOVERY_FILE)),{code:'ENOENT'});await readVerifiedHostingRecovery(f.packet,f.review);
});
test('original journal, cache, logs, source and predecessor remain digest-bound after proof',async t=>{
 const f=await hostingRecoveryFixture(t),proof=await readVerifiedHostingRecovery(f.packet,f.review);
 for(const path of [f.state,f.cache,join(f.logs,'hosting-game.stdout.log'),join(f.logs,'hosting-game.stderr.log'),f.packet.reviewPath,f.packet.manifestPath,join(f.packet.gameDir,'public/lab/floating-garden/trial/index.html'),join(f.prior.packet.output,'OPERATION-STATE.json')]){
  const bytes=await readFile(path);await writeFile(path,Buffer.concat([bytes,Buffer.from('\n')]));await assert.rejects(verifyVerifiedHostingRecovery(f.packet,proof));await writeFile(path,bytes);
 }
 await verifyVerifiedHostingRecovery(f.packet,proof);
});
test('every prior or uncertain activation receipt is refused without overwrite',async t=>{
 const f=await hostingRecoveryFixture(t),proof=await readVerifiedHostingRecovery(f.packet,f.review),path=join(f.packet.output,ACTIVATION_RECOVERY_FILE);
 for(const bytes of ['{}','uncertain',JSON.stringify({deploy:{status:'failed'}})]){await writeFile(path,bytes,{mode:0o600});await assert.rejects(createActivationRecoveryJournal(f.packet,proof));assert.equal(await readFile(path,'utf8'),bytes);await rm(path);}
 await symlink(f.state,path);await assert.rejects(createActivationRecoveryJournal(f.packet,proof));await rm(path);
 const journal=await createActivationRecoveryJournal(f.packet,proof);journal.begin('activate');await journal.flush();await assert.rejects(createActivationRecoveryJournal(f.packet,proof));
});
test('altered activation receipt prevents cloud calls, and uncertain activation is never retried',async t=>{
 const f=await hostingRecoveryFixture(t),h=await activationHarness(f);await writeFile(join(f.packet.output,ACTIVATION_RECOVERY_FILE),'{}');assert.equal((await h.run()).status,'blocked');assert.deepEqual(h.op.mutations,[]);assert(!h.op.calls.includes('preflight:activate'));
 const g=await hostingRecoveryFixture(t),other=await activationHarness(g);let attempts=0;other.op.cloud.updateAdmin=async()=>{attempts++;return{kind:'unknown'};};assert.equal((await other.run()).status,'blocked');await other.journal.flush();assert.equal(attempts,1);assert.equal((await json(join(g.packet.output,ACTIVATION_RECOVERY_FILE))).deploy.status,'failed');await assert.rejects(createActivationRecoveryJournal(g.packet,other.proof));
});
test('activation recovery requires stopped-unused admin and all fresh live proofs',async t=>{
 for(const bad of ['used','active','functions','rules','hosting']){
  const f=await hostingRecoveryFixture(t),h=await activationHarness(f);
  if(bad==='used')h.op.admin.usage.createdRoomCount=1;else if(bad==='active')h.op.admin=adminRecords(h.op.value,true);else h.op.cloud['verify'+bad[0].toUpperCase()+bad.slice(1)]=async()=>({verified:false});
  assert.equal((await h.run()).status,'blocked');await h.journal.flush();assert.deepEqual(h.op.mutations,[]);
 }
});
test('early or expired recovery CLI makes no journal, provider call or new dates',async t=>{
 const f=await hostingRecoveryFixture(t),runner=join(f.dir,'offline-timing-test.mjs'),logs=[];
 await writeFile(runner,`import {main} from ${JSON.stringify(new URL('../scripts/operate-floating-garden-trial.mjs',import.meta.url).href)}; Date.now=()=>Number(process.argv[2]); const logs=[]; const code=await main(${JSON.stringify(['--activate-verified-hosting','--operation',f.packet.output,'--tooling-dir',join(f.dir,'unused-tooling')])},{log:s=>logs.push(s)}); console.log(JSON.stringify({code,logs}));`);
 for(const time of [NOW-1,NOW+WEEK]){const result=JSON.parse(execFileSync(process.execPath,[runner,String(time)],{env:{},encoding:'utf8',stdio:['ignore','pipe','pipe']}));assert.equal(result.code,1);logs.push(...result.logs);await assert.rejects(lstat(join(f.packet.output,ACTIVATION_RECOVERY_FILE)),{code:'ENOENT'});}
 assert(logs.some(s=>s.startsWith('READY_STOPPED:')));assert(logs.some(s=>s.startsWith('STOP:')));assert.equal(logs.filter(s=>s===`END: ${formatTrialJst(NOW+WEEK)}`).length,2);assert.equal((await readOperationPacket(f.packet.output)).review.endsAtMillis,NOW+WEEK);
});
test('expiry during live proof stops recovery before activation',async t=>{
 const f=await hostingRecoveryFixture(t),h=await activationHarness(f);h.op.cloud.verifyRules=async()=>{h.op.time=NOW+WEEK;return{verified:true};};assert.equal((await h.run()).status,'blocked');await h.journal.flush();assert.deepEqual(h.op.mutations,[]);
});
test('ordinary inspect and gate-first stop remain available after activation recovery despite changed predecessor',async t=>{
 const f=await hostingRecoveryFixture(t),h=await activationHarness(f);assert.equal((await h.run()).status,'active');await h.journal.flush();const receipt=await readFile(join(f.packet.output,ACTIVATION_RECOVERY_FILE));await writeFile(join(f.prior.packet.output,'OPERATION-STATE.json'),'changed');
 const normal=await createJournal(f.packet),checkLocal=()=>verifyOperationPacket(f.packet);assert.equal((await h.op.run('inspect',{journal:normal,checkLocal})).admin,'active');assert.equal((await h.op.run('stop',{journal:normal,checkLocal})).status,'stopped');await normal.flush();assert.deepEqual(await readFile(join(f.packet.output,ACTIVATION_RECOVERY_FILE)),receipt);
});

// Authorized active-trial UI replacement: one Hosting deployment and no admin writes.
async function hostingUpdateFixture(t) {
 const f=await hostingRecoveryFixture(t),activated=await activationHarness(f);assert.equal((await activated.run()).status,'active');await activated.journal.flush();
 const prior=await readActiveHostingPrior(f.packet.output),out=join(f.dir,'hosting-update'),source=join(f.dir,'source-update');
 for(const part of ['lab/floating-garden','functions/floating-garden-trial','functions/floating-garden-online']){await mkdir(dirname(join(source,part)),{recursive:true});await cp(join(ROOT,part),join(source,part),{recursive:true});}
 for(const path of HOSTING_UPDATE_FILES){const from=join(source,path.slice('game/public/'.length));await writeFile(from,(await readFile(from,'utf8'))+'\n// synthetic reviewed UI update\n');}
 await prepareTrialOperation({review:f.review,output:out,now:NOW+180000,repositoryRoot:source});
 const {packet,review:value}=await readOperationPacket(out);return{...f,prior,packet,review:value};
}
async function hostingUpdateHarness(f, count=2) {
 let time=NOW+180000,admin=adminRecords(f.review,true,count),hosting={kind:'game',version:'original-v1'},attempts=0;
 const calls=[],journal=await createHostingUpdateJournal(f.packet,f.review,f.prior,{now:()=>time});
 const oldCloud={preflight:async m=>calls.push('old-preflight:'+m),verifyFunctions:async()=>{calls.push('old-functions');return{verified:true};},verifyRules:async()=>{calls.push('old-rules');return{verified:true};},verifyHosting:async k=>{calls.push('old-hosting:'+k);return{verified:true};},readAdmin:async()=>{calls.push('admin-read');return clone(admin);},readHosting:async()=>{calls.push('hosting-read');return clone(hosting);}};
 const newCloud={preflight:async m=>calls.push('new-preflight:'+m),verifyHosting:async k=>{calls.push('new-hosting:'+k);return{verified:true};},verifyFunctions:async()=>{calls.push('new-functions');return{verified:true};},verifyRules:async()=>{calls.push('new-rules');return{verified:true};}};
 for(const cloud of [oldCloud,newCloud])for(const name of ['createStoppedAdmin','updateAdmin','replaceStoppedWindow','deployFunctions','deployRules','deployHosting'])cloud[name]=()=>assert.fail('Forbidden mutation: '+name);
 const publish=async()=>{attempts++;calls.push('only-hosting-publish');hosting={kind:'game',version:'new-v1'};return{kind:'success'};};
 const checkLocal=()=>verifyHostingUpdatePacket(f.packet,f.review,f.prior);
 return{oldCloud,newCloud,journal,calls,get attempts(){return attempts;},get admin(){return admin;},set admin(v){admin=v;},set time(v){time=v;},run:changes=>operateHostingUpdate({review:f.review,oldCloud,newCloud,publish,journal,checkLocal,now:()=>time,log:()=>{},...changes})};
}
test('active Hosting update preserves two existing rooms, all admin data, fixed dates and old records',async t=>{
 const f=await hostingUpdateFixture(t),paths=[f.state,join(f.prior.packet.output,ACTIVATION_RECOVERY_FILE),f.prior.packet.manifestPath,f.prior.packet.reviewPath,join(f.logs,'hosting-game.stdout.log')],original=await Promise.all(paths.map(p=>readFile(p))),h=await hostingUpdateHarness(f),admin=clone(h.admin);
 assert.equal((await h.run()).status,'active');assert.equal(h.attempts,1);assert.deepEqual(h.admin,admin);assert.equal(h.admin.usage.createdRoomCount,2);assert.equal(h.admin.gate.endsAtMillis,NOW+WEEK);
 assert(h.calls.indexOf('old-functions')<h.calls.indexOf('only-hosting-publish'));assert(h.calls.indexOf('new-rules')>h.calls.indexOf('only-hosting-publish'));
 for(let i=0;i<paths.length;i++)assert.deepEqual(await readFile(paths[i]),original[i]);
 const state=await json(join(f.packet.output,'OPERATION-STATE.json'));assert.deepEqual(state.deploy,{status:'active'});assert.deepEqual(state.stop,{status:'new'});assert.equal(state.hostingUpdate.priorOutput,f.prior.packet.output);assert.equal(state.hostingUpdate.activationReceiptDigest,f.prior.activationReceiptDigest);assert.deepEqual(state.events.map(e=>[e.stage,e.status]),[['update-hosting','issued'],['update-hosting','verified']]);
 assert.equal(await selectVerifiedHostingOperation(f.prior.packet.output,f.packet.output),f.packet.output);assert.throws(()=>h.journal.begin('update-hosting'));await assert.rejects(createHostingUpdateJournal(f.packet,f.review,f.prior));
});
test('Hosting-only source allowlist rejects changed review, other files, inventory additions and no-op packets',async t=>{
 const f=await hostingUpdateFixture(t);await verifyHostingUpdatePacket(f.packet,f.review,f.prior);
 await assert.rejects(verifyHostingUpdatePacket(f.packet,{...f.review,endsAtMillis:f.review.endsAtMillis+1},f.prior));
 const untouched=join(f.dir,'untouched');await prepareTrialOperation({review:f.review,output:untouched,now:NOW+180000});await assert.rejects(verifyHostingUpdatePacket((await readOperationPacket(untouched)).packet,f.review,f.prior));
 const path=join(f.packet.gameDir,'functions/trial-config.json'),bytes=await readFile(path),manifestBytes=await readFile(f.packet.manifestPath),manifest=JSON.parse(manifestBytes);
 await writeFile(path,Buffer.concat([bytes,Buffer.from('\n')]));manifest.files['game/functions/trial-config.json']=sha(await readFile(path));await writeFile(f.packet.manifestPath,JSON.stringify(manifest));await assert.rejects(verifyHostingUpdatePacket((await readOperationPacket(f.packet.output)).packet,f.review,f.prior));
 await writeFile(path,bytes);await writeFile(f.packet.manifestPath,manifestBytes);await writeFile(join(f.packet.gameDir,'public/extra.txt'),'extra');await assert.rejects(verifyHostingUpdatePacket(f.packet,f.review,f.prior));
});
test('real generation changes exactly two public assets and their authenticated source-audit entries',async t=>{
 const f=await hostingUpdateFixture(t),changed=Object.keys(f.packet.manifest.files).filter(path=>f.packet.manifest.files[path]!==f.prior.packet.manifest.files[path]);
 assert.deepEqual(changed.sort(),['game/SOURCE-SHA256.json',...HOSTING_UPDATE_FILES].sort());await verifyHostingUpdatePacket(f.packet,f.review,f.prior);await verifyPreparedHostingPacket(f.packet,f.review,f.prior);
 const before=await json(join(f.prior.packet.gameDir,'SOURCE-SHA256.json')),after=await json(join(f.packet.gameDir,'SOURCE-SHA256.json'));assert.deepEqual(Object.keys(after).filter(key=>before[key]!==after[key]).sort(),HOSTING_UPDATE_FILES.map(path=>path.slice('game/public/'.length)).sort());
 for(const path of HOSTING_UPDATE_FILES){const key=path.slice('game/public/'.length);assert.equal(before[key],f.prior.packet.manifest.files[path]);assert.equal(after[key],f.packet.manifest.files[path]);}
});
test('source audit rejects extra/missing keys, unrelated changes, wrong public hashes and noncanonical duplicate entries',async t=>{
 const f=await hostingUpdateFixture(t),auditPath=join(f.packet.gameDir,'SOURCE-SHA256.json'),audit=await json(auditPath),manifest=await json(f.packet.manifestPath),publicKey=HOSTING_UPDATE_FILES[0].slice('game/public/'.length),other=Object.keys(audit).find(key=>!HOSTING_UPDATE_FILES.includes('game/public/'+key));
 const cases=[v=>{v.extra='f'.repeat(64)},v=>{delete v[other]},v=>{v[other]='f'.repeat(64)},v=>{v[publicKey]='f'.repeat(64)},v=>{v[publicKey]=123}];
 for(const change of cases){const value=clone(audit);change(value);await writeFile(auditPath,JSON.stringify(value,null,2)+'\n');const next=clone(manifest);next.files['game/SOURCE-SHA256.json']=sha(await readFile(auditPath));await writeFile(f.packet.manifestPath,JSON.stringify(next,null,2)+'\n');const {packet}=await readOperationPacket(f.packet.output);await assert.rejects(verifyHostingUpdatePacket(packet,f.review,f.prior));}
 const duplicate=JSON.stringify(audit,null,2).replace('{','{\n'+JSON.stringify(publicKey)+':'+JSON.stringify(audit[publicKey])+',')+'\n';await writeFile(auditPath,duplicate);manifest.files['game/SOURCE-SHA256.json']=sha(await readFile(auditPath));await writeFile(f.packet.manifestPath,JSON.stringify(manifest,null,2)+'\n');await assert.rejects(verifyHostingUpdatePacket((await readOperationPacket(f.packet.output)).packet,f.review,f.prior));
});
test('prepared Hosting continuation rejects every local execution artifact without deleting it',async t=>{
 const f=await hostingUpdateFixture(t);await verifyPreparedHostingPacket(f.packet,f.review,f.prior);
 for(const path of ['OPERATION-STATE.json','OPERATION.lock','ACTIVATION-RECOVERY-STATE.json','hosting-update-logs','recovery-logs','game/functions/node_modules','game/.firebase','firebase-debug.log','game/firebase-debug.log','extra-note']){
  const full=join(f.packet.output,path),directory=['hosting-update-logs','recovery-logs','game/functions/node_modules','game/.firebase'].includes(path);if(directory)await mkdir(full,{recursive:true});else await writeFile(full,'retained');
  await assert.rejects(verifyPreparedHostingPacket(f.packet,f.review,f.prior));assert(await lstat(full));await rm(full,{recursive:true});
 }
 await verifyPreparedHostingPacket(f.packet,f.review,f.prior);
});
async function fullMainHostingFixture(t, prepared, setupFailure=false, tamperPrepared=false) {
 const sourceDir=await temp(t),source=join(sourceDir,'previous-source');
 for(const part of ['lab/floating-garden','functions/floating-garden-trial','functions/floating-garden-online']){await mkdir(dirname(join(source,part)),{recursive:true});await cp(join(ROOT,part),join(source,part),{recursive:true});}
 for(const path of HOSTING_UPDATE_FILES){const target=join(source,path.slice('game/public/'.length));await writeFile(target,(await readFile(target,'utf8'))+'\n// synthetic previous approved UI\n');}
 const f=await hostingRecoveryFixture(t,{repositoryRoot:source}),active=await activationHarness(f);assert.equal((await active.run()).status,'active');await active.journal.flush();
 const runtime=join(f.prior.packet.gameDir,'functions/node_modules');await mkdir(runtime);await writeFile(join(runtime,'synthetic-runtime-canary'),'local runtime copy only');
 const out=join(f.dir,'main-update');if(prepared)await prepareTrialOperation({review:f.review,output:out,now:NOW+180000});
 if(tamperPrepared){const path=HOSTING_UPDATE_FILES[0],full=join(out,path),auditPath=join(out,'game/SOURCE-SHA256.json'),manifestPath=join(out,'OPERATION-MANIFEST.json'),audit=await json(auditPath),manifest=await json(manifestPath);await writeFile(full,(await readFile(full,'utf8'))+'\n// unreviewed resealed packet\n');audit[path.slice('game/public/'.length)]=sha(await readFile(full));await writeFile(auditPath,JSON.stringify(audit,null,2)+'\n');manifest.files[path]=sha(await readFile(full));manifest.files['game/SOURCE-SHA256.json']=sha(await readFile(auditPath));await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');}
 const files=[f.state,f.packet.reviewPath,f.packet.manifestPath,join(f.packet.output,ACTIVATION_RECOVERY_FILE)],original=await Promise.all(files.map(path=>readFile(path)));
 const pending=prepared?await readFile(join(out,'OPERATION-MANIFEST.json')):null,publicMtime=prepared?(await lstat(join(out,HOSTING_UPDATE_FILES[0]))).mtimeMs:null;
 const runner=join(f.dir,'offline-hosting-main.mjs'),mode=prepared?'--resume-hosting-prepared':'--update-hosting-reviewed',args=[mode,'--prior-operation',f.packet.output,prepared?'--operation':'--out',out,'--tooling-dir',join(f.dir,'mock-tooling')];
 await writeFile(runner,`import {main,adminRecords} from ${JSON.stringify(new URL('../scripts/operate-floating-garden-trial.mjs',import.meta.url).href)}; Date.now=()=>${NOW+180000}; const calls=[],logs=[];let published=false;const hostingCapabilities={createCloudAdapter:({packet,review})=>{const old=packet.output===${JSON.stringify(f.packet.output)};calls.push(old?'factory-old':'factory-new');return {preflight:async mode=>calls.push('preflight:'+mode),verifyFunctions:async()=>({verified:true}),verifyRules:async()=>({verified:true}),verifyHosting:async kind=>({verified:kind==='game'}),readAdmin:async()=>{if(!old)throw Error('unexpected second Admin app');return adminRecords(review,true,2)},readHosting:async()=>({kind:'game',version:published?'new':'old'})}},createHostingPublisher:async()=>{calls.push('publisher-factory');if(${JSON.stringify(setupFailure)})throw Error('PRIVATE_SENTINEL_owner@example.invalid');return async()=>{calls.push('hosting-only-publish');published=true;return {kind:'success'}}}};const code=await main(${JSON.stringify(args)},{log:x=>logs.push(x),hostingCapabilities});const firstCalls=[...calls];calls.length=0;const repeated=await main(${JSON.stringify(args)},{log:x=>logs.push(x),hostingCapabilities});console.log(JSON.stringify({code,repeated,calls,firstCalls,logs}));`);
 const result=JSON.parse(execFileSync(process.execPath,[runner],{env:{},encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000}));assert.equal(result.code,setupFailure||tamperPrepared?1:0);assert.equal(result.repeated,1);assert.equal(result.firstCalls.filter(x=>x==='hosting-only-publish').length,setupFailure||tamperPrepared?0:1);assert.deepEqual(result.calls,[]);if(tamperPrepared){assert.deepEqual(result.firstCalls,[]);assert(result.logs.some(x=>x.startsWith('STOP: verify-hosting-source.')));}else if(setupFailure){assert(result.logs.some(x=>x.startsWith('STOP: check-hosting-tooling.')));assert(!JSON.stringify(result).includes('PRIVATE_SENTINEL'));assert(!JSON.stringify(result).includes('owner@example'));}else{assert(result.logs.some(x=>x.startsWith('END:')));assert(result.logs.some(x=>x.startsWith('HOSTING_UPDATED:')));}
 if(tamperPrepared){for(let i=0;i<files.length;i++)assert.deepEqual(await readFile(files[i]),original[i]);assert.deepEqual(await readFile(join(out,'OPERATION-MANIFEST.json')),pending);await assert.rejects(lstat(join(out,'OPERATION-STATE.json')),{code:'ENOENT'});return;}
 assert.equal(await readFile(join(out,'game/functions/node_modules/synthetic-runtime-canary'),'utf8'),'local runtime copy only');const {packet,review:value}=await readOperationPacket(out);assert.deepEqual(value,f.review);assert.equal((await json(join(out,'OPERATION-STATE.json'))).deploy.status,setupFailure?'new':'active');assert.equal(await selectVerifiedHostingOperation(f.packet.output,out),setupFailure?f.packet.output:out);
 for(let i=0;i<files.length;i++)assert.deepEqual(await readFile(files[i]),original[i]);if(prepared){assert.deepEqual(await readFile(packet.manifestPath),pending);assert.equal((await lstat(join(out,HOSTING_UPDATE_FILES[0]))).mtimeMs,publicMtime);}
}
test('full fresh Hosting CLI initialization generates real source audit and reaches exactly one injected publication',async t=>fullMainHostingFixture(t,false));
test('full prepared Hosting CLI initialization reuses bytes/dates, copies runtime and refuses a second run',async t=>fullMainHostingFixture(t,true));
test('Hosting setup reports only a finite stage and suppresses private exception details',async t=>fullMainHostingFixture(t,true,true));
test('prepared main rejects internally resealed UI bytes that differ from the pinned source',async t=>fullMainHostingFixture(t,true,false,true));

test('Hosting prior requires exact active one-shot receipt and stays bound to unchanged predecessor evidence',async t=>{
 const f=await hostingUpdateFixture(t),path=join(f.prior.packet.output,ACTIVATION_RECOVERY_FILE),bytes=await readFile(path),base=JSON.parse(bytes);
 for(const change of [s=>s.deploy.status='failed',s=>s.stop.status='stopped',s=>s.events.pop(),s=>s.events[0].atMillis=NOW-1,s=>s.manifestDigest='f'.repeat(64),s=>s.recovery.originalJournalDigest='f'.repeat(64)]){const state=clone(base);change(state);await writeFile(path,JSON.stringify(state));await assert.rejects(readActiveHostingPrior(f.prior.packet.output));}
 await writeFile(path,Buffer.concat([bytes,Buffer.from('\n')]));await assert.rejects(verifyActiveHostingPrior(f.prior));await writeFile(path,bytes);await verifyActiveHostingPrior(f.prior);
});
test('Hosting update never requires unused count zero but rejects inactive/malformed admin and expired window',async t=>{
 for(const kind of ['stopped','invalid-count','expired','before-start']){const f=await hostingUpdateFixture(t),h=await hostingUpdateHarness(f);if(kind==='stopped')h.admin=adminRecords(f.review,false,2);if(kind==='invalid-count')h.admin.usage.createdRoomCount=21;if(kind==='expired')h.time=NOW+WEEK;if(kind==='before-start')h.time=NOW-1;assert.equal((await h.run()).status,'blocked');assert.equal(h.attempts,0);}
 const f=await hostingUpdateFixture(t),h=await hostingUpdateHarness(f,20);assert.equal((await h.run()).status,'active');assert.equal(h.admin.usage.createdRoomCount,20);
});
test('concurrent admin/Hosting changes and prepublication proof failures prevent the sole Hosting call',async t=>{
 for(const kind of ['admin','hosting','functions','rules','source']){const f=await hostingUpdateFixture(t),h=await hostingUpdateHarness(f);let reads=0;
  if(kind==='admin')h.oldCloud.readAdmin=async()=>({...clone(h.admin),usage:{...h.admin.usage,createdRoomCount:++reads===1?2:3}});
  if(kind==='hosting')h.oldCloud.readHosting=async()=>({kind:'game',version:++reads===1?'v1':'v2'});
  if(kind==='functions')h.oldCloud.verifyFunctions=async()=>({verified:false});if(kind==='rules')h.oldCloud.verifyRules=async()=>({verified:false});
  const changes=kind==='source'?{checkLocal:async()=>{throw Error('changed local source');}}:{};
  assert.equal((await h.run(changes)).status,'blocked');assert.equal(h.attempts,0);
 }
});
test('failed/unknown publication and failed postproof are not retried or promoted as verified updates',async t=>{
 for(const kind of ['failed','unknown','post-hosting','post-functions','post-rules','post-admin']){const f=await hostingUpdateFixture(t),h=await hostingUpdateHarness(f);let attempts=0;
  const changes=['failed','unknown'].includes(kind)?{publish:async()=>{attempts++;return{kind,diagnostic:{reason:'unclassified'}};}}:{};
  if(kind==='post-hosting')h.newCloud.verifyHosting=async()=>({verified:false});if(kind==='post-functions')h.newCloud.verifyFunctions=async()=>({verified:false});if(kind==='post-rules')h.newCloud.verifyRules=async()=>({verified:false});
  if(kind==='post-admin')h.newCloud.verifyRules=async()=>{h.admin.usage.createdRoomCount=3;return{verified:true};};
  assert.equal((await h.run(changes)).status,'blocked');assert.equal(['failed','unknown'].includes(kind)?attempts:h.attempts,1);assert.equal((await json(join(f.packet.output,'OPERATION-STATE.json'))).deploy.status,'failed');assert.equal(await selectVerifiedHostingOperation(f.prior.packet.output,f.packet.output),f.prior.packet.output);assert.throws(()=>h.journal.begin('update-hosting'));
 }
});
test('verified new packet remains selectable for stop without mutable old logs, and ordinary gate-first stop works',async t=>{
 const f=await hostingUpdateFixture(t),h=await hostingUpdateHarness(f);assert.equal((await h.run()).status,'active');await writeFile(f.state,'changed prior journal');
 assert.equal(await selectVerifiedHostingOperation(f.prior.packet.output,f.packet.output),f.packet.output);
 const journal=await createJournal(f.packet),op=fakeOperation();op.admin=clone(h.admin);op.hosting={kind:'game',version:'updated'};
 assert.equal((await op.run('stop',{journal,checkLocal:()=>verifyOperationPacket(f.packet)})).status,'stopped');await journal.flush();assert.deepEqual(op.mutations,['updateAdmin','deployHosting']);assert.equal(op.admin.usage.createdRoomCount,2);assert.equal(await selectVerifiedHostingOperation(f.prior.packet.output,f.packet.output),f.packet.output);
});
test('selection falls back for missing, incomplete, altered own manifest or mismatched Hosting update binding',async t=>{
 const f=await hostingUpdateFixture(t);assert.equal(await selectVerifiedHostingOperation(f.prior.packet.output,join(f.dir,'missing')),f.prior.packet.output);const h=await hostingUpdateHarness(f);assert.equal(await selectVerifiedHostingOperation(f.prior.packet.output,f.packet.output),f.prior.packet.output);assert.equal((await h.run()).status,'active');
 const path=join(f.packet.output,'OPERATION-STATE.json'),bytes=await readFile(path),base=JSON.parse(bytes);
 for(const change of [s=>s.manifestDigest='f'.repeat(64),s=>s.reviewDigest='f'.repeat(64),s=>s.hostingUpdate.priorOutput='/wrong',s=>s.events[1].status='issued',s=>s.deploy.status='running']){const state=clone(base);change(state);await writeFile(path,JSON.stringify(state));assert.equal(await selectVerifiedHostingOperation(f.prior.packet.output,f.packet.output),f.prior.packet.output);}await writeFile(path,bytes);
 await writeFile(join(f.packet.output,HOSTING_UPDATE_FILES[0]),'changed');assert.equal(await selectVerifiedHostingOperation(f.prior.packet.output,f.packet.output),f.prior.packet.output);
});
async function hostingToolingFixture(t) {
 const root=await temp(t),tooling=join(root,'tooling');await mkdir(join(tooling,'node_modules/firebase-tools/lib/bin'),{recursive:true});
 await writeFile(join(tooling,'package.json'),await readFile(join(ROOT,'tests/fixtures/floating-garden-maintenance-package.json')));await writeFile(join(tooling,'package-lock.json'),await readFile(join(ROOT,'package-lock.json')));await writeFile(join(tooling,'node_modules/firebase-tools/package.json'),'{"version":"14.27.0"}');await writeFile(join(tooling,'node_modules/firebase-tools/lib/bin/firebase.js'),'// synthetic CLI; never executed');return tooling;
}
test('Hosting publisher verifies pinned tooling then issues one exact dedicated Hosting command with private bounded logs',async t=>{
 const {packet}=await cachePacket(t),toolingDir=await hostingToolingFixture(t),calls=[],secret='SYNTHETIC_PRIVATE_PROVIDER_DETAIL';
 const runner=(command,args,cwd)=>{calls.push({command,args,cwd});return args.includes('--version')?{exitCode:0,stdout:'14.27.0'}:{exitCode:0,stdout:JSON.stringify({status:'success',result:{}}),stderr:secret};};
 const publish=await createHostingPublisher({packet,toolingDir,runner});assert.deepEqual(await publish(),{kind:'success'});await assert.rejects(publish());assert.equal(calls.length,2);assert.equal(calls[0].cwd,packet.output);
 assert.deepEqual(calls[1].args.slice(1),['deploy','--only','hosting:wa-awesome-garden-stg','--message',`garden-trial-game-v1:${packet.manifestDigest}`,'--config','firebase.hosting-only.json','--project','wa-awesome-garden-stg','--non-interactive','--json']);assert.equal(calls[1].cwd,packet.gameDir);assert.equal(calls[1].command,process.execPath);
 const logs=join(packet.output,'hosting-update-logs');assert.equal((await lstat(logs)).mode&0o777,0o700);assert.equal((await lstat(join(logs,'hosting.stderr.log'))).mode&0o777,0o600);assert.equal(await readFile(join(logs,'hosting.stderr.log'),'utf8'),secret);
});
test('publisher rejects tooling mismatch, preexisting log targets and source tampering without deployment',async t=>{
 const {packet}=await cachePacket(t),toolingDir=await hostingToolingFixture(t);let deploys=0;const runner=(_c,args)=>{if(args.includes('deploy'))deploys++;return{exitCode:0,stdout:args.includes('--version')?'14.27.0':'{"status":"success"}'};};
 await assert.rejects(createHostingPublisher({packet,toolingDir,runner:()=>({exitCode:0,stdout:'99.0.0'})}));
 const publish=await createHostingPublisher({packet,toolingDir,runner});await mkdir(join(packet.output,'hosting-update-logs'));assert.equal((await publish()).kind,'unknown');assert.equal(deploys,0);await assert.rejects(publish());
 const {packet:other}=await cachePacket(t),next=await createHostingPublisher({packet:other,toolingDir,runner});await writeFile(join(other.output,HOSTING_UPDATE_FILES[0]),'changed');await assert.rejects(next());assert.equal(deploys,0);
});

// Provider boundary: entirely injected responses, no cloud calls.
{
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const load = (path) => import(pathToFileURL(join(ROOT, path)));
const adapterModule = await load('scripts/floating-garden-trial-cloud-adapter.mjs');
const { createCloudAdapter, classifyDeployResult, CLEANUP_WARNING, validateFunctionMetadata,
  validateRunService, validateInvokerPolicy, validateSourceArchive, FIRESTORE_CLIENT_CONFIG,
  REGION, RUNTIME_ACCOUNT, makeCloudRunner } = adapterModule;
const { prepareTrialOperation } = await load('scripts/prepare-floating-garden-trial-operation.mjs');
const { FUNCTION_NAMES } = await load('scripts/prepare-floating-garden-trial.mjs');
const { EMBEDDED: fixtureConnectionPayload, connectionMessage: fixtureConnectionMessage,
  CONNECTION_CSP: fixtureConnectionCsp } = await load('scripts/deploy-floating-garden-connection-check.mjs');
const require = createRequire(join(ROOT, 'package.json'));
const archiver = require('archiver'); // Already pinned transitively by firebase-tools.
const NOW = 1791095800000;
const PROJECT = 'wa-awesome-garden-stg';
const PROJECT_NUMBER = '120030709276';
const ORIGIN = `https://${PROJECT}.web.app`;
const SECRET = 'FLOATING_GARDEN_INVITE_HMAC_KEY';
function review() { return { schemaVersion: 1, startsAtMillis: NOW, endsAtMillis: NOW + 604800000,
  testerUids: ['synthetic_alpha', 'synthetic_beta'], retainBuildArtifacts: true,
  allowInitialFunctionRecreate: true, approvePublicInvoker: true }; }
async function temp(t) { const root = await mkdtemp(join(tmpdir(), 'garden-adapter-repro-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
async function packet(t) { const root = await temp(t), input = review(); const output = await prepareTrialOperation({ review: input, output: join(root, 'packet'), now: NOW }); return { root, review: input, packet: output }; }
async function zip(entries) {
  const archive = archiver('zip'), chunks = [];
  archive.on('data', (bytes) => chunks.push(bytes));
  const done = new Promise((ok, bad) => { archive.on('end', ok); archive.on('error', bad); });
  for (const [name, bytes] of entries) archive.append(bytes, { name, mode: 0o100644 });
  await archive.finalize(); await done; return Buffer.concat(chunks);
}
function metadata(index = 0) {
  const name = FUNCTION_NAMES[index], service = `projects/${PROJECT}/locations/${REGION}/services/garden-fn-${index}`;
  return { name: `projects/${PROJECT}/locations/${REGION}/functions/${name}`, environment: 'GEN_2', state: 'ACTIVE',
    labels: { 'firebase-functions-codebase': 'floating-garden-trial', 'deployment-callable': 'true' },
    buildConfig: { runtime: 'nodejs22', entryPoint: name, sourceProvenance: { resolvedStorageSource: {
      bucket: `gcf-v2-sources-${PROJECT_NUMBER}-${REGION}`, object: 'function-source.zip', generation: '123' } } },
    serviceConfig: { service, revision: `garden-fn-${index}-00001-abc`, serviceAccountEmail: RUNTIME_ACCOUNT,
      availableMemory: '256Mi', availableCpu: '1', maxInstanceRequestConcurrency: 1, maxInstanceCount: 1,
      timeoutSeconds: 30, ingressSettings: 'ALLOW_ALL', allTrafficOnLatestRevision: true,
      secretEnvironmentVariables: index < 2 ? [{ key: SECRET, secret: SECRET, projectId: PROJECT_NUMBER, version: '1' }] : [] } };
}
function runService(fn) {
  const name = fn.serviceConfig.service, revision = `${name}/revisions/${fn.serviceConfig.revision}`;
  return { name, generation: '1', observedGeneration: '1', terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
    latestCreatedRevision: revision, latestReadyRevision: revision,
    template: { serviceAccount: RUNTIME_ACCOUNT, scaling: { maxInstanceCount: 1 }, maxInstanceRequestConcurrency: 1,
      timeout: '30s', containers: [{ resources: { limits: { memory: '256Mi', cpu: '1' } } }] },
    trafficStatuses: [{ revision, percent: 100 }] };
}
const invokerPolicy = () => ({ bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }] });
const identityRunner = (cmd, args) => {
  assert.equal(cmd, 'gcloud');
  assert(args.includes(`--project=${PROJECT}`));
  assert(args.includes('--format=json'));
  assert(['config', 'projects'].includes(args[0]));
  return { exitCode: 0, stdout: JSON.stringify(args[0] === 'config' ? {} : { projectId: PROJECT, projectNumber: PROJECT_NUMBER, lifecycleState: 'ACTIVE' }) };
};

async function providerHarness(t, overrides = {}) {
  const fixture = await packet(t), { packet: p, root } = fixture;
  const manifest = JSON.parse(await readFile(p.manifestPath));
  const entries = await Promise.all(Object.keys(manifest.files).filter((x) => x.startsWith('game/functions/')).map(async (path) => [path.slice(15), await readFile(join(p.output, path))]));
  const archive = await zip(entries), functions = FUNCTION_NAMES.map((_, i) => metadata(i));
  const rules = await readFile(join(p.gameDir, 'firestore.rules'), 'utf8');
  const requests = [], cli = [], publicReads = [];
  let hosting = 'game';
  const requestClient = { request: async (options) => {
    requests.push(options); const { url, method, retry, maxRedirects } = options;
    assert.equal(method, 'GET'); assert.equal(retry, false); assert.equal(maxRedirects, 0);
    let data;
    if (url.startsWith('https://cloudfunctions.googleapis.com/')) data = { functions: structuredClone(functions) };
    else if (url.startsWith('https://run.googleapis.com/') && url.includes(':getIamPolicy')) data = invokerPolicy();
    else if (url.startsWith('https://run.googleapis.com/')) {
      const name = url.slice('https://run.googleapis.com/v2/'.length), fn = functions.find((f) => f.serviceConfig.service === name);
      assert(fn); data = runService(fn);
    } else if (url.includes('/releases/cloud.firestore')) data = { name: `projects/${PROJECT}/releases/cloud.firestore`, rulesetName: `projects/${PROJECT}/rulesets/synthetic` };
    else if (url.includes('/rulesets/')) data = { name: `projects/${PROJECT}/rulesets/synthetic`, source: { files: [{ name: 'firestore.rules', content: rules }] } };
    else if (url.startsWith('https://storage.googleapis.com/') && url.includes('&alt=media')) data = archive;
    else if (url.startsWith('https://storage.googleapis.com/') && url.includes('/o/')) data = { bucket: `gcf-v2-sources-${PROJECT_NUMBER}-${REGION}`, name: 'function-source.zip', generation: '123', size: String(archive.length) };
    else if (url.startsWith('https://storage.googleapis.com/')) data = { name: `gcf-v2-sources-${PROJECT_NUMBER}-${REGION}`, projectNumber: PROJECT_NUMBER };
    else assert.fail('Unrecognized synthetic provider URL');
    if (overrides.response) data = overrides.response(url, data);
    return { status: 200, data };
  } };
  // Same immutable manifest inputs as the existing connection publisher tests.
  const toolingDir = join(root, 'tooling'); await mkdir(join(toolingDir, 'node_modules/firebase-tools/lib/bin'), { recursive: true });
  await writeFile(join(toolingDir, 'package.json'), await readFile(join(ROOT, 'tests/fixtures/floating-garden-maintenance-package.json')));
  await writeFile(join(toolingDir, 'package-lock.json'), await readFile(join(ROOT, 'package-lock.json')));
  await writeFile(join(toolingDir, 'node_modules/firebase-tools/package.json'), '{"version":"14.27.0"}');
  await writeFile(join(toolingDir, 'node_modules/firebase-tools/lib/bin/firebase.js'), '// synthetic; never executed');
  const runner = (cmd, args, cwd) => {
    cli.push({ cmd, args, cwd });
    if (overrides.command) { const handled = overrides.command(cmd, args, cwd); if (handled !== undefined) return handled; }
    if (cmd === 'gcloud') return identityRunner(cmd, args);
    assert.equal(cmd, process.execPath);
    if (args.includes('--version')) return { exitCode: 0, stdout: '14.27.0' };
    assert(args.includes('--non-interactive')); assert(args.includes('--json'));
    let result;
    if (args[1] === 'hosting:sites:list') result = { sites: [{ name: `projects/${PROJECT}/sites/${PROJECT}`, defaultUrl: ORIGIN }] };
    else {
      assert.equal(args[1], 'hosting:channel:list');
      result = { channels: [{ name: `sites/${PROJECT}/channels/live`, url: ORIGIN,
        release: { type: 'DEPLOY', message: hosting === 'maintenance' ? 'garden-maintenance-static-v1' :
          hosting === 'connection' ? fixtureConnectionMessage(fixtureConnectionPayload) : `garden-trial-${hosting}-v1:${p.manifestDigest}`,
          version: { name: `sites/${PROJECT}/versions/synthetic`, status: 'FINALIZED' } } }] };
    }
    return { exitCode: 0, stdout: JSON.stringify({ status: 'success', result }) };
  };
  const fetchImpl = async (url, options) => {
    assert.equal(new URL(url).origin, ORIGIN); assert.equal(options.redirect, ['connection', 'maintenance'].includes(hosting) ? 'error' : 'manual');
    const path = new URL(url).pathname; publicReads.push({ hosting, path });
    const dir = hosting === 'game' ? p.gameDir : p.stoppedDir;
    const config = JSON.parse(await readFile(join(dir, hosting === 'game' ? 'firebase.hosting-only.json' : 'firebase.maintenance.json')));
    const headers = Object.fromEntries(config.hosting.headers[0].headers.map((h) => [h.key, h.value]));
    if (hosting === 'game' && path === '/') return new Response('', { status: 302, headers: { ...headers, location: '/lab/floating-garden/trial/index.html' } });
    if (hosting === 'connection' && path.startsWith('/connection-check/')) {
      const name = path.slice('/connection-check/'.length) || 'index.html';
      const bytes = fixtureConnectionPayload.connectionFiles[name]; assert.notEqual(bytes, undefined);
      headers['Content-Security-Policy'] = fixtureConnectionCsp;
      return new Response(bytes, { status: 200, headers });
    }
    const key = path === '/' ? 'index.html' : path.slice(1); let body, status;
    try { body = await readFile(join(dir, 'public', key)); status = 200; }
    catch { body = await readFile(join(p.stoppedDir, 'public/404.html')); status = 404; }
    if (overrides.publicBody) body = overrides.publicBody(path, body);
    return new Response(body, { status, headers });
  };
  const cloud = createCloudAdapter({ ...fixture, toolingDir, runner, requestClient, fetchImpl, env: {}, execArgv: [], now: () => NOW });
  await cloud.preflight('stop'); // Only injected identity reads; no absence requirement.
  return { ...fixture, cloud, manifest, requests, cli, publicReads, functions, toolingDir, runner, requestClient, fetchImpl,
    setHosting: (value) => { hosting = value; } };
}

test('constructing the adapter does not evaluate packet/review or call capabilities', () => {
  const hostile = new Proxy({}, { get() { assert.fail('Lazy data evaluated'); } });
  const no = () => assert.fail('Capability invoked during construction');
  const cloud = createCloudAdapter({ packet: hostile, review: hostile, toolingDir: '/synthetic', runner: no,
    requestClient: { request: no }, db: hostile, now: no, fetchImpl: no, env: {}, execArgv: [] });
  assert.deepEqual(Object.keys(cloud).sort(), ['preflight', 'readAdmin', 'createStoppedAdmin', 'replaceStoppedWindow', 'updateAdmin', 'deployFunctions', 'verifyFunctions', 'verifyResumeSource', 'deployRules', 'verifyRules', 'readHosting', 'deployHosting', 'verifyHosting'].sort());
});

test('CLI classification distinguishes success, exact cleanup warning, failure and unknown', () => {
  assert.deepEqual(classifyDeployResult({ exitCode: 0, stdout: '{"status":"success"}' }), { kind: 'success' });
  const warning = { exitCode: 1, stdout: JSON.stringify({ status: 'error', error: CLEANUP_WARNING }) };
  assert.equal(classifyDeployResult(warning).kind, 'failed');
  assert.equal(classifyDeployResult(warning).diagnostic.exitCode, 1);
  assert.deepEqual(classifyDeployResult(warning, { allowCleanupWarning: true }), { kind: 'cleanup-warning' });
  assert.equal(classifyDeployResult({ ...warning, stdout: JSON.stringify({ status: 'error', error: CLEANUP_WARNING + ' unrelated failure' }) }, { allowCleanupWarning: true }).kind, 'failed');
  assert.equal(classifyDeployResult({ exitCode: null, signal: 'SIGTERM', stdout: warning.stdout }, { allowCleanupWarning: true }).kind, 'unknown');
  assert.equal(classifyDeployResult({ exitCode: 0, stdout: 'not JSON' }).kind, 'unknown');
});

test('all five function metadata checks bind source, labels, limits and exact HMAC users', () => {
  for (let i = 0; i < 5; i++) assert.equal(validateFunctionMetadata(metadata(i), FUNCTION_NAMES[i]).source.generation, '123');
  const mutations = [
    (f) => { f.state = 'DEPLOYING'; }, (f) => { f.environment = 'GEN_1'; },
    (f) => { f.buildConfig.runtime = 'nodejs20'; }, (f) => { f.buildConfig.entryPoint = 'other'; },
    (f) => { f.labels['firebase-functions-codebase'] = 'other'; }, (f) => { f.serviceConfig.maxInstanceCount = 2; },
    (f) => { f.serviceConfig.maxInstanceRequestConcurrency = 80; }, (f) => { f.serviceConfig.serviceAccountEmail = 'other@example.invalid'; },
    (f) => { f.serviceConfig.secretEnvironmentVariables[0].version = 'latest'; },
    (f) => { f.buildConfig.sourceProvenance.resolvedStorageSource.bucket = 'unrelated-bucket'; },
    (f) => { f.buildConfig.sourceProvenance.resolvedStorageSource.generation = ''; },
  ];
  for (const mutate of mutations) { const f = metadata(); mutate(f); assert.throws(() => validateFunctionMetadata(f, FUNCTION_NAMES[0])); }
  const noSecret = metadata(2); noSecret.serviceConfig.secretEnvironmentVariables = metadata(0).serviceConfig.secretEnvironmentVariables;
  assert.throws(() => validateFunctionMetadata(noSecret, FUNCTION_NAMES[2]));
});

test('Run proof requires Ready/current generation, latest function revision and unconditional invoker', () => {
  const fn = metadata(), run = runService(fn), revision = `${fn.serviceConfig.service}/revisions/${fn.serviceConfig.revision}`;
  assert(validateRunService(run, run.name, revision));
  assert.throws(() => validateRunService(run, run.name, revision + '-unrelated'));
  assert.throws(() => validateRunService({ ...run, generation: '2' }, run.name, revision));
  assert.throws(() => validateRunService({ ...run, reconciling: true }, run.name, revision));
  assert(validateInvokerPolicy(invokerPolicy()));
  assert.throws(() => validateInvokerPolicy({ bindings: [{ role: 'roles/run.invoker', members: ['allUsers'], condition: { expression: 'true' } }] }));
  assert.throws(() => validateInvokerPolicy({ bindings: [{ role: 'roles/run.invoker', members: ['allAuthenticatedUsers'] }] }));
});

test('Run traffic accepts observed single 100-percent LATEST with absent or empty revision for all five functions', () => {
  for (let i = 0; i < FUNCTION_NAMES.length; i++) {
    const run = runService(metadata(i)), revision = run.latestReadyRevision;
    for (const target of [
      { type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 100 },
      { type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 100, revision: '' },
    ]) assert.equal(validateRunService({ ...run, trafficStatuses: [target] }, run.name, revision), true);
  }
});

test('Run traffic binds full or short explicit latest revision to the exact Service for all five functions', () => {
  for (let i = 0; i < FUNCTION_NAMES.length; i++) {
    const run = runService(metadata(i)), revision = run.latestReadyRevision;
    for (const type of [undefined, 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST']) {
      for (const value of [revision, revision.split('/').at(-1)]) {
        assert.equal(validateRunService({ ...run, trafficStatuses: [{ ...(type === undefined ? {} : { type }), percent: 100, revision: value }] }, run.name, revision), true);
      }
    }
  }
});

test('Run short revision identity never crosses Service, project or region and never normalizes arbitrary text', () => {
  const run = runService(metadata()), revision = run.latestReadyRevision, id = revision.split('/').at(-1);
  const wrong = [id + '-other', id.toUpperCase(), ` ${id}`, `${id} `, `${id}\n`, `../${id}`, `./${id}`,
    `${id}/`, `${id}%2F`, `${id}%00`, `${id}_`, `${id}.`, 'a'.repeat(64), '-', 'a-', 0, null, false, {}, [],
    revision.replace('/services/', '/services/other-'), revision.replace('/locations/asia-northeast1/', '/locations/us-central1/'),
    revision.replace(`projects/${PROJECT}/`, 'projects/wrong-project/'),
    revision.replace(`projects/${PROJECT}/`, 'projects/120030709276/'),
    `https://run.googleapis.com/v2/${revision}`, `${run.name}/revisions/../revisions/${id}`];
  for (const value of wrong) for (const type of [undefined, 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION']) {
    assert.throws(() => validateRunService({ ...run, trafficStatuses: [{ ...(type === undefined ? {} : { type }), percent: 100, revision: value }] }, run.name, revision), error => error.code === 'run-latest-traffic');
  }
});

test('Run short revision equivalence cannot bypass readiness, Function identity or traffic constraints', () => {
  const run = runService(metadata()), revision = run.latestReadyRevision, id = revision.split('/').at(-1);
  const target = { type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 100, revision: id };
  const actual = { ...run, trafficStatuses: [target] };
  for (const mutation of [{ reconciling: true }, { observedGeneration: '999' }, { latestCreatedRevision: revision + '-other' },
    { terminalCondition: { type: 'Ready', state: 'CONDITION_FAILED' } }]) {
    assert.throws(() => validateRunService({ ...actual, ...mutation }, run.name, revision));
  }
  assert.throws(() => validateRunService(actual, run.name, revision + '-other'));
  for (const value of [
    [{ ...target, percent: 99 }], [{ ...target, percent: '100' }], [{ ...target, percent: true }],
    [target, { ...target, percent: 0 }], [{ ...target, type: 'UNKNOWN' }],
    [{ ...target, type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_UNSPECIFIED' }],
  ]) assert.throws(() => validateRunService({ ...run, trafficStatuses: value }, run.name, revision), error => error.code === 'run-latest-traffic');
});

test('Run traffic rejects conflicts, splits, malformed percentages and unknown allocation types', () => {
  const run = runService(metadata()), revision = run.latestReadyRevision;
  const latest = { type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 100 };
  const rejected = [
    undefined, null, {}, [], [null], [100],
    [{ ...latest, revision: revision + '-other' }], [{ ...latest, revision: null }], [{ ...latest, revision: 0 }],
    [{ ...latest, revision: false }], [{ ...latest, revision: ' ' }],
    [{ ...latest, percent: 99 }], [{ ...latest, percent: 0 }], [{ ...latest, percent: 101 }],
    [{ ...latest, percent: '100' }], [{ type: latest.type }],
    [latest, { type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision, percent: 0 }],
    [{ ...latest, percent: 50 }, { type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision, percent: 50 }],
    [{ percent: 100 }], [{ percent: 100, revision: '' }],
    [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', percent: 100 }],
    [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', percent: 100, revision: '' }],
  ];
  for (const type of ['TRAFFIC_TARGET_ALLOCATION_TYPE_UNSPECIFIED', 'UNKNOWN', '', null, 1, 2]) {
    rejected.push([{ type, percent: 100 }], [{ type, percent: 100, revision }]);
  }
  for (const trafficStatuses of rejected) assert.throws(() => validateRunService({ ...run, trafficStatuses }, run.name, revision), (error) => error.code === 'run-latest-traffic');
});

test('Run LATEST traffic does not bypass exact function revision, readiness, generation or resource checks', () => {
  const run = runService(metadata()), revision = run.latestReadyRevision;
  run.trafficStatuses = [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 100 }];
  assert.throws(() => validateRunService(run, run.name, revision + '-other'), (error) => error.code === 'run-ready-latest');
  const mutations = [
    (value) => { value.reconciling = true; },
    (value) => { value.terminalCondition.state = 'CONDITION_PENDING'; },
    (value) => { value.latestCreatedRevision = revision + '-other'; },
    (value) => { value.latestReadyRevision = revision.split('/').at(-1); value.latestCreatedRevision = value.latestReadyRevision; },
    (value) => { value.generation = '2'; },
    (value) => { value.template.serviceAccount = 'synthetic-other@example.invalid'; },
    (value) => { value.template.scaling.minInstanceCount = 1; },
    (value) => { value.template.scaling.maxInstanceCount = 2; },
    (value) => { value.template.maxInstanceRequestConcurrency = 80; },
    (value) => { value.template.timeout = '60s'; },
    (value) => { value.template.containers[0].resources.limits.memory = '512Mi'; },
    (value) => { value.template.containers[0].resources.limits.cpu = '2'; },
  ];
  for (const mutate of mutations) { const changed = structuredClone(run); mutate(changed); assert.throws(() => validateRunService(changed, run.name, revision)); }
});

test('full injected Functions proof accepts the observed LATEST representation on all five Run services', async (t) => {
  const h = await providerHarness(t, { response: (url, data) => url.startsWith('https://run.googleapis.com/') && !url.includes(':getIamPolicy') ?
    { ...data, trafficStatuses: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 100 }] } : data });
  assert.deepEqual(await h.cloud.verifyFunctions(), { verified: true });
  assert.equal(h.requests.filter(({ url }) => url.startsWith('https://run.googleapis.com/') && !url.includes(':getIamPolicy')).length, 5);
  assert(h.cli.every(({ args }) => !args.includes('deploy')));
});

test('full injected Functions proof accepts observed short LATEST revision IDs on all five exact services', async (t) => {
  const h = await providerHarness(t, { response: (url, data) => url.startsWith('https://run.googleapis.com/') && !url.includes(':getIamPolicy') ?
    { ...data, trafficStatuses: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 100, revision: data.latestReadyRevision.split('/').at(-1) }] } : data });
  assert.deepEqual(await h.cloud.verifyFunctions(), { verified: true });
  assert.equal(h.requests.filter(({ url }) => url.startsWith('https://run.googleapis.com/') && !url.includes(':getIamPolicy')).length, 5);
  assert(h.cli.every(({ args }) => !args.includes('deploy')));
});

test('genuine pinned archiver ZIP matches exact source bytes', async () => {
  const files = { 'index.js': Buffer.from('module.exports = {}\n'), 'folder/a.json': Buffer.from('{}\n') };
  assert.deepEqual(validateSourceArchive(await zip(Object.entries(files)), files), { verified: true, fileCount: 2 });
});

test('ZIP rejects extras, duplicate paths, traversal, symlinks, hidden bytes and corruption', async () => {
  const files = { 'index.js': Buffer.from('module.exports = {}\n'), 'folder/a.json': Buffer.from('{}\n') }, entries = Object.entries(files);
  for (const values of [[...entries, ['extra', 'x']], [entries[0], entries[0]]]) {
    const bad = await zip(values); assert.throws(() => validateSourceArchive(bad, files));
  }
  const good = await zip(entries), traversal = Buffer.from(good), old = Buffer.from('folder/a.json'), replacement = Buffer.from('../dir/a.json');
  assert.equal(old.length, replacement.length); let at = 0;
  // archiver sanitizes ../ names itself. Change BOTH ZIP name fields afterward.
  while ((at = traversal.indexOf(old, at)) >= 0) { replacement.copy(traversal, at); at += old.length; }
  assert.throws(() => validateSourceArchive(traversal, files));
  const symlink = Buffer.from(good), central = symlink.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert(central > 0); symlink.writeUInt32LE((0xa1ff * 65536) >>> 0, central + 38);
  assert.throws(() => validateSourceArchive(symlink, files));
  assert.throws(() => validateSourceArchive(Buffer.concat([Buffer.from('unexpected'), good]), files));
  const corrupt = Buffer.from(good); corrupt[30 + corrupt.readUInt16LE(26) + corrupt.readUInt16LE(28)] ^= 1;
  assert.throws(() => validateSourceArchive(corrupt, files));
});

test('fully injected provider proof verifies Functions/source/Run/IAM/Rules and game/stopped Hosting', async (t) => {
  const h = await providerHarness(t);
  assert.deepEqual(await h.cloud.verifyFunctions(), { verified: true });
  assert.deepEqual(await h.cloud.verifyRules(), { verified: true });
  assert.deepEqual(await h.cloud.verifyHosting('game'), { verified: true });
  h.setHosting('stopped'); assert.deepEqual(await h.cloud.verifyHosting('stopped'), { verified: true });
  assert.equal(h.requests.length, 18);
  const gamePaths = Object.keys(h.manifest.files).filter((p) => p.startsWith('game/public/')).map((p) => '/' + p.slice(12));
  for (const path of gamePaths) {
    assert(h.publicReads.some((r) => r.hosting === 'game' && r.path === path));
    assert(h.publicReads.some((r) => r.hosting === 'stopped' && r.path === path));
  }
  for (const path of ['/connection-check/', '/connection-check/connection-runtime.js', '/lab/floating-garden/trial/']) assert(h.publicReads.some((r) => r.hosting === 'stopped' && r.path === path));
  assert(h.cli.every(({ args }) => !args.includes('deploy')));
});

test('Hosting metadata reads reject timeout or signal despite exit zero and complete success JSON', async (t) => {
  for (const command of ['hosting:sites:list', 'hosting:channel:list']) for (const fault of [
    { timedOut: true, signal: null, reason: 'timeout' },
    { timedOut: false, signal: 'SYNTHETIC_PRIVATE_SIGNAL', reason: 'process-interrupted' },
  ]) {
    let h, reads = 0;
    h = await providerHarness(t, { command: (_, args) => {
      if (args[1] !== command) return undefined;
      reads++;
      const result = command === 'hosting:sites:list' ? { sites: [{ name: `projects/${PROJECT}/sites/${PROJECT}`, defaultUrl: ORIGIN }] } :
        { channels: [{ name: `sites/${PROJECT}/channels/live`, url: ORIGIN, release: { type: 'DEPLOY',
          message: `garden-trial-game-v1:${h.packet.manifestDigest}`,
          version: { name: `sites/${PROJECT}/versions/synthetic`, status: 'FINALIZED' } } }] };
      return { exitCode: 0, signal: fault.signal, timedOut: fault.timedOut,
        stdout: JSON.stringify({ status: 'success', result }), stderr: 'SYNTHETIC_PRIVATE_STDERR' };
    } });
    await assert.rejects(h.cloud.readHosting(), error => {
      assert.deepEqual(describeAdapterFailure(error), { reason: fault.reason, exitCode: 0, timedOut: fault.timedOut });
      assert(!error.message.includes('SYNTHETIC_PRIVATE')); return true;
    });
    assert.equal(reads, 1); assert.equal(h.publicReads.length, 0);
    assert(h.cli.every(({ args }) => !args.includes('deploy')));
  }
});

test('provider proof fails closed on wrong source generation and Rules bytes', async (t) => {
  const wrongSource = await providerHarness(t, { response: (url, data) => url.startsWith('https://storage.googleapis.com/') && url.includes('/o/') && !url.includes('alt=media') ? { ...data, generation: '999' } : data });
  await assert.rejects(wrongSource.cloud.verifyFunctions(), /source-object-identity/);
  const wrongRules = await providerHarness(t, { response: (url, data) => url.includes('/rulesets/') ? { ...data, source: { files: [{ name: 'firestore.rules', content: 'allow everything' }] } } : data });
  await assert.rejects(wrongRules.cloud.verifyRules(), /rules-bytes/);
});

test('provider proof rejects mismatched public game bytes', async (t) => {
  const h = await providerHarness(t, { publicBody: (path, bytes) => path.endsWith('/trialruntime.js') ? Buffer.from('wrong') : bytes });
  await assert.rejects(h.cloud.verifyHosting('game'), /hosting-bytes/);
});

function resumeRecords(input) {
  return { gate: { enabled: false, projectId: PROJECT, region: REGION, previewOrigin: ORIGIN,
    startsAtMillis: input.startsAtMillis, endsAtMillis: input.endsAtMillis, maxRooms: 20, testerUids: [] },
    usage: { projectId: PROJECT, startsAtMillis: input.startsAtMillis, endsAtMillis: input.endsAtMillis, maxRooms: 20, createdRoomCount: 0 },
    testers: input.testerUids.map(() => ({ active: false, expiresAtMillis: input.endsAtMillis })) };
}
async function recoveryHarness(t, options = {}) {
  let current = NOW + 60000, drift = false, rulesChanged = false;
  const deniedRules = await readFile(join(ROOT, 'config/floating-garden-trial/deny-all.rules'), 'utf8');
  const h = await providerHarness(t, {
    response: (url, value) => {
      if (url.includes('/rulesets/')) value = { ...value, source: { files: [{ name: 'firestore.rules', content: rulesChanged ? 'unapproved' : deniedRules }] } };
      if (drift && url.startsWith('https://cloudfunctions.googleapis.com/')) value = { ...value, functions: value.functions.slice(1) };
      return options.response ? options.response(url, value) : value;
    },
    command: (cmd, args, cwd) => {
      if (options.command) { const handled = options.command(cmd, args, cwd); if (handled !== undefined) return handled; }
      if (cmd === 'gcloud' && args[0] === 'services') return { exitCode: 0, stdout: JSON.stringify(adapterModule.RESUME_REQUIRED_APIS.filter((name) => name !== options.missingApi).map((name) => ({ config: { name } }))) };
      if (cmd === process.execPath && args[1] === 'deploy') return options.deployResult ?? { exitCode: 0, stdout: '{"status":"success"}' };
    },
  });
  h.setHosting(options.hosting ?? 'connection');
  const nextReview = { ...h.review, startsAtMillis: NOW + 3600000, endsAtMillis: NOW + 3600000 + 604800000,
    ...(options.newReview ?? {}) };
  const nextPacket = await prepareTrialOperation({ review: nextReview, output: join(h.root, 'recovery'), now: current });
  const initial = resumeRecords(h.review), paths = ['floatingGardenTrial/config', 'floatingGardenTrial/usage', ...h.review.testerUids.map((uid) => `floatingGardenTrialTesters/${uid}`)];
  const docs = new Map(paths.map((path, i) => [path, structuredClone([initial.gate, initial.usage, ...initial.testers][i])]));
  if (options.mutateDocs) options.mutateDocs(docs, paths);
  const writes = [], transactionReads = []; let transactions = 0;
  const snap = (ref) => ({ exists: docs.has(ref.path), data: () => structuredClone(docs.get(ref.path)) });
  const db = { doc: (path) => ({ path }), getAll: async (...refs) => refs.map(snap),
    runTransaction: async (callback, config) => {
      transactions++; assert.deepEqual(config, { maxAttempts: 1 }); const queued = [];
      if (options.beforeTransaction) options.beforeTransaction(docs, paths);
      await callback({ get: async (ref) => { transactionReads.push(ref.path); return snap(ref); },
        create: () => assert.fail('Recovery must never create a document'),
        update: (ref, value) => { assert(docs.has(ref.path)); assert.equal(transactionReads.length, 4);
          writes.push({ path: ref.path, value: structuredClone(value) }); queued.push([ref.path, value]); } });
      if (!options.commitUnknown || options.applyBeforeUnknown) for (const [path, value] of queued) docs.set(path, { ...docs.get(path), ...value });
      if (options.commitUnknown) throw Error('synthetic private uncertain commit');
    } };
  const prior = { packet: h.packet, review: h.review };
  const shared = { toolingDir: h.toolingDir, runner: h.runner, requestClient: h.requestClient, fetchImpl: h.fetchImpl, db,
    env: {}, execArgv: [], now: () => current };
  const cloud = createCloudAdapter({ ...shared, packet: nextPacket, review: nextReview, prior });
  const old = createCloudAdapter({ ...shared, ...prior });
  return { ...h, cloud, old, nextReview, nextPacket, prior, initial, next: resumeRecords(nextReview), docs, paths, writes, transactionReads,
    transactions: () => transactions, moveClock: (value) => { current = value; }, drift: () => { drift = true; },
    changeRules: () => { rulesChanged = true; }, fresh: () => createCloudAdapter({ ...shared, packet: nextPacket, review: nextReview, prior }) };
}

test('recovery readiness accepts only the same exact connection baseline as execution before a new clock is chosen', async (t) => {
  for (const hosting of ['connection', 'maintenance']) {
    const h = await recoveryHarness(t, { hosting });
    await h.old.preflight('stop');
    if (hosting === 'connection') assert.deepEqual(await h.old.verifyResumeSource(), { verified: true });
    else { await assert.rejects(h.old.verifyResumeSource(), /resume-hosting/); await assert.rejects(h.cloud.preflight('resume'), /resume-hosting/); }
    assert.equal(h.transactions(), 0); assert.equal(h.writes.length, 0); assert(!h.cli.some(({ args }) => args.includes('deploy')));
  }
});

test('recovery requires pinned deployment services already enabled with one bounded list and never enables any', async (t) => {
  for (const missingApi of ['cloudbilling.googleapis.com', 'firebaseextensions.googleapis.com', 'run.googleapis.com']) {
    const h = await recoveryHarness(t, { missingApi });
    await h.old.preflight('stop');
    await assert.rejects(h.old.verifyResumeSource(), /apis-already-enabled/);
    const services = h.cli.filter(({ cmd, args }) => cmd === 'gcloud' && args[0] === 'services');
    assert.equal(services.length, 1); assert.equal(services[0].args[1], 'list');
    assert.equal(h.transactions(), 0); assert(!h.cli.some(({ args }) => args.includes('deploy') || args.includes('enable')));
  }
  const h = await recoveryHarness(t); await h.cloud.preflight('resume');
  assert.equal(h.cli.filter(({ cmd, args }) => cmd === 'gcloud' && args[0] === 'services').length, 1);
});

test('prior readiness CLI metadata and version checks isolate their cwd and preserve original debug logs', async (t) => {
  const fs = require('node:fs'), readDirectories = [];
  const h = await recoveryHarness(t, { command: (cmd, args, cwd) => {
    if (cmd !== process.execPath) return undefined;
    assert(!args.includes('deploy')); assert.equal(fs.lstatSync(cwd).mode & 0o777, 0o700);
    assert(cwd.startsWith(join(tmpdir(), 'garden-trial-cli-read-')));
    readDirectories.push(cwd); fs.writeFileSync(join(cwd, 'firebase-debug.log'), 'synthetic read-only CLI log');
  } });
  const originals = [join(h.prior.packet.gameDir, 'firebase-debug.log'), join(h.prior.packet.gameDir, 'firebase-debug.1.log'), join(h.toolingDir, 'firebase-debug.log')];
  for (const path of originals) await writeFile(path, 'original private evidence', { mode: 0o600 });
  await h.old.preflight('stop'); await h.old.verifyResumeSource();
  assert(readDirectories.length >= 5);
  for (const directory of readDirectories) assert.equal(fs.existsSync(directory), false);
  for (const path of originals) assert.equal(await readFile(path, 'utf8'), 'original private evidence');
  for (const { cmd, args, cwd } of h.cli) if (cmd === process.execPath) {
    assert.notEqual(cwd, h.prior.packet.gameDir); assert.notEqual(cwd, h.toolingDir);
    if (!args.includes('--version')) assert.equal(args[args.indexOf('--config') + 1], join(h.prior.packet.gameDir, 'firebase.hosting-only.json'));
  }
});

test('resume preflight proves old backend while replacement CAS updates only four disabled window fields', async (t) => {
  const h = await recoveryHarness(t), beforeFiles = await Promise.all([h.prior.packet.manifestPath, h.prior.packet.reviewPath].map((path) => readFile(path)));
  assert.deepEqual(await h.cloud.preflight('resume'), { verified: true });
  assert.deepEqual(await h.cloud.readAdmin(), h.initial);
  assert.deepEqual(await h.cloud.replaceStoppedWindow(h.next, h.initial), { kind: 'success' });
  assert.equal(h.transactions(), 1); assert.deepEqual(h.transactionReads, h.paths);
  assert.deepEqual(h.writes, [
    { path: h.paths[0], value: { startsAtMillis: h.nextReview.startsAtMillis, endsAtMillis: h.nextReview.endsAtMillis } },
    { path: h.paths[1], value: { startsAtMillis: h.nextReview.startsAtMillis, endsAtMillis: h.nextReview.endsAtMillis } },
    ...h.paths.slice(2).map((path) => ({ path, value: { expiresAtMillis: h.nextReview.endsAtMillis } })),
  ]);
  assert.deepEqual(await h.cloud.readAdmin(), h.next);
  const afterFiles = await Promise.all([h.prior.packet.manifestPath, h.prior.packet.reviewPath].map((path) => readFile(path)));
  assert.deepEqual(afterFiles, beforeFiles);
  await assert.rejects(h.cloud.replaceStoppedWindow(h.next, h.initial), /resume-replace-mode/);
  await assert.rejects(h.cloud.createStoppedAdmin(h.next), /admin-create-mode/);
});

test('resume requires replacement before any deployment then updates only the same five function selectors', async (t) => {
  const h = await recoveryHarness(t, { deployResult: { exitCode: 1, stdout: JSON.stringify({ status: 'error', error: CLEANUP_WARNING }) } });
  await h.cloud.preflight('resume');
  for (const action of [() => h.cloud.deployFunctions(), () => h.cloud.deployRules(), () => h.cloud.deployHosting('game')]) await assert.rejects(action(), /resume-replacement-required/);
  assert.deepEqual(await h.cloud.replaceStoppedWindow(h.next, h.initial), { kind: 'success' });
  const beforeProofReads = h.requests.length;
  assert.deepEqual(await h.cloud.deployFunctions(), { kind: 'cleanup-warning' });
  assert(h.requests.length > beforeProofReads); // Prior exact source is independently re-proved.
  const deployment = h.cli.filter(({ args }) => args.includes('deploy'));
  assert.equal(deployment.length, 1); assert.equal(deployment[0].cwd, h.nextPacket.gameDir);
  assert.equal(deployment[0].args[deployment[0].args.indexOf('--only') + 1], FUNCTION_NAMES.map((name) => `functions:floating-garden-trial:${name}`).join(','));
  assert.equal(deployment[0].args[deployment[0].args.indexOf('--config') + 1], 'firebase.trial.json');
  assert(!deployment[0].args.some((arg) => /force|delete|setpolicy/.test(arg)));
  await assert.rejects(h.cloud.deployFunctions(), /functions-deploy-mode/);
});

test('resume rejects missing, active, extra or used prior admin state before any writes', async (t) => {
  const mutations = [
    (docs, paths) => docs.delete(paths[0]), (docs, paths) => docs.delete(paths[2]),
    (docs, paths) => { docs.get(paths[0]).enabled = true; },
    (docs, paths) => { docs.get(paths[2]).active = true; },
    (docs, paths) => { docs.get(paths[1]).createdRoomCount = 1; },
    (docs, paths) => { docs.get(paths[0]).unexpected = true; },
  ];
  for (const mutateDocs of mutations) {
    const h = await recoveryHarness(t, { mutateDocs });
    await assert.rejects(h.cloud.preflight('resume'), /resume-prior-admin/);
    assert.equal(h.transactions(), 0); assert(!h.cli.some(({ args }) => args.includes('deploy')));
  }
});

test('resume rejects changed tester identities, started windows, source drift and non-closed Rules', async (t) => {
  const different = await recoveryHarness(t, { newReview: { testerUids: ['synthetic_alpha', 'synthetic_changed'] } });
  await assert.rejects(different.cloud.preflight('resume'), /resume-prior-scope/);
  const started = await recoveryHarness(t); started.moveClock(started.nextReview.startsAtMillis);
  await assert.rejects(started.cloud.preflight('resume'), /resume-window/);
  const source = await recoveryHarness(t);
  const changedPath = join(source.nextPacket.gameDir, 'functions/index.js'); await writeFile(changedPath, (await readFile(changedPath)) + '\n// unrelated change\n');
  const changedManifest = JSON.parse(await readFile(source.nextPacket.manifestPath));
  changedManifest.files['game/functions/index.js'] = createHash('sha256').update(await readFile(changedPath)).digest('hex');
  await writeFile(source.nextPacket.manifestPath, JSON.stringify(changedManifest, null, 2) + '\n');
  const changedPacket = { ...source.nextPacket, manifestDigest: createHash('sha256').update(await readFile(source.nextPacket.manifestPath)).digest('hex') };
  const changedAdapter = createCloudAdapter({ packet: changedPacket, review: source.nextReview, prior: source.prior,
    toolingDir: source.toolingDir, runner: source.runner, requestClient: source.requestClient, env: {}, execArgv: [], now: () => NOW + 60000 });
  await assert.rejects(changedAdapter.preflight('resume'), /resume-source-change/);
  const rules = await recoveryHarness(t); rules.changeRules();
  await assert.rejects(rules.cloud.preflight('resume'), /rules-initial-deny-all/);
});

test('recovery CAS compares all four documents including usage and never resets a concurrent admission', async (t) => {
  const h = await recoveryHarness(t, { beforeTransaction: (docs, paths) => { docs.get(paths[1]).createdRoomCount = 1; } });
  await h.cloud.preflight('resume');
  const result = await h.cloud.replaceStoppedWindow(h.next, h.initial);
  assert.equal(result.kind, 'failed'); assert.equal(result.diagnostic.reason, 'resume-admin-concurrent-change');
  assert.equal(h.transactions(), 1); assert.equal(h.writes.length, 0); assert.equal(h.docs.get(h.paths[1]).createdRoomCount, 1);
  await assert.rejects(h.cloud.replaceStoppedWindow(h.next, h.initial), /resume-replace-mode/);
});

test('uncertain recovery replacement is never retried or treated as success even if it committed', async (t) => {
  const h = await recoveryHarness(t, { commitUnknown: true, applyBeforeUnknown: true });
  await h.cloud.preflight('resume');
  assert.equal((await h.cloud.replaceStoppedWindow(h.next, h.initial)).kind, 'unknown');
  assert.equal(h.transactions(), 1); assert.deepEqual(await h.cloud.readAdmin(), h.next);
  await assert.rejects(h.cloud.replaceStoppedWindow(h.next, h.initial), /resume-replace-mode/);
  await assert.rejects(h.cloud.deployFunctions(), /resume-replacement-required/);
  await assert.rejects(h.fresh().preflight('resume'), /resume-prior-admin/);
});

test('resume rechecks the future start at replacement and exact old backend before function update', async (t) => {
  const late = await recoveryHarness(t); await late.cloud.preflight('resume'); late.moveClock(late.nextReview.startsAtMillis);
  await assert.rejects(late.cloud.replaceStoppedWindow(late.next, late.initial), /resume-window/); assert.equal(late.transactions(), 0);
  const drift = await recoveryHarness(t); await drift.cloud.preflight('resume'); await drift.cloud.replaceStoppedWindow(drift.next, drift.initial); drift.drift();
  await assert.rejects(drift.cloud.deployFunctions(), /function-inventory/);
  assert(!drift.cli.some(({ args }) => args.includes('deploy')));
});

test('resume captures raw CLI streams only in fresh private bounded files and returns sanitized diagnostics', async (t) => {
  const marker = 'SYNTHETIC_PRIVATE_CAPTURE_uid_token_owner@example.invalid';
  const stdout = JSON.stringify({ status: 'error', error: `Missing permissions required for functions deploy. ${marker}` }), stderr = `synthetic provider detail ${marker}`;
  const h = await recoveryHarness(t, { deployResult: { exitCode: 2, stdout, stderr } });
  await h.cloud.preflight('resume'); await h.cloud.replaceStoppedWindow(h.next, h.initial);
  const original = await readFile(h.prior.packet.manifestPath);
  const result = await h.cloud.deployFunctions();
  assert.deepEqual(result, { kind: 'failed', diagnostic: { reason: 'permission', exitCode: 2, timedOut: false } });
  assert(!JSON.stringify(result).includes(marker));
  const logs = join(h.nextPacket.output, 'recovery-logs'); assert.equal((await lstat(logs)).mode & 0o777, 0o700);
  for (const [name, bytes] of [['stdout', stdout], ['stderr', stderr]]) {
    const path = join(logs, `functions.${name}.log`), info = await lstat(path);
    assert(info.isFile()); assert(!info.isSymbolicLink()); assert.equal(info.nlink, 1); assert.equal(info.mode & 0o777, 0o600);
    assert.equal(await readFile(path, 'utf8'), bytes); assert(info.size < 16 * 1024 * 1024);
  }
  assert.deepEqual(await readFile(h.prior.packet.manifestPath), original);
  await assert.rejects(h.cloud.deployFunctions(), /functions-deploy-mode/);
  assert.equal(h.cli.filter(({ args }) => args.includes('deploy')).length, 1);
});

test('resume log capture rejects existing names, links and nonprivate directories before issuing a command', async (t) => {
  for (const kind of ['existing', 'file-link', 'directory-link', 'public-directory']) {
    const h = await recoveryHarness(t); await h.cloud.preflight('resume'); await h.cloud.replaceStoppedWindow(h.next, h.initial);
    const logs = join(h.nextPacket.output, 'recovery-logs'), unrelated = join(h.root, 'unrelated');
    await mkdir(unrelated, { mode: 0o700 }); await writeFile(join(unrelated, 'kept'), 'do not overwrite');
    if (kind === 'directory-link') await symlink(unrelated, logs);
    else {
      await mkdir(logs, { mode: 0o700 });
      if (kind === 'existing') await writeFile(join(logs, 'functions.stdout.log'), 'original log', { mode: 0o600 });
      if (kind === 'file-link') await symlink(join(unrelated, 'kept'), join(logs, 'functions.stdout.log'));
      if (kind === 'public-directory') await chmod(logs, 0o755);
    }
    await assert.rejects(h.cloud.deployFunctions(), /resume-log-prepare/);
    assert(!h.cli.some(({ args }) => args.includes('deploy'))); assert.equal(await readFile(join(unrelated, 'kept'), 'utf8'), 'do not overwrite');
    if (kind === 'existing') assert.equal(await readFile(join(logs, 'functions.stdout.log'), 'utf8'), 'original log');
    await assert.rejects(h.cloud.deployFunctions(), /functions-deploy-mode/);
  }
});

test('capture failure after an issued CLI command returns unknown and blocks replay', async (t) => {
  const h = await recoveryHarness(t, { deployResult: { exitCode: 0, stdout: 'x'.repeat(16 * 1024 * 1024 + 1), stderr: '' } });
  await h.cloud.preflight('resume'); await h.cloud.replaceStoppedWindow(h.next, h.initial);
  assert.deepEqual(await h.cloud.deployFunctions(), { kind: 'unknown', diagnostic: { reason: 'resume-log-write', exitCode: 0, timedOut: false } });
  assert.equal(h.cli.filter(({ args }) => args.includes('deploy')).length, 1);
  const logs = join(h.nextPacket.output, 'recovery-logs');
  for (const stream of ['stdout', 'stderr']) assert.equal((await lstat(join(logs, `functions.${stream}.log`))).size, 0);
  await assert.rejects(h.cloud.deployFunctions(), /functions-deploy-mode/);
});

async function stopHarness(t, { unknown = false, concurrent = false } = {}) {
  const fixture = await packet(t), docs = new Map([
    ['floatingGardenTrial/usage', { opaque: 'malformed-but-untouched' }],
    ['floatingGardenTrialTesters/synthetic_alpha', { active: true, expiresAtMillis: fixture.review.endsAtMillis }],
  ]);
  let attempts = 0; const writes = [];
  const snap = (ref) => ({ exists: docs.has(ref.path), data: () => structuredClone(docs.get(ref.path)) });
  const db = { doc: (path) => ({ path }), getAll: async (...r) => r.map(snap),
    runTransaction: async (callback, options) => {
      attempts++; assert.deepEqual(options, { maxAttempts: 1 }); const queued = [];
      if (concurrent) docs.set('floatingGardenTrialTesters/synthetic_alpha', { active: true, expiresAtMillis: fixture.review.endsAtMillis, concurrent: true });
      await callback({ get: async (ref) => snap(ref), update: (ref, value) => { writes.push({ path: ref.path, value }); queued.push([ref.path, value]); }, create: () => assert.fail('Stop must never create') });
      if (unknown) throw Error('PRIVATE provider error must not escape');
      for (const [path, value] of queued) docs.set(path, { ...docs.get(path), ...value });
    } };
  const cloud = createCloudAdapter({ ...fixture, runner: identityRunner, db, now: () => NOW, env: {}, execArgv: [],
    requestClient: { request: () => assert.fail('Gate-first stop should not request backend/Hosting metadata') }, fetchImpl: () => assert.fail('Gate-first stop should not read Hosting') });
  await cloud.preflight('stop');
  const before = await cloud.readAdmin(), next = structuredClone(before); next.testers[0].active = false;
  return { cloud, before, next, docs, writes, attempts: () => attempts };
}

test('stop preserves absent gate/tester and opaque usage while disabling the existing tester', async (t) => {
  const h = await stopHarness(t);
  assert.deepEqual(await h.cloud.updateAdmin(h.next, h.before), { kind: 'success' });
  assert.equal(h.attempts(), 1);
  assert.deepEqual(h.writes, [{ path: 'floatingGardenTrialTesters/synthetic_alpha', value: { active: false } }]);
  assert(!h.docs.has('floatingGardenTrial/config')); assert(!h.docs.has('floatingGardenTrialTesters/synthetic_beta'));
  assert.deepEqual(h.docs.get('floatingGardenTrial/usage'), { opaque: 'malformed-but-untouched' });
});

test('unknown stop commit is attempted once, returns no raw error and never retries', async (t) => {
  const h = await stopHarness(t, { unknown: true });
  assert.deepEqual(await h.cloud.updateAdmin(h.next, h.before), { kind: 'unknown' });
  assert.equal(h.attempts(), 1); assert.equal(h.writes.length, 1);
  assert.deepEqual(h.docs.get('floatingGardenTrial/usage'), { opaque: 'malformed-but-untouched' });
});

test('concurrent tester change aborts before any write', async (t) => {
  const h = await stopHarness(t, { concurrent: true });
  assert.deepEqual(await h.cloud.updateAdmin(h.next, h.before), { kind: 'failed' });
  assert.equal(h.attempts(), 1); assert.equal(h.writes.length, 0);
});

// The dedicated trial CI installs this pinned runtime. The general root-only
// unit job deliberately does not install additional Functions dependencies.
test('pinned Firestore GAPIC disables Commit RPC retries without initializing credentials', { skip: !existsSync(join(ROOT, 'functions/floating-garden-trial/node_modules/@google-cloud/firestore/package.json')) }, async () => {
  // Existing prepared runtime dependency only. Never npm install or initialize().
  const req = createRequire(join(ROOT, 'functions/floating-garden-trial/package.json'));
  assert.equal(req('@google-cloud/firestore/package.json').version, '7.11.6');
  const { FirestoreClient } = req('@google-cloud/firestore').v1;
  const client = new FirestoreClient({ projectId: 'synthetic-project', clientConfig: FIRESTORE_CLIENT_CONFIG });
  try {
    assert.deepEqual(client._defaults.commit.retry.retryCodes, []);
    assert.notDeepEqual(client._defaults.getDocument.retry.retryCodes, []);
  } finally { await client.close(); }
});

// Sanitized failure retention; every provider and subprocess is injected.
const SECRET_SENTINEL = 'SYNTHETIC_PRIVATE_UID_token_owner@example.invalid';
const emptyDiagnostic = { reason: 'unclassified', exitCode: null, timedOut: false };
function assertNoPrivate(value) {
  const text = JSON.stringify(value);
  assert(!text.includes(SECRET_SENTINEL));
  for (const field of ['stdout', 'stderr', 'message', 'token', 'uid', 'email']) assert(!Object.hasOwn(value, field));
}
function classifyMessage(message, extra = {}) {
  return classifyDeployResult({ exitCode: 2, stdout: JSON.stringify({ status: 'error', error: message }), ...extra });
}
async function diagnosticFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'garden-diagnostic-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const now = 1791095800000, review = { schemaVersion: 1, startsAtMillis: now, endsAtMillis: now + 604800000,
    testerUids: ['synthetic_alpha', 'synthetic_beta'], retainBuildArtifacts: true, allowInitialFunctionRecreate: true, approvePublicInvoker: true };
  const packet = await prepareTrialOperation({ review, output: join(root, 'packet'), now });
  const runner = (_command, args) => ({ exitCode: 0, stdout: JSON.stringify(args[0] === 'config' ? {} :
    { projectId: 'wa-awesome-garden-stg', projectNumber: '120030709276', lifecycleState: 'ACTIVE' }) });
  return { packet, review, runner, env: {}, execArgv: [], now: () => now };
}

test('diagnostic signatures map only to bounded categories without echoing provider text', () => {
  const messages = [
    ['invalid-filter', 'No function matches given --only filters. Aborting deployment.'],
    ['invalid-filter', 'Cannot understand what targets to deploy/serve.'],
    ['missing-sdk-binary', 'Failed to find location of Firebase Functions SDK.'],
    ['missing-dependencies', "Cannot find module 'synthetic-missing-package'"],
    ['source-analysis', 'Functions codebase could not be analyzed successfully.'],
    ['source-analysis', 'User code failed to load. Cannot determine backend specification.'],
    ['authentication', 'Failed to authenticate, have you run firebase login?'],
    ['permission', 'Missing permissions required for functions deploy.'],
    ['billing', 'Your project synthetic must be on the Blaze (pay-as-you-go) plan to complete this command.'],
    ['quota', 'RESOURCE_EXHAUSTED'], ['build', 'Build failed with status: FAILURE'], ['network', 'ENOTFOUND'],
  ];
  for (const [reason, message] of messages) {
    const result = classifyMessage(`${message} ${SECRET_SENTINEL}`);
    assert.deepEqual(result, { kind: 'failed', diagnostic: { reason, exitCode: 2, timedOut: false } });
    assert(Object.isFrozen(result)); assert(Object.isFrozen(result.diagnostic)); assertNoPrivate(result.diagnostic);
  }
  // Prefer the terminal JSON error over less specific captured stream text.
  assert.equal(classifyMessage('Missing permissions required for functions deploy.', { stderr: 'ENOTFOUND' }).diagnostic.reason, 'permission');
});

test('diagnostic parsing observations distinguish unavailable JSON and unknown result shapes', () => {
  assert.deepEqual(classifyDeployResult({ exitCode: 1, stdout: SECRET_SENTINEL }), {
    kind: 'failed', diagnostic: { reason: 'cli-json-unavailable', exitCode: 1, timedOut: false } });
  assert.deepEqual(classifyDeployResult({ exitCode: 0, stdout: '{}' }), {
    kind: 'unknown', diagnostic: { reason: 'cli-result-unrecognized', exitCode: 0, timedOut: false } });
  assert.deepEqual(classifyMessage(SECRET_SENTINEL), { kind: 'failed', diagnostic: { reason: 'unclassified', exitCode: 2, timedOut: false } });
  assert.deepEqual(classifyDeployResult({ exitCode: 0, stdout: '{"status":"success"}' }), { kind: 'success' });
  assert.deepEqual(classifyMessage(CLEANUP_WARNING, { exitCode: 1 }), { kind: 'failed', diagnostic: { reason: 'unclassified', exitCode: 1, timedOut: false } });
  assert.deepEqual(classifyDeployResult({ exitCode: 1, stdout: JSON.stringify({ status: 'error', error: CLEANUP_WARNING }) }, { allowCleanupWarning: true }), { kind: 'cleanup-warning' });
});

test('diagnostic timeouts, signals and invalid exit statuses remain unknown outcomes', () => {
  for (const exitCode of [null, -1, 256, '2', NaN]) {
    const result = classifyDeployResult({ exitCode, stdout: '' });
    assert.equal(result.kind, 'unknown'); assert.equal(result.diagnostic.exitCode, null);
  }
  assert.deepEqual(classifyDeployResult({ exitCode: null, signal: SECRET_SENTINEL, timedOut: true, stdout: '' }), {
    kind: 'unknown', diagnostic: { reason: 'timeout', exitCode: null, timedOut: true } });
  assert.deepEqual(classifyDeployResult({ exitCode: null, signal: SECRET_SENTINEL, stdout: '' }), {
    kind: 'unknown', diagnostic: { reason: 'process-interrupted', exitCode: null, timedOut: false } });
});

test('diagnostic normalizer ignores hostile accessors/proxies, arbitrary fields and coercion', () => {
  let reads = 0;
  const getter = Object.defineProperty({}, 'reason', { get() { reads++; throw Error(SECRET_SENTINEL); } });
  const proxy = new Proxy({}, { get() { reads++; throw Error(SECRET_SENTINEL); }, getOwnPropertyDescriptor() { reads++; throw Error(SECRET_SENTINEL); } });
  const inherited = Object.create({ reason: 'permission', exitCode: 2, timedOut: true, httpStatus: 403 });
  for (const input of [getter, proxy, inherited, null, 'permission']) assert.deepEqual(normalizeFailureDiagnostic(input), emptyDiagnostic);
  assert.equal(reads, 0);
  assert.deepEqual(normalizeFailureDiagnostic({ reason: SECRET_SENTINEL, exitCode: '2', timedOut: 'true', httpStatus: '403', stdout: SECRET_SENTINEL }), emptyDiagnostic);
  assert.deepEqual(normalizeFailureDiagnostic({ reason: 'permission', exitCode: 255, timedOut: true, httpStatus: 599, message: SECRET_SENTINEL }),
    { reason: 'permission', exitCode: 255, timedOut: true, httpStatus: 599 });
  assert(Object.isFrozen(normalizeFailureDiagnostic({ reason: 'permission' })));
});

test('only genuinely branded AdapterStop diagnostics survive, even after property tampering', () => {
  let branded;
  try { validateFunctionMetadata(null, 'floatingGardenCreateRoom'); } catch (error) { branded = error; }
  assert(branded); assert.equal(describeAdapterFailure(branded).reason, 'function-identity');
  branded.code = SECRET_SENTINEL; branded.message = SECRET_SENTINEL;
  assert.equal(describeAdapterFailure(branded).reason, 'function-identity');
  for (const error of [Object.assign(Error(SECRET_SENTINEL), { code: 'permission' }), Object.create(Object.getPrototypeOf(branded)), null, SECRET_SENTINEL]) {
    assert.deepEqual(describeAdapterFailure(error), emptyDiagnostic); assertNoPrivate(describeAdapterFailure(error));
  }
});

test('runner captures stderr transiently for classification and never retries a failed exec', () => {
  let calls = 0;
  const runner = makeCloudRunner({ env: {}, exec: (_command, _args, options) => {
    calls++; assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    throw Object.assign(Error(SECRET_SENTINEL), { status: 1, stdout: Buffer.from(''),
      stderr: Buffer.from(`Error: Failed to find location of Firebase Functions SDK. ${SECRET_SENTINEL}`) });
  } });
  const captured = runner('synthetic-command', [], '/synthetic');
  assert.equal(calls, 1); assert(captured.stderr.includes(SECRET_SENTINEL)); // Internal memory only.
  const result = classifyDeployResult(captured);
  assert.deepEqual(result, { kind: 'failed', diagnostic: { reason: 'missing-sdk-binary', exitCode: 1, timedOut: false } });
  assertNoPrivate(result); assertNoPrivate(result.diagnostic);
});

test('CLI error text/default status/gRPC numeric codes never become an HTTP status', () => {
  for (const raw of [
    { exitCode: 1, stdout: JSON.stringify({ status: 'error', error: 'HTTP Error: 403, Forbidden' }) },
    { exitCode: 1, stdout: JSON.stringify({ status: 'error', error: { message: SECRET_SENTINEL, status: 500, code: 7 } }) },
    { exitCode: 1, stdout: JSON.stringify({ status: 'error', error: SECRET_SENTINEL }), status: 500, code: 7 },
  ]) assert(!Object.hasOwn(classifyDeployResult(raw).diagnostic, 'httpStatus'));
});

test('HTTP adapter exports only a real numeric response status and suppresses exception payloads', async (t) => {
  const fixture = await diagnosticFixture(t);
  for (const [failure, status] of [
    [Object.assign(Error(SECRET_SENTINEL), { response: { status: 403 }, status: 500, code: 7 }), 403],
    [Object.assign(Error(SECRET_SENTINEL), { response: { statusCode: 429 } }), 429],
    [Object.assign(Error('HTTP Error: 403 ' + SECRET_SENTINEL), { status: 500, code: 7 }), undefined],
    [Object.assign(Error(SECRET_SENTINEL), { response: { status: '403' } }), undefined],
  ]) {
    let requests = 0;
    const cloud = createCloudAdapter({ ...fixture, requestClient: { request: async () => { requests++; throw failure; } } });
    await cloud.preflight('stop');
    let caught; try { await cloud.verifyFunctions(); } catch (error) { caught = error; }
    assert(caught); assert.equal(requests, 1);
    const diagnostic = describeAdapterFailure(caught);
    assert.deepEqual(diagnostic, { reason: 'metadata-http', exitCode: null, timedOut: false, ...(status === undefined ? {} : { httpStatus: status }) });
    assert(!caught.message.includes(SECRET_SENTINEL)); assertNoPrivate(diagnostic);
  }
});

test('failed read-only command propagates only categorized metadata and actual exit code', async (t) => {
  const fixture = await diagnosticFixture(t);
  const cloud = createCloudAdapter({ ...fixture, runner: () => ({ exitCode: 2, stdout: '', stderr: `PERMISSION_DENIED ${SECRET_SENTINEL}` }) });
  let caught; try { await cloud.preflight('stop'); } catch (error) { caught = error; }
  assert.deepEqual(describeAdapterFailure(caught), { reason: 'permission', exitCode: 2, timedOut: false });
  assert(!caught.message.includes(SECRET_SENTINEL));
});

}

import { sameDenyAllRules } from '../scripts/floating-garden-trial-cloud-adapter.mjs';
const consoleClosedRules = "rules_version = '2';\n\n\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /{document=**} {\n      allow read, write: if false;\n    }\n  }\n}\n";
test('initial closed Rules accept observed Console whitespace only, at initial/recovery and deployment guards',async()=>{
 const expected=await readFile(join(ROOT,'config/floating-garden-trial/deny-all.rules'),'utf8');
 assert.equal(sameDenyAllRules(consoleClosedRules,expected),true);
 assert.equal(sameDenyAllRules(expected,expected),true);
 assert.equal(sameDenyAllRules(consoleClosedRules.replaceAll('\n','\r\n').replaceAll('  ','\t'),expected),true);
 const source=await readFile(join(ROOT,'scripts/floating-garden-trial-cloud-adapter.mjs'),'utf8');
 assert.equal((source.match(/requireThat\(sameDenyAllRules\(/g)??[]).length,4);
});
test('initial Rules token comparison rejects permission, path, string and lexical changes',async()=>{
 const expected=await readFile(join(ROOT,'config/floating-garden-trial/deny-all.rules'),'utf8');
 for(const altered of [consoleClosedRules.replace('if false','if true'),consoleClosedRules.replace('if false','if request.auth != null'),consoleClosedRules.replace('false','fa lse'),consoleClosedRules.replace("'2'","' 2'"),consoleClosedRules.replace('{document=**}','{document=*}'),consoleClosedRules.replace('allow read, write: if false;','allow read, write: if false; allow read: if true;'),consoleClosedRules+'\nservice cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read: if true; } } }'])assert.equal(sameDenyAllRules(altered,expected),false);
});
test('initial Rules token comparison remains narrow on comments, unexpected types and oversized input',async()=>{
 const expected=await readFile(join(ROOT,'config/floating-garden-trial/deny-all.rules'),'utf8');
 for(const altered of ['// comment\n'+consoleClosedRules,consoleClosedRules.replace('if false','if /*comment*/ false'),consoleClosedRules+' '.repeat(16385),null,{},123])assert.equal(sameDenyAllRules(altered,expected),false);
});

// Exercise the exact generic wrapper payload, without executing Python or Node owner modes.
{
const diagnosticSource = execFileSync('python3', ['-I', '-c',
  "import ast,json,pathlib,sys; t=ast.parse(pathlib.Path(sys.argv[1]).read_text()); v=[n for n in t.body if isinstance(n,ast.Assign) and any(isinstance(k,ast.Name) and k.id=='DIAGNOSE' for k in n.targets)]; assert len(v)==1; print(json.dumps(ast.literal_eval(v[0].value)))",
  join(ROOT,'scripts/start-floating-garden-trial-owner.py')], {encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000,maxBuffer:65536});
const { classifyLog, summarizeFunctions, summarizeJournal, validateTokyoInventory, inspect, patchLegacyTrafficAdapter, prepareReadOnlyAdapter } =
  await import('data:text/javascript;base64,'+Buffer.from(JSON.parse(diagnosticSource)).toString('base64'));
test('historical read-only compatibility helper and predicate retain their exact pins and behavior',async()=>{
 const diag=JSON.parse(diagnosticSource),owner=await readFile(join(ROOT,'scripts/start-floating-garden-trial-owner.py'));
 assert.equal(createHash('sha256').update(owner).digest('hex'),'ed06f8a738b549670382b9ac3e87388b8892de0364978cf6c86a3c8e9c99fb50');
 const readConst=name=>JSON.parse(diag.split('\n').find(x=>x.startsWith(`const ${name} = `)).slice(`const ${name} = `.length,-1));
 const embedded=readConst('CORRECT_TRAFFIC_CHECK');
 assert.equal(createHash('sha256').update(embedded).digest('hex'),'91e889cb89a6e008ca6b1acd30372c55b7836e8ca959e4ea17f146cb352adb67');
 assert(diag.includes('b769a758fc34679d0428bb4712b13e8cb4413faf3d7e79499b2ab21379fefc6e'));
 assert(diag.includes('bc8549cea2bbedc8fdd2400b127c7c02bad19fb2412e1711ec86cff4f3e3f724'));
 const historicalCheck=new Function('service','requireThat','plain',embedded+'return true;');
 const requireHistorical=(ok,code)=>{if(!ok)throw new Error(code);};
 const isPlain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
 for(let i=0;i<FUNCTION_NAMES.length;i++){
  const revision=`projects/wa-awesome-garden-stg/locations/asia-northeast1/services/garden-fn-${i}/revisions/garden-fn-${i}-00001-abc`;
  const run={latestReadyRevision:revision,trafficStatuses:[{revision,percent:100}]};
  assert.equal(historicalCheck(run,requireHistorical,isPlain),true);
  assert.equal(historicalCheck({...run,trafficStatuses:[{type:'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST',percent:100}]},requireHistorical,isPlain),true);
  assert.throws(()=>historicalCheck({...run,trafficStatuses:[{type:'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST',percent:100,revision:revision.split('/').at(-1)}]},requireHistorical,isPlain),/run-latest-traffic/);
 }
 assert.equal(diag.split("const corrected=source.replace(LEGACY_TRAFFIC_CHECK,CORRECT_TRAFFIC_CHECK);").length,2);
});
test('read-only compatibility patch rejects unpinned source rather than broad replacement',()=>{
 for(const value of ['',null,{},'  const traffic = service.trafficStatuses;','DO_NOT_PRINT_TOKEN'])assert.throws(()=>patchLegacyTrafficAdapter(value));
});
test('unverified compatibility source creates no temporary directory or subprocess',async t=>{
 const base=await temp(t);await mkdir(join(base,'source/scripts'),{recursive:true});
 await writeFile(join(base,'source/scripts/floating-garden-trial-cloud-adapter.mjs'),'untrusted source');
 const before=await files(base);let invoked=false;
 await assert.rejects(prepareReadOnlyAdapter(base,{extract:()=>{invoked=true;},load:()=>{invoked=true;}}));
 assert.equal(invoked,false);assert.deepEqual(await files(base),before);
});
const names=['floatingGardenCreateRoom','floatingGardenJoinRoom','floatingGardenStartMatch','floatingGardenGetSnapshot','floatingGardenSubmitAction'];
const inventory=names.map(n=>({name:'projects/wa-awesome-garden-stg/locations/asia-northeast1/functions/'+n,state:'ACTIVE',environment:'GEN_2',secret:'DO_NOT_PRINT_TOKEN',serviceConfig:{uri:'https://SECRET'}}));
const packet={manifestDigest:'a',reviewDigest:'b',gameDir:'/mock/operation/game'};
const journal={schemaVersion:1,manifestDigest:'a',reviewDigest:'b',deploy:{status:'failed',stage:'deploy-functions',secret:'DO_NOT_PRINT_TOKEN'},stop:{status:'new'},events:[{stage:'create-stopped-admin',status:'issued'},{stage:'create-stopped-admin',status:'verified'},{stage:'deploy-functions',status:'issued'}]};
test('logs disclose only fixed codes and HTTP status',()=>{
 const output=classifyLog('[debug] TOKEN=DO_NOT_PRINT_TOKEN email=private@example.com\n[debug] <<< [apiv2][status] POST https://SECRET?q=TOKEN 403\nPERMISSION_DENIED\nFunctions deploy failed.\nError: private@example.com cannot use SECRET').join(',');
 assert.equal(output,'PERMISSION_DENIED,FUNCTIONS_DEPLOY_FAILED,HTTP_403');
 assert.deepEqual(classifyLog('DO_NOT_PRINT_TOKEN'),['NO_WHITELISTED_SIGNATURE']);
});
test('inventory emits only exact known names and state enums',()=>{
 const lines=summarizeFunctions(inventory);assert.equal(lines.length,5);assert(lines.every(x=>x.endsWith(':STATE=ACTIVE:ENVIRONMENT=GEN_2')));assert(!lines.join().includes('DO_NOT_PRINT_TOKEN'));
 assert(summarizeFunctions([{...inventory[0],state:'SECRET'}])[0].endsWith(':STATE=UNKNOWN:ENVIRONMENT=GEN_2'));
 assert.throws(()=>summarizeFunctions({error:'SECRET'}));
});
test('journal validates identity, sanitizes each value',()=>{
 assert.equal(summarizeJournal(journal,packet),'DEPLOY=failed:deploy-functions,STOP=new,create-stopped-admin:issued,create-stopped-admin:verified,deploy-functions:issued');
 assert.throws(()=>summarizeJournal({...journal,manifestDigest:'wrong'},packet));
 assert(summarizeJournal({...journal,events:[{stage:'SECRET',status:'TOKEN'}]},packet).endsWith('UNKNOWN:UNKNOWN'));
});
async function mock({functions=inventory,inventoryResponse,verifyError,preflightError,rawError}={}){
 const calls=[],out=[];
 await inspect({base:'/mock',requestClient:{request:async options=>{calls.push('request:tokyo');assert.equal(options.url,'https://cloudfunctions.googleapis.com/v2/projects/wa-awesome-garden-stg/locations/asia-northeast1/functions?pageSize=1000');assert.equal(options.method,'GET');assert.equal(options.retry,false);assert.equal(options.maxRedirects,0);assert.equal(options.timeout,30000);assert.equal(options.maxContentLength,16*1024*1024);assert.equal(options.maxBodyLength,16*1024*1024);if(rawError)throw Error('DO_NOT_PRINT_TOKEN');return inventoryResponse??{status:200,data:{functions}};}},emit:x=>out.push(x),verify:async()=>calls.push('source'),read:async p=>{calls.push('read:'+p);if(p.endsWith('OPERATION-STATE.json'))return JSON.stringify(journal);if(p.endsWith('/firebase-debug.log'))return 'PERMISSION_DENIED DO_NOT_PRINT_TOKEN';throw Object.assign(Error(),{code:'ENOENT'});},load:async p=>p.includes('/operate-')?{readOperationPacket:async()=>({packet,review:{}}),adminState:()=> 'stopped'}:{makeCloudRunner:()=>()=>{throw Error('UNEXPECTED_SUBPROCESS');},createCloudAdapter:()=>({preflight:async mode=>{calls.push('preflight:'+mode);assert.equal(mode,'stop');if(preflightError)throw preflightError;},readAdmin:async()=>{calls.push('readAdmin');return {};},verifyFunctions:async()=>{calls.push('verifyFunctions');if(verifyError)throw verifyError;return {verified:true};}})}});
 return {calls,out};
}
test('all local logs precede preflight; only metadata list and verify follow',async()=>{const {calls,out}=await mock();assert(calls.indexOf('read:/mock/operation/game/firebase-debug.9.log')<calls.indexOf('preflight:stop'));assert(!calls.some(x=>x.startsWith('run:')));assert(calls.indexOf('readAdmin')<calls.indexOf('request:tokyo'));assert.equal(calls.filter(x=>x==='request:tokyo').length,1);assert(out.includes('FUNCTIONS_VERIFY: VERIFIED'));assert.equal(out.at(-1),'READ_ONLY_DONE');assert(!out.join().includes('DO_NOT_PRINT_TOKEN'));});
test('safe verification code survives; unrelated errors are hidden',async()=>{assert.equal((await mock({verifyError:{code:'source-archive-size',message:'TOKEN'}})).out.at(-1),'READ_ONLY_STOP: FUNCTIONS_VERIFY:source-archive-size');assert.equal((await mock({verifyError:{code:'DO_NOT_PRINT_TOKEN',message:'TOKEN'}})).out.at(-1),'READ_ONLY_STOP: FUNCTIONS_VERIFY:UNCLASSIFIED');assert.equal((await mock({rawError:true})).out.at(-1),'READ_ONLY_STOP: TOKYO_FUNCTIONS_LIST:UNCLASSIFIED');});
test('incomplete inventory does not call full verification',async()=>{const {calls,out}=await mock({functions:inventory.slice(0,2)});assert(!calls.includes('verifyFunctions'));assert(out.includes('FUNCTIONS_VERIFY: SKIPPED_INCOMPLETE_INVENTORY'));});
test('failed preflight prevents functions list',async()=>{const {calls,out}=await mock({preflightError:{code:'project-identity',message:'TOKEN'}});assert(!calls.includes('request:tokyo'));assert.equal(out.at(-1),'READ_ONLY_STOP: METADATA_PREFLIGHT:project-identity');});

test('exact successful empty Tokyo inventory supports scoped not-found only',async()=>{
 assert.deepEqual(validateTokyoInventory({status:200,data:{functions:[]}}),[]);assert.deepEqual(validateTokyoInventory({status:200,data:{}}),[]);assert.deepEqual(validateTokyoInventory({status:200,data:{nextPageToken:'',unreachable:[]}}),[]);
 const emptyObject=await mock({inventoryResponse:{status:200,data:{}}});assert(emptyObject.out.some(x=>x.includes('STATE=NOT_FOUND_IN_TOKYO_LIST')));
 const {out}=await mock({functions:[]});const lines=out.filter(x=>x.startsWith('FUNCTION:'));
 assert.equal(lines.length,5);assert(lines.every(x=>x.includes(':STATE=NOT_FOUND_IN_TOKYO_LIST:ENVIRONMENT=UNKNOWN')));assert(!out.join().includes('ABSENT'));
});
test('wrong HTTP code, absent or invalid fields, pagination and unreachable are never absence',async()=>{
 const cases=[{status:403,data:{functions:[]}},{status:'200',data:{functions:[]}},{status:200,data:[]},{status:200,data:{error:{code:403}}},{status:200,data:{unexpected:true}},{status:200,data:{functions:null}},{status:200,data:{functions:{}}},{status:200,data:{functions:[],nextPageToken:'more'}},{status:200,data:{functions:[],nextPageToken:null}},{status:200,data:{functions:[],unreachable:['asia-northeast1']}},{status:200,data:{functions:[],unreachable:'bad'}}];
 for(const inventoryResponse of cases){assert.throws(()=>validateTokyoInventory(inventoryResponse));const {out,calls}=await mock({inventoryResponse});assert(out.at(-1).startsWith('READ_ONLY_STOP: TOKYO_FUNCTIONS_LIST:tokyo-inventory-'));assert(!out.some(x=>x.startsWith('FUNCTION:')));assert(!out.join().includes('NOT_FOUND'));assert(!calls.includes('verifyFunctions'));}
});
test('wrong region, project, short or malformed names and duplicates fail closed',async()=>{
 for(const functions of [[{...inventory[0],name:inventory[0].name.replace('asia-northeast1','us-central1')}],[{...inventory[0],name:inventory[0].name.replace('wa-awesome-garden-stg','other-project')}],[{...inventory[0],name:names[0]}],[{...inventory[0],name:inventory[0].name+'/extra'}],[null],[inventory[0],inventory[0]]]){assert.throws(()=>summarizeFunctions(functions));const {out}=await mock({functions});assert.equal(out.at(-1),'READ_ONLY_STOP: TOKYO_FUNCTIONS_LIST:tokyo-inventory-identity');assert(!out.some(x=>x.startsWith('FUNCTION:')));}
});
test('unknown state and environment are separate fields, never copied',()=>{
 const rows=summarizeFunctions([{...inventory[0],state:'PRIVATE_TOKEN',environment:'PRIVATE_ENV',status:'ACTIVE'}]);assert.equal(rows[0],names[0]+':STATE=UNKNOWN:ENVIRONMENT=UNKNOWN');assert(!rows.join().includes('PRIVATE'));
});
test('a valid unexpected Tokyo function is not printed and prevents full inventory verification',async()=>{
 const {calls,out}=await mock({functions:[...inventory,{name:'projects/wa-awesome-garden-stg/locations/asia-northeast1/functions/privateOtherFunction',state:'ACTIVE',environment:'GEN_2'}]});assert(!out.join().includes('privateOtherFunction'));assert(!calls.includes('verifyFunctions'));
});
test('oversized successful body is incomplete',()=>{assert.throws(()=>validateTokyoInventory({status:200,data:{functions:[{...inventory[0],extra:'x'.repeat(16*1024*1024)}]}}),e=>e.code==='tokyo-inventory-incomplete');});

}

// Final verified recovery orchestrator regression; all capabilities are local/injected.
{
const test = (await import('node:test')).default;
const assert = (await import('node:assert/strict')).default;
const { mkdtemp, rm, readFile, writeFile, mkdir, lstat, symlink, readlink } = await import('node:fs/promises');
const { join } = await import('node:path');
const { tmpdir } = await import('node:os');
const { createHash } = await import('node:crypto');
const { prepareTrialOperation } = await import('../scripts/prepare-floating-garden-trial-operation.mjs');
const { adminRecords, operateTrial, readOperationPacket, readPriorOperation, verifyPriorOperation, readPriorForMode, verifyOperationPacket, createJournal, validateResumeReview, installRuntime, main, MAX_START_WAIT_MILLIS } = await import('../scripts/operate-floating-garden-trial.mjs');
const OLD=1800000000000, START=OLD+1000000, WEEK=604800000;
const priorReview=()=>({schemaVersion:1,startsAtMillis:OLD,endsAtMillis:OLD+WEEK,testerUids:['SYNTHETIC_A','SYNTHETIC_B'],retainBuildArtifacts:true,allowInitialFunctionRecreate:true,approvePublicInvoker:true});
const nextReview=()=>({...priorReview(),startsAtMillis:START,endsAtMillis:START+WEEK});
const clone=v=>structuredClone(v), sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'garden-resume-local-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const old=join(root,'old');await prepareTrialOperation({review:priorReview(),output:old,now:OLD-1000});
 const {packet}=await readOperationPacket(old), journal=await createJournal(packet,{now:()=>OLD-1000});
 journal.begin('deploy');journal.issued('create-stopped-admin');journal.verified('create-stopped-admin');journal.issued('deploy-functions');journal.fail('deploy-functions',{reason:'unclassified',exitCode:1,timedOut:false});await journal.flush();
 const prior=await readPriorOperation(old), out=join(root,'new');await prepareTrialOperation({review:nextReview(),output:out,now:START-10000});
 const next=await readOperationPacket(out);return {root,prior,...next};
}
function harness(){
 let time=START-10000, admin=adminRecords(priorReview()), hosting={kind:'connection',version:'initial'};
 const calls=[], mutations=[];
 const journal={begin:v=>calls.push('begin:'+v),issued:v=>calls.push('issued:'+v),verified:v=>calls.push('verified:'+v),finish:v=>calls.push('finish:'+v),fail:v=>calls.push('fail:'+v),flush:async()=>calls.push('flush')};
 const mutate=(name,fn)=>async(...args)=>{calls.push(name);mutations.push(name);fn?.(...args);return {kind:'success'};};
 const cloud={preflight:async mode=>calls.push('preflight:'+mode),readAdmin:async()=>clone(admin),readHosting:async()=>clone(hosting),verifyHosting:async kind=>({verified:kind===hosting.kind}),verifyFunctions:async()=>({verified:true}),verifyRules:async()=>({verified:true}),
 replaceStoppedWindow:mutate('replaceStoppedWindow',(next,expected)=>{assert.deepEqual(expected,admin);assert.deepEqual(admin,adminRecords(priorReview()));assert.deepEqual(next,adminRecords(nextReview()));admin=clone(next);}),
 createStoppedAdmin:mutate('createStoppedAdmin'),deployFunctions:mutate('deployFunctions'),deployRules:mutate('deployRules'),deployHosting:mutate('deployHosting',kind=>{hosting={kind,version:'next'};}),updateAdmin:mutate('updateAdmin',next=>{assert.equal(time>=START,true);admin=clone(next);})};
 return {cloud,journal,calls,mutations,get time(){return time;},set time(v){time=v;},get admin(){return admin;},set admin(v){admin=v;},set hosting(v){hosting=v;},run:changes=>operateTrial({mode:'resume',review:nextReview(),priorReview:priorReview(),cloud,journal,now:()=>time,wait:async ms=>{time+=ms;},log:()=>{},checkLocal:async()=>calls.push('checkLocal'),...changes})};
}
test('resume replaces only stopped window before existing publication stages and fixed-start activation',async()=>{
 const h=harness(),r=await h.run();assert.equal(r.status,'active');assert.equal(h.time,START);
 assert.deepEqual(h.mutations,['replaceStoppedWindow','deployFunctions','deployRules','deployHosting','updateAdmin']);assert.deepEqual(h.admin,adminRecords(nextReview(),true));
 assert(h.calls.includes('begin:resume'));assert(h.calls.includes('preflight:resume'));
 for(const name of h.mutations){const i=h.calls.indexOf(name);assert.equal(h.calls[i-1],'flush');assert.match(h.calls[i-2],/^issued:/);assert.equal(h.calls[i-3],'checkLocal');}
});
test('resume only accepts explicit later exact week, same ordered pair and both approval reviews',async()=>{
 validateResumeReview(nextReview(),priorReview());
 for(const review of [{...nextReview(),testerUids:['SYNTHETIC_B','SYNTHETIC_A']},{...nextReview(),testerUids:['SYNTHETIC_A','OTHER']},{...nextReview(),startsAtMillis:OLD,endsAtMillis:OLD+WEEK},{...nextReview(),endsAtMillis:START+WEEK+1},{...nextReview(),retainBuildArtifacts:false}])assert.throws(()=>validateResumeReview(review,priorReview()));
 assert.throws(()=>validateResumeReview(nextReview(),{...priorReview(),approvePublicInvoker:false}));
 const h=harness();assert.equal((await h.run({priorReview:undefined})).status,'blocked');assert.deepEqual(h.mutations,[]);
});
test('used, active, partial, wrong-window records and non-connection Hosting block replacement',async()=>{
 for(const change of [a=>a.usage.createdRoomCount=1,a=>a.gate.enabled=true,a=>a.testers[0].active=true,a=>a.usage=null,a=>a.gate.startsAtMillis++,a=>a.testers[0]=null]){const h=harness();change(h.admin);assert.equal((await h.run()).status,'blocked');assert.deepEqual(h.mutations,[]);}
 for(const kind of ['maintenance','stopped','game','unknown']){const h=harness();h.hosting={kind,version:'unexpected'};assert.equal((await h.run()).status,'blocked');assert.deepEqual(h.mutations,[]);}
});
test('preflight failure, replacement unknown and concurrent local change never retry or deploy',async()=>{
 const one=harness();one.cloud.preflight=async()=>{throw Error('PRIVATE');};assert.equal((await one.run()).status,'blocked');assert.deepEqual(one.mutations,[]);
 const two=harness();let attempts=0;two.cloud.replaceStoppedWindow=async()=>{attempts++;return{kind:'unknown'};};assert.equal((await two.run()).status,'blocked');assert.equal(attempts,1);assert.deepEqual(two.mutations,[]);
 const three=harness();const original=three.cloud.replaceStoppedWindow;let changed=false;three.cloud.replaceStoppedWindow=async(...args)=>{const result=await original(...args);changed=true;return result;};assert.equal((await three.run({checkLocal:async()=>{if(changed)throw Error('changed');}})).status,'blocked');assert.deepEqual(three.mutations,['replaceStoppedWindow']);
});
test('resume rejects passed start before preflight and after slow preflight',async()=>{
 for(const kind of ['before','after']){const h=harness();if(kind==='before')h.time=START;else h.cloud.preflight=async()=>{h.time=START;};assert.equal((await h.run()).status,'blocked');assert.deepEqual(h.mutations,[]);}
});
test('resume retains fixed window across missed-start, distant-start and late-wake paths',async()=>{
 const passed=harness();passed.cloud.deployFunctions=async()=>{passed.time=START+1;return{kind:'success'};};assert.equal((await passed.run()).reason,'start-passed');assert.equal(passed.admin.gate.enabled,false);
 const distant=harness();distant.time=START-MAX_START_WAIT_MILLIS-1;assert.equal((await distant.run()).reason,'future-start');assert.equal(distant.admin.gate.enabled,false);
 const late=harness();assert.equal((await late.run({wait:async()=>{late.time=START+60001;}})).reason,'late-wake');assert.equal(late.admin.gate.enabled,false);
 const proof=harness();let count=0;proof.cloud.verifyFunctions=async()=>{if(++count===2)proof.time=START+60001;return{verified:true};};assert.equal((await proof.run()).reason,'late-verification');assert.equal(proof.admin.gate.enabled,false);
 for(const h of [passed,distant,late,proof]){assert(!h.mutations.includes('updateAdmin'));assert.equal(h.admin.gate.endsAtMillis,START+WEEK);}
});
test('exact failed predecessor has immutable digests and remains byte-for-byte unchanged',async t=>{
 const f=await fixture(t),statePath=join(f.prior.packet.output,'OPERATION-STATE.json'),before=await readFile(statePath);
 assert.equal(f.prior.predecessor.journalDigest,sha(before));await verifyPriorOperation(f.prior);
 const j=await createJournal(f.packet,{prior:f.prior,now:()=>START-1});j.begin('resume');j.issued('replace-stopped-window');await j.flush();
 assert.deepEqual(await readFile(statePath),before);const fresh=await createJournal(f.packet);assert.deepEqual(fresh.predecessor(),f.prior.predecessor);assert.throws(()=>fresh.begin('resume'));assert.throws(()=>fresh.begin('deploy'));assert.throws(()=>fresh.begin('activate'));
 const persisted=JSON.parse(await readFile(join(f.packet.output,'OPERATION-STATE.json')));assert.equal(persisted.deploy.stage,'replace-stopped-window');assert.equal(persisted.predecessor.journalDigest,sha(before));
 await assert.rejects(createJournal(f.packet,{prior:f.prior}));
});
test('original failed journal cannot be retried; resumed published-stopped journal allows explicit activate/stop',async t=>{
 const f=await fixture(t),old=await createJournal(f.prior.packet);assert.throws(()=>old.begin('resume'));assert.throws(()=>old.begin('deploy'));assert.throws(()=>old.begin('activate'));
 const j=await createJournal(f.packet,{prior:f.prior,now:()=>START});j.begin('resume');j.finish('published-stopped');await j.flush();
 const later=await createJournal(f.packet);const loaded=await readPriorOperation(later.predecessor().output,later.predecessor());assert.deepEqual(loaded.predecessor,f.prior.predecessor);later.begin('activate');later.finish('active');await later.flush();
 const final=await createJournal(f.packet);assert.throws(()=>final.begin('resume'));assert.throws(()=>final.begin('activate'));final.begin('stop');final.finish('stopped');await final.flush();
});
test('predecessor rejects altered event sequence, unknown state, old locks and changed hashes',async t=>{
 const f=await fixture(t),p=join(f.prior.packet.output,'OPERATION-STATE.json'),original=await readFile(p),base=JSON.parse(original);
 const edits=[s=>s.deploy.status='running',s=>s.deploy.stage='deploy-rules',s=>s.stop.status='failed',s=>s.events.push(s.events[2]),s=>s.events[2].status='verified',s=>s.events.reverse(),s=>delete s.events[1].atMillis,s=>s.events[0].atMillis=-1,s=>s.events[2].atMillis=OLD-2000,s=>s.predecessor=f.prior.predecessor,s=>s.manifestDigest='f'.repeat(64),s=>s.deploy.diagnostic.reason='PRIVATE'];
 for(const edit of edits){const state=clone(base);edit(state);await writeFile(p,JSON.stringify(state));await assert.rejects(readPriorOperation(f.prior.packet.output));}
 await writeFile(p,original);await writeFile(join(f.prior.packet.output,'OPERATION.lock'),'uncertain');await assert.rejects(readPriorOperation(f.prior.packet.output));await rm(join(f.prior.packet.output,'OPERATION.lock'));
 await writeFile(p,Buffer.concat([original,Buffer.from('\n')]));await assert.rejects(verifyPriorOperation(f.prior));await assert.rejects(readPriorOperation(f.prior.packet.output,f.prior.predecessor));await writeFile(p,original);
 for(const name of ['private-review.json','OPERATION-MANIFEST.json','game/functions/trial-config.json']){const path=join(f.prior.packet.output,name),bytes=await readFile(path);await writeFile(path,Buffer.concat([bytes,Buffer.from('\n')]));await assert.rejects(verifyPriorOperation(f.prior));await writeFile(path,bytes);}
 await verifyPriorOperation(f.prior);
});
test('resume runtime copies only from canonical prior root with unchanged package/lock and fresh destination',async t=>{
 const f=await fixture(t),oldModules=join(f.prior.packet.gameDir,'functions/node_modules'),newModules=join(f.packet.gameDir,'functions/node_modules');
 await mkdir(join(oldModules,'synthetic'),{recursive:true});await mkdir(join(oldModules,'.bin'));await writeFile(join(oldModules,'synthetic/cli.js'),'// synthetic');await symlink('../synthetic/cli.js',join(oldModules,'.bin/synthetic'));
 await installRuntime(f.packet,f.prior);assert.equal(await readFile(join(newModules,'synthetic/cli.js'),'utf8'),'// synthetic');assert.equal(await readlink(join(newModules,'.bin/synthetic')),'../synthetic/cli.js');assert.notEqual((await lstat(join(oldModules,'synthetic/cli.js'))).ino,(await lstat(join(newModules,'synthetic/cli.js'))).ino);
 await assert.rejects(installRuntime(f.packet,f.prior));await verifyPriorOperation(f.prior);
});
test('resume runtime rejects changed lock or symlinked prior modules without touching source',async t=>{
 const f=await fixture(t),source=join(f.prior.packet.gameDir,'functions/node_modules'),destination=join(f.packet.gameDir,'functions/node_modules');
 const real=join(f.root,'elsewhere');await mkdir(real);await symlink(real,source);await assert.rejects(installRuntime(f.packet,f.prior));await assert.rejects(lstat(destination),{code:'ENOENT'});await rm(source);
 await mkdir(source);const lock=join(f.packet.gameDir,'functions/package-lock.json');await writeFile(lock,(await readFile(lock,'utf8'))+'\n');await assert.rejects(installRuntime(f.packet,f.prior));await assert.rejects(lstat(destination),{code:'ENOENT'});
});
test('CLI resume requires exact explicit arguments; defaults remain plan-only',async()=>{
 const logs=[];assert.equal(await main(['--plan'],{log:x=>logs.push(x)}),0);
 for(const args of [['--resume-reviewed'],['--resume-reviewed','--review-base64','{}'],['--resume-reviewed','--operation','/unused','--tooling-dir','/unused']])assert.equal(await main(args,{log:x=>logs.push(x)}),1);
 assert(logs[0].startsWith('PLAN_ONLY:'));assert(logs.slice(1).every(x=>x.startsWith('STOP:')));
});

test('changed predecessor blocks later activation but cannot block exact gate-first stop',async t=>{
 const f=await fixture(t),j=await createJournal(f.packet,{prior:f.prior,now:()=>START});j.begin('resume');j.finish('published-stopped');await j.flush();
 await writeFile(join(f.prior.packet.output,'OPERATION-STATE.json'),'changed original');
 await assert.rejects(readPriorForMode('activate',j));assert.equal(await readPriorForMode('stop',j),undefined);assert.equal(await readPriorForMode('inspect',j),undefined);
 const h=harness();h.admin=adminRecords(nextReview(),true);h.hosting={kind:'game',version:'new'};h.time=START;
 assert.equal((await h.run({mode:'stop',journal:j,priorReview:undefined,checkLocal:()=>verifyOperationPacket(f.packet)})).status,'stopped');await j.flush();
 assert.equal(h.admin.gate.enabled,false);assert.deepEqual(h.mutations,['updateAdmin','deployHosting']);assert.deepEqual(j.predecessor(),f.prior.predecessor);
});

test('slow durable activation journal cannot bypass automatic fixed-start grace period',async()=>{
 const h=harness();h.journal.issued=stage=>{h.calls.push('issued:'+stage);if(stage==='activate-two-testers')h.time=START+60001;};
 assert.equal((await h.run()).reason,'late-verification');assert.equal(h.admin.gate.enabled,false);assert(!h.mutations.includes('updateAdmin'));
});

}

// Exact generic owner bootstrap: readiness must precede the single approved clock.
{
const finalPayload=JSON.parse(execFileSync('python3',['-I','-c',"import ast,json,pathlib,sys; t=ast.parse(pathlib.Path(sys.argv[1]).read_text()); print(json.dumps({n.targets[0].id:ast.literal_eval(n.value) for n in t.body if isinstance(n,ast.Assign) and n.targets[0].id.startswith('FINAL_')}))",join(ROOT,'scripts/start-floating-garden-trial-owner.py')],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000,maxBuffer:262144}));
const test = (await import('node:test')).default;const assert = (await import('node:assert/strict')).default;
const {resumeAfterReadiness,inspectOrStop,updateHostingOnly,resumePreparedHosting} = await import('data:text/javascript;base64,'+Buffer.from(finalPayload.FINAL_RESUME).toString('base64'));
const NOW=1800000000000,prior={packet:{output:'/old/operation'},review:{schemaVersion:1,startsAtMillis:NOW-1000,endsAtMillis:NOW-1000+604800000,testerUids:['PRIVATE_SYNTHETIC_A','PRIVATE_SYNTHETIC_B'],retainBuildArtifacts:true,allowInitialFunctionRecreate:true,approvePublicInvoker:true},predecessor:{journalDigest:'SYNTHETIC'}};
function harness(){const calls=[],logs=[],writes=[];let nowCalls=0,execution;
 const cloud={preflight:async m=>calls.push('preflight:'+m),verifyResumeSource:async()=>{calls.push('ready');return{verified:true}}};
 const operator={selectVerifiedHostingOperation:async(original,updated)=>{assert.equal(original,'/fresh/operation');assert.equal(updated,'/garden-lobby-entry-reviewed-v1/operation');calls.push('select');return original},readPriorOperation:async p=>{assert.equal(p,'/old/operation');calls.push('prior');return prior},verifyPriorOperation:async p=>{assert.equal(p,prior);calls.push('prior-again')},main:async(args)=>{calls.push('main');execution=args;return 0}};
 const adapter={describeAdapterFailure:()=>({reason:'unclassified',exitCode:null,timedOut:false}),createCloudAdapter:args=>{assert.equal(args.packet,prior.packet);assert.equal(args.review,prior.review);return cloud}};
 const options={base:'/fresh',priorBase:'/old',source:'/source',load:async p=>p.endsWith('/operate-floating-garden-trial.mjs')?operator:adapter,now:()=>{calls.push('clock');nowCalls++;return NOW},write:async(...args)=>{calls.push('write');writes.push(args)},log:s=>logs.push(s)};
 return{calls,logs,writes,operator,cloud,options,get nowCalls(){return nowCalls},get execution(){return execution},run:()=>resumeAfterReadiness(options)};
}
test('readiness completes before one chosen clock; exact seven days and private same pair',async()=>{const h=harness();assert.equal(await h.run(),0);assert.deepEqual(h.calls,['prior','preflight:stop','ready','prior-again','clock','write','main']);assert.equal(h.nowCalls,1);const r=JSON.parse(Buffer.from(h.execution[2],'base64url'));assert.deepEqual(r.testerUids,prior.review.testerUids);assert.equal(r.startsAtMillis,NOW+1800000);assert.equal(r.endsAtMillis-r.startsAtMillis,604800000);assert.deepEqual(h.writes[0][2],{flag:'wx',mode:0o600});assert(!h.logs.join().includes('PRIVATE'));assert.equal(h.execution[0],'--resume-reviewed')});
test('each readiness failure produces no dates, record or execution',async()=>{for(const phase of ['prior','preflight','ready','recheck']){const h=harness();const fail=async()=>{throw Error('PRIVATE_SECRET')};if(phase==='prior')h.operator.readPriorOperation=fail;if(phase==='preflight')h.cloud.preflight=fail;if(phase==='ready')h.cloud.verifyResumeSource=fail;if(phase==='recheck')h.operator.verifyPriorOperation=fail;assert.equal(await h.run(),1);assert.equal(h.nowCalls,0);assert.equal(h.writes.length,0);assert(!h.calls.includes('main'));assert(!h.logs.join().includes('PRIVATE'))}});
test('unproven readiness and invalid clock fail closed',async()=>{const h=harness();h.cloud.verifyResumeSource=async()=>({verified:false});assert.equal(await h.run(),1);assert.equal(h.nowCalls,0);const b=harness();b.options.now=()=>NaN;assert.equal(await b.run(),1);assert.equal(b.writes.length,0);assert(!b.calls.includes('main'))});
test('existing launch record and failed operation are never retried',async()=>{const h=harness();h.options.write=async()=>{throw Error('EXISTS')};assert.equal(await h.run(),1);assert(!h.calls.includes('main'));const b=harness();b.operator.main=async()=>{b.calls.push('main');return 1};assert.equal(await b.run(),1);assert.equal(b.calls.filter(x=>x==='main').length,1);assert.equal(b.nowCalls,1);assert(!b.logs.some(x=>x.startsWith('OWNER_COMMAND_FINISHED')))});
test('inspect and stop never create a window or expose review',async()=>{for(const mode of ['--inspect','--stop','--activate-verified-hosting']){const h=harness();assert.equal(await inspectOrStop({...h.options,mode}),0);assert.equal(h.nowCalls,0);assert.equal(h.writes.length,0);assert.deepEqual(h.execution,[mode,'--operation','/fresh/operation','--tooling-dir','/old/tooling'])}await assert.rejects(inspectOrStop({mode:'--activate'}))});

test('Hosting-only wrapper forwards exact original/new/tooling paths without reading a clock or review',async()=>{const h=harness();assert.equal(await updateHostingOnly({...h.options,source:'/new/source'}),0);assert.deepEqual(h.calls,['main']);assert.equal(h.nowCalls,0);assert.equal(h.writes.length,0);assert.deepEqual(h.execution,['--update-hosting-reviewed','--prior-operation','/fresh/operation','--out','/new/operation','--tooling-dir','/old/tooling']);assert(!JSON.stringify(h.execution).includes('PRIVATE'))});
test('prepared Hosting wrapper forwards existing packet paths without preparing source or choosing dates',async()=>{const h=harness();assert.equal(await resumePreparedHosting({...h.options,source:'/temporary/fixed-source'}),0);assert.deepEqual(h.calls,['main']);assert.equal(h.nowCalls,0);assert.equal(h.writes.length,0);assert.deepEqual(h.execution,['--resume-hosting-prepared','--prior-operation','/fresh/operation','--operation','/garden-lobby-entry-reviewed-v1/operation','--tooling-dir','/old/tooling'])});
test('stop and inspect select the latest verified packet; activation recovery always keeps the original',async()=>{for(const mode of ['--stop','--inspect','--activate-verified-hosting']){const h=harness();h.operator.selectVerifiedHostingOperation=async()=>{h.calls.push('select-latest');return '/latest/operation'};assert.equal(await inspectOrStop({...h.options,mode}),0);assert.equal(h.execution[2],mode==='--activate-verified-hosting'?'/fresh/operation':'/latest/operation');assert.equal(h.calls.includes('select-latest'),mode!=='--activate-verified-hosting');assert.equal(h.nowCalls,0);assert.equal(h.writes.length,0)}});

test('historical owner recovery pins its reviewed 60-file source without authorizing the current feature tree',async()=>{
 const baseline=finalPayload.FINAL_SOURCE_BASELINE, overrides=finalPayload.FINAL_SOURCE_FILES;
 assert.equal(Object.keys(baseline).length,60);assert.deepEqual(Object.keys(overrides).sort(),['lab/floating-garden/online/controller.js','lab/floating-garden/online/view.js','scripts/floating-garden-trial-cloud-adapter.mjs','scripts/operate-floating-garden-trial.mjs']);
 for(const digest of Object.values(baseline))assert.match(digest,/^[a-f0-9]{64}$/);
 // This owner helper intentionally downloads its reviewed commit, not HEAD.
 // New features must not silently expand a previously approved deployment.
 // CI checks out full history so the exact old artifact remains verifiable offline.
 if(finalPayload.FINAL_SOURCE_COMMIT==='PENDING_REVIEW')assert(Object.values(overrides).every(x=>x==='PENDING_REVIEW'));
 else{
  assert.match(finalPayload.FINAL_SOURCE_COMMIT,/^[a-f0-9]{40}$/);
  for(const [path,digest] of Object.entries({...baseline,...overrides})){
   const approved=execFileSync('git',['show',`${finalPayload.FINAL_SOURCE_COMMIT}:${path}`],{cwd:ROOT,stdio:['ignore','pipe','pipe'],maxBuffer:4*1024*1024});
   assert.equal(sha(approved),digest,path);
  }
 }
});
}

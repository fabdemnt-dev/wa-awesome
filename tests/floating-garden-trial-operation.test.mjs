import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, lstat, mkdtemp, mkdir, cp, symlink, rm, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
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

import { approvalReady, adminRecords, adminState, operateTrial, readOperationPacket, verifyOperationPacket, createJournal, parseReviewBase64, main, MAX_START_WAIT_MILLIS } from '../scripts/operate-floating-garden-trial.mjs';
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
    if (cmd === 'gcloud') return identityRunner(cmd, args);
    assert.equal(cmd, process.execPath);
    if (args.includes('--version')) return { exitCode: 0, stdout: '14.27.0' };
    assert(args.includes('--non-interactive')); assert(args.includes('--json'));
    let result;
    if (args[1] === 'hosting:sites:list') result = { sites: [{ name: `projects/${PROJECT}/sites/${PROJECT}`, defaultUrl: ORIGIN }] };
    else {
      assert.equal(args[1], 'hosting:channel:list');
      result = { channels: [{ name: `sites/${PROJECT}/channels/live`, url: ORIGIN,
        release: { type: 'DEPLOY', message: `garden-trial-${hosting}-v1:${p.manifestDigest}`,
          version: { name: `sites/${PROJECT}/versions/synthetic`, status: 'FINALIZED' } } }] };
    }
    return { exitCode: 0, stdout: JSON.stringify({ status: 'success', result }) };
  };
  const fetchImpl = async (url, options) => {
    assert.equal(new URL(url).origin, ORIGIN); assert.equal(options.redirect, 'manual');
    const path = new URL(url).pathname; publicReads.push({ hosting, path });
    const dir = hosting === 'game' ? p.gameDir : p.stoppedDir;
    const config = JSON.parse(await readFile(join(dir, hosting === 'game' ? 'firebase.hosting-only.json' : 'firebase.maintenance.json')));
    const headers = Object.fromEntries(config.hosting.headers[0].headers.map((h) => [h.key, h.value]));
    if (hosting === 'game' && path === '/') return new Response('', { status: 302, headers: { ...headers, location: '/lab/floating-garden/trial/index.html' } });
    const key = path === '/' ? 'index.html' : path.slice(1); let body, status;
    try { body = await readFile(join(dir, 'public', key)); status = 200; }
    catch { body = await readFile(join(p.stoppedDir, 'public/404.html')); status = 404; }
    if (overrides.publicBody) body = overrides.publicBody(path, body);
    return new Response(body, { status, headers });
  };
  const cloud = createCloudAdapter({ ...fixture, toolingDir, runner, requestClient, fetchImpl, env: {}, execArgv: [], now: () => NOW });
  await cloud.preflight('stop'); // Only injected identity reads; no absence requirement.
  return { ...fixture, cloud, manifest, requests, cli, publicReads, functions, setHosting: (value) => { hosting = value; } };
}

test('constructing the adapter does not evaluate packet/review or call capabilities', () => {
  const hostile = new Proxy({}, { get() { assert.fail('Lazy data evaluated'); } });
  const no = () => assert.fail('Capability invoked during construction');
  const cloud = createCloudAdapter({ packet: hostile, review: hostile, toolingDir: '/synthetic', runner: no,
    requestClient: { request: no }, db: hostile, now: no, fetchImpl: no, env: {}, execArgv: [] });
  assert.deepEqual(Object.keys(cloud).sort(), ['preflight', 'readAdmin', 'createStoppedAdmin', 'updateAdmin', 'deployFunctions', 'verifyFunctions', 'deployRules', 'verifyRules', 'readHosting', 'deployHosting', 'verifyHosting'].sort());
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

test('Run traffic preserves exact explicit-revision acceptance without short/full normalization', () => {
  const run = runService(metadata()), revision = run.latestReadyRevision;
  for (const type of [undefined, 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST']) {
    assert.equal(validateRunService({ ...run, trafficStatuses: [{ ...(type === undefined ? {} : { type }), percent: 100, revision }] }, run.name, revision), true);
    assert.throws(() => validateRunService({ ...run, trafficStatuses: [{ ...(type === undefined ? {} : { type }), percent: 100, revision: revision.split('/').at(-1) }] }, run.name, revision), (error) => error.code === 'run-latest-traffic');
  }
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
test('initial closed Rules accept observed Console whitespace only, at both preflight and deployment guards',async()=>{
 const expected=await readFile(join(ROOT,'config/floating-garden-trial/deny-all.rules'),'utf8');
 assert.equal(sameDenyAllRules(consoleClosedRules,expected),true);
 assert.equal(sameDenyAllRules(expected,expected),true);
 assert.equal(sameDenyAllRules(consoleClosedRules.replaceAll('\n','\r\n').replaceAll('  ','\t'),expected),true);
 const source=await readFile(join(ROOT,'scripts/floating-garden-trial-cloud-adapter.mjs'),'utf8');
 assert.equal((source.match(/requireThat\(sameDenyAllRules\(/g)??[]).length,2);
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
test('read-only compatibility predicate is byte-identical to the ordinary validator',async()=>{
 const diag=JSON.parse(diagnosticSource),adapter=await readFile(join(ROOT,'scripts/floating-garden-trial-cloud-adapter.mjs'),'utf8');
 const line=diag.split('\n').find(x=>x.startsWith('const CORRECT_TRAFFIC_CHECK = '));
 const embedded=JSON.parse(line.slice('const CORRECT_TRAFFIC_CHECK = '.length,-1));
 const from=adapter.indexOf('  const traffic = service.trafficStatuses;');
 assert.equal(embedded,adapter.slice(from,adapter.indexOf('  return true;\n}',from)));
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, lstat, mkdtemp, mkdir, cp, symlink, rm, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { validateOperationReview, publicTrialConfig, prepareTrialOperation } from '../scripts/prepare-floating-garden-trial-operation.mjs';
import { runtimeConfig } from '../scripts/deploy-floating-garden-connection-template.mjs';
import { FUNCTION_NAMES } from '../scripts/prepare-floating-garden-trial.mjs';
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
  REGION, RUNTIME_ACCOUNT } = adapterModule;
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
  assert.deepEqual(classifyDeployResult(warning), { kind: 'failed' });
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

}

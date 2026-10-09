// SDK587 and bounded HTTPS read boundary. Import is inert. Never expose tokens,
// subprocess output, provider errors or account identities to callers/logs.
import { isDeepStrictEqual } from 'node:util';
import { spawnSync } from 'node:child_process';
import { realpathSync, lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { ACTIVE_UPDATE_SCOPE as S } from './floating-garden-active-update.mjs';
import { FUNCTION_NAMES } from './prepare-floating-garden-trial.mjs';
import { RUNTIME_ACCOUNT } from './floating-garden-trial-cloud-adapter.mjs';
import { OWNER_SDK_VERSION, requireOwnerReadonlyPolicy, ownerNeed as need, ownerGuard } from './floating-garden-owner-readonly-policy.mjs';
import { createOwnerReadonlyFirestore, OWNER_ROOTS, OWNER_GROUPS } from './floating-garden-owner-readonly-firestore.mjs';
const SECRET = 'FLOATING_GARDEN_INVITE_HMAC_KEY', MAX = 16 * 1024 * 1024;
export const OWNER_READ_COMMANDS = Object.freeze([
  ['version'], ['config','list','--all'], ['auth','list','--filter=status:ACTIVE'], ['projects','describe',S.project],
  ['projects','get-iam-policy',S.project], ['iam','service-accounts','get-iam-policy',RUNTIME_ACCOUNT], ['iam','service-accounts','describe',RUNTIME_ACCOUNT],
  ['secrets','get-iam-policy',SECRET], ['secrets','describe',SECRET], ['secrets','versions','describe','1',`--secret=${SECRET}`],
  ['secrets','versions','describe','latest',`--secret=${SECRET}`], ['artifacts','repositories','list',`--location=${S.region}`], ['services','list','--enabled'],
].map(Object.freeze));
export function strictOwnerJson(bytes) {
  const text = Buffer.from(bytes).toString('utf8'); need(Buffer.from(text).equals(Buffer.from(bytes)) && Buffer.byteLength(text) <= MAX);
  let at = 0, count = 0;
  function ws() { while (/[ \t\r\n]/.test(text[at] || '') && at < text.length) at++; }
  function str() { const m = text.slice(at).match(/^"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/); need(m); at += m[0].length; return JSON.parse(m[0]); }
  function value(depth = 0) {
    need(depth < 40 && ++count < 200000); ws();
    if (text[at] === '"') return str();
    if (text[at] === '{') { at++; ws(); const entries = [], keys = new Set(); if (text[at] === '}') { at++; return {}; }
      while (true) { ws(); const key = str(); need(!keys.has(key)); keys.add(key); ws(); need(text[at++] === ':'); entries.push([key,value(depth+1)]); ws(); if (text[at] === '}') { at++; return Object.fromEntries(entries); } need(text[at++] === ','); }
    }
    if (text[at] === '[') { at++; ws(); const values=[]; if (text[at] === ']') { at++; return values; } while (true) { values.push(value(depth+1)); ws(); if (text[at] === ']') { at++; return values; } need(text[at++] === ','); } }
    const m = text.slice(at).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/); need(m); at += m[0].length; const v=JSON.parse(m[0]); need(typeof v !== 'number' || Number.isFinite(v)); return v;
  }
  const result=value(); ws(); need(at === text.length); return result;
}
export async function createOwnerReadonlyClients({ policy, env, execArgv = [], gcloudPath, publicPaths, now = Date.now,
  spawn = spawnSync, fetchImpl = fetch } = {}) {
  const owner = requireOwnerReadonlyPolicy(policy); owner.validateEnvironment(env, execArgv);
  need(typeof gcloudPath === 'string' && isAbsolute(gcloudPath) && realpathSync(gcloudPath) === gcloudPath && lstatSync(gcloudPath).isFile());
  need(Array.isArray(publicPaths) && publicPaths.length <= 256 && publicPaths.every(p => typeof p === 'string' && /^\/[A-Za-z0-9_./-]*$/.test(p) && !p.split('/').some(s => s === '.' || s === '..')));
  const allowedPublic = new Set(publicPaths), started=now(); let token, account, commands=0, requests=0, total=0, closed=false;
  const budget = () => { owner.validateEnvironment(env, execArgv); need(!closed && now() >= started && now()-started <= 15*60*1000 && commands <= 100 && requests <= 300 && total <= 128*1024*1024); };
  const childEnv = { ...env, CLOUDSDK_CORE_DISABLE_PROMPTS: 'false', CLOUDSDK_CORE_DISABLE_FILE_LOGGING: 'true', CLOUDSDK_CORE_LOG_HTTP: 'false', CLOUDSDK_CORE_DISABLE_USAGE_REPORTING: 'true', CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: 'true' };
  function command(args, rawToken=false) {
    budget(); need(rawToken ? account && args.length === 2 && args.join(' ') === 'auth print-access-token' : OWNER_READ_COMMANDS.some(a => JSON.stringify(a) === JSON.stringify(args)));
    if (args[0] !== 'version' && JSON.stringify(args) !== JSON.stringify(['config','list','--all'])) owner.validateConfiguration(command(['config','list','--all']));
    budget(); need(++commands <= 100);
    const suffix=[`--project=${S.project}`,`--billing-project=${S.project}`,'--verbosity=error',...(rawToken?[]:['--format=json']),...(account?[`--account=${account}`]:[])];
    let result; try { result=spawn(gcloudPath,[...args,...suffix],{ env:childEnv,input:'n\n'.repeat(4096),encoding:'utf8',timeout:60000,maxBuffer:MAX,windowsHide:true }); } catch { throw ownerGuard(); }
    need(result?.status === 0 && !result.signal && !result.error && typeof result.stdout === 'string' && Buffer.byteLength(result.stdout) <= MAX && Buffer.byteLength(result.stderr || '') <= MAX);
    total += Buffer.byteLength(result.stdout); budget(); return rawToken ? result.stdout : strictOwnerJson(Buffer.from(result.stdout));
  }
  try {
    need(command(['version'])['Google Cloud SDK'] === OWNER_SDK_VERSION);
    owner.validateConfiguration(command(['config','list','--all']));
    account=owner.validateIdentity(command(['auth','list','--filter=status:ACTIVE']));
    const project=command(['projects','describe',S.project]); need(project.projectId === S.project && String(project.projectNumber) === S.projectNumber && project.lifecycleState === 'ACTIVE');
    token=command(['auth','print-access-token'],true).trim(); need(/^[!-~]{20,8192}$/.test(token));
  } catch { closed=true; token=undefined; throw ownerGuard(); }
  const fnPaths=new Set(FUNCTION_NAMES.map(n=>`projects/${S.project}/locations/${S.region}/functions/${n}`)), services=new Set(), objects=new Set(), rulesets=new Set();
  const fixed=new Set([
    `https://cloudfunctions.googleapis.com/v2/projects/${S.project}/locations/-/functions?pageSize=1000`,
    `https://firebaserules.googleapis.com/v1/projects/${S.project}/releases/cloud.firestore`,
    `https://identitytoolkit.googleapis.com/admin/v2/projects/${S.project}/config`,
    `https://firebaseappcheck.googleapis.com/v1/projects/${S.projectNumber}/apps/1:120030709276:web:015f4e996b7c42a4e801d9/recaptchaEnterpriseConfig`,
    `https://firebaseappcheck.googleapis.com/v1/projects/${S.projectNumber}/services?pageSize=100`,
    `https://firebasehosting.googleapis.com/v1beta1/projects/${S.project}/sites/${S.project}`,
    `https://firebasehosting.googleapis.com/v1beta1/projects/${S.project}/sites/${S.project}/channels/live`,
  ]);
  function allowed(url) {
    if (fixed.has(url)) return true;
    for (const p of fnPaths) if (url === `https://cloudfunctions.googleapis.com/v2/${p}:getIamPolicy?options.requestedPolicyVersion=3`) return true;
    for (const p of services) if ([`https://run.googleapis.com/v2/${p}`,`https://run.googleapis.com/v2/${p}:getIamPolicy?options.requestedPolicyVersion=3`].includes(url)) return true;
    for (const p of rulesets) if (url === `https://firebaserules.googleapis.com/v1/${p}`) return true;
    const bucket=`gcf-v2-sources-${S.projectNumber}-${S.region}`;
    if (url === `https://storage.googleapis.com/storage/v1/b/${bucket}?fields=name,projectNumber`) return true;
    return [...objects].some(p => url === p || url === p+'&alt=media');
  }
  function register(url,data) {
    if (url.includes('/functions?pageSize=')) {
      need(data && Array.isArray(data.functions) && data.functions.length === 5 && !data.nextPageToken && !(data.unreachable?.length) && new Set(data.functions.map(f=>f.name)).size === 5);
      need(new Set(data.functions.map(f => typeof f.serviceConfig?.service === 'string' ? f.serviceConfig.service.replace(`projects/${S.projectNumber}/`, `projects/${S.project}/`) : undefined)).size === 5);
      for (const f of data.functions) {
        need(fnPaths.has(f.name)); const service=f.serviceConfig?.service;
        need(typeof service === 'string' && new RegExp(`^projects/(?:${S.project}|${S.projectNumber})/locations/${S.region}/services/[a-z][a-z0-9-]{0,62}$`).test(service)); services.add(service);
        const source=f.buildConfig?.sourceProvenance?.resolvedStorageSource;
        need(source && source.bucket === `gcf-v2-sources-${S.projectNumber}-${S.region}` && typeof source.object === 'string' && source.object.length <= 1024 && !/[\x00-\x1f]/.test(source.object) && /^[1-9][0-9]*$/.test(String(source.generation || '')));
        objects.add(`https://storage.googleapis.com/storage/v1/b/${source.bucket}/o/${encodeURIComponent(source.object)}?generation=${source.generation}`);
      }
      need(services.size <= 5 && objects.size <= 5);
    }
    if (url.endsWith('/releases/cloud.firestore')) { need(data && typeof data.rulesetName === 'string' && new RegExp(`^projects/${S.project}/rulesets/[A-Za-z0-9_-]+$`).test(data.rulesetName)); rulesets.add(data.rulesetName); need(rulesets.size <= 1); }
  }
  async function http(url,{ method='GET',body,authenticated=true }={}) {
    budget(); need(++requests <= 300 && typeof token === 'string');
    const headers=authenticated ? { Authorization:`Bearer ${token}`, 'X-Goog-User-Project':S.project, Accept:'application/json', ...(body ? {'Content-Type':'application/json'}:{}) } : {};
    let response; try { response=await fetchImpl(url,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:authenticated?'error':'manual',signal:AbortSignal.timeout(30000),cache:'no-store'}); } catch { throw ownerGuard(); }
    need(response && (response.url === url || response.url === '') && (authenticated ? response.status === 200 : [200,302,404].includes(response.status)));
    const reader=response.body?.getReader(); need(reader); const chunks=[]; let size=0;
    try { while(true) { const {done,value}=await reader.read(); if(done)break; size+=value.length; need(size<=MAX && total+size<=128*1024*1024); chunks.push(Buffer.from(value)); } } finally { await reader.cancel(); }
    total+=size; budget(); return {status:response.status,bytes:Buffer.concat(chunks),headers:response.headers};
  }
  const requestClient=Object.freeze({ async request(options) {
    need(options?.method === 'GET' && allowed(options.url) && ['json','arraybuffer'].includes(options.responseType) && options.retry === false && options.maxRedirects === 0 && !options.data && !options.body && !options.headers);
    const r=await http(options.url); const data=options.responseType === 'arraybuffer' ? r.bytes : strictOwnerJson(r.bytes); if(options.responseType === 'json')register(options.url,data); return {status:r.status,data};
  } });
  const readTokens = new Set();
  const db=createOwnerReadonlyFirestore(async(url,body)=>{
    const prefix=`https://firestore.googleapis.com/v1/projects/${S.project}/databases/(default)/documents:`;
    need(typeof url === 'string' && url.startsWith(prefix) && Buffer.byteLength(JSON.stringify(body)) <= 16384);
    const method=url.slice(prefix.length);
    if (method === 'listCollectionIds') need(isDeepStrictEqual(body,{pageSize:100}));
    else if (method === 'beginTransaction') need(readTokens.size === 0 && isDeepStrictEqual(body,{options:{readOnly:{}}}));
    else if (method === 'rollback') need(Object.keys(body).length === 1 && readTokens.has(body.transaction));
    else if (method === 'runQuery') {
      const from=body?.structuredQuery?.from;
      need(readTokens.has(body.transaction) && Array.isArray(from) && from.length === 1 && typeof from[0].allDescendants === 'boolean' &&
        (from[0].allDescendants ? OWNER_GROUPS : OWNER_ROOTS).includes(from[0].collectionId) &&
        isDeepStrictEqual(body,{structuredQuery:{from:[{collectionId:from[0].collectionId,allDescendants:from[0].allDescendants}],limit:10001},transaction:body.transaction}));
    } else throw ownerGuard();
    const result=strictOwnerJson((await http(url,{method:'POST',body})).bytes);
    if(method==='beginTransaction') { need(typeof result?.transaction==='string' && /^[A-Za-z0-9+/]+={0,2}$/.test(result.transaction) && result.transaction.length <= 4096); readTokens.add(result.transaction); }
    if(method==='rollback') readTokens.delete(body.transaction);
    return result;
  });
  return Object.freeze({ requestClient, db,
    runner(commandName,args) {
      need(commandName === 'gcloud' && Array.isArray(args));
      const tail=[`--project=${S.project}`,`--billing-project=${S.project}`,'--format=json','--verbosity=error'];
      let base=args;
      // Existing provider and adapter use two exact flag orderings.
      if (JSON.stringify(args.slice(-4)) === JSON.stringify(tail)) base=args.slice(0,-4);
      else { const other=['--format=json',`--project=${S.project}`,`--billing-project=${S.project}`,'--verbosity=error']; need(JSON.stringify(args.slice(-4))===JSON.stringify(other)); base=args.slice(0,-4); }
      return {exitCode:0,stdout:JSON.stringify(command(base))};
    },
    async fetchPublic(url) { const parsed=new URL(url); need(parsed.origin===S.origin && parsed.href===S.origin+parsed.pathname && allowedPublic.has(parsed.pathname));
      const r=await http(url,{authenticated:false}); return new Response(r.bytes,{status:r.status,headers:r.headers}); },
    recheckIdentity() { budget(); owner.validateConfiguration(command(['config','list','--all'])); need(owner.validateIdentity(command(['auth','list','--filter=status:ACTIVE']))===account); },
    close() { token=undefined; account=undefined; closed=true; },
  });
}

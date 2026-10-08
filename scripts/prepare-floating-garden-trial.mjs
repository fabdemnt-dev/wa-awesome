#!/usr/bin/env node
// File preparation only. This module never invokes Firebase, gcloud, git, a network
// client, a shell, or a credential API. Generated commands are reviewable data.
import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { validateTrialConfig as validateClient, FIXED_TRIAL_PROJECT, FIXED_TRIAL_ORIGIN } from '../lab/floating-garden/trial/config.js';
const require = createRequire(import.meta.url);
const { validateTrialConfig: validateBackend, renderTrialRules } = require('../functions/floating-garden-trial/config.js');
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DAY = 86400000;
export const FUNCTION_NAMES = Object.freeze(['floatingGardenCreateRoom', 'floatingGardenJoinRoom', 'floatingGardenStartMatch', 'floatingGardenGetSnapshot', 'floatingGardenSubmitAction']);
const SHARED = ['engine.js', 'match-engine.js', 'session.js', 'view.js', 'match-rule-examples.js', 'style.css', 'match-style.css'];
const ONLINE = ['controller.js', 'mount.js', 'view.js', 'style.css'];
const TRIAL = ['index.html', 'app.js', 'bootstrap.js', 'config.js', 'firebase.js', 'style.css'];
const SERVER = ['index.js', 'trial-handlers.js', 'config.js', 'package.json', 'package-lock.json'];
const TRUSTED = ['handlers.js', 'contract.js', 'invite-code.js', 'core/engine.js', 'core/match-engine.js', 'core/cpu.js', 'core/package.json'];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function projectId(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value) || value.startsWith('demo-') || ['wa-awesome', 'wa-awesome-mofumofu-stg'].includes(value)) throw new Error('A verified new garden-only Firebase project is required');
  return value;
}
async function newDirectory(output) {
  try { await lstat(output); throw new Error('Output already exists; choose a fresh directory (nothing is overwritten)'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(output, { recursive: true });
}
function fixedTrialCsp(config) {
  // The fixed-site game uses only these pinned SDK modules and SDK 10.8.0
  // transports: Enterprise exchange, anonymous Auth/refresh, and Listen (no
  // browser Firestore writes). Callable paths do not authorize other functions.
  const scripts = ['app', 'app-check', 'auth', 'firestore', 'functions'].map((name) => `https://www.gstatic.com/firebasejs/10.8.0/firebase-${name}.js`);
  const connections = [
    `https://content-firebaseappcheck.googleapis.com/v1/projects/${FIXED_TRIAL_PROJECT}/apps/${config.firebase.appId}:exchangeRecaptchaEnterpriseToken`,
    'https://identitytoolkit.googleapis.com/v1/accounts:signUp',
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup',
    'https://securetoken.googleapis.com/v1/token',
    'https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel',
    ...FUNCTION_NAMES.map((name) => `https://asia-northeast1-${FIXED_TRIAL_PROJECT}.cloudfunctions.net/${name}`),
    'https://www.google.com/recaptcha/',
  ];
  return [
    "default-src 'none'",
    `script-src 'self' ${scripts.join(' ')} https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/`,
    "style-src 'self'",
    // online/view.js emits this one literal style attribute. Do not permit
    // arbitrary inline styles; DOM style properties need no inline exception.
    "style-src-attr 'unsafe-hashes' 'sha256-B/IIVW4l3ftMSU48N0ClttKC1O2UQW2APFMSKYmzs64='",
    `connect-src ${connections.join(' ')}`,
    'frame-src https://www.google.com/recaptcha/ https://recaptcha.google.com/recaptcha/',
    "worker-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  ].join('; ');
}
function hosting(site, publicDirectory, csp) {
  return { site, public: publicDirectory, ignore: ['**/.*', '**/node_modules/**'], headers: [{ source: '**', headers: [
    { key: 'Cache-Control', value: 'no-store, max-age=0' }, { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'no-referrer' }, { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
    ...(csp ? [{ key: 'Content-Security-Policy', value: csp }] : []),
  ] }], redirects: [{ source: '/', destination: '/lab/floating-garden/trial/index.html', type: 302 }] };
}
export function previewExpiryMinutes(config, executionNow) {
  validateClient(config);
  const remaining = config.endsAtMillis - executionNow;
  if (!Number.isSafeInteger(executionNow) || remaining < 60000) throw new Error('Recalculate immediately before approved execution; less than one minute remains');
  return Math.floor(Math.min(7 * DAY, remaining) / 60000);
}
export function reviewPlan(config, now) {
  const remaining = config.endsAtMillis - now;
  if (!Number.isSafeInteger(now) || remaining <= 0 || config.startsAtMillis - now > 7 * DAY) throw new Error('Build must be within 7 days before trial start and before expiry');
  validateClient(config);
  const fixed = config.projectId === FIXED_TRIAL_PROJECT && config.previewOrigin === FIXED_TRIAL_ORIGIN;
  const channel = 'garden-7day';
  const maxMinutesAtPreparation = fixed ? null : previewExpiryMinutes(config, now);
  const common = ['firebase', '--config', 'firebase.trial.json', '--project', config.projectId];
  return { schemaVersion: 1, mode: 'review-only-not-executed', projectId: config.projectId, region: 'asia-northeast1',
    requiredNewDefaultDatabase: { id: '(default)', location: 'asia-northeast1' },
    runtimeServiceAccount: `garden-trial-runtime@${config.projectId}.iam.gserviceaccount.com`,
    previewOrigin: config.previewOrigin, trialEndsAtMillis: config.endsAtMillis, maxRooms: 20, maxTesters: 2,
    hosting: { mode: fixed ? 'fixed-dedicated-live' : 'expiring-preview', site: config.projectId, origin: config.previewOrigin },
    ...(fixed ? { hostingExpiry: null, hostingWarning: 'The fixed URL does not expire. Client/backend trial gates still stop access at the fixed deadline; replace Hosting with the reviewed closed-live maintenance bundle when stopping.' } : { previewExpiry: { preparedAtMillis: now, maxMinutesAtPreparation, mustRecalculateAtApprovedExecution: true, unit: 'm', warning: 'Firebase expiry is relative to deployment time; verify returned expireTime against the trial deadline. This file is not an executable deploy script.' } }),
    functionNames: FUNCTION_NAMES, perFunctionLimits: { minInstances: 0, maxInstances: 1, timeoutSeconds: 30, memory: '256MiB', cpu: 1, concurrency: 1 },
    secret: { name: 'FLOATING_GARDEN_INVITE_HMAC_KEY', bindings: FUNCTION_NAMES.slice(0, 2), valueIncluded: false },
    approvalsStillRequired: ['publish-preparation-branch-and-CI', 'new-project-and-exact-billing-association', 'APIs-and-default-database-creation', 'Anonymous-Auth-and-App-Check-configuration', 'new-secret-and-exact-runtime-IAM-grants', 'exact-tester-enrollment-and-trial-activation', fixed ? 'dedicated-fixed-hosting-five-functions-and-rules-deployment' : 'named-preview-five-functions-and-rules-deployment', 'data-and-resource-cleanup'],
    commandsNotExecuted: {
      functions: [...common, 'deploy', '--only', 'functions:floating-garden-trial'],
      rules: [...common, 'deploy', '--only', 'firestore:rules'],
      ...(fixed ? { hosting: ['firebase', '--config', 'firebase.hosting-only.json', '--project', FIXED_TRIAL_PROJECT, 'deploy', '--only', `hosting:${FIXED_TRIAL_PROJECT}`] } : { preview: [...common, 'hosting:channel:deploy', channel, '--expires', '<RECALCULATE_AT_APPROVED_EXECUTION>m', '--no-authorized-domains'] }),
    },
    forbidden: ['production or mofumofu project', 'main merge', fixed ? 'live Hosting outside the exact dedicated site' : 'live Hosting deploy', 'all-Functions deploy', '--force', 'automatic Auth-domain synchronization', 'App Check debug tokens', 'default Editor service account reuse', 'unapproved irreversible cleanup'],
    costWarning: '20 rooms, instance limits, trial expiry and spend notifications are not a monetary hard cap. Static hosting expiry does not delete backend resources.',
  };
}
export async function prepareTrialBundle({ config, output, now = Date.now(), repositoryRoot = ROOT }) {
  const client = validateClient(config);
  projectId(client.projectId);
  if (client.previewOrigin !== FIXED_TRIAL_ORIGIN && !new RegExp(`^https://${client.projectId}--garden-7day-[a-z0-9]{4,20}\\.web\\.app$`).test(client.previewOrigin)) throw new Error('Bundle origin must be the exact dedicated fixed host or verified garden-7day preview channel');
  const backend = validateBackend(Object.fromEntries(['enabled', 'projectId', 'region', 'previewOrigin', 'startsAtMillis', 'endsAtMillis', 'maxRooms'].map((key) => [key, client[key]])));
  const plan = reviewPlan(client, now);
  const source = resolve(repositoryRoot), out = resolve(output);
  const inputs = [];
  for (const name of SHARED) inputs.push([`lab/floating-garden/${name}`, `public/lab/floating-garden/${name}`]);
  for (const name of ONLINE) inputs.push([`lab/floating-garden/online/${name}`, `public/lab/floating-garden/online/${name}`]);
  for (const name of TRIAL) inputs.push([`lab/floating-garden/trial/${name}`, `public/lab/floating-garden/trial/${name}`]);
  for (const name of SERVER) inputs.push([`functions/floating-garden-trial/${name}`, `functions/${name}`]);
  for (const name of TRUSTED) inputs.push([`functions/floating-garden-online/${name}`, `functions/online/${name}`]);
  const prepared = [];
  for (const [from, to] of inputs) {
    const path = resolve(source, from), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || !((await realpath(path)).startsWith((await realpath(source)) + '/'))) throw new Error(`Unsafe source file ${from}`);
    prepared.push({ from, to, bytes: await readFile(path) });
  }
  for (const name of ['engine.js', 'match-engine.js', 'cpu.js']) {
    const canonical = await readFile(join(source, 'lab/floating-garden', name));
    const staged = prepared.find((item) => item.to === `functions/online/core/${name}`).bytes;
    if (!canonical.equals(staged)) throw new Error(`Trusted staged core mismatch: ${name}`);
  }
  const template = await readFile(join(source, 'functions/floating-garden-trial/firestore.rules.template'), 'utf8');
  const rules = renderTrialRules(template, backend);
  const manifest = Object.fromEntries(prepared.map(({ from, bytes }) => [from, digest(bytes)]));
  await newDirectory(out);
  async function put(path, content) { const destination = join(out, path); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, content); }
  for (const { to, bytes } of prepared) await put(to, bytes);
  await put('functions/trial-config.json', JSON.stringify(backend, null, 2) + '\n');
  await put('public/lab/floating-garden/trial/trialruntime.js', `// Public Web App configuration only; generated locally. No server credentials or HMAC secret.\nexport default Object.freeze(${JSON.stringify(client, null, 2)});\n`);
  await put('firestore.rules', rules);
  await put('firestore.indexes.json', JSON.stringify({ indexes: [], fieldOverrides: [] }, null, 2) + '\n');
  const fixed = client.projectId === FIXED_TRIAL_PROJECT && client.previewOrigin === FIXED_TRIAL_ORIGIN;
  const csp = fixed ? fixedTrialCsp(client) : undefined;
  await put('firebase.trial.json', JSON.stringify({ functions: { source: 'functions', codebase: 'floating-garden-trial', ignore: ['node_modules', '**/.*', '*-debug.log'] }, firestore: { rules: 'firestore.rules', indexes: 'firestore.indexes.json' }, hosting: hosting(client.projectId, 'public', csp) }, null, 2) + '\n');
  if (fixed) await put('firebase.hosting-only.json', JSON.stringify({ hosting: hosting(FIXED_TRIAL_PROJECT, 'public', csp) }, null, 2) + '\n');
  // Initial admin records are deliberately locked. This is review data, not an importer.
  await put('ADMIN-RECORDS-REVIEW.json', JSON.stringify({ 'floatingGardenTrial/config': { ...backend, enabled: false, testerUids: [] }, 'floatingGardenTrial/usage': { projectId: backend.projectId, startsAtMillis: backend.startsAtMillis, endsAtMillis: backend.endsAtMillis, maxRooms: 20, createdRoomCount: 0 }, testerDocumentTemplate: { active: false, expiresAtMillis: backend.endsAtMillis } }, null, 2) + '\n');
  await put('REVIEW-PLAN.json', JSON.stringify(plan, null, 2) + '\n');
  await put('SOURCE-SHA256.json', JSON.stringify(manifest, null, 2) + '\n');
  return { output: out, fileCount: prepared.length + 8 + Number(fixed), plan };
}
export async function prepareClosedPreview({ project, output }) {
  const id = projectId(project), out = resolve(output);
  await newDirectory(out); await mkdir(join(out, 'public'), { recursive: true });
  await writeFile(join(out, 'public/index.html'), '<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>庭園の検証準備中</title><p>接続はまだ無効です。認証やゲームデータの送信は行いません。</p></html>\n');
  const host = hosting(id, 'public'); delete host.redirects;
  await writeFile(join(out, 'firebase.preview-only.json'), JSON.stringify({ hosting: host }, null, 2) + '\n');
  await writeFile(join(out, 'REVIEW-PLAN.json'), JSON.stringify({ mode: 'closed-preview-review-only', projectId: id, commandNotExecuted: ['firebase', '--config', 'firebase.preview-only.json', '--project', id, 'hosting:channel:deploy', 'garden-7day', '--expires', '7d', '--no-authorized-domains'], warning: 'Explicit hosting deployment approval and verified new project are still required; no command was executed.' }, null, 2) + '\n');
  return { output: out, enabled: false };
}
export const CLOSED_LIVE_HTML = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>庭園の試験は停止中です</title></head><body><main><h1>庭園の試験は停止中です</h1><p>現在は準備中、または試験期間が終了しています。</p><p>この画面では認証やゲームデータの送信を行いません。</p></main></body></html>\n';
export const CLOSED_LIVE_CONFIG_JSON = (() => {
  const host = hosting(FIXED_TRIAL_PROJECT, 'public'); delete host.redirects;
  host.headers[0].headers.push({ key: 'Content-Security-Policy', value: "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
  return JSON.stringify({ hosting: host }, null, 2) + '\n';
})();
export async function prepareClosedLive({ project, output }) {
  if (project !== FIXED_TRIAL_PROJECT) throw new Error('Closed live Hosting is restricted to the exact approved garden-only project/site');
  const out = resolve(output);
  // The same inert 404 page covers old entry/deep links without a rewrite.
  const files = {
    'public/index.html': CLOSED_LIVE_HTML,
    'public/404.html': CLOSED_LIVE_HTML,
    'firebase.maintenance.json': CLOSED_LIVE_CONFIG_JSON,
  };
  const plan = {
    schemaVersion: 1, mode: 'closed-live-review-only', projectId: FIXED_TRIAL_PROJECT,
    site: FIXED_TRIAL_PROJECT, origin: FIXED_TRIAL_ORIGIN, enabled: false,
    commandNotExecuted: ['firebase', '--config', 'firebase.maintenance.json', '--project', FIXED_TRIAL_PROJECT, 'deploy', '--only', `hosting:${FIXED_TRIAL_PROJECT}`],
    files: Object.keys(files).sort(),
    warning: 'Local preparation only. Verify the exact dedicated project/site and review these files before an authorized Hosting-only deployment. This static page does not disable or delete backend resources; keep the separate trial gate disabled or expired.',
  };
  files['REVIEW-PLAN.json'] = JSON.stringify(plan, null, 2) + '\n';
  files['FILES-SHA256.json'] = JSON.stringify(Object.fromEntries(Object.keys(files).sort().map((path) => [path, digest(files[path])])), null, 2) + '\n';
  await newDirectory(out);
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(out, path)), { recursive: true });
    await writeFile(join(out, path), bytes);
  }
  return { output: out, enabled: false, fileCount: Object.keys(files).length, plan };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, input, output] = process.argv.slice(2);
  if (!['--config', '--closed-preview', '--closed-live'].includes(mode) || !input || !output || process.argv.length !== 5) throw new Error('Usage: node scripts/prepare-floating-garden-trial.mjs --config CONFIG.json NEW_OUTPUT | --closed-preview NEW_PROJECT_ID NEW_OUTPUT | --closed-live wa-awesome-garden-stg NEW_OUTPUT');
  const result = mode === '--config' ? await prepareTrialBundle({ config: JSON.parse(await readFile(input, 'utf8')), output }) : mode === '--closed-live' ? await prepareClosedLive({ project: input, output }) : await prepareClosedPreview({ project: input, output });
  console.log(JSON.stringify({ ...result, notice: 'Local files only. No cloud action executed.' }, null, 2));
}

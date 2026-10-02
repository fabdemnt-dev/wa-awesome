#!/usr/bin/env node
// File preparation only. This module never invokes Firebase, gcloud, git, a network
// client, a shell, or a credential API. Generated commands are reviewable data.
import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { validateTrialConfig as validateClient } from '../lab/floating-garden/trial/config.js';
const require = createRequire(import.meta.url);
const { validateTrialConfig: validateBackend, renderTrialRules } = require('../functions/floating-garden-trial/config.js');
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DAY = 86400000;
export const FUNCTION_NAMES = Object.freeze(['floatingGardenCreateRoom', 'floatingGardenJoinRoom', 'floatingGardenStartMatch', 'floatingGardenGetSnapshot', 'floatingGardenSubmitAction']);
const SHARED = ['engine.js', 'match-engine.js', 'session.js', 'view.js', 'match-rule-examples.js', 'style.css', 'match-style.css'];
const ONLINE = ['controller.js', 'mount.js', 'view.js', 'style.css'];
const TRIAL = ['index.html', 'app.js', 'bootstrap.js', 'config.js', 'firebase.js', 'style.css'];
const SERVER = ['index.js', 'trial-handlers.js', 'config.js', 'package.json', 'package-lock.json'];
const TRUSTED = ['handlers.js', 'contract.js', 'invite-code.js', 'core/engine.js', 'core/match-engine.js', 'core/package.json'];
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
function hosting(site, publicDirectory) {
  return { site, public: publicDirectory, ignore: ['**/.*', '**/node_modules/**'], headers: [{ source: '**', headers: [
    { key: 'Cache-Control', value: 'no-store, max-age=0' }, { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'no-referrer' }, { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
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
  const channel = 'garden-7day';
  const maxMinutesAtPreparation = previewExpiryMinutes(config, now);
  const common = ['firebase', '--config', 'firebase.trial.json', '--project', config.projectId];
  return { schemaVersion: 1, mode: 'review-only-not-executed', projectId: config.projectId, region: 'asia-northeast1',
    requiredNewDefaultDatabase: { id: '(default)', location: 'asia-northeast1' },
    runtimeServiceAccount: `garden-trial-runtime@${config.projectId}.iam.gserviceaccount.com`,
    previewOrigin: config.previewOrigin, trialEndsAtMillis: config.endsAtMillis, maxRooms: 20, maxTesters: 2,
    previewExpiry: { preparedAtMillis: now, maxMinutesAtPreparation, mustRecalculateAtApprovedExecution: true, unit: 'm', warning: 'Firebase expiry is relative to deployment time; verify returned expireTime against the trial deadline. This file is not an executable deploy script.' },
    functionNames: FUNCTION_NAMES, perFunctionLimits: { minInstances: 0, maxInstances: 1, timeoutSeconds: 30, memory: '256MiB', cpu: 1, concurrency: 1 },
    secret: { name: 'FLOATING_GARDEN_INVITE_HMAC_KEY', bindings: FUNCTION_NAMES.slice(0, 2), valueIncluded: false },
    approvalsStillRequired: ['publish-preparation-branch-and-CI', 'new-project-and-exact-billing-association', 'APIs-and-default-database-creation', 'Anonymous-Auth-and-App-Check-configuration', 'new-secret-and-exact-runtime-IAM-grants', 'exact-tester-enrollment-and-trial-activation', 'named-preview-five-functions-and-rules-deployment', 'data-and-resource-cleanup'],
    commandsNotExecuted: {
      functions: [...common, 'deploy', '--only', 'functions:floating-garden-trial'],
      rules: [...common, 'deploy', '--only', 'firestore:rules'],
      preview: [...common, 'hosting:channel:deploy', channel, '--expires', '<RECALCULATE_AT_APPROVED_EXECUTION>m', '--no-authorized-domains'],
    },
    forbidden: ['production or mofumofu project', 'main merge', 'live Hosting deploy', 'all-Functions deploy', '--force', 'automatic Auth-domain synchronization', 'App Check debug tokens', 'default Editor service account reuse', 'unapproved irreversible cleanup'],
    costWarning: '20 rooms, instance limits, trial expiry and spend notifications are not a monetary hard cap. Static hosting expiry does not delete backend resources.',
  };
}
export async function prepareTrialBundle({ config, output, now = Date.now(), repositoryRoot = ROOT }) {
  const client = validateClient(config);
  projectId(client.projectId);
  if (!new RegExp(`^https://${client.projectId}--garden-7day-[a-z0-9]{4,20}\\.web\\.app$`).test(client.previewOrigin)) throw new Error('Bundle channel is fixed to garden-7day; origin must be that exact verified channel');
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
  for (const name of ['engine.js', 'match-engine.js']) {
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
  await put('firebase.trial.json', JSON.stringify({ functions: { source: 'functions', codebase: 'floating-garden-trial', ignore: ['node_modules', '**/.*', '*-debug.log'] }, firestore: { rules: 'firestore.rules', indexes: 'firestore.indexes.json' }, hosting: hosting(client.projectId, 'public') }, null, 2) + '\n');
  // Initial admin records are deliberately locked. This is review data, not an importer.
  await put('ADMIN-RECORDS-REVIEW.json', JSON.stringify({ 'floatingGardenTrial/config': { ...backend, enabled: false, testerUids: [] }, 'floatingGardenTrial/usage': { projectId: backend.projectId, startsAtMillis: backend.startsAtMillis, endsAtMillis: backend.endsAtMillis, maxRooms: 20, createdRoomCount: 0 }, testerDocumentTemplate: { active: false, expiresAtMillis: backend.endsAtMillis } }, null, 2) + '\n');
  await put('REVIEW-PLAN.json', JSON.stringify(plan, null, 2) + '\n');
  await put('SOURCE-SHA256.json', JSON.stringify(manifest, null, 2) + '\n');
  return { output: out, fileCount: prepared.length + 8, plan };
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
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, input, output] = process.argv.slice(2);
  if (!['--config', '--closed-preview'].includes(mode) || !input || !output || process.argv.length !== 5) throw new Error('Usage: node scripts/prepare-floating-garden-trial.mjs --config CONFIG.json NEW_OUTPUT | --closed-preview NEW_PROJECT_ID NEW_OUTPUT');
  const result = mode === '--config' ? await prepareTrialBundle({ config: JSON.parse(await readFile(input, 'utf8')), output }) : await prepareClosedPreview({ project: input, output });
  console.log(JSON.stringify({ ...result, notice: 'Local files only. No cloud action executed.' }, null, 2));
}

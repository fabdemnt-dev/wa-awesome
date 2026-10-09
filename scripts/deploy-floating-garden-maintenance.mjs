#!/usr/bin/env node
// A single-purpose operator helper. Default: show plan. The explicit deploy flag
// publishes only the inert maintenance page to this dedicated staging project.
// It never starts login, enables APIs, changes Auth/IAM/Rules or deploys Functions.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, lstatSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const PROJECT = 'wa-awesome-garden-stg';
export const PROJECT_NUMBER = '120030709276';
export const ORIGIN = `https://${PROJECT}.web.app`;
export const MESSAGE = 'garden-maintenance-static-v1';
export const CONFIG_FILE = 'firebase.maintenance.json';
export const HTML = "<!doctype html><html lang=\"ja\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta name=\"robots\" content=\"noindex,nofollow\"><title>庭園の試験は停止中です</title></head><body><main><h1>庭園の試験は停止中です</h1><p>現在は準備中、または試験期間が終了しています。</p><p>この画面では認証やゲームデータの送信を行いません。</p></main></body></html>\n";
export const CONFIG = "{\n  \"hosting\": {\n    \"site\": \"wa-awesome-garden-stg\",\n    \"public\": \"public\",\n    \"ignore\": [\n      \"**/.*\",\n      \"**/node_modules/**\"\n    ],\n    \"headers\": [\n      {\n        \"source\": \"**\",\n        \"headers\": [\n          {\n            \"key\": \"Cache-Control\",\n            \"value\": \"no-store, max-age=0\"\n          },\n          {\n            \"key\": \"X-Content-Type-Options\",\n            \"value\": \"nosniff\"\n          },\n          {\n            \"key\": \"Referrer-Policy\",\n            \"value\": \"no-referrer\"\n          },\n          {\n            \"key\": \"X-Robots-Tag\",\n            \"value\": \"noindex, nofollow\"\n          },\n          {\n            \"key\": \"Content-Security-Policy\",\n            \"value\": \"default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\"\n          }\n        ]\n      }\n    ]\n  }\n}\n";
// The prior reviewed PR revision supplies only the npm lockfile and CLI package.
// These bytes cannot change when the branch advances. No fetched script is run.
const DEPENDENCY_REVISION = '0404104414c1fb25a1248fc3a2fd0945f9478051';
export const DEPENDENCIES = Object.freeze({
  'package.json': 'd9d9988d3f196e7672d9c9671df688231600404344245fb9dfd34d61f4630272',
  'package-lock.json': 'd42c28f7b71969648ae4ec97799460e13210edd55fede3a5f4a97170cbb027c6',
});
const hash = (value) => createHash('sha256').update(value).digest('hex');
const stop = (message) => { throw new Error(message); };
const siteNames = [PROJECT, PROJECT_NUMBER].map((p) => `projects/${p}/sites/${PROJECT}`);
const channelSites = [`sites/${PROJECT}`, ...siteNames];
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function jsonResult(output) {
  let value;
  try { value = JSON.parse(output); } catch { stop('Unexpected CLI output; no automatic retry. Do not share debug logs.'); }
  if (value.status !== 'success' || !plain(value.result)) stop('CLI did not confirm success; inspect the stage before retrying.');
  return value.result;
}
export function sitePresent(result) {
  if (!Array.isArray(result.sites) || result.sites.some((s) => !plain(s) || typeof s.name !== 'string')) stop('Invalid site inventory');
  const matches = result.sites.filter((s) => siteNames.includes(s.name));
  if (matches.length > 1 || (matches[0] && matches[0].defaultUrl !== ORIGIN)) stop('Unexpected dedicated site identity');
  return matches.length === 1;
}
export function liveChannel(result) {
  if (!Array.isArray(result.channels) || result.channels.some((c) => !plain(c) || !channelSites.some((s) => typeof c.name === 'string' && c.name.startsWith(`${s}/channels/`)))) stop('Invalid channel inventory');
  const matches = result.channels.filter((c) => channelSites.some((s) => c.name === `${s}/channels/live`));
  if (matches.length !== 1 || (matches[0] && (matches[0].url !== ORIGIN || matches[0].expireTime))) stop('Unexpected live channel identity');
  const channel = matches[0];
  if (Object.hasOwn(channel, 'release') && channel.release !== null && !plain(channel.release)) stop('Malformed live release');
  return channel;
}
export function writeBundle(dir) {
  mkdirSync(join(dir, 'public'));
  writeFileSync(join(dir, CONFIG_FILE), CONFIG, { mode: 0o600 });
  writeFileSync(join(dir, 'public/index.html'), HTML, { mode: 0o600 });
  writeFileSync(join(dir, 'public/404.html'), HTML, { mode: 0o600 });
}
export function checkBundle(dir) {
  const directory = (p) => { const s = lstatSync(p); if (!s.isDirectory() || s.isSymbolicLink()) stop('Unsafe bundle directory'); };
  directory(dir); directory(join(dir, 'public'));
  if (JSON.stringify(readdirSync(dir).sort()) !== JSON.stringify([CONFIG_FILE, 'public'])) stop('Unexpected bundle entries');
  if (JSON.stringify(readdirSync(join(dir, 'public')).sort()) !== '["404.html","index.html"]') stop('Unexpected public assets');
  for (const [name, expected] of [[CONFIG_FILE, CONFIG], ['public/index.html', HTML], ['public/404.html', HTML]]) {
    const path = join(dir, name), s = lstatSync(path);
    if (!s.isFile() || s.isSymbolicLink() || !readFileSync(path).equals(Buffer.from(expected))) stop('Maintenance bytes differ from reviewed content');
  }
}
async function download(url, fetchImpl, maxBytes, expectedStatus = 200) {
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (response.status !== expectedStatus) stop('Required HTTPS read failed; no automatic mutation retry');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) stop('Unexpected response size');
  return { bytes, response };
}
async function verifyPage(fetchImpl) {
  for (const [path, status] of [['/', 200], ['/404.html', 200], ['/lab/floating-garden/trial/index.html', 404]]) {
    const { bytes, response } = await download(`${ORIGIN}${path}`, fetchImpl, 32768, status);
    if (!bytes.equals(Buffer.from(HTML))) stop('Hosted page differs from reviewed maintenance page');
    if (response.headers.get('x-content-type-options') !== 'nosniff' || response.headers.get('referrer-policy') !== 'no-referrer' || !response.headers.get('cache-control')?.includes('no-store') || response.headers.get('content-security-policy') !== "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'") stop('Hosted safety headers were not confirmed');
  }
}
export function canonicalVersionName(value) {
  // Hosting can return the same version with no project prefix, the project ID,
  // or the project number. Normalize only these exact approved resource names.
  const match = typeof value === 'string' && value.match(new RegExp(`^(?:projects/(?:${PROJECT}|${PROJECT_NUMBER})/)?sites/${PROJECT}/versions/([A-Za-z0-9_-]+)$`));
  if (!match || match[0] !== value) stop('Hosting version does not name the exact dedicated garden site');
  return `sites/${PROJECT}/versions/${match[1]}`;
}
function releaseVersion(channel) {
  const release = channel?.release;
  if (!plain(release) || release.message !== MESSAGE || release.type !== 'DEPLOY' || !plain(release.version) || release.version.status !== 'FINALIZED') stop('Existing live release is not recognized. Stop; do not overwrite it.');
  return canonicalVersionName(release.version.name);
}
function defaultRun(command, args, cwd, inherited = false) {
  try { return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: inherited ? 'inherit' : ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } }) || ''; }
  catch { stop(`${command === 'gcloud' ? 'Project/API read' : 'CLI stage'} failed. No retry or new login was started. Do not paste credential or debug output.`); }
}
// Dependency injection is for isolated command-sequence tests, never a CLI option.
export async function deployMaintenance({ approved = false, run = defaultRun, fetchImpl = fetch, log = console.log, tempRoot = tmpdir(), sleep = (ms) => new Promise((done) => setTimeout(done, ms)) } = {}) {
  if (approved !== true) stop('Explicit --deploy-stopped-live approval is required');
  if (Number(process.versions.node.split('.')[0]) < 20) stop('Node 20 or newer is required');
  const identity = run('gcloud', ['projects', 'describe', PROJECT, '--format=value(projectId,projectNumber)']).trim().split(/\s+/);
  if (identity.length !== 2 || identity[0] !== PROJECT || identity[1] !== PROJECT_NUMBER) stop('Project ID/number mismatch');
  const apis = run('gcloud', ['services', 'list', '--enabled', `--project=${PROJECT}`, '--format=value(config.name)']).trim().split(/\s+/);
  if (!apis.includes('firebasehosting.googleapis.com')) stop('Hosting API is not enabled. No API was enabled.');
  const base = mkdtempSync(join(tempRoot, 'garden-maintenance-'));
  const tooling = join(base, 'tooling'), bundle = join(base, 'bundle');
  mkdirSync(tooling); mkdirSync(bundle); writeBundle(bundle); checkBundle(bundle);
  log('Project verified. Preparing the reviewed Firebase CLI locally.');
  for (const [name, sha] of Object.entries(DEPENDENCIES)) {
    const { bytes } = await download(`https://raw.githubusercontent.com/fabdemnt-dev/wa-awesome/${DEPENDENCY_REVISION}/${name}`, fetchImpl, 2 * 1024 * 1024);
    if (hash(bytes) !== sha) stop('Pinned dependency manifest checksum mismatch');
    writeFileSync(join(tooling, name), bytes, { mode: 0o600 });
  }
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], tooling, true);
  const firebase = join(tooling, 'node_modules/.bin/firebase');
  if (run(firebase, ['--version'], tooling).trim() !== '14.27.0') stop('Pinned CLI version mismatch');
  const cliRaw = (args) => run(firebase, [...args, '--config', join(bundle, CONFIG_FILE), '--project', PROJECT, '--non-interactive', '--json'], tooling);
  const cli = (args) => jsonResult(cliRaw(args));
  const channels = () => liveChannel(cli(['hosting:channel:list', '--site', PROJECT]));
  let before;
  if (!sitePresent(cli(['hosting:sites:list']))) {
    log('Creating only the dedicated garden Hosting site.');
    const created = cli(['hosting:sites:create', PROJECT]);
    if (!siteNames.includes(created.name) || created.defaultUrl !== ORIGIN) stop('Created site identity could not be verified; inspect before continuing');
    // Firebase documents that a new site may take several minutes to propagate.
    // Retry only read-only inventory calls after the create response is verified.
    // Never retry create/deploy; malformed or mismatched identities fail closed.
    for (let attempt = 0; attempt <= 12; attempt++) {
      let rawInventory;
      try { rawInventory = cliRaw(['hosting:sites:list']); } catch { /* Read-only transient failure. */ }
      const inventory = rawInventory === undefined ? null : jsonResult(rawInventory);
      if (inventory && sitePresent(inventory)) {
        let rawChannels;
        try { rawChannels = cliRaw(['hosting:channel:list', '--site', PROJECT]); } catch { /* Read-only propagation failure. */ }
        const listed = rawChannels === undefined ? null : jsonResult(rawChannels);
        if (listed && !(Array.isArray(listed.channels) && listed.channels.length === 0)) before = liveChannel(listed);
        if (before) break;
      }
      if (attempt === 12) stop('New site is not readable yet. Creation was not retried; inspect this exact site before continuing.');
      if (attempt === 0) log('Waiting up to three minutes for the new site to become readable. Only inventory reads are retried.');
      await sleep(15000);
    }
  } else before = channels();
  if (before?.release) {
    releaseVersion(before); await verifyPage(fetchImpl);
    log(`Already present: ${ORIGIN}. Known maintenance marker, root, 404 and old entry are verified. No deployment performed; the full existing release inventory was not audited.`);
    return { origin: ORIGIN, deployed: false, existingReleaseInventoryVerified: false };
  }
  // Metadata commands run outside the bundle; no .firebase/debug/log additions
  // can silently expand the reviewed upload. Recheck immediately before deploy.
  checkBundle(bundle);
  log('Publishing the stopped static page to the dedicated garden live site.');
  const result = cli(['deploy', '--only', `hosting:${PROJECT}`, '--message', MESSAGE]);
  if (typeof result.hosting !== 'string') stop('Deployment result was not recognized; no automatic retry');
  const after = channels();
  if (releaseVersion(after) !== canonicalVersionName(result.hosting)) stop('Live release does not match this deployment; inspect before retrying');
  await verifyPage(fetchImpl);
  log(`Verified: ${ORIGIN} (maintenance only, no page expiry).`);
  log('Stop here. This page makes no Auth or game requests. No backend deployment was performed. Share only this URL and the Verified line; never debug logs or credentials.');
  return { origin: ORIGIN, deployed: true };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.length || (args.length === 1 && args[0] === '--plan')) {
    console.log(`Target: ${PROJECT} / ${PROJECT_NUMBER}\nURL: ${ORIGIN}\nPublishes only a stopped static page, with no page expiry.\nThe separate game trial still has a 7-day / 20-room / 2-tester limit.\nLocal preparation downloads checksum-pinned manifests and installs official Firebase CLI14.27.0 using npm ci --ignore-scripts.\nCloud changes: create this Hosting site only if missing; publish only when no live release exists. A recognized maintenance release is checked read-only at root/404/old entry; its full file inventory is not audited.\nNo API enablement, authentication flow, Auth-domain synchronization, IAM, secret, Rules or Functions changes.\nRun only after approval: node deploy-floating-garden-maintenance.mjs --deploy-stopped-live`);
  } else if (args.length === 1 && args[0] === '--deploy-stopped-live') {
    process.umask(0o077);
    try { await deployMaintenance({ approved: true }); }
    catch (error) { console.error(`STOP: ${error.message}`); process.exitCode = 1; }
  } else { console.error('STOP: use --plan or the specifically approved --deploy-stopped-live'); process.exitCode = 1; }
}

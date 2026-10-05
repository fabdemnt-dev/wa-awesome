// Local, dependency-injected provider transport. There is no CLI, ADC discovery,
// default network client, resource creation fallback, IAM mutation or write retry.
// A source-only Function PATCH preserves requested configuration; the provider
// may still apply managed runtime patches. It does not pin a runtime image.
// Production wiring is deliberately absent; the caller must supply a reviewed
// durable journal and a fresh closed-gate/approval check in beforeMutation.
// Provider contracts (reviewed 2026-10-05):
// https://cloud.google.com/functions/docs/reference/rest/v2/projects.locations.functions/generateUploadUrl
// https://cloud.google.com/functions/docs/reference/rest/v2/projects.locations.functions/patch
// https://firebase.google.com/docs/reference/rules/rest/v1/projects.releases/patch
// https://firebase.google.com/docs/hosting/api-deploy
// https://firebase.google.com/docs/reference/hosting/rest/v1beta1/sites.versions.files/list
// https://cloud.google.com/storage/docs/xml-api/reference-headers#xgooggeneration
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { readOperationPacket, verifyOperationPacket } from './operate-floating-garden-trial.mjs';
import { FUNCTION_NAMES } from './prepare-floating-garden-trial.mjs';

export const TRANSPORT_SCOPE = Object.freeze({ project: 'wa-awesome-garden-stg', projectNumber: '120030709276', region: 'asia-northeast1', site: 'wa-awesome-garden-stg' });
const { project, region, site } = TRANSPORT_SCOPE;
const CF = 'https://cloudfunctions.googleapis.com/v2/';
const RULES = 'https://firebaserules.googleapis.com/v1/';
const HOSTING = 'https://firebasehosting.googleapis.com/v1beta1/';
const parent = `projects/${project}/locations/${region}`;
const releaseName = `projects/${project}/releases/cloud.firestore`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const HEX = /^[a-f0-9]{64}$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const failures = new WeakMap();
const REASONS = new Set(['input', 'packet', 'url', 'response', 'http', 'network', 'timeout', 'operation-failed', 'already-attempted', 'halted', 'authorization', 'gate', 'read', 'drift', 'hosting-inventory', 'source-generation']);
function failure(reason, kind = 'failed', httpStatus) {
  const safeReason = REASONS.has(reason) ? reason : 'response';
  const error = new Error(`Garden provider transport stopped: ${safeReason}. No automatic retry.`);
  failures.set(error, Object.freeze({ kind, reason: safeReason, ...(Number.isInteger(httpStatus) ? { httpStatus } : {}) }));
  return error;
}
export function describeTransportFailure(error) { return failures.get(error) ?? Object.freeze({ kind: 'unknown', reason: 'network' }); }
function need(condition, reason = 'input') { if (!condition) throw failure(reason); }
function dataName(value, pattern) { need(typeof value === 'string' && pattern.test(value), 'response'); return value; }
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
// Canonical ZIP: stored entries, deterministic DOS timestamp, UTF-8 names, no
// subprocess, extras, links, descriptors or unreviewed node_modules entries.
export function createSourceZip(files) {
  need(plain(files) && Object.keys(files).length > 0 && Object.keys(files).length <= 128);
  const locals = [], central = []; let offset = 0, total = 0;
  for (const name of Object.keys(files).sort()) {
    need(/^[A-Za-z0-9_./-]+$/.test(name) && !name.startsWith('/') && !name.split('/').some(part => !part || part === '.' || part === '..'));
    const bytes = Buffer.from(files[name]); const filename = Buffer.from(name); const crc = crc32(bytes);
    need(bytes.length <= 4 * 1024 * 1024 && (total += bytes.length) <= 16 * 1024 * 1024);
    const local = Buffer.alloc(30), entry = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8);
    entry.writeUInt16LE(0x21, 14); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(bytes.length, 20); entry.writeUInt32LE(bytes.length, 24); entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(local, filename, bytes); central.push(entry, filename); offset += local.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const prepared = new WeakMap();
export async function prepareActiveUpdatePayload(packet) {
  try {
    need(plain(packet) && typeof packet.output === 'string', 'packet');
    const current = (await readOperationPacket(packet.output)).packet;
    need(current.manifestDigest === packet.manifestDigest && isDeepStrictEqual(current.manifest, packet.manifest), 'packet');
    const files = {}, publicFiles = {};
    for (const name of Object.keys(current.manifest.files).sort()) {
      if (name.startsWith('game/functions/') || name.startsWith('game/public/')) {
        const bytes = await readFile(join(current.output, name)); need(sha(bytes) === current.manifest.files[name], 'packet');
        if (name.startsWith('game/functions/')) files[name.slice('game/functions/'.length)] = bytes;
        else publicFiles[`/${name.slice('game/public/'.length)}`] = bytes;
      }
    }
    need(files['package.json'] && files['package-lock.json'] && files['index.js'] && Object.keys(publicFiles).length, 'packet');
    const configBytes = await readFile(join(current.gameDir, 'firebase.hosting-only.json'));
    need(sha(configBytes) === current.manifest.files['game/firebase.hosting-only.json'], 'packet');
    const config = JSON.parse(configBytes.toString('utf8'));
    const h = config.hosting;
    need(plain(h) && h.site === site && h.public === 'public' && isDeepStrictEqual(Object.keys(h).sort(), ['headers', 'ignore', 'public', 'redirects', 'site']) &&
      isDeepStrictEqual(h.ignore, ['**/.*', '**/node_modules/**']) && Array.isArray(h.headers) && Array.isArray(h.redirects), 'packet');
    const headers = h.headers.map(row => {
      need(plain(row) && isDeepStrictEqual(Object.keys(row).sort(), ['headers', 'source']) && row.source === '**' && Array.isArray(row.headers), 'packet');
      const values = {};
      for (const header of row.headers) { need(plain(header) && typeof header.key === 'string' && typeof header.value === 'string' && /^[A-Za-z0-9-]+$/.test(header.key) && !/[\r\n]/.test(header.value) && !Object.hasOwn(values, header.key), 'packet'); values[header.key] = header.value; }
      return { glob: row.source, headers: values };
    });
    const redirects = h.redirects.map(row => {
      need(isDeepStrictEqual(row, { source: '/', destination: '/lab/floating-garden/trial/index.html', type: 302 }), 'packet');
      return { glob: row.source, location: row.destination, statusCode: row.type };
    });
    const rulesBytes = await readFile(join(current.gameDir, 'firestore.rules'));
    need(sha(rulesBytes) === current.manifest.files['game/firestore.rules'], 'packet');
    const rules = rulesBytes.toString('utf8');
    const compressed = {}, fileHashes = {};
    for (const [path, bytes] of Object.entries(publicFiles)) { const gzip = gzipSync(bytes, { level: 9 }); const hash = sha(gzip); compressed[hash] = gzip; fileHashes[path] = hash; }
    await verifyOperationPacket(current);
    const zip = createSourceZip(files);
    const payload = Object.freeze({ manifestDigest: current.manifestDigest, sourceDigest: sha(zip), fileCount: Object.keys(fileHashes).length });
    prepared.set(payload, { packet: current, zip, rules, config: { headers, redirects }, compressed, fileHashes });
    return payload;
  } catch (error) { if (failures.has(error)) throw error; throw failure('packet'); }
}
function checkedPayload(value) { const result = prepared.get(value); need(result, 'packet'); return result; }

function strictURL(raw) {
  need(typeof raw === 'string' && raw.length <= 16384 && !/[\s\\\u0000-\u001f]/.test(raw), 'url');
  let value; try { value = new URL(raw); } catch { throw failure('url'); }
  need(value.protocol === 'https:' && !value.username && !value.password && !value.port && !value.hash && value.href === raw, 'url');
  need(!/%(?:2f|5c|2e|00)/i.test(value.pathname) && !value.pathname.split('/').some(part => part === '.' || part === '..'), 'url');
  return value;
}
function storageSource(value) {
  need(plain(value) && Object.keys(value).every(key => ['bucket', 'object', 'generation'].includes(key)), 'response');
  need(typeof value.bucket === 'string' && /^gcf-v2-uploads-120030709276-asia-northeast1$/.test(value.bucket), 'response');
  need(typeof value.object === 'string' && /^[A-Za-z0-9][A-Za-z0-9_./-]{0,1023}\.zip$/.test(value.object) && !value.object.split('/').some(part => !part || part === '.' || part === '..'), 'response');
  need(value.generation === undefined || typeof value.generation === 'string' && /^(0|[1-9][0-9]*)$/.test(value.generation), 'response');
  return structuredClone(value);
}
function uploadURL(raw, source) {
  const url = strictURL(raw);
  need(url.hostname === 'storage.googleapis.com' && url.pathname === `/${source.bucket}/${source.object}` && url.search.length > 1, 'url');
  return url.href;
}
function versionName(name) { return dataName(name, new RegExp(`^sites/${site}/versions/[A-Za-z0-9_-]{1,128}$`)); }
function rulesetName(name) { return dataName(name, new RegExp(`^projects/${project}/rulesets/[A-Za-z0-9_-]{1,128}$`)); }
function operationName(name) { return dataName(name, new RegExp(`^projects/${project}/locations/${region}/operations/[A-Za-z0-9_-]{1,200}$`)); }

/** request receives an explicit auth mode; never attach Google credentials to
 * signed upload hosts. Return {status, body, headers}; headers is a plain object
 * of string values, including x-goog-generation for source PUT. Never redirect/retry,
 * and must obey timeoutMillis. Provider bodies/exception text are never logged.
 * Each phase requires beforeMutation, which runs before EVERY POST/PATCH/PUT and must freshly
 * verify the gate is closed plus bounded owner approval/journal authorization.
 * This is a one-shot in-memory capability, NOT a cross-process lock or CAS. */
export function createActiveUpdateTransport({ request, now, clock, wait, requestTimeoutMillis = 30000, operationTimeoutMillis = 600000, pollMillis = 1000 } = {}) {
  need(typeof request === 'function' && typeof (now ?? clock) === 'function' && typeof wait === 'function');
  need([requestTimeoutMillis, operationTimeoutMillis, pollMillis].every(x => Number.isSafeInteger(x) && x > 0) && requestTimeoutMillis <= 120000 && operationTimeoutMillis <= 3600000 && pollMillis <= operationTimeoutMillis);
  const time = now ?? clock; const attempted = new Set(); let halted = false, uploaded, boundDigest, context, busy = false, lastStage = 'input';
  const expectedFunctions = new Map(), completedFunctionNames = [];
  // These are observed-baseline checks, never provider-side CAS. The published
  // Functions/Rules/Hosting write contracts expose no atomic precondition here.
  async function checkBaseline() {
    if (!context) return;
    if (context.kind === 'functions') {
      for (const name of FUNCTION_NAMES) {
        const actual = await send(CF + `${parent}/functions/${name}`);
        need(isDeepStrictEqual(actual, expectedFunctions.get(name)), 'drift');
      }
    } else if (context.kind === 'rules') {
      need(isDeepStrictEqual(await send(RULES + releaseName), context.baseline.rules.release), 'drift');
    } else if (context.kind === 'hosting') {
      const channel = await send(HOSTING + `sites/${site}/channels/live`);
      need(channel?.name === `sites/${site}/channels/live` && channel?.release?.version?.name === context.baseline.hosting.version && channel?.release?.message === context.baseline.hosting.marker, 'drift');
    }
  }
  function bind(payload) { const value = checkedPayload(payload); need(boundDigest === undefined || boundDigest === payload.manifestDigest, 'packet'); boundDigest = payload.manifestDigest; return value; }
  async function send(url, { method = 'GET', body, auth = 'google', headers = {}, stage = 'read', includeResponseHeaders = false } = {}) {
    const parsed = strictURL(url);
    if (auth === 'google') need([new URL(CF).origin, new URL(RULES).origin, new URL(HOSTING).origin, 'https://upload-firebasehosting.googleapis.com'].includes(parsed.origin), 'url');
    else need(auth === 'none' && !Object.keys(headers).some(key => /authorization|cookie/i.test(key)), 'url');
    const write = method !== 'GET';
    if (write) {
      need(!halted, 'halted'); need(!attempted.has(stage), 'already-attempted');
      lastStage = stage.startsWith('function:') ? 'function-patch' : stage.startsWith('hosting-file:') ? 'hosting-file-upload' : stage;
      await checkBaseline();
      let approval;
      const index = stage.startsWith('function:') ? FUNCTION_NAMES.indexOf(stage.slice('function:'.length)) : 0;
      try {
        if (context) { const result = await context.beforeMutation({ stage: lastStage, resourceKind: context.kind, index, completedFunctionNames: [...completedFunctionNames] }); approval = result !== false; }
      } catch { throw failure('authorization'); }
      need(approval === true, 'authorization'); attempted.add(stage);
    }
    let response;
    try { response = await request({ url, method, headers: { ...(body !== undefined && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers }, body, auth, redirect: 'error', timeoutMillis: requestTimeoutMillis }); }
    catch (error) { if (write) halted = true; throw failure(describeTransportFailure(error).reason === 'timeout' ? 'timeout' : 'network', write ? 'unknown' : 'failed'); }
    if (!plain(response) || !Number.isInteger(response.status) || response.status < 100 || response.status > 599 || response.redirected === true) { if (write) halted = true; throw failure('response', write ? 'unknown' : 'failed'); }
    if (response.status < 200 || response.status >= 300) {
      if (write) halted = true;
      // Request timeout, server faults and redirects cannot prove no effect.
      const unknown = write && (response.status >= 500 || response.status === 408 || response.status >= 300 && response.status < 400);
      throw failure('http', unknown ? 'unknown' : 'failed', response.status);
    }
    return includeResponseHeaders ? { body: response.body, headers: response.headers } : response.body;
  }
  async function mutation(action) {
    try { need(!halted, 'halted'); return Object.freeze({ kind: 'success', ...await action() }); }
    catch (error) { const diagnostic = describeTransportFailure(error); if (diagnostic.kind === 'unknown' || attempted.size > 0) halted = true; return Object.freeze({ ...diagnostic, stage: lastStage }); }
  }
  async function awaitOperation(initial, expectedFunction) {
    let op = initial, name;
    try { name = operationName(op?.name); } catch { halted = true; throw failure('response', 'unknown'); }
    const start = time(); need(Number.isSafeInteger(start), 'input'); let prior = start;
    for (;;) {
      if (!plain(op) || op.name !== name || typeof op.done !== 'boolean' && op.done !== undefined || op.error && op.response) { halted = true; throw failure('response', 'unknown'); }
      if (op.done === true) {
        if (op.error) { halted = true; throw failure('operation-failed', 'failed'); }
        if (!plain(op.response) || op.response.name !== expectedFunction) { halted = true; throw failure('response', 'unknown'); }
        return { operation: name, functionName: expectedFunction };
      }
      const current = time();
      if (!Number.isSafeInteger(current) || current < prior || current - start >= operationTimeoutMillis) { halted = true; throw failure('timeout', 'unknown'); }
      prior = current;
      await wait(Math.min(pollMillis, operationTimeoutMillis - (current - start)));
      try { op = await send(CF + name); } catch { halted = true; throw failure('read', 'unknown'); }
    }
  }
  async function ensureSource(payload) {
    if (uploaded) return uploaded;
    const content = bind(payload);
    const response = await send(CF + parent + '/functions:generateUploadUrl', { method: 'POST', body: { environment: 'GEN_2' }, stage: 'functions-source-url' });
    let source, url;
    try { source = storageSource(response?.storageSource); url = uploadURL(response?.uploadUrl, source); }
    catch { halted = true; throw failure('response', 'unknown'); }
    const upload = await send(url, { method: 'PUT', auth: 'none', headers: { 'Content-Type': 'application/zip' }, body: Buffer.from(content.zip), stage: 'functions-source-upload', includeResponseHeaders: true });
    // Cloud Storage XML object upload returns x-goog-generation. Pin the exact
    // uploaded object generation in every PATCH, never the pre-upload default 0.
    const generationHeaders = plain(upload.headers) ? Object.entries(upload.headers).filter(([name]) => name.toLowerCase() === 'x-goog-generation') : [];
    if (generationHeaders.length !== 1 || typeof generationHeaders[0][1] !== 'string' || !/^[1-9][0-9]*$/.test(generationHeaders[0][1])) { halted = true; throw failure('source-generation', 'unknown'); }
    uploaded = { ...source, generation: generationHeaders[0][1] }; return uploaded;
  }
  async function updateFunctionSource({ payload, name } = {}) {
    return mutation(async () => {
      need(FUNCTION_NAMES.includes(name)); bind(payload);
      need(!attempted.has(`function:${name}`), 'already-attempted');
      const source = await ensureSource(payload), resource = `${parent}/functions/${name}`;
      const op = await send(CF + resource + '?updateMask=buildConfig.source', { method: 'PATCH', stage: `function:${name}`, body: { name: resource, buildConfig: { source: { storageSource: source } } } });
      const outcome = await awaitOperation(op, resource);
      if (context) {
        let current; try { current = await send(CF + resource); } catch { halted = true; throw failure('read', 'unknown'); }
        if (current?.name !== resource || current?.state !== 'ACTIVE') { halted = true; throw failure('response', 'unknown'); }
        expectedFunctions.set(name, structuredClone(current)); completedFunctionNames.push(name);
      }
      return outcome;
    });
  }
  async function updateRules({ payload } = {}) {
    return mutation(async () => {
      const content = bind(payload); need(!attempted.has('rules-create'), 'already-attempted');
      // Existing release is mandatory. A 404 never switches to create-release.
      const existing = await send(RULES + releaseName); need(existing?.name === releaseName, 'response'); rulesetName(existing?.rulesetName);
      const created = await send(RULES + `projects/${project}/rulesets`, { method: 'POST', stage: 'rules-create', body: { source: { files: [{ name: 'firestore.rules', content: content.rules }] } } });
      let name; try { name = rulesetName(created?.name); } catch { halted = true; throw failure('response', 'unknown'); }
      const released = await send(RULES + releaseName, { method: 'PATCH', stage: 'rules-release', body: { release: { name: releaseName, rulesetName: name }, updateMask: 'rulesetName' } });
      if (released?.name !== releaseName || released?.rulesetName !== name) { halted = true; throw failure('response', 'unknown'); }
      let actual; try { actual = await send(RULES + releaseName); } catch { halted = true; throw failure('read', 'unknown'); }
      if (actual?.name !== releaseName || actual?.rulesetName !== name) { halted = true; throw failure('read', 'unknown'); }
      return { releaseName, rulesetName: name, pointerVerified: true, propagationVerified: false };
    });
  }
  async function verifyHostingInventory(name, content, expectedStatus) {
    lastStage = 'hosting-inventory';
    try {
      const version = await send(HOSTING + name);
      need(version?.name === name && version?.status === expectedStatus && isDeepStrictEqual(version?.config, content.config), 'hosting-inventory');
      for (const status of ['ACTIVE', 'EXPECTED']) {
        const seen = new Set(), tokens = new Set(); let token;
        for (let page = 0; ; page++) {
          need(page < 129, 'hosting-inventory');
          const value = await send(HOSTING + name + `/files?status=${status}&pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`);
          need(plain(value) && (value.files === undefined || Array.isArray(value.files)), 'hosting-inventory');
          const files = value.files ?? [];
          need(files.length <= 128 && (status !== 'EXPECTED' || files.length === 0), 'hosting-inventory');
          for (const file of files) {
            need(plain(file) && typeof file.path === 'string' && Object.hasOwn(content.fileHashes, file.path) && !seen.has(file.path) && file.status === 'ACTIVE' && file.hash === content.fileHashes[file.path], 'hosting-inventory');
            seen.add(file.path);
          }
          const next = value.nextPageToken;
          if (next === undefined || next === '') break;
          need(typeof next === 'string' && next.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(next) && !tokens.has(next), 'hosting-inventory');
          tokens.add(next); token = next;
        }
        need(status !== 'ACTIVE' || seen.size === Object.keys(content.fileHashes).length, 'hosting-inventory');
      }
    } catch { halted = true; throw failure('hosting-inventory', 'unknown'); }
  }
  async function updateHosting({ payload } = {}) {
    return mutation(async () => {
      const content = bind(payload); need(!attempted.has('hosting-create'), 'already-attempted');
      const created = await send(HOSTING + `sites/${site}/versions`, { method: 'POST', stage: 'hosting-create', body: { config: structuredClone(content.config) } });
      let name; try { name = versionName(created?.name); need(created.status === 'CREATED', 'response'); } catch { halted = true; throw failure('response', 'unknown'); }
      const populated = await send(HOSTING + name + ':populateFiles', { method: 'POST', stage: 'hosting-populate', body: { files: { ...content.fileHashes } } });
      let base, required;
      try {
        need(plain(populated), 'response');
        required = populated.uploadRequiredHashes ?? [];
        need(Array.isArray(required) && required.length <= Object.keys(content.compressed).length && new Set(required).size === required.length && required.every(hash => HEX.test(hash) && Object.hasOwn(content.compressed, hash)), 'response');
        base = strictURL(populated.uploadUrl); need(base.origin === 'https://upload-firebasehosting.googleapis.com' && base.pathname === `/upload/${name}/files` && !base.search, 'url');
      } catch { halted = true; throw failure('response', 'unknown'); }
      for (const hash of required) await send(`${base.href}/${hash}`, { method: 'POST', auth: 'google', stage: `hosting-file:${hash}`, headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from(content.compressed[hash]) });
      await verifyHostingInventory(name, content, 'CREATED');
      const finalized = await send(HOSTING + name + '?updateMask=status', { method: 'PATCH', stage: 'hosting-finalize', body: { status: 'FINALIZED' } });
      if (finalized?.name !== name || finalized?.status !== 'FINALIZED') { halted = true; throw failure('response', 'unknown'); }
      await verifyHostingInventory(name, content, 'FINALIZED');
      const released = await send(HOSTING + `sites/${site}/releases?versionName=${name}`, { method: 'POST', stage: 'hosting-release', body: { message: `garden-trial-game-v1:${payload.manifestDigest}` } });
      if (released?.version?.name !== name || released?.message !== `garden-trial-game-v1:${payload.manifestDigest}` || typeof released?.name !== 'string' || !new RegExp(`^sites/${site}/releases/[A-Za-z0-9_-]{1,200}$`).test(released.name)) { halted = true; throw failure('response', 'unknown'); }
      return { versionName: name, releaseName: released.name };
    });
  }
  async function facade(kind, args) {
    if (busy) return Object.freeze({ kind: 'failed', reason: 'already-attempted', stage: 'input' });
    busy = true;
    try {
      need(!halted, 'halted');
      need(plain(args) && typeof args.beforeMutation === 'function' && plain(args.baseline) && plain(args.previous) && plain(args.next));
      await verifyOperationPacket(args.previous.packet);
      const payload = await prepareActiveUpdatePayload(args.next.packet);
      if (kind === 'functions') {
        need(Array.isArray(args.baseline.functions) && args.baseline.functions.length === FUNCTION_NAMES.length);
        for (const name of FUNCTION_NAMES) {
          const item = args.baseline.functions.find(item => item.function?.name === `${parent}/functions/${name}`);
          need(item?.function?.state === 'ACTIVE'); expectedFunctions.set(name, structuredClone(item.function));
        }
      }
      context = { kind, baseline: args.baseline, beforeMutation: args.beforeMutation };
      if (kind === 'rules') return await updateRules({ payload });
      if (kind === 'hosting') return await updateHosting({ payload });
      const outcomes = [];
      for (const name of FUNCTION_NAMES) { const result = await updateFunctionSource({ payload, name }); outcomes.push(result); if (result.kind !== 'success') return Object.freeze({ ...result, completedFunctionCount: outcomes.filter(x => x.kind === 'success').length }); }
      return Object.freeze({ kind: 'success', functionCount: outcomes.length });
    } catch (error) { if (attempted.size > 0) halted = true; return Object.freeze({ ...describeTransportFailure(error), stage: lastStage }); }
    finally { context = undefined; busy = false; }
  }
  return Object.freeze({ functions: args => facade('functions', args), rules: args => facade('rules', args), hosting: args => facade('hosting', args),
    readFunction: name => { need(FUNCTION_NAMES.includes(name)); return send(CF + `${parent}/functions/${name}`); },
    readRulesRelease: () => send(RULES + releaseName),
    readHostingVersion: name => send(HOSTING + versionName(name)),
  });
}

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
function bridgeURL(call) {
  need(plain(call) && ['GET', 'POST', 'PUT', 'PATCH'].includes(call.method) && call.redirect === 'error' && Number.isSafeInteger(call.timeoutMillis) && call.timeoutMillis > 0 && call.timeoutMillis <= 120000);
  const url = strictURL(call.url), path = url.pathname;
  need(plain(call.headers) && !Object.keys(call.headers).some(key => /authorization|cookie|proxy-authorization/i.test(key)), 'url');
  if (call.auth === 'none') {
    need(call.method === 'PUT' && url.origin === 'https://storage.googleapis.com' && path.startsWith(`/gcf-v2-uploads-120030709276-${region}/`) && url.search && Buffer.isBuffer(call.body) && call.body.length <= 17 * 1024 * 1024 && isDeepStrictEqual(call.headers, { 'Content-Type': 'application/zip' }), 'url');
    return;
  }
  need(call.auth === 'google', 'url');
  if (url.origin === new URL(CF).origin) {
    const fn = FUNCTION_NAMES.some(name => path === `/v2/${parent}/functions/${name}`);
    const operation = new RegExp(`^/v2/${parent}/operations/[A-Za-z0-9_-]{1,200}$`).test(path);
    need(fn && (call.method === 'GET' && !url.search || call.method === 'PATCH' && url.search === '?updateMask=buildConfig.source') || operation && call.method === 'GET' && !url.search || path === `/v2/${parent}/functions:generateUploadUrl` && call.method === 'POST' && !url.search, 'url');
  } else if (url.origin === new URL(RULES).origin) {
    need(!url.search && (path === `/v1/${releaseName}` && ['GET', 'PATCH'].includes(call.method) || path === `/v1/projects/${project}/rulesets` && call.method === 'POST'), 'url');
  } else if (url.origin === new URL(HOSTING).origin) {
    const base = `/v1beta1/sites/${site}`, version = new RegExp(`^${base}/versions/[A-Za-z0-9_-]{1,128}$`).test(path);
    const files = new RegExp(`^${base}/versions/[A-Za-z0-9_-]{1,128}/files$`).test(path);
    const populate = new RegExp(`^${base}/versions/[A-Za-z0-9_-]{1,128}:populateFiles$`).test(path);
    const params = [...url.searchParams.keys()];
    need(path === `${base}/channels/live` && call.method === 'GET' && !url.search || path === `${base}/versions` && call.method === 'POST' && !url.search || version && (call.method === 'GET' && !url.search || call.method === 'PATCH' && url.search === '?updateMask=status') ||
      populate && call.method === 'POST' && !url.search || files && call.method === 'GET' && params.every(key => ['status', 'pageSize', 'pageToken'].includes(key)) && new Set(params).size === params.length && ['ACTIVE', 'EXPECTED'].includes(url.searchParams.get('status')) && url.searchParams.get('pageSize') === '1000' ||
      path === `${base}/releases` && call.method === 'POST' && isDeepStrictEqual(params, ['versionName']) && new RegExp(`^sites/${site}/versions/[A-Za-z0-9_-]{1,128}$`).test(url.searchParams.get('versionName')), 'url');
  } else if (url.origin === 'https://upload-firebasehosting.googleapis.com') {
    need(call.method === 'POST' && !url.search && new RegExp(`^/upload/sites/${site}/versions/[A-Za-z0-9_-]{1,128}/files/[a-f0-9]{64}$`).test(path) && Buffer.isBuffer(call.body), 'url');
  } else throw failure('url');
}

/** Explicit network bridge for the already-approved execution path ONLY.
 * Construction is inert: no default fetch, SDK construction, ADC lookup, token
 * extraction, credential mutation or request occurs here.
 * Audited against pinned google-auth-library 9.15.1 / Gaxios 6.7.1: OAuth2Client
 * and BaseExternalAccountClient replay only from their error-response catch.
 * validateStatus accepts every HTTP status, including 401/403, so those responses
 * never trigger auth-refresh replay. retryConfig disables Gaxios retries even if
 * the injected client's defaults enabled them. Token acquisition before the
 * provider request can still refresh existing credentials; no provider mutation
 * is retried. Preserve these options when upgrading the separately pinned SDK.
 */
export function createActiveUpdateRequest({ requestClient, fetchImpl, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  need(requestClient && typeof requestClient.request === 'function' && typeof fetchImpl === 'function' && typeof setTimer === 'function' && typeof clearTimer === 'function');
  return async function request(call) {
    bridgeURL(call);
    const controller = new AbortController(); let timer;
    const deadline = new Promise((_, reject) => { timer = setTimer(() => { controller.abort(); reject(failure('timeout', 'unknown')); }, call.timeoutMillis); });
    async function once() {
      if (call.auth === 'none') {
        const response = await fetchImpl(call.url, { method: 'PUT', headers: { ...call.headers }, body: Buffer.from(call.body), redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
        need(response && Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 && response.redirected !== true && (!response.url || response.url === call.url), 'response');
        // The PUT's body is never needed. Do not load arbitrary XML/provider
        // diagnostics into memory; only the bounded generation header is used.
        const generation = response.headers?.get?.('x-goog-generation');
        const headers = typeof generation === 'string' && generation.length <= 32 ? { 'x-goog-generation': generation } : {};
        if (response.body?.cancel) await response.body.cancel();
        return { status: response.status, headers };
      }
      const result = await requestClient.request({ url: call.url, method: call.method, data: call.body, headers: { ...call.headers },
        retry: false, retryConfig: { retry: 0, noResponseRetries: 0, httpMethodsToRetry: [] }, maxRedirects: 0, redirect: 'error',
        validateStatus: () => true, timeout: call.timeoutMillis, signal: controller.signal,
        responseType: 'arraybuffer', maxContentLength: MAX_RESPONSE_BYTES, maxBodyLength: 17 * 1024 * 1024 });
      need(result && Number.isInteger(result.status) && result.status >= 100 && result.status <= 599, 'response');
      // Error bodies are unnecessary and must never cross the boundary.
      if (result.status < 200 || result.status >= 300) return { status: result.status, headers: {} };
      need(result.data === undefined || typeof result.data === 'string' || Buffer.isBuffer(result.data) || result.data instanceof ArrayBuffer || ArrayBuffer.isView(result.data), 'response');
      const bytes = result.data === undefined ? Buffer.alloc(0) : ArrayBuffer.isView(result.data) ? Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength) : Buffer.from(result.data);
      need(bytes.length <= MAX_RESPONSE_BYTES, 'response');
      // Hosting's raw gzip upload promises HTTP success, not a JSON response.
      // Exact ACTIVE/EXPECTED inventory is independently proved by the caller.
      if (new URL(call.url).origin === 'https://upload-firebasehosting.googleapis.com') return { status: result.status, headers: {} };
      let body;
      if (bytes.length) { try { body = JSON.parse(bytes.toString('utf8')); } catch { throw failure('response', 'unknown'); } }
      return { status: result.status, body, headers: {} };
    }
    try { return await Promise.race([once(), deadline]); }
    catch (error) { if (failures.has(error)) throw error; throw failure('network', 'unknown'); }
    finally { clearTimer(timer); }
  };
}

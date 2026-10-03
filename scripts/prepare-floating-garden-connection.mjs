#!/usr/bin/env node
// Purely local generator. All deployable bytes are embedded in one standalone
// operator helper; generation never fetches source, runs commands, or deploys.
import { lstatSync, readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HTML, CONFIG } from './deploy-floating-garden-maintenance.mjs';
import { hostingConfig, runtimeSource, validatePayload, writeBundle, checkBundle, hash, connectionMessage } from './deploy-floating-garden-connection-template.mjs';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const INPUT_NAMES = ['app.js', 'connection.js', 'index.html', 'style.css'];
const TEMPLATE = fileURLToPath(new URL('./deploy-floating-garden-connection-template.mjs', import.meta.url));
export function buildPayload(source = join(ROOT, 'lab/floating-garden/connection-check')) {
  const stat = lstatSync(source); if (realpathSync(source) !== resolve(source) || !stat.isDirectory() || stat.isSymbolicLink()) throw Error('Source must be a regular directory.');
  if (JSON.stringify(readdirSync(source).sort()) !== JSON.stringify(INPUT_NAMES)) throw Error('Source must contain exactly the four reviewed connection client files.');
  const connectionFiles = {};
  for (const name of INPUT_NAMES) {
    const path = join(source, name), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw Error('Unsafe client source file.');
    const bytes = readFileSync(path), text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) throw Error('Client source must be valid UTF-8.');
    connectionFiles[name] = text;
  }
  connectionFiles['connection-runtime.js'] = runtimeSource();
  return validatePayload({ schemaVersion: 1, maintenanceHtml: HTML, maintenanceConfig: CONFIG, connectionFiles, connectionConfig: `${JSON.stringify(hostingConfig(), null, 2)}\n` });
}
export function renderHelper(payload) {
  validatePayload(payload);
  const template = readFileSync(TEMPLATE, 'utf8');
  const token = '/*__CONNECTION_PAYLOAD__*/ null';
  if (template.split(token).length !== 2) throw Error('Template payload marker must occur once.');
  return template.replace(token, () => JSON.stringify(payload));
}
export function prepareConnection({ output, source } = {}) {
  if (typeof output !== 'string' || !output) throw Error('An explicit fresh output directory outside this repository is required.');
  const destination = resolve(output), repo = realpathSync(ROOT);
  // Resolve the existing parent to reject an output hidden in the checkout via
  // symlink. This generator never writes or overwrites the checkout. Publishing
  // the reviewed standalone helper to source control is a separate explicit step.
  if (existsSync(destination)) throw Error('Output must not already exist.');
  const parent = realpathSync(dirname(destination));
  const resolvedDestination = join(parent, destination.split('/').at(-1));
  const fromRepo = relative(repo, resolvedDestination);
  if (!fromRepo || (fromRepo !== '..' && !fromRepo.startsWith('../') && !fromRepo.startsWith('/'))) throw Error('Generated output must be outside the repository.');
  const payload = buildPayload(source), helper = renderHelper(payload);
  mkdirSync(destination, { mode: 0o700 });
  const bundle = join(destination, 'bundle'); mkdirSync(bundle, { mode: 0o700 });
  writeBundle(bundle, payload); checkBundle(bundle, payload);
  const helperPath = join(destination, 'deploy-floating-garden-connection-check.mjs');
  writeFileSync(helperPath, helper, { mode: 0o600 });
  return { output: destination, helper: helperPath, helperSha256: hash(helper), releaseMessage: connectionMessage(payload), publicFiles: 7 };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.length || args.length === 1 && args[0] === '--plan') console.log('LOCAL_PLAN: read exactly the four connection client files; preserve maintenance root/404 and headers; emit seven public files and one standalone helper into --out FRESH_DIRECTORY outside this repository. No network, subprocess or cloud action.');
  else if (args.length === 2 && args[0] === '--out') {
    try { console.log(JSON.stringify(prepareConnection({ output: args[1] }), null, 2)); } catch (error) { console.error(`STOP: ${error.message}`); process.exitCode = 1; }
  } else { console.error('STOP: use --plan or --out FRESH_DIRECTORY.'); process.exitCode = 1; }
}

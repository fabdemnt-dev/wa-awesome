// Pure file preparation. No emulator processes, network, cloud resources or deploy.
import { readFile, writeFile, mkdir, copyFile, symlink } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareTrialBundle } from '../../scripts/prepare-floating-garden-trial.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export async function prepareTrialEmulator(output, now = Date.now()) {
  const out = resolve(output);
  const projectId = 'demo-floating-garden-trial';
  const ports = { auth: 9099, firestore: 8183, functions: 5103 };
  const runtime = { schemaVersion: 1, enabled: true, projectId: 'wa-garden-ci-trial',
    previewOrigin: 'https://wa-garden-ci-trial--garden-7day-ci0001.web.app',
    startsAtMillis: now - 60000, endsAtMillis: now + 3600000, region: 'asia-northeast1', maxTesters: 2, maxRooms: 20,
    // Syntactically valid inert identifiers. SDK fixture remaps them BEFORE any
    // real SDK app is initialized; no request may use this non-demo project.
    firebase: { projectId: 'wa-garden-ci-trial', authDomain: 'wa-garden-ci-trial.firebaseapp.com', apiKey: `AIza${'Q'.repeat(35)}`, appId: '1:123456789:web:abcdef123456' },
    appCheck: { provider: 'recaptcha-enterprise', siteKey: 'ciOnlyInertAttestationFixture00001', verified: true },
  };
  await prepareTrialBundle({ config: runtime, output: out, now });
  const config = JSON.parse(await readFile(join(out, 'functions/trial-config.json'), 'utf8'));
  const fixture = { kind: 'floating-garden-trial-browser-emulator-only-v1', browserOrigin: 'http://127.0.0.1:8783', projectId, ports, runtime, config,
    boundaries: ['generated production public assets unchanged; actual production entry is verified fail-closed at loopback before SDK/auth/network', 'successful UI flow uses a separate test entry calling unchanged bootstrapTrial with explicit synthetic location injection', 'real SDK Auth/Functions/Firestore connect directly to demo emulators; native browser offline/reload/listeners, no streaming proxy', 'App Check synthetic: no live attestation validation', 'successful production app.js/default-window-location/HTTPS/CORS/App Check path is not validated', 'test Functions entry verifies exact loopback Origin before explicit synthetic trial-Origin adaptation', 'production Functions entry, IAM and Secret Manager not exercised'] };
  const productionHtml = await readFile(join(out, 'public/lab/floating-garden/trial/index.html'), 'utf8');
  const fixtureHtml = productionHtml.replace('<script type="module" src="./app.js"></script>', '<script type="module" src="./emulator-entry.js"></script>');
  if (fixtureHtml === productionHtml) throw new Error('The production HTML entry script was not found; fixture preparation must be reviewed');
  // Keep BOTH fixture assets outside the deployable production public directory.
  // The CI-only HTTP server maps two exact URLs to these files.
  await mkdir(join(out, 'browser-fixture'));
  await writeFile(join(out, 'browser-fixture/index.html'), '<!-- EMULATOR TEST ENTRY: production index.html remains unchanged. -->\n' + fixtureHtml);
  await writeFile(join(out, 'browser-fixture/entry.js'), `// TEST ONLY: explicit bootstrap location seam, not the production app.js entry.\nimport runtime from './trialruntime.js';\nimport { bootstrapTrial } from './bootstrap.js';\nawait bootstrapTrial(document.querySelector('#online-app'), document.querySelector('#trial-status'), runtime, { location: new URL(${JSON.stringify(runtime.previewOrigin + '/lab/floating-garden/trial/index.html')}) });\n`);
  const source = join(out, 'emulator-functions');
  await mkdir(source);
  for (const name of ['trial-handlers.js', 'config.js', 'package.json', 'package-lock.json', 'online/handlers.js', 'online/contract.js', 'online/invite-code.js', 'online/core/engine.js', 'online/core/match-engine.js', 'online/core/package.json']) {
    const destination = join(source, name); await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(out, 'functions', name), destination);
  }
  await copyFile(join(root, 'tests/helpers/floating-garden-trial-functions-fixture.cjs'), join(source, 'index.js'));
  const installed = join(root, 'functions/floating-garden-trial/node_modules');
  // The caller installs pinned trial dependencies before execution. A dangling
  // link is intentional during pure file-only preparation without installed SDKs.
  await symlink(installed, join(source, 'node_modules'), 'dir');
  await writeFile(join(source, 'emulator-fixture.json'), JSON.stringify(fixture, null, 2));
  await writeFile(join(out, 'emulator-fixture.json'), JSON.stringify(fixture, null, 2));
  await writeFile(join(out, 'firebase.emulator.json'), JSON.stringify({
    firestore: { rules: 'firestore.rules', indexes: 'firestore.indexes.json' },
    functions: { source: 'emulator-functions', codebase: 'floating-garden-trial-emulator-fixture' },
    emulators: { ...Object.fromEntries(Object.entries(ports).map(([name, port]) => [name, { host: '127.0.0.1', port }])), ui: { enabled: false }, singleProjectMode: true },
  }, null, 2));
  return { output: out, projectId, boundaries: fixture.boundaries };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node tests/helpers/prepare-floating-garden-trial-emulator.mjs NEW_OUTPUT');
  console.log(JSON.stringify(await prepareTrialEmulator(process.argv[2]), null, 2));
}

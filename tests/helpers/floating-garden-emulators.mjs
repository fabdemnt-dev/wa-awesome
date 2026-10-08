import assert from 'node:assert/strict';

// These suites must fail rather than silently skip or accidentally use a live project.
export function emulatorAddress(value, label) {
  assert.ok(value, `${label} is required. Run the dedicated floating-garden emulator script.`);
  const url = new URL(`http://${value}`);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), `${label} must point to a loopback emulator`);
  assert.ok(Number(url.port) > 0, `${label} must include its emulator port`);
  assert.equal(url.pathname, '/');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  return { host: url.hostname, port: Number(url.port), origin: url.origin };
}

export function emulatorConfig({ authAndFunctions = false } = {}) {
  const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'demo-floating-garden';
  assert.ok(projectId.startsWith('demo-'), 'Floating garden emulator tests require a demo- project; live projects are forbidden');
  const firestore = emulatorAddress(process.env.FIRESTORE_EMULATOR_HOST, 'FIRESTORE_EMULATOR_HOST');
  if (!authAndFunctions) return { projectId, firestore };
  const auth = emulatorAddress(process.env.FIREBASE_AUTH_EMULATOR_HOST, 'FIREBASE_AUTH_EMULATOR_HOST');
  // The CLI exports the Auth/Firestore hosts but not always the Functions host.
  const functions = emulatorAddress(process.env.FUNCTIONS_EMULATOR_HOST || '127.0.0.1:5103', 'FUNCTIONS_EMULATOR_HOST');
  return { projectId, firestore, auth, functions };
}

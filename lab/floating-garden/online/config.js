// Release gate: this implementation is approved for local testing only.
// Deliberately no production Firebase project/config import, fallback, or query-string override.
export const EMULATOR_CONFIG = Object.freeze({ projectId: 'demo-floating-garden', apiKey: 'demo-floating-garden-key', appId: 'demo-floating-garden-app', authDomain: 'demo-floating-garden.firebaseapp.com' });
export const EMULATOR_PORTS = Object.freeze({ auth: 9099, firestore: 8182, functions: 5103 });
export function localTestAllowed(location) { return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location?.hostname) && ['http:', 'https:'].includes(location?.protocol); }

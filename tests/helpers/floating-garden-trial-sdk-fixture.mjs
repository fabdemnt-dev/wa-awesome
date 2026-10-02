// Test-only module facades. Game/app/transport modules are never rewritten.
// Only SDK constructors connect to emulators; all Auth, callable requests,
// transactions, listeners, local persistence and errors are the real SDK behavior.
export function trialSdkFixture(file, { projectId, ports }) {
  if (projectId !== 'demo-floating-garden-trial') throw new Error('Only the isolated demo project is permitted');
  const original = `https://www.gstatic.com/firebasejs/10.8.0/${file}?trial-emulator-original=1`;
  const prelude = `export * from ${JSON.stringify(original)}; import * as real from ${JSON.stringify(original)};\n`;
  if (file === 'firebase-app.js') return prelude + `
    export function initializeApp(options, name) {
      return real.initializeApp({ ...options, projectId: ${JSON.stringify(projectId)},
        apiKey: 'demo-floating-garden-trial-key', authDomain: 'demo-floating-garden-trial.firebaseapp.com' }, name);
    }`;
  if (file === 'firebase-auth.js') return prelude + `
    const connected = new WeakSet();
    export function getAuth(app) {
      const auth = real.getAuth(app);
      if (!connected.has(auth)) { real.connectAuthEmulator(auth, 'http://127.0.0.1:${ports.auth}', { disableWarnings: true }); connected.add(auth); }
      return auth;
    }`;
  if (file === 'firebase-firestore.js') return prelude + `
    export function initializeFirestore(app, settings) {
      const db = real.initializeFirestore(app, settings);
      real.connectFirestoreEmulator(db, '127.0.0.1', ${ports.firestore}); return db;
    }`;
  if (file === 'firebase-functions.js') return prelude + `
    const connected = new WeakSet();
    export function getFunctions(app, region) {
      const functions = real.getFunctions(app, region);
      if (!connected.has(functions)) { real.connectFunctionsEmulator(functions, '127.0.0.1', ${ports.functions}); connected.add(functions); }
      return functions;
    }`;
  if (file === 'firebase-app-check.js') return `
    // This is a synthetic fixture, not successful Enterprise attestation.
    export class ReCaptchaEnterpriseProvider { constructor() {} }
    export function initializeAppCheck() { return Object.freeze({ emulatorFixture: true }); }
    export async function getToken() { return { token: 'emulator-only-synthetic-attestation' }; }
    export function setTokenAutoRefreshEnabled() {}`;
  return null;
}

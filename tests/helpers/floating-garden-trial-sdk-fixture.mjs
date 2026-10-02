// Test-only module facades. Game/app/transport modules are never rewritten.
// Only SDK constructors select direct demo emulator endpoints; all Auth, requests,
// transactions, listeners, local persistence and errors are the real SDK behavior.
function validateFixture({ kind, projectId, ports, runtime, browserOrigin }) {
  if (kind !== 'floating-garden-trial-browser-emulator-only-v1') throw new Error('Generated emulator fixture marker is required');
  if (projectId !== 'demo-floating-garden-trial') throw new Error('Only the isolated demo project is permitted');
  for (const [name, port] of Object.entries({ auth: 9099, firestore: 8183, functions: 5103 })) if (ports?.[name] !== port) throw new Error('Only the pinned loopback emulator ports are permitted');
  if (browserOrigin !== 'http://127.0.0.1:8783') throw new Error('Only the exact loopback fixture origin is permitted');
  if (runtime?.previewOrigin !== 'https://wa-garden-ci-trial--garden-7day-ci0001.web.app') throw new Error('Only the explicit synthetic trial origin is permitted');
}
// Playwright APIRequestContext errors can append headers and complete URLs to
// message/stack. Never persist either, even for synthetic emulator credentials.
export function sanitizeTrialRelayFailure({ kind, url, error, status }) {
  let path = '[unrecognized]';
  try {
    const candidate = new URL(url).pathname;
    if (/^\/(?:demo-floating-garden-trial\/asia-northeast1\/floatingGarden(?:CreateRoom|JoinRoom|StartMatch|GetSnapshot|SubmitAction)|identitytoolkit\.googleapis\.com\/v1\/accounts:(?:signUp|lookup)|securetoken\.googleapis\.com\/v1\/token|google\.firestore\.v1\.Firestore\/(?:Listen|Write)\/channel)$/.test(candidate)) path = candidate;
  } catch { /* Omit a malformed URL entirely. */ }
  const errorName = ['Error', 'TimeoutError', 'AssertionError', 'SyntaxError'].includes(error?.name) ? error.name : 'Error';
  const httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  // Inspect only the leading error sentence to select a fixed diagnostic enum.
  // Neither it nor the following Playwright Call log is persisted or returned.
  const firstLine = typeof error?.message === 'string' ? error.message.split('\n', 1)[0] : '';
  const knownShape = [
    ['interception-invalidated', /Invalid InterceptionId/i],
    ['route-already-handled', /Route is already handled/i],
    ['context-closed', /Target (?:page, context or browser|closed)|browser has been closed/i],
    ['request-context-disposed', /Request context disposed/i],
    ['connection-reset', /ECONNRESET|socket hang up/i],
    ['connection-refused', /ECONNREFUSED/],
    ['request-aborted', /net::ERR_ABORTED/],
    ['network-disconnected', /net::ERR_INTERNET_DISCONNECTED/],
    ['timeout', /Timeout \d+ms exceeded|ETIMEDOUT|timed out/i],
  ].find(([, pattern]) => pattern.test(firstLine))?.[0];
  return { kind: ['auth', 'firestore', 'functions'].includes(kind) ? kind : 'unknown', path, errorName,
    category: httpStatus >= 300 && httpStatus < 400 ? 'redirect-refused' : errorName === 'TimeoutError' ? 'timeout' : errorName === 'AssertionError' ? 'assertion-failed' : knownShape || 'relay-failed',
    ...(httpStatus === null ? {} : { status: httpStatus }) };
}
export function trialSdkFixture(file, fixture) {
  validateFixture(fixture);
  const { projectId, ports } = fixture;
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
      if (region !== 'asia-northeast1') throw new Error('Unexpected trial Functions region');
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

// Test-only module facades. Game/app/transport modules are never rewritten.
// Only SDK constructors select the same-origin test relay; all Auth, requests,
// transactions, listeners, local persistence and errors are the real SDK behavior.
function validateFixture({ kind, projectId, ports, runtime }) {
  if (kind !== 'floating-garden-trial-browser-emulator-only-v1') throw new Error('Generated emulator fixture marker is required');
  if (projectId !== 'demo-floating-garden-trial') throw new Error('Only the isolated demo project is permitted');
  for (const [name, port] of Object.entries({ auth: 9099, firestore: 8183, functions: 5103 })) if (ports?.[name] !== port) throw new Error('Only the pinned loopback emulator ports are permitted');
  if (runtime?.previewOrigin !== 'https://wa-garden-ci-trial--garden-7day-ci0001.web.app') throw new Error('Only the intercepted fixture origin is permitted');
}
const freshDocumentPath = /^\/v1\/projects\/demo-floating-garden-trial\/databases\/\(default\)\/documents\/(?:floatingGardenTrial\/(?:config|usage)|(?:floatingGardenTrialTesters|floatingGardenActionRequests)\/[A-Za-z0-9_-]{1,300}|floatingGardenRooms\/[A-Za-z0-9_-]{1,128}(?:\/(?:members|serverGames)\/[A-Za-z0-9_-]{1,128})?)$/;
// Reverse-proxy ONLY these real SDK routes. Never proxy an arbitrary URL, project,
// method, host, redirect or asset request. Unknown requests stay local 404/blocked.
export function trialEmulatorRoute(rawUrl, method, fixture) {
  validateFixture(fixture);
  const url = new URL(rawUrl);
  if (url.origin !== fixture.runtime.previewOrigin || url.username || url.password || url.hash) return null;
  let kind;
  if (method === 'POST' && /^\/(?:identitytoolkit\.googleapis\.com\/v1\/accounts:(?:signUp|lookup)|securetoken\.googleapis\.com\/v1\/token)$/.test(url.pathname)) kind = 'auth';
  if (method === 'POST' && !url.search && /^\/floatingGarden(?:CreateRoom|JoinRoom|StartMatch|GetSnapshot|SubmitAction)$/.test(url.pathname)) kind = 'functions';
  if (['GET', 'POST'].includes(method) && /^\/google\.firestore\.v1\.Firestore\/(?:Listen|Write)\/channel$/.test(url.pathname)) {
    if (url.searchParams.getAll('database').length > 1) return null;
    const database = url.searchParams.get('database');
    if (database && database !== 'projects/demo-floating-garden-trial/databases/(default)') return null;
    kind = 'firestore';
  }
  // Fresh authorization probes use the SAME browser Auth token, avoiding reuse
  // of an already-current SDK watch target. This is read-only and demo-only.
  if (method === 'GET' && !url.search && freshDocumentPath.test(url.pathname)) kind = 'firestore';
  const path = kind === 'functions' ? `/demo-floating-garden-trial/asia-northeast1${url.pathname}` : url.pathname;
  return kind ? { kind, url: `http://127.0.0.1:${fixture.ports[kind]}${path}${url.search}` } : null;
}
// Only a browser-confirmed cancellation of a Firestore long poll is expected
// during native reload. Never classify a callable/Auth/backend failure this way.
export function isTrialRelayNavigationCancellation(kind, failure) {
  return kind === 'firestore' && failure?.errorText === 'net::ERR_ABORTED';
}
// Playwright APIRequestContext errors can append headers and complete URLs to
// message/stack. Never persist either, even for synthetic emulator credentials.
export function sanitizeTrialRelayFailure({ kind, url, error, status }) {
  let path = '[unrecognized]';
  try {
    const candidate = new URL(url).pathname;
    if (/^\/(?:floatingGarden(?:CreateRoom|JoinRoom|StartMatch|GetSnapshot|SubmitAction)|identitytoolkit\.googleapis\.com\/v1\/accounts:(?:signUp|lookup)|securetoken\.googleapis\.com\/v1\/token|google\.firestore\.v1\.Firestore\/(?:Listen|Write)\/channel)$/.test(candidate)) path = candidate;
    if (freshDocumentPath.test(candidate)) path = '/v1/projects/demo-floating-garden-trial/databases/(default)/documents/[redacted]';
  } catch { /* Omit a malformed URL entirely. */ }
  const errorName = ['Error', 'TimeoutError', 'AssertionError', 'SyntaxError'].includes(error?.name) ? error.name : 'Error';
  const httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  return { kind: ['auth', 'firestore', 'functions'].includes(kind) ? kind : 'unknown', path, errorName,
    category: httpStatus >= 300 && httpStatus < 400 ? 'redirect-refused' : errorName === 'TimeoutError' ? 'timeout' : errorName === 'AssertionError' ? 'assertion-failed' : 'relay-failed',
    ...(httpStatus === null ? {} : { status: httpStatus }) };
}
export function trialSdkFixture(file, fixture) {
  validateFixture(fixture);
  const { projectId, runtime } = fixture, origin = runtime.previewOrigin;
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
      if (!connected.has(auth)) { real.connectAuthEmulator(auth, ${JSON.stringify(origin)}, { disableWarnings: true }); connected.add(auth); }
      return auth;
    }`;
  if (file === 'firebase-firestore.js') return prelude + `
    export function initializeFirestore(app, settings) {
      return real.initializeFirestore(app, { ...settings, host: ${JSON.stringify(new URL(origin).host)}, ssl: true,
        experimentalAutoDetectLongPolling: false, experimentalForceLongPolling: true,
        experimentalLongPollingOptions: { timeoutSeconds: 5 } });
    }`;
  if (file === 'firebase-functions.js') return prelude + `
    export function getFunctions(app, region) {
      if (region !== 'asia-northeast1') throw new Error('Unexpected trial Functions region');
      // Use an origin-only custom domain, avoiding version-specific path handling.
      // The strict relay adds the fixed demo project/region on the server side.
      return real.getFunctions(app, ${JSON.stringify(origin)});
    }`;
  if (file === 'firebase-app-check.js') return `
    // This is a synthetic fixture, not successful Enterprise attestation.
    export class ReCaptchaEnterpriseProvider { constructor() {} }
    export function initializeAppCheck() { return Object.freeze({ emulatorFixture: true }); }
    export async function getToken() { return { token: 'emulator-only-synthetic-attestation' }; }
    export function setTokenAutoRefreshEnabled() {}`;
  return null;
}

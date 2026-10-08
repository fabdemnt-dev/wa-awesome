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
// This self-contained function is also embedded into the browser SDK facade.
// Observe only an allowlisted, bounded summary; callbacks and unsubscribe still
// go to the real SDK exactly once, with their original values and receivers.
export function createTrialListenerDiagnostics(real, history, now = Date.now) {
  const codes = new Set(['ok', 'cancelled', 'unknown', 'invalid-argument', 'deadline-exceeded', 'not-found', 'already-exists', 'permission-denied', 'resource-exhausted', 'failed-precondition', 'aborted', 'out-of-range', 'unimplemented', 'internal', 'unavailable', 'data-loss', 'unauthenticated']);
  const integer = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  let sequence = 0;
  function record(id, event, value) {
    try {
      const entry = { id, event, time: integer(now()) };
      if (event === 'next') {
        const data = value?.data?.();
        entry.revision = integer(data?.revision);
        entry.matchRevision = integer(data?.match?.revision);
        entry.fromCache = typeof value?.metadata?.fromCache === 'boolean' ? value.metadata.fromCache : null;
        entry.hasPendingWrites = typeof value?.metadata?.hasPendingWrites === 'boolean' ? value.metadata.hasPendingWrites : null;
      }
      if (event === 'error') entry.code = codes.has(value?.code) ? value.code : 'unknown';
      history.push(entry);
      if (history.length > 256) history.splice(0, history.length - 256);
    } catch { /* Diagnostics must not suppress, synthesize or change SDK events. */ }
  }
  const isObserver = (value) => value && typeof value === 'object' && ['next', 'error', 'complete'].some((key) => typeof value[key] === 'function');
  return function onSnapshot(...args) {
    sequence = sequence < Number.MAX_SAFE_INTEGER ? sequence + 1 : 1;
    const id = sequence;
    record(id, 'start');
    const offset = typeof args[1] === 'function' || isObserver(args[1]) ? 1 : 2;
    if (isObserver(args[offset])) {
      const observer = args[offset], wrapped = Object.create(observer);
      for (const event of ['next', 'error', 'complete']) {
        const callback = observer[event];
        if (typeof callback === 'function') Object.defineProperty(wrapped, event, { value: function (...values) {
          if (event !== 'complete') record(id, event, values[0]);
          return Reflect.apply(callback, observer, values);
        } });
      }
      args[offset] = wrapped;
    } else {
      for (const [index, event] of [[offset, 'next'], [offset + 1, 'error']]) {
        const callback = args[index];
        if (typeof callback === 'function') args[index] = function (...values) {
          record(id, event, values[0]);
          return Reflect.apply(callback, this, values);
        };
      }
    }
    let unsubscribe;
    try { unsubscribe = real.onSnapshot(...args); }
    catch (error) { record(id, 'error', error); throw error; }
    return function (...values) {
      record(id, 'stop');
      return Reflect.apply(unsubscribe, this, values);
    };
  };
}

export function sanitizeTrialSnapshotRevisions(snapshot) {
  const integer = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return { revision: integer(snapshot?.room?.revision), matchRevision: integer(snapshot?.room?.match?.revision) };
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
    const listenerHistory = [];
    globalThis.__trialListenerDiagnostics = listenerHistory;
    export const onSnapshot = (${createTrialListenerDiagnostics.toString()})(real, listenerHistory);
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

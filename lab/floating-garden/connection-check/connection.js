// This module is deliberately independent of the seven-day game trial.
export const CONNECTION_PROJECT = 'wa-awesome-garden-stg';
export const CONNECTION_ORIGIN = 'https://wa-awesome-garden-stg.web.app';
export const CONNECTION_APP_NAME = 'floating-garden-trial-wa-awesome-garden-stg';
export const CONNECTION_MAX_DURATION_MILLIS = 48 * 60 * 60 * 1000;
export const CONNECTION_STAGE_TIMEOUT_MILLIS = 15000;
export const IDENTITY_ATTEMPT_KEY = 'floating-garden-connection-anonymous-attempt-v1';
const IDENTITY_LOCK = 'floating-garden-trial-wa-awesome-garden-stg-identity';
const FIREBASE = Object.freeze({
  apiKey: 'AIzaSyCfa04hxQzY0T6gsVLsvTxIhB2zAB0v874',
  authDomain: 'wa-awesome-garden-stg.firebaseapp.com',
  projectId: CONNECTION_PROJECT,
  appId: '1:120030709276:web:015f4e996b7c42a4e801d9',
});
export const CONNECTION_LABELS = Object.freeze({
  idle: '開始前',
  checking: '接続を確認しています',
  authenticating: '匿名認証を確認しています',
  connected: '接続確認が完了しました',
  invalid: '配信元・設定・有効期間を確認できません',
  failed: '接続を確認できませんでした',
  timeout: '応答を確認できないため停止しました',
  expired: '接続確認の有効期間が終了しました',
  stopped: '接続確認を停止しました',
});
// Only these literal SDK codes may cross the diagnostic boundary. In particular,
// never reflect a prefix match, raw exception, or property accessor into state.
const DIAGNOSTIC_CODES = new Set([
  'appCheck/recaptcha-error', 'appCheck/fetch-network-error', 'appCheck/fetch-parse-error',
  'appCheck/fetch-status-error', 'appCheck/throttled', 'appCheck/already-initialized',
  'appCheck/use-before-activation', 'appCheck/storage-open', 'appCheck/storage-get', 'appCheck/storage-set',
  'auth/network-request-failed', 'auth/operation-not-allowed', 'auth/admin-restricted-operation',
  'auth/invalid-api-key', 'auth/app-not-authorized', 'auth/too-many-requests', 'auth/quota-exceeded',
  'auth/internal-error', 'auth/web-storage-unsupported', 'auth/invalid-user-token',
  'auth/user-token-expired', 'auth/user-disabled', 'auth/already-initialized',
  'connection/unknown', 'connection/invalid-access', 'connection/timeout', 'connection/expired',
  'connection/stopped', 'connection/duplicate-app', 'connection/lock-unavailable', 'connection/lock-busy',
  'connection/storage-unavailable', 'connection/previous-attempt', 'connection/storage-unconfirmed',
  'connection/invalid-proof', 'connection/invalid-identity', 'connection/identity-mismatch',
]);
function diagnosticCode(error) {
  try {
    // A Proxy descriptor trap may run or throw; nothing it returns is trusted.
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    if (descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string' &&
      DIAGNOSTIC_CODES.has(descriptor.value)) return descriptor.value;
  } catch { /* Unknown, revoked Proxy, or primitive: fixed fallback only. */ }
  return 'connection/unknown';
}
const NO_HTTP_DIAGNOSTIC = Object.freeze({ httpStatus: null, waitSeconds: null });
function ownData(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}
function diagnosticHttp(error, code) {
  if (!['appCheck/throttled', 'appCheck/fetch-status-error'].includes(code)) return NO_HTTP_DIAGNOSTIC;
  const data = ownData(error, 'customData'), httpStatus = ownData(data, 'httpStatus');
  if (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599 || httpStatus === 200) return NO_HTTP_DIAGNOSTIC;
  let waitSeconds = null;
  if (code === 'appCheck/throttled') {
    const time = ownData(data, 'time');
    // SDK 10.8.0 formats a rounded, local backoff duration. This is neither an
    // HTTP Retry-After value nor an exact time when a request will succeed.
    if (typeof time === 'string' && time.length <= 15) {
      const match = /^(?:(\d{2})d:)?(?:(\d{2})h:)?(\d{2})m:(\d{2})s$/.exec(time);
      if (match) {
        const [, d = '00', h = '00', m, s] = match;
        const seconds = Number(d) * 86400 + Number(h) * 3600 + Number(m) * 60 + Number(s);
        if (Number(h) < 24 && Number(m) < 60 && Number(s) < 60 && seconds <= 86400) waitSeconds = seconds;
      }
    }
  }
  return Object.freeze({ httpStatus, waitSeconds });
}
function failure(code = 'connection/unknown') {
  const error = new Error('接続確認を継続できません');
  Object.defineProperty(error, 'code', { value: code });
  return error;
}
function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw failure();
}
export function validateConnectionRuntime(input) {
  exactKeys(input, ['schemaVersion', 'projectId', 'origin', 'startsAtMillis', 'expiresAtMillis', 'firebase', 'appCheck']);
  exactKeys(input.firebase, Object.keys(FIREBASE));
  exactKeys(input.appCheck, ['provider', 'siteKey']);
  if (input.schemaVersion !== 1 || input.projectId !== CONNECTION_PROJECT || input.origin !== CONNECTION_ORIGIN ||
    Object.entries(FIREBASE).some(([key, value]) => input.firebase[key] !== value)) throw failure();
  if (!Number.isSafeInteger(input.startsAtMillis) || !Number.isSafeInteger(input.expiresAtMillis) ||
    input.startsAtMillis <= 0 || input.expiresAtMillis <= input.startsAtMillis ||
    input.expiresAtMillis - input.startsAtMillis > CONNECTION_MAX_DURATION_MILLIS) throw failure();
  if (input.appCheck.provider !== 'recaptcha-enterprise' ||
    input.appCheck.siteKey !== '6Lc_LNwtAAAAADRAHvql0FwxirR3c5jZlxS9QpYw') throw failure();
  return Object.freeze({ ...input, firebase: Object.freeze({ ...input.firebase }), appCheck: Object.freeze({ ...input.appCheck }) });
}
export function assertConnectionAccess(config, location, now, environment = globalThis) {
  let page;
  try { page = new URL(typeof location === 'string' ? location : location?.href); } catch { throw failure(); }
  if (page.origin !== CONNECTION_ORIGIN || page.protocol !== 'https:' || page.port || page.username || page.password || page.search ||
    !Number.isSafeInteger(now) || now < config.startsAtMillis || now >= config.expiresAtMillis ||
    'FIREBASE_APPCHECK_DEBUG_TOKEN' in environment) throw failure();
}
// No remote imports run until Start and the complete gate have succeeded.
export async function loadConnectionSdk() {
  const [appSdk, appCheckSdk, authSdk] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-check.js'),
    import('https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js'),
  ]);
  return { appSdk, appCheckSdk, authSdk };
}
function browserIdentityLock(callback) {
  if (!globalThis.navigator?.locks?.request) return Promise.reject(failure('connection/lock-unavailable'));
  return globalThis.navigator.locks.request(IDENTITY_LOCK, { ifAvailable: true }, (lock) => {
    if (!lock) throw failure('connection/lock-busy');
    return callback();
  });
}
/** Dependencies are injectable solely for offline tests. No runtime override is read from the page. */
export function createConnectionCheck(runtime, {
  location = globalThis.location, environment = globalThis, now = () => Date.now(),
  loadSdk = loadConnectionSdk, setTimer = setTimeout, clearTimer = clearTimeout,
  getAttemptStorage = () => globalThis.localStorage, withIdentityLock = browserIdentityLock,
  onState = () => {},
} = {}) {
  let config = null, sdk = null, app = null, appCheck = null;
  let started = false, terminal = false, generation = 0, startFlight = null;
  let activeStage = 'preflight', diagnosticStage = null, safeCode = null;
  let httpDiagnostic = NO_HTTP_DIAGNOSTIC;
  const wrappedDiagnostics = new WeakMap();
  let state = Object.freeze({ status: 'idle', label: CONNECTION_LABELS.idle, uid: null, expiresAtMillis: null, canStart: true, diagnosticStage: null, diagnosticCode: null, diagnosticHttpStatus: null, diagnosticWaitSeconds: null });
  const timers = new Set(), aborts = new Set();
  function publish(status, uid = null) {
    state = Object.freeze({ status, label: CONNECTION_LABELS[status], uid, expiresAtMillis: config?.expiresAtMillis ?? null, canStart: !started && !terminal, diagnosticStage, diagnosticCode: safeCode, diagnosticHttpStatus: httpDiagnostic.httpStatus, diagnosticWaitSeconds: httpDiagnostic.waitSeconds });
    // The observer receives only this allowlisted shape, never SDK results/errors.
    try { onState(state); } catch { /* An observer cannot alter the lifecycle. */ }
  }
  function stop(status = 'stopped', error = null) {
    if (terminal) return state;
    terminal = true; generation++;
    // Freeze the first terminal outcome before inspecting even a hostile Proxy.
    diagnosticStage = activeStage;
    safeCode = status === 'failed' ? diagnosticCode(error) : ({
      invalid: 'connection/invalid-access', timeout: 'connection/timeout',
      expired: 'connection/expired', stopped: 'connection/stopped',
    })[status] || 'connection/stopped';
    if (status === 'failed' && diagnosticStage === 'app-check-request') {
      // Async errors arrive as our own wrappers; synchronous SDK throws can
      // arrive directly. No raw SDK exception or customData is retained.
      httpDiagnostic = wrappedDiagnostics.get(error) ?? diagnosticHttp(error, safeCode);
    }
    for (const timer of timers) clearTimer(timer);
    timers.clear();
    for (const abort of [...aborts]) abort();
    if (appCheck) {
      try { sdk.appCheckSdk.setTokenAutoRefreshEnabled(appCheck, false); } catch { /* No error reflection. */ }
    }
    if (app) {
      try { Promise.resolve(sdk.appSdk.deleteApp(app)).catch(() => {}); } catch { /* No error reflection. */ }
    }
    // Never sign out, clear Auth persistence, or clear the uncertain-attempt guard.
    publish(Object.hasOwn(CONNECTION_LABELS, status) ? status : 'stopped');
    return state;
  }
  function assertActive(expected) {
    if (terminal || generation !== expected) throw failure();
    try { assertConnectionAccess(config, location, now(), environment); } catch {
      stop(Number.isSafeInteger(now()) && now() >= config.expiresAtMillis ? 'expired' : 'invalid');
      throw failure();
    }
  }
  function stage(promise) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true; clearTimer(timer); timers.delete(timer); aborts.delete(abort); fn(value);
      };
      const abort = () => finish(reject, failure());
      const timer = setTimer(() => stop('timeout'), CONNECTION_STAGE_TIMEOUT_MILLIS);
      timers.add(timer); aborts.add(abort);
      Promise.resolve(promise).then((value) => finish(resolve, value), (error) => {
        if (settled || terminal) return;
        // Keep only bounded numeric diagnostics across this boundary. A hostile
        // descriptor trap can stop the client; check again before inspecting it.
        const code = diagnosticCode(error);
        if (settled || terminal) return;
        const detail = activeStage === 'app-check-request' ? diagnosticHttp(error, code) : NO_HTTP_DIAGNOSTIC;
        if (settled || terminal) return;
        const safeError = failure(code);
        wrappedDiagnostics.set(safeError, detail);
        finish(reject, safeError);
      });
      if (terminal) abort();
    });
  }
  function armExpiry(expected) {
    const timer = setTimer(() => {
      timers.delete(timer);
      if (terminal || generation !== expected) return;
      // A timer can be early or suspended; recheck the fixed wall-clock boundary.
      try { assertActive(expected); armExpiry(expected); } catch { /* Already stopped. */ }
    }, Math.max(0, config.expiresAtMillis - now()));
    timers.add(timer);
  }
  async function run(expected) {
    try {
      config = validateConnectionRuntime(runtime);
      assertConnectionAccess(config, location, now(), environment);
    } catch { stop('invalid'); return state; }
    try {
      publish('checking'); assertActive(expected); armExpiry(expected);
      activeStage = 'sdk-load';
      sdk = await stage(loadSdk()); assertActive(expected);
      activeStage = 'app-init';
      if (sdk.appSdk.getApps().some((item) => item.name === CONNECTION_APP_NAME)) throw failure('connection/duplicate-app');
      app = sdk.appSdk.initializeApp(config.firebase, CONNECTION_APP_NAME);
      assertActive(expected);
      activeStage = 'app-check-init';
      appCheck = sdk.appCheckSdk.initializeAppCheck(app, {
        provider: new sdk.appCheckSdk.ReCaptchaEnterpriseProvider(config.appCheck.siteKey),
        // A one-shot check has no reason to schedule repeated attestations.
        isTokenAutoRefreshEnabled: false,
      });
      activeStage = 'app-check-request';
      const proof = await stage(sdk.appCheckSdk.getToken(appCheck, false));
      assertActive(expected);
      if (!proof || typeof proof.token !== 'string' || proof.token.length === 0) throw failure('connection/invalid-proof');
      publish('authenticating'); assertActive(expected);
      // Match the game's named app and persistence namespace without loading game code.
      activeStage = 'auth-init';
      const auth = sdk.authSdk.initializeAuth(app, { persistence: sdk.authSdk.browserLocalPersistence });
      activeStage = 'auth-persistence-restore';
      await stage(sdk.authSdk.setPersistence(auth, sdk.authSdk.browserLocalPersistence)); assertActive(expected);
      activeStage = 'identity-lock';
      await stage(withIdentityLock(async () => {
        assertActive(expected);
        activeStage = 'identity-ready';
        await auth.authStateReady(); assertActive(expected);
        let user = auth.currentUser;
        if (!user) {
          // An unknown earlier sign-in must never be retried, even after reload.
          // This durable boolean contains no UID, token, credential, or expiry.
          activeStage = 'identity-guard';
          const storage = attemptStorage();
          if (readAttempt(storage) !== null) throw failure('connection/previous-attempt');
          writeAttempt(storage);
          if (readAttempt(storage) !== 'attempted') throw failure('connection/storage-unconfirmed');
          assertActive(expected);
          activeStage = 'anonymous-signup';
          user = (await sdk.authSdk.signInAnonymously(auth))?.user;
          assertActive(expected);
        }
        activeStage = 'final-validation';
        if (!user || user.isAnonymous !== true || typeof user.uid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(user.uid)) throw failure('connection/invalid-identity');
        if (auth.currentUser?.uid !== user.uid || auth.currentUser?.isAnonymous !== true) throw failure('connection/identity-mismatch');
        // Also remember that a reused identity existed, without storing the UID.
        // Losing that persisted identity must not silently create a replacement.
        activeStage = 'identity-guard';
        const storage = attemptStorage();
        if (readAttempt(storage) === null) writeAttempt(storage);
        if (readAttempt(storage) !== 'attempted') throw failure('connection/storage-unconfirmed');
        activeStage = 'final-validation';
        assertActive(expected);
        publish('connected', user.uid);
      }));
      assertActive(expected);
    } catch (error) { if (!terminal) stop('failed', error); }
    return state;
  }
  function attemptStorage() {
    try { return getAttemptStorage(); } catch { throw failure('connection/storage-unavailable'); }
  }
  function readAttempt(storage) {
    try { return storage.getItem(IDENTITY_ATTEMPT_KEY); } catch { throw failure('connection/storage-unavailable'); }
  }
  function writeAttempt(storage) {
    try { storage.setItem(IDENTITY_ATTEMPT_KEY, 'attempted'); } catch { throw failure('connection/storage-unavailable'); }
  }
  // This local-only preflight lets the user see the fixed expiry before Start.
  // It performs no SDK import, browser storage access, or network operation.
  try {
    config = validateConnectionRuntime(runtime);
    assertConnectionAccess(config, location, now(), environment);
    state = Object.freeze({ ...state, expiresAtMillis: config.expiresAtMillis });
  } catch {
    terminal = true; diagnosticStage = 'preflight'; safeCode = 'connection/invalid-access';
    state = Object.freeze({ status: 'invalid', label: CONNECTION_LABELS.invalid, uid: null, expiresAtMillis: config?.expiresAtMillis ?? null, canStart: false, diagnosticStage, diagnosticCode: safeCode, diagnosticHttpStatus: null, diagnosticWaitSeconds: null });
  }
  return Object.freeze({
    start() {
      if (started || terminal) return startFlight || Promise.resolve(state);
      started = true;
      startFlight = run(generation);
      return startFlight;
    },
    stop() { return stop(); },
    checkAccess() {
      if (!started || terminal) return state;
      try { assertActive(generation); } catch { /* Safe terminal state already published. */ }
      return state;
    },
    getState() { return state; },
  });
}

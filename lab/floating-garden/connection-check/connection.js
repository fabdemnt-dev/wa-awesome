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
const failure = () => new Error('接続確認を継続できません');
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
    input.appCheck.siteKey !== '6Lc_LNwtAAAAADRAHvq10FwxirR3c5jZlxS9QpYw') throw failure();
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
  if (!globalThis.navigator?.locks?.request) return Promise.reject(failure());
  return globalThis.navigator.locks.request(IDENTITY_LOCK, { ifAvailable: true }, (lock) => {
    if (!lock) throw failure();
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
  let state = Object.freeze({ status: 'idle', label: CONNECTION_LABELS.idle, uid: null, expiresAtMillis: null, canStart: true });
  const timers = new Set(), aborts = new Set();
  function publish(status, uid = null) {
    state = Object.freeze({ status, label: CONNECTION_LABELS[status], uid, expiresAtMillis: config?.expiresAtMillis ?? null, canStart: !started && !terminal });
    // The observer receives only this allowlisted shape, never SDK results/errors.
    try { onState(state); } catch { /* An observer cannot alter the lifecycle. */ }
  }
  function stop(status = 'stopped') {
    if (terminal) return state;
    terminal = true; generation++;
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
      Promise.resolve(promise).then((value) => finish(resolve, value), () => finish(reject, failure()));
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
      sdk = await stage(loadSdk()); assertActive(expected);
      if (sdk.appSdk.getApps().some((item) => item.name === CONNECTION_APP_NAME)) throw failure();
      app = sdk.appSdk.initializeApp(config.firebase, CONNECTION_APP_NAME);
      assertActive(expected);
      appCheck = sdk.appCheckSdk.initializeAppCheck(app, {
        provider: new sdk.appCheckSdk.ReCaptchaEnterpriseProvider(config.appCheck.siteKey),
        // A one-shot check has no reason to schedule repeated attestations.
        isTokenAutoRefreshEnabled: false,
      });
      const proof = await stage(sdk.appCheckSdk.getToken(appCheck, false));
      assertActive(expected);
      if (!proof || typeof proof.token !== 'string' || proof.token.length === 0) throw failure();
      publish('authenticating'); assertActive(expected);
      // Match the game's named app and persistence namespace without loading game code.
      const auth = sdk.authSdk.initializeAuth(app, { persistence: sdk.authSdk.browserLocalPersistence });
      await stage(sdk.authSdk.setPersistence(auth, sdk.authSdk.browserLocalPersistence)); assertActive(expected);
      await stage(withIdentityLock(async () => {
        assertActive(expected);
        await auth.authStateReady(); assertActive(expected);
        let user = auth.currentUser;
        if (!user) {
          // An unknown earlier sign-in must never be retried, even after reload.
          // This durable boolean contains no UID, token, credential, or expiry.
          const storage = getAttemptStorage();
          if (storage.getItem(IDENTITY_ATTEMPT_KEY) !== null) throw failure();
          storage.setItem(IDENTITY_ATTEMPT_KEY, 'attempted');
          if (storage.getItem(IDENTITY_ATTEMPT_KEY) !== 'attempted') throw failure();
          assertActive(expected);
          user = (await sdk.authSdk.signInAnonymously(auth))?.user;
          assertActive(expected);
        }
        if (!user || user.isAnonymous !== true || typeof user.uid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(user.uid) ||
          auth.currentUser?.uid !== user.uid || auth.currentUser?.isAnonymous !== true) throw failure();
        // Also remember that a reused identity existed, without storing the UID.
        // Losing that persisted identity must not silently create a replacement.
        const storage = getAttemptStorage();
        if (storage.getItem(IDENTITY_ATTEMPT_KEY) === null) storage.setItem(IDENTITY_ATTEMPT_KEY, 'attempted');
        if (storage.getItem(IDENTITY_ATTEMPT_KEY) !== 'attempted') throw failure();
        assertActive(expected);
        publish('connected', user.uid);
      }));
      assertActive(expected);
    } catch { if (!terminal) stop('failed'); }
    return state;
  }
  // This local-only preflight lets the user see the fixed expiry before Start.
  // It performs no SDK import, browser storage access, or network operation.
  try {
    config = validateConnectionRuntime(runtime);
    assertConnectionAccess(config, location, now(), environment);
    state = Object.freeze({ ...state, expiresAtMillis: config.expiresAtMillis });
  } catch {
    terminal = true;
    state = Object.freeze({ status: 'invalid', label: CONNECTION_LABELS.invalid, uid: null, expiresAtMillis: config?.expiresAtMillis ?? null, canStart: false });
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

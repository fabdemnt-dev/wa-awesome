#!/usr/bin/env node
// Build template: the local generator replaces only the payload token below.
// Standalone output needs Node 20+, the user's existing Cloud Shell session, and
// explicitly prepared pinned local CLI dependencies. It never starts a login.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EMBEDDED = /*__CONNECTION_PAYLOAD__*/ null;
export const PROJECT = 'wa-awesome-garden-stg';
export const PROJECT_NUMBER = '120030709276';
export const ORIGIN = 'https://wa-awesome-garden-stg.web.app';
export const APP_ID = '1:120030709276:web:015f4e996b7c42a4e801d9';
export const SITE_KEY = '6Lc_LNwtAAAAADRAHvq10FwxirR3c5jZlxS9QpYw';
export const API_KEY = 'AIzaSyCfa04hxQzY0T6gsVLsvTxIhB2zAB0v874';
export const STARTS_AT = Date.parse('2026-10-03T02:15:00Z');
export const EXPIRES_AT = Date.parse('2026-10-04T03:00:00Z');
export const MAINTENANCE_MESSAGE = 'garden-maintenance-static-v1';
export const CONFIG_FILE = 'firebase.connection-check.json';
export const DEPENDENCY_REVISION = '0404104414c1fb25a1248fc3a2fd0945f9478051';
export const DEPENDENCIES = Object.freeze({
  'package.json': 'd9d9988d3f196e7672d9c9671df688231600404344245fb9dfd34d61f4630272',
  'package-lock.json': 'd42c28f7b71969648ae4ec97799460e13210edd55fede3a5f4a97170cbb027c6',
});
export const MAINTENANCE_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const CONNECTION_CSP = "default-src 'none'; script-src 'self' https://www.gstatic.com/firebasejs/ https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/ https://recaptcha.google.com/recaptcha/; style-src 'self'; img-src 'self' data: https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/; connect-src https://content-firebaseappcheck.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.google.com/recaptcha/ https://recaptcha.google.com/recaptcha/; frame-src https://www.google.com/recaptcha/ https://recaptcha.google.com/recaptcha/; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// Preserve both historical identities. Only the fixed-CSP current release is
// a migration source; the original release remains inspectable and stoppable.
export const ORIGINAL_CONNECTION_CSP = CONNECTION_CSP.replace('https://content-firebaseappcheck.googleapis.com', 'https://firebaseappcheck.googleapis.com');
export const ORIGINAL_CONNECTION_DIGEST = 'd73fa35889621062065889b52242b37b052a81c375f78c208f80c5e4ddff3e2d';
export const ORIGINAL_CONNECTION_MESSAGE = `garden-connection-static-v1:${ORIGINAL_CONNECTION_DIGEST}`;
export const PREVIOUS_CONNECTION_CSP = CONNECTION_CSP;
export const PREVIOUS_CONNECTION_DIGEST = '2303007a968a8e063f49275d120631a5fa08f91cf1a28ae771dda6ad8055123d';
export const PREVIOUS_CONNECTION_MESSAGE = `garden-connection-static-v1:${PREVIOUS_CONNECTION_DIGEST}`;
// Immutable exact public payload from reviewed fixed-CSP release a7950aa
// (local checkpoint 2ad1ef9). Never derive historical bytes from a candidate.
const freeze = (value) => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
export const PREVIOUS_CONNECTION_PAYLOAD = freeze({"schemaVersion":1,"maintenanceHtml":"<!doctype html><html lang=\"ja\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta name=\"robots\" content=\"noindex,nofollow\"><title>庭園の試験は停止中です</title></head><body><main><h1>庭園の試験は停止中です</h1><p>現在は準備中、または試験期間が終了しています。</p><p>この画面では認証やゲームデータの送信を行いません。</p></main></body></html>\n","maintenanceConfig":"{\n  \"hosting\": {\n    \"site\": \"wa-awesome-garden-stg\",\n    \"public\": \"public\",\n    \"ignore\": [\n      \"**/.*\",\n      \"**/node_modules/**\"\n    ],\n    \"headers\": [\n      {\n        \"source\": \"**\",\n        \"headers\": [\n          {\n            \"key\": \"Cache-Control\",\n            \"value\": \"no-store, max-age=0\"\n          },\n          {\n            \"key\": \"X-Content-Type-Options\",\n            \"value\": \"nosniff\"\n          },\n          {\n            \"key\": \"Referrer-Policy\",\n            \"value\": \"no-referrer\"\n          },\n          {\n            \"key\": \"X-Robots-Tag\",\n            \"value\": \"noindex, nofollow\"\n          },\n          {\n            \"key\": \"Content-Security-Policy\",\n            \"value\": \"default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\"\n          }\n        ]\n      }\n    ]\n  }\n}\n","connectionFiles":{"app.js":"import runtime from './connection-runtime.js';\nimport { createConnectionCheck } from './connection.js';\n\n// Local assets only on load. The first SDK request is inside the Start handler.\nconst start = document.getElementById('connection-start');\nconst status = document.getElementById('connection-status');\nconst uid = document.getElementById('connection-uid');\nconst expiry = document.getElementById('connection-expiry');\nfunction render(state) {\n  status.textContent = state.label;\n  uid.textContent = state.uid ?? '未確認';\n  expiry.textContent = state.expiresAtMillis === null ? '開始時に確認します' :\n    new Intl.DateTimeFormat('ja-JP', { dateStyle: 'long', timeStyle: 'long', timeZone: 'Asia/Tokyo' }).format(state.expiresAtMillis);\n  start.disabled = !state.canStart;\n}\nconst connection = createConnectionCheck(runtime, { onState: render });\nrender(connection.getState());\nstart.addEventListener('click', () => { start.disabled = true; void connection.start(); });\nwindow.addEventListener('pagehide', () => connection.stop());\n// A BFCache return remains terminal. Resuming never silently starts another check.\nwindow.addEventListener('pageshow', () => connection.checkAccess());\ndocument.addEventListener('visibilitychange', () => connection.checkAccess());\n","connection.js":"// This module is deliberately independent of the seven-day game trial.\nexport const CONNECTION_PROJECT = 'wa-awesome-garden-stg';\nexport const CONNECTION_ORIGIN = 'https://wa-awesome-garden-stg.web.app';\nexport const CONNECTION_APP_NAME = 'floating-garden-trial-wa-awesome-garden-stg';\nexport const CONNECTION_MAX_DURATION_MILLIS = 48 * 60 * 60 * 1000;\nexport const CONNECTION_STAGE_TIMEOUT_MILLIS = 15000;\nexport const IDENTITY_ATTEMPT_KEY = 'floating-garden-connection-anonymous-attempt-v1';\nconst IDENTITY_LOCK = 'floating-garden-trial-wa-awesome-garden-stg-identity';\nconst FIREBASE = Object.freeze({\n  apiKey: 'AIzaSyCfa04hxQzY0T6gsVLsvTxIhB2zAB0v874',\n  authDomain: 'wa-awesome-garden-stg.firebaseapp.com',\n  projectId: CONNECTION_PROJECT,\n  appId: '1:120030709276:web:015f4e996b7c42a4e801d9',\n});\nexport const CONNECTION_LABELS = Object.freeze({\n  idle: '開始前',\n  checking: '接続を確認しています',\n  authenticating: '匿名認証を確認しています',\n  connected: '接続確認が完了しました',\n  invalid: '配信元・設定・有効期間を確認できません',\n  failed: '接続を確認できませんでした',\n  timeout: '応答を確認できないため停止しました',\n  expired: '接続確認の有効期間が終了しました',\n  stopped: '接続確認を停止しました',\n});\nconst failure = () => new Error('接続確認を継続できません');\nfunction exactKeys(value, keys) {\n  if (!value || typeof value !== 'object' || Array.isArray(value) ||\n    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||\n    Reflect.ownKeys(value).length !== keys.length ||\n    keys.some((key) => !Object.hasOwn(value, key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw failure();\n}\nexport function validateConnectionRuntime(input) {\n  exactKeys(input, ['schemaVersion', 'projectId', 'origin', 'startsAtMillis', 'expiresAtMillis', 'firebase', 'appCheck']);\n  exactKeys(input.firebase, Object.keys(FIREBASE));\n  exactKeys(input.appCheck, ['provider', 'siteKey']);\n  if (input.schemaVersion !== 1 || input.projectId !== CONNECTION_PROJECT || input.origin !== CONNECTION_ORIGIN ||\n    Object.entries(FIREBASE).some(([key, value]) => input.firebase[key] !== value)) throw failure();\n  if (!Number.isSafeInteger(input.startsAtMillis) || !Number.isSafeInteger(input.expiresAtMillis) ||\n    input.startsAtMillis <= 0 || input.expiresAtMillis <= input.startsAtMillis ||\n    input.expiresAtMillis - input.startsAtMillis > CONNECTION_MAX_DURATION_MILLIS) throw failure();\n  if (input.appCheck.provider !== 'recaptcha-enterprise' ||\n    input.appCheck.siteKey !== '6Lc_LNwtAAAAADRAHvq10FwxirR3c5jZlxS9QpYw') throw failure();\n  return Object.freeze({ ...input, firebase: Object.freeze({ ...input.firebase }), appCheck: Object.freeze({ ...input.appCheck }) });\n}\nexport function assertConnectionAccess(config, location, now, environment = globalThis) {\n  let page;\n  try { page = new URL(typeof location === 'string' ? location : location?.href); } catch { throw failure(); }\n  if (page.origin !== CONNECTION_ORIGIN || page.protocol !== 'https:' || page.port || page.username || page.password || page.search ||\n    !Number.isSafeInteger(now) || now < config.startsAtMillis || now >= config.expiresAtMillis ||\n    'FIREBASE_APPCHECK_DEBUG_TOKEN' in environment) throw failure();\n}\n// No remote imports run until Start and the complete gate have succeeded.\nexport async function loadConnectionSdk() {\n  const [appSdk, appCheckSdk, authSdk] = await Promise.all([\n    import('https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js'),\n    import('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-check.js'),\n    import('https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js'),\n  ]);\n  return { appSdk, appCheckSdk, authSdk };\n}\nfunction browserIdentityLock(callback) {\n  if (!globalThis.navigator?.locks?.request) return Promise.reject(failure());\n  return globalThis.navigator.locks.request(IDENTITY_LOCK, { ifAvailable: true }, (lock) => {\n    if (!lock) throw failure();\n    return callback();\n  });\n}\n/** Dependencies are injectable solely for offline tests. No runtime override is read from the page. */\nexport function createConnectionCheck(runtime, {\n  location = globalThis.location, environment = globalThis, now = () => Date.now(),\n  loadSdk = loadConnectionSdk, setTimer = setTimeout, clearTimer = clearTimeout,\n  getAttemptStorage = () => globalThis.localStorage, withIdentityLock = browserIdentityLock,\n  onState = () => {},\n} = {}) {\n  let config = null, sdk = null, app = null, appCheck = null;\n  let started = false, terminal = false, generation = 0, startFlight = null;\n  let state = Object.freeze({ status: 'idle', label: CONNECTION_LABELS.idle, uid: null, expiresAtMillis: null, canStart: true });\n  const timers = new Set(), aborts = new Set();\n  function publish(status, uid = null) {\n    state = Object.freeze({ status, label: CONNECTION_LABELS[status], uid, expiresAtMillis: config?.expiresAtMillis ?? null, canStart: !started && !terminal });\n    // The observer receives only this allowlisted shape, never SDK results/errors.\n    try { onState(state); } catch { /* An observer cannot alter the lifecycle. */ }\n  }\n  function stop(status = 'stopped') {\n    if (terminal) return state;\n    terminal = true; generation++;\n    for (const timer of timers) clearTimer(timer);\n    timers.clear();\n    for (const abort of [...aborts]) abort();\n    if (appCheck) {\n      try { sdk.appCheckSdk.setTokenAutoRefreshEnabled(appCheck, false); } catch { /* No error reflection. */ }\n    }\n    if (app) {\n      try { Promise.resolve(sdk.appSdk.deleteApp(app)).catch(() => {}); } catch { /* No error reflection. */ }\n    }\n    // Never sign out, clear Auth persistence, or clear the uncertain-attempt guard.\n    publish(Object.hasOwn(CONNECTION_LABELS, status) ? status : 'stopped');\n    return state;\n  }\n  function assertActive(expected) {\n    if (terminal || generation !== expected) throw failure();\n    try { assertConnectionAccess(config, location, now(), environment); } catch {\n      stop(Number.isSafeInteger(now()) && now() >= config.expiresAtMillis ? 'expired' : 'invalid');\n      throw failure();\n    }\n  }\n  function stage(promise) {\n    return new Promise((resolve, reject) => {\n      let settled = false;\n      const finish = (fn, value) => {\n        if (settled) return;\n        settled = true; clearTimer(timer); timers.delete(timer); aborts.delete(abort); fn(value);\n      };\n      const abort = () => finish(reject, failure());\n      const timer = setTimer(() => stop('timeout'), CONNECTION_STAGE_TIMEOUT_MILLIS);\n      timers.add(timer); aborts.add(abort);\n      Promise.resolve(promise).then((value) => finish(resolve, value), () => finish(reject, failure()));\n      if (terminal) abort();\n    });\n  }\n  function armExpiry(expected) {\n    const timer = setTimer(() => {\n      timers.delete(timer);\n      if (terminal || generation !== expected) return;\n      // A timer can be early or suspended; recheck the fixed wall-clock boundary.\n      try { assertActive(expected); armExpiry(expected); } catch { /* Already stopped. */ }\n    }, Math.max(0, config.expiresAtMillis - now()));\n    timers.add(timer);\n  }\n  async function run(expected) {\n    try {\n      config = validateConnectionRuntime(runtime);\n      assertConnectionAccess(config, location, now(), environment);\n    } catch { stop('invalid'); return state; }\n    try {\n      publish('checking'); assertActive(expected); armExpiry(expected);\n      sdk = await stage(loadSdk()); assertActive(expected);\n      if (sdk.appSdk.getApps().some((item) => item.name === CONNECTION_APP_NAME)) throw failure();\n      app = sdk.appSdk.initializeApp(config.firebase, CONNECTION_APP_NAME);\n      assertActive(expected);\n      appCheck = sdk.appCheckSdk.initializeAppCheck(app, {\n        provider: new sdk.appCheckSdk.ReCaptchaEnterpriseProvider(config.appCheck.siteKey),\n        // A one-shot check has no reason to schedule repeated attestations.\n        isTokenAutoRefreshEnabled: false,\n      });\n      const proof = await stage(sdk.appCheckSdk.getToken(appCheck, false));\n      assertActive(expected);\n      if (!proof || typeof proof.token !== 'string' || proof.token.length === 0) throw failure();\n      publish('authenticating'); assertActive(expected);\n      // Match the game's named app and persistence namespace without loading game code.\n      const auth = sdk.authSdk.initializeAuth(app, { persistence: sdk.authSdk.browserLocalPersistence });\n      await stage(sdk.authSdk.setPersistence(auth, sdk.authSdk.browserLocalPersistence)); assertActive(expected);\n      await stage(withIdentityLock(async () => {\n        assertActive(expected);\n        await auth.authStateReady(); assertActive(expected);\n        let user = auth.currentUser;\n        if (!user) {\n          // An unknown earlier sign-in must never be retried, even after reload.\n          // This durable boolean contains no UID, token, credential, or expiry.\n          const storage = getAttemptStorage();\n          if (storage.getItem(IDENTITY_ATTEMPT_KEY) !== null) throw failure();\n          storage.setItem(IDENTITY_ATTEMPT_KEY, 'attempted');\n          if (storage.getItem(IDENTITY_ATTEMPT_KEY) !== 'attempted') throw failure();\n          assertActive(expected);\n          user = (await sdk.authSdk.signInAnonymously(auth))?.user;\n          assertActive(expected);\n        }\n        if (!user || user.isAnonymous !== true || typeof user.uid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(user.uid) ||\n          auth.currentUser?.uid !== user.uid || auth.currentUser?.isAnonymous !== true) throw failure();\n        // Also remember that a reused identity existed, without storing the UID.\n        // Losing that persisted identity must not silently create a replacement.\n        const storage = getAttemptStorage();\n        if (storage.getItem(IDENTITY_ATTEMPT_KEY) === null) storage.setItem(IDENTITY_ATTEMPT_KEY, 'attempted');\n        if (storage.getItem(IDENTITY_ATTEMPT_KEY) !== 'attempted') throw failure();\n        assertActive(expected);\n        publish('connected', user.uid);\n      }));\n      assertActive(expected);\n    } catch { if (!terminal) stop('failed'); }\n    return state;\n  }\n  // This local-only preflight lets the user see the fixed expiry before Start.\n  // It performs no SDK import, browser storage access, or network operation.\n  try {\n    config = validateConnectionRuntime(runtime);\n    assertConnectionAccess(config, location, now(), environment);\n    state = Object.freeze({ ...state, expiresAtMillis: config.expiresAtMillis });\n  } catch {\n    terminal = true;\n    state = Object.freeze({ status: 'invalid', label: CONNECTION_LABELS.invalid, uid: null, expiresAtMillis: config?.expiresAtMillis ?? null, canStart: false });\n  }\n  return Object.freeze({\n    start() {\n      if (started || terminal) return startFlight || Promise.resolve(state);\n      started = true;\n      startFlight = run(generation);\n      return startFlight;\n    },\n    stop() { return stop(); },\n    checkAccess() {\n      if (!started || terminal) return state;\n      try { assertActive(generation); } catch { /* Safe terminal state already published. */ }\n      return state;\n    },\n    getState() { return state; },\n  });\n}\n","index.html":"<!doctype html>\n<html lang=\"ja\">\n  <head>\n    <meta charset=\"utf-8\">\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n    <meta name=\"referrer\" content=\"no-referrer\">\n    <meta name=\"robots\" content=\"noindex, nofollow\">\n    <title>浮遊庭園 · 接続確認</title>\n    <link rel=\"stylesheet\" href=\"./style.css\">\n    <script type=\"module\" src=\"./app.js\"></script>\n  </head>\n  <body>\n    <main aria-labelledby=\"page-title\">\n      <p class=\"eyebrow\">浮遊庭園</p>\n      <h1 id=\"page-title\">接続確認</h1>\n      <p class=\"intro\">開始すると、このブラウザーで App Check と匿名認証を確認します。</p>\n      <p class=\"note\">ゲームは開始しません。ゲームの7日間の試験期間も開始しません。</p>\n      <section class=\"result\" aria-label=\"接続状態\">\n        <p id=\"connection-status\" role=\"status\" aria-live=\"polite\">準備中</p>\n        <dl>\n          <div><dt>このブラウザーの匿名 UID</dt><dd id=\"connection-uid\">未確認</dd></div>\n          <div><dt>接続確認の有効期限</dt><dd id=\"connection-expiry\">開始時に確認します</dd></div>\n        </dl>\n      </section>\n      <button id=\"connection-start\" type=\"button\" disabled>接続確認を開始</button>\n      <p class=\"note\">同じブラウザーの匿名認証を引き継ぎます。失敗・停止後は、このページで認証を繰り返しません。</p>\n      <p class=\"note\">同じスマホ・ブラウザーを使い、登録担当には匿名 UID だけを伝えてください。認証情報は送らず、ブラウザーのデータも消去しないでください。</p>\n      <noscript><p>接続確認には JavaScript が必要です。</p></noscript>\n    </main>\n  </body>\n</html>\n","style.css":":root { color-scheme: light; font-family: system-ui, -apple-system, BlinkMacSystemFont, \"Noto Sans JP\", sans-serif; background: #f4f7f2; color: #203a31; }\n* { box-sizing: border-box; }\nbody { margin: 0; min-height: 100svh; display: grid; place-items: center; padding: 32px 18px; }\nmain { width: min(100%, 620px); padding: clamp(24px, 5vw, 44px); border: 1px solid #d4dfd2; border-radius: 24px; background: #fffef9; box-shadow: 0 16px 48px #2841320c; }\n.eyebrow { margin: 0; font-size: .85rem; letter-spacing: .14em; color: #486951; }\nh1 { font-size: clamp(1.6rem, 5vw, 2rem); line-height: 1.4; margin: 10px 0 22px; }\np { line-height: 1.8; }\n.intro { margin-bottom: 8px; }\n.note { color: #4e6156; font-size: .875rem; }\n.result { background: #edf4eb; border: 1px solid #d5e3d1; border-radius: 16px; padding: 18px 20px; margin: 24px 0; }\n#connection-status { font-weight: 700; margin: 0 0 18px; }\ndl { margin: 0; display: grid; gap: 18px; }\ndt { font-size: .8rem; color: #4e6156; margin-bottom: 6px; }\ndd { margin: 0; font-size: .95rem; line-height: 1.7; overflow-wrap: anywhere; }\n#connection-uid { font-family: ui-monospace, monospace; }\nbutton { display: block; width: 100%; min-height: 50px; border: 0; border-radius: 12px; padding: 12px 20px; background: #315c43; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }\nbutton:hover:not(:disabled) { background: #244a34; }\nbutton:focus-visible { outline: 3px solid #a07725; outline-offset: 4px; }\nbutton:disabled { background: #d9e1d7; color: #4e6156; cursor: default; }\n@media (prefers-reduced-motion: no-preference) { button { transition: background .15s; } }\n","connection-runtime.js":"// Public Firebase configuration. Expiry is a client guard, not credential revocation.\nexport default Object.freeze({\n  \"schemaVersion\": 1,\n  \"projectId\": \"wa-awesome-garden-stg\",\n  \"origin\": \"https://wa-awesome-garden-stg.web.app\",\n  \"startsAtMillis\": 1790993700000,\n  \"expiresAtMillis\": 1791082800000,\n  \"firebase\": {\n    \"apiKey\": \"AIzaSyCfa04hxQzY0T6gsVLsvTxIhB2zAB0v874\",\n    \"authDomain\": \"wa-awesome-garden-stg.firebaseapp.com\",\n    \"projectId\": \"wa-awesome-garden-stg\",\n    \"appId\": \"1:120030709276:web:015f4e996b7c42a4e801d9\"\n  },\n  \"appCheck\": {\n    \"provider\": \"recaptcha-enterprise\",\n    \"siteKey\": \"6Lc_LNwtAAAAADRAHvq10FwxirR3c5jZlxS9QpYw\"\n  }\n});\n"},"connectionConfig":"{\n  \"hosting\": {\n    \"site\": \"wa-awesome-garden-stg\",\n    \"public\": \"public\",\n    \"ignore\": [\n      \"**/.*\",\n      \"**/node_modules/**\"\n    ],\n    \"headers\": [\n      {\n        \"source\": \"**\",\n        \"headers\": [\n          {\n            \"key\": \"Cache-Control\",\n            \"value\": \"no-store, max-age=0\"\n          },\n          {\n            \"key\": \"X-Content-Type-Options\",\n            \"value\": \"nosniff\"\n          },\n          {\n            \"key\": \"Referrer-Policy\",\n            \"value\": \"no-referrer\"\n          },\n          {\n            \"key\": \"X-Robots-Tag\",\n            \"value\": \"noindex, nofollow\"\n          }\n        ]\n      },\n      {\n        \"source\": \"/\",\n        \"headers\": [\n          {\n            \"key\": \"Content-Security-Policy\",\n            \"value\": \"default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\"\n          }\n        ]\n      },\n      {\n        \"source\": \"/index.html\",\n        \"headers\": [\n          {\n            \"key\": \"Content-Security-Policy\",\n            \"value\": \"default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\"\n          }\n        ]\n      },\n      {\n        \"source\": \"/404.html\",\n        \"headers\": [\n          {\n            \"key\": \"Content-Security-Policy\",\n            \"value\": \"default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\"\n          }\n        ]\n      },\n      {\n        \"source\": \"/lab/**\",\n        \"headers\": [\n          {\n            \"key\": \"Content-Security-Policy\",\n            \"value\": \"default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\"\n          }\n        ]\n      },\n      {\n        \"source\": \"/connection-check/**\",\n        \"headers\": [\n          {\n            \"key\": \"Content-Security-Policy\",\n            \"value\": \"default-src 'none'; script-src 'self' https://www.gstatic.com/firebasejs/ https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/ https://recaptcha.google.com/recaptcha/; style-src 'self'; img-src 'self' data: https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/; connect-src https://content-firebaseappcheck.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.google.com/recaptcha/ https://recaptcha.google.com/recaptcha/; frame-src https://www.google.com/recaptcha/ https://recaptcha.google.com/recaptcha/; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\"\n          }\n        ]\n      }\n    ]\n  }\n}\n"});
// Updated only after reviewing the diagnostic client; generation never chooses
// a trusted digest from arbitrary source. Both all public files and config pin.
export const CONNECTION_DIGEST = '9bcca9cdf43f3b17e3afbf64f84ea0dcb9737d882688ce92c364cb035aea3ca9';
export const CONNECTION_FILE_HASHES = Object.freeze({
  "app.js": "3746cf5669873970d7d7f5fe032ca7195397c7394c31e8400466dc085c221b0e",
  "connection.js": "f824b8054c3d3de6e5f25af20b99704e51619e4978f5031f6d008b61cd05d8da",
  "index.html": "df9f726f3b13dfa779ae068ab69594502dea548e64586cdf5d4dbf98046cd9b9",
  "style.css": "25aef22d9e8bd13652cccbbd4a2f005a19de8b8b984c7a549d22440875d253e2",
  "connection-runtime.js": "6c062bed22df3e7cd27c506cc2ae67577d1d2b43b396cf166735aee85357d667"
});
export const CONNECTION_NAMES = ['app.js', 'connection-runtime.js', 'connection.js', 'index.html', 'style.css'];
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const present = (v) => v !== undefined && v !== null && v !== '';
const enabled = (v) => v === true || ['true', '1'].includes(String(v).toLowerCase());
export const hash = (value) => createHash('sha256').update(value).digest('hex');
class SafeStop extends Error {}
const stop = (message) => { throw new SafeStop(message); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const COMMON_HEADERS = [
  { key: 'Cache-Control', value: 'no-store, max-age=0' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
];
export function runtimeConfig() {
  return { schemaVersion: 1, projectId: PROJECT, origin: ORIGIN, startsAtMillis: STARTS_AT, expiresAtMillis: EXPIRES_AT,
    firebase: { apiKey: API_KEY, authDomain: `${PROJECT}.firebaseapp.com`, projectId: PROJECT, appId: APP_ID },
    appCheck: { provider: 'recaptcha-enterprise', siteKey: SITE_KEY } };
}
export function runtimeSource() { return `// Public Firebase configuration. Expiry is a client guard, not credential revocation.\nexport default Object.freeze(${JSON.stringify(runtimeConfig(), null, 2)});\n`; }
export function hostingConfig() {
  return { hosting: { site: PROJECT, public: 'public', ignore: ['**/.*', '**/node_modules/**'], headers: [
    { source: '**', headers: COMMON_HEADERS },
    // Disjoint rules: the restrictive maintenance CSP never intersects the
    // connection-check subtree. No catch-all CSP is combined with an allowlist.
    ...['/', '/index.html', '/404.html', '/lab/**'].map((source) => ({ source, headers: [{ key: 'Content-Security-Policy', value: MAINTENANCE_CSP }] })),
    { source: '/connection-check/**', headers: [{ key: 'Content-Security-Policy', value: CONNECTION_CSP }] },
  ] } };
}
export function payloadDigest(payload) {
  return hash(JSON.stringify({ maintenanceHtml: payload.maintenanceHtml, maintenanceConfig: payload.maintenanceConfig, connectionFiles: payload.connectionFiles, connectionConfig: payload.connectionConfig }));
}
export function validatePayload(payload) {
  if (!plain(payload) || !same(Object.keys(payload).sort(), ['connectionConfig', 'connectionFiles', 'maintenanceConfig', 'maintenanceHtml', 'schemaVersion'].sort()) || payload.schemaVersion !== 1) stop('Missing or invalid generated payload; run the local generator first.');
  if (typeof payload.maintenanceHtml !== 'string' || hash(payload.maintenanceHtml) !== '1c2f109e911797f9cc1724ffe692555995c1993f4cca06500ef7180bd6e945a8' || !payload.maintenanceHtml.startsWith('<!doctype html>') || /<script|<iframe|<link|https?:|\bon\w+\s*=/i.test(payload.maintenanceHtml)) stop('Maintenance page is not inert.');
  if (typeof payload.maintenanceConfig !== 'string' || hash(payload.maintenanceConfig) !== 'cab5a176d3b67bd6461bcf0b5cc94792bf1f88f4ccb2fde81de39dd2c84f38ed') stop('Original maintenance configuration bytes changed.');
  let original; try { original = JSON.parse(payload.maintenanceConfig); } catch { stop('Invalid maintenance configuration.'); }
  const expected = { hosting: { site: PROJECT, public: 'public', ignore: ['**/.*', '**/node_modules/**'], headers: [{ source: '**', headers: [...COMMON_HEADERS, { key: 'Content-Security-Policy', value: MAINTENANCE_CSP }] }] } };
  if (!same(original, expected) || payload.connectionConfig !== `${JSON.stringify(hostingConfig(), null, 2)}\n`) stop('Hosting config differs from the exact allowlist.');
  if (!plain(payload.connectionFiles) || !same(Object.keys(payload.connectionFiles).sort(), CONNECTION_NAMES)) stop('Unexpected public connection assets.');
  for (const value of Object.values(payload.connectionFiles)) if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 256 * 1024 || value.includes('\u0000')) stop('Invalid public asset bytes.');
  if (payload.connectionFiles['connection-runtime.js'] !== runtimeSource()) stop('Runtime config differs from the fixed public config/window.');
  // Historical bytes come exclusively from the frozen snapshot, never from
  // the candidate. Independently pin its fixed-CSP and original-CSP identities.
  const previous = PREVIOUS_CONNECTION_PAYLOAD;
  if (previous.schemaVersion !== 1 || payloadDigest(previous) !== PREVIOUS_CONNECTION_DIGEST || previous.connectionConfig !== payload.connectionConfig || previous.maintenanceHtml !== payload.maintenanceHtml || previous.maintenanceConfig !== payload.maintenanceConfig || previous.connectionFiles['connection-runtime.js'] !== runtimeSource()) stop('Historical connection payload identity changed.');
  if (payloadDigest({ ...previous, connectionConfig: previous.connectionConfig.replace(CONNECTION_CSP, ORIGINAL_CONNECTION_CSP) }) !== ORIGINAL_CONNECTION_DIGEST) stop('Original connection payload identity changed.');
  if (!same(Object.keys(CONNECTION_FILE_HASHES).sort(), CONNECTION_NAMES)) stop('Reviewed diagnostic asset hashes are missing.');
  for (const [name, expected] of Object.entries(CONNECTION_FILE_HASHES)) if (hash(payload.connectionFiles[name]) !== expected) stop('Diagnostic asset differs from its reviewed checksum.');
  if (payloadDigest(payload) !== CONNECTION_DIGEST || [ORIGINAL_CONNECTION_DIGEST, PREVIOUS_CONNECTION_DIGEST].includes(CONNECTION_DIGEST)) stop('Diagnostic payload differs from its exact reviewed release.');
  return payload;
}
export function connectionMessage(payload) { validatePayload(payload); return `garden-connection-static-v1:${payloadDigest(payload)}`; }
function directory(path) { const s = lstatSync(path); if (!s.isDirectory() || s.isSymbolicLink()) stop('Unsafe local directory.'); }
function exactFile(path, bytes) { const s = lstatSync(path); if (!s.isFile() || s.isSymbolicLink() || !readFileSync(path).equals(Buffer.from(bytes))) stop('Local bundle or dependency bytes differ from the reviewed payload.'); }
export function writeBundle(dir, payload, kind = 'connection') {
  validatePayload(payload); if (!['connection', 'maintenance'].includes(kind)) stop('Invalid bundle kind.');
  directory(dir); if (readdirSync(dir).length) stop('Bundle directory must be fresh and empty.');
  mkdirSync(join(dir, 'public'), { mode: 0o700 });
  writeFileSync(join(dir, CONFIG_FILE), kind === 'connection' ? payload.connectionConfig : payload.maintenanceConfig, { mode: 0o600 });
  for (const name of ['index.html', '404.html']) writeFileSync(join(dir, 'public', name), payload.maintenanceHtml, { mode: 0o600 });
  if (kind === 'connection') {
    mkdirSync(join(dir, 'public/connection-check'), { mode: 0o700 });
    for (const [name, value] of Object.entries(payload.connectionFiles)) writeFileSync(join(dir, 'public/connection-check', name), value, { mode: 0o600 });
  }
}
export function checkBundle(dir, payload, kind = 'connection') {
  validatePayload(payload); directory(dir); directory(join(dir, 'public'));
  if (!same(readdirSync(dir).sort(), [CONFIG_FILE, 'public']) || !same(readdirSync(join(dir, 'public')).sort(), kind === 'connection' ? ['404.html', 'connection-check', 'index.html'] : ['404.html', 'index.html'])) stop('Unexpected bundle entries.');
  exactFile(join(dir, CONFIG_FILE), kind === 'connection' ? payload.connectionConfig : payload.maintenanceConfig);
  for (const name of ['index.html', '404.html']) exactFile(join(dir, 'public', name), payload.maintenanceHtml);
  if (kind === 'connection') {
    directory(join(dir, 'public/connection-check'));
    if (!same(readdirSync(join(dir, 'public/connection-check')).sort(), CONNECTION_NAMES)) stop('Unexpected public connection files.');
    for (const [name, value] of Object.entries(payload.connectionFiles)) exactFile(join(dir, 'public/connection-check', name), value);
  }
}
export function validateEnvironment(env, execArgv = process.execArgv) {
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'NODE_OPTIONS', 'NODE_V8_COVERAGE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'GOOGLE_APPLICATION_CREDENTIALS', 'GCLOUD_ACCESS_TOKEN', 'GOOGLE_OAUTH_ACCESS_TOKEN']) if (present(env[key])) stop('Environment has credential, proxy, debug, Node or TLS overrides. Stop without bypassing them.');
  for (const [key, value] of Object.entries(env)) if (present(value) && /^npm_config_(?:proxy|http_proxy|https_proxy|noproxy|cafile|ca|cert|key|strict_ssl|registry|userconfig|globalconfig|node_options|_auth|_authToken)$/i.test(key)) stop('npm proxy, TLS, registry or configuration overrides are not allowed.');
  if (execArgv.some((arg) => /inspect|trace|heap|prof|report|require|import/i.test(arg))) stop('Node inspection/diagnostic/injection options are not allowed.');
  for (const [key, value] of Object.entries(env)) if (present(value) && (key.startsWith('CLOUDSDK_API_ENDPOINT_OVERRIDES_') || key.startsWith('FIREBASE_') || /_EMULATOR_HOST$/.test(key) || /^GOOGLE_(API_USE|CLOUD_UNIVERSE_DOMAIN)/.test(key) || /^CLOUDSDK_AUTH_(ACCESS_TOKEN|ACCESS_TOKEN_FILE|CREDENTIAL_FILE_OVERRIDE|IMPERSONATE_SERVICE_ACCOUNT|TOKEN_HOST|AUTH_HOST)$/.test(key))) stop('Environment has credential or API route overrides. Stop without changing them.');
  for (const key of ['CLOUDSDK_AUTH_DISABLE_CREDENTIALS', 'CLOUDSDK_AUTH_DISABLE_SSL_VALIDATION', 'CLOUDSDK_CORE_DISABLE_SSL_VALIDATION']) if (enabled(env[key])) stop('Environment weakens authentication or TLS.');
}
export function validateConfiguration(config) {
  if (!plain(config)) stop('Could not verify existing gcloud configuration.');
  for (const section of ['core', 'auth', 'proxy', 'regional', 'api_endpoint_overrides']) if (config[section] !== undefined && !plain(config[section])) stop('Malformed gcloud configuration section.');
  if (Object.values(config.api_endpoint_overrides ?? {}).some(present) || ['type', 'address', 'port', 'username', 'password'].some((key) => present(config.proxy?.[key]))) stop('Custom API endpoint or proxy configuration. Stop without bypassing it.');
  for (const key of ['impersonate_service_account', 'credential_file_override', 'access_token_file', 'access_token']) if (present(config.auth?.[key])) stop('Credential or impersonation override.');
  if (enabled(config.auth?.disable_credentials) || enabled(config.auth?.disable_ssl_validation) || enabled(config.core?.disable_ssl_validation) || present(config.core?.custom_ca_certs_file)) stop('Authentication/TLS configuration is not the reviewed default.');
  if (present(config.auth?.token_host) && !['https://oauth2.googleapis.com/token', 'https://accounts.google.com/o/oauth2/token'].includes(config.auth.token_host)) stop('Nonstandard token endpoint.');
  if (present(config.auth?.auth_host) && !['https://accounts.google.com/o/oauth2/auth', 'https://accounts.google.com/o/oauth2/v2/auth'].includes(config.auth.auth_host)) stop('Nonstandard authentication endpoint.');
  if (present(config.core?.universe_domain) && config.core.universe_domain !== 'googleapis.com') stop('Nonstandard cloud universe.');
  if (present(config.regional?.endpoint_mode) && config.regional.endpoint_mode !== 'global') stop('Regional endpoint override.');
}
export function makeRunner({ exec = execFileSync, env = process.env } = {}) {
  return (command, args, cwd) => {
    try { return exec(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024, timeout: 10 * 60 * 1000, env: { ...env, NO_COLOR: '1', FORCE_COLOR: '0', CI: 'true', CLOUDSDK_CORE_DISABLE_PROMPTS: 'true', CLOUDSDK_CORE_LOG_HTTP: 'false', CLOUDSDK_CORE_DISABLE_FILE_LOGGING: 'true' } }) || ''; }
    catch { stop('Command failed or timed out. Raw credential/debug output suppressed. Inspect only; no write retry.'); }
  };
}
async function download(url, fetchImpl, maxBytes, status = 200) {
  const response = await fetchImpl(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30000) });
  if (response.status !== status) stop('Required HTTPS read returned an unexpected status.');
  const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > maxBytes) stop('Unexpected response size.');
  return { bytes, response };
}
function verifyDependencyManifests(dir) {
  directory(dir);
  for (const [name, expected] of Object.entries(DEPENDENCIES)) {
    const path = join(dir, name); const s = lstatSync(path);
    if (!s.isFile() || s.isSymbolicLink() || hash(readFileSync(path)) !== expected) stop('Pinned dependency manifest checksum mismatch.');
  }
  const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
  for (const [name, info] of Object.entries(lock.packages ?? {})) {
    if (!name) continue;
    if (typeof info.resolved !== 'string' || !info.resolved.startsWith('https://registry.npmjs.org/') || typeof info.integrity !== 'string' || !info.integrity.startsWith('sha512-') || info.link) stop('Dependency is not an integrity-locked official npm package.');
  }
}
export async function prepareDependencies({ dir, run = makeRunner(), fetchImpl = fetch, env = process.env, execArgv = process.execArgv, log = console.log } = {}) {
  validateEnvironment(env, execArgv);
  if (typeof dir !== 'string' || !dir) stop('A fresh local dependency directory is required.');
  mkdirSync(dir, { mode: 0o700 });
  for (const [name, expected] of Object.entries(DEPENDENCIES)) {
    const { bytes } = await download(`https://raw.githubusercontent.com/fabdemnt-dev/wa-awesome/${DEPENDENCY_REVISION}/${name}`, fetchImpl, 2 * 1024 * 1024);
    if (hash(bytes) !== expected) stop('Pinned dependency manifest checksum mismatch.');
    writeFileSync(join(dir, name), bytes, { mode: 0o600 });
  }
  verifyDependencyManifests(dir);
  // No lifecycle scripts, registry substitution, cloud calls, or auth changes.
  const userConfig = join(dir, 'empty-user.npmrc'), globalConfig = join(dir, 'empty-global.npmrc');
  writeFileSync(userConfig, '', { mode: 0o600 }); writeFileSync(globalConfig, '', { mode: 0o600 });
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/', `--userconfig=${userConfig}`, `--globalconfig=${globalConfig}`], dir);
  checkTooling(dir, run);
  log(`LOCAL_DEPS_READY: ${dir}. No cloud read or write was performed.`);
  return dir;
}
export function checkTooling(dir, run) {
  verifyDependencyManifests(dir);
  const root = realpathSync(dir), firebase = join(root, 'node_modules/firebase-tools/lib/bin/firebase.js');
  for (const path of [join(root, 'node_modules'), join(root, 'node_modules/firebase-tools'), join(root, 'node_modules/firebase-tools/lib'), join(root, 'node_modules/firebase-tools/lib/bin')]) directory(path);
  const s = lstatSync(firebase); if (!s.isFile() || s.isSymbolicLink() || !realpathSync(firebase).startsWith(`${root}/`)) stop('Pinned CLI path is not local.');
  if (JSON.parse(readFileSync(join(root, 'node_modules/firebase-tools/package.json'), 'utf8')).version !== '14.27.0' || run(process.execPath, [firebase, '--version'], root).trim() !== '14.27.0') stop('Pinned CLI version mismatch.');
  return firebase;
}
function parse(raw, stage) { try { return JSON.parse(raw); } catch { stop(`${stage}: invalid JSON. Raw output suppressed.`); } }
function cliResult(raw) { const result = parse(raw, 'CLI'); if (result.status !== 'success' || !plain(result.result)) stop('CLI did not confirm success. Inspect before any later action.'); return result.result; }
export function canonicalVersionName(value) {
  const match = typeof value === 'string' && value.match(new RegExp(`^(?:projects/(?:${PROJECT}|${PROJECT_NUMBER})/)?sites/${PROJECT}/versions/([A-Za-z0-9_-]+)$`));
  if (!match || match[0] !== value) stop('Hosting version does not name the exact dedicated site.');
  return `sites/${PROJECT}/versions/${match[1]}`;
}
export function sitePresent(result) {
  const names = [PROJECT, PROJECT_NUMBER].map((p) => `projects/${p}/sites/${PROJECT}`);
  if (!Array.isArray(result.sites) || result.sites.some((s) => !plain(s) || typeof s.name !== 'string')) stop('Invalid site inventory.');
  const found = result.sites.filter((s) => names.includes(s.name));
  if (found.length !== 1 || found[0].defaultUrl !== ORIGIN) stop('Exact dedicated site must already exist. This helper creates no site.');
  return true;
}
export function liveChannel(result) {
  const names = [`sites/${PROJECT}`, ...[PROJECT, PROJECT_NUMBER].map((p) => `projects/${p}/sites/${PROJECT}`)];
  if (!Array.isArray(result.channels) || result.channels.some((c) => !plain(c) || !names.some((s) => typeof c.name === 'string' && c.name.startsWith(`${s}/channels/`)))) stop('Invalid channel inventory.');
  const matches = result.channels.filter((c) => names.some((s) => c.name === `${s}/channels/live`));
  if (matches.length !== 1 || matches[0].url !== ORIGIN || matches[0].expireTime) stop('Unexpected live channel identity.');
  return matches[0];
}
export function releaseIdentity(channel, payload) {
  const r = channel?.release;
  if (!plain(r) || r.type !== 'DEPLOY' || !plain(r.version) || r.version.status !== 'FINALIZED' || ![MAINTENANCE_MESSAGE, ORIGINAL_CONNECTION_MESSAGE, PREVIOUS_CONNECTION_MESSAGE, connectionMessage(payload)].includes(r.message)) stop('Existing live release is not recognized. Stop; do not overwrite it.');
  return { version: canonicalVersionName(r.version.name), message: r.message, kind: r.message === MAINTENANCE_MESSAGE ? 'maintenance' : r.message === ORIGINAL_CONNECTION_MESSAGE ? 'original-connection' : r.message === PREVIOUS_CONNECTION_MESSAGE ? 'previous-connection' : 'connection' };
}
export async function verifyPublic(payload, kind, fetchImpl = fetch) {
  validatePayload(payload);
  if (!['maintenance', 'original-connection', 'previous-connection', 'connection'].includes(kind)) stop('Unrecognized public release kind.');
  const reads = [['/', 200, payload.maintenanceHtml, MAINTENANCE_CSP], ['/index.html', 200, payload.maintenanceHtml, MAINTENANCE_CSP], ['/404.html', 200, payload.maintenanceHtml, MAINTENANCE_CSP], ['/lab/floating-garden/trial/index.html', 404, payload.maintenanceHtml, MAINTENANCE_CSP]];
  if (kind !== 'maintenance') {
    const files = kind === 'connection' ? payload.connectionFiles : PREVIOUS_CONNECTION_PAYLOAD.connectionFiles;
    const csp = kind === 'original-connection' ? ORIGINAL_CONNECTION_CSP : CONNECTION_CSP;
    for (const [name, value] of Object.entries(files)) reads.push([`/connection-check/${name}`, 200, value, csp]);
    reads.push(['/connection-check/', 200, files['index.html'], csp]);
  } else {
    // A restored maintenance release must make every formerly published file inert.
    for (const name of CONNECTION_NAMES) reads.push([`/connection-check/${name}`, 404, payload.maintenanceHtml, MAINTENANCE_CSP]);
    reads.push(['/connection-check/', 404, payload.maintenanceHtml, MAINTENANCE_CSP]);
  }
  for (const [path, status, expected, csp] of reads) {
    const { bytes, response } = await download(`${ORIGIN}${path}`, fetchImpl, 256 * 1024, status);
    if (!bytes.equals(Buffer.from(expected))) stop('Hosted bytes differ from the reviewed payload.');
    for (const h of [...COMMON_HEADERS, { key: 'Content-Security-Policy', value: csp }]) if (response.headers.get(h.key) !== h.value) stop('Exact hosted safety headers were not confirmed.');
  }
  return { publicBytesVerified: true, fullExistingReleaseInventoryVerified: false };
}
export function validateWindow(now) {
  if (!Number.isSafeInteger(now) || now < STARTS_AT || now > EXPIRES_AT - 10 * 60 * 1000) stop('Connection window is not open with at least ten minutes remaining.');
}
export async function operate({ mode = 'inspect', payload = EMBEDDED, toolingDir, run = makeRunner(), fetchImpl = fetch, log = console.log, env = process.env, execArgv = process.execArgv, tempRoot = tmpdir(), now = Date.now } = {}) {
  let issued = false, channels, last;
  try {
    if (!['inspect', 'deploy', 'stop'].includes(mode)) stop('Invalid operator mode.');
    if (Number(process.versions.node.split('.')[0]) < 20) stop('Node 20 or newer is required.');
    validatePayload(payload); validateEnvironment(env, execArgv);
    if (mode === 'deploy') validateWindow(now());
    const gcloud = (args, stage) => parse(run('gcloud', [...args, `--project=${PROJECT}`, `--billing-project=${PROJECT}`, '--format=json', '--verbosity=error']), stage);
    validateConfiguration(gcloud(['config', 'list', '--all'], 'Configuration'));
    const p = gcloud(['projects', 'describe', PROJECT], 'Project');
    if (!plain(p) || p.projectId !== PROJECT || String(p.projectNumber) !== PROJECT_NUMBER || p.lifecycleState !== 'ACTIVE') stop('Exact active project ID/number was not verified.');
    const apis = gcloud(['services', 'list', '--enabled'], 'API inventory');
    if (!Array.isArray(apis) || apis.some((a) => !plain(a) || !plain(a.config) || typeof a.config.name !== 'string') || !apis.some((a) => a.config.name === 'firebasehosting.googleapis.com')) stop('Hosting API is not already enabled. This helper enables none.');
    const firebase = checkTooling(toolingDir, run);
    const base = mkdtempSync(join(tempRoot, 'garden-connection-')), bundle = join(base, 'bundle'), work = join(base, 'work');
    mkdirSync(bundle, { mode: 0o700 }); mkdirSync(work, { mode: 0o700 });
    const targetKind = mode === 'stop' ? 'maintenance' : 'connection';
    writeBundle(bundle, payload, targetKind);
    const cli = (args) => cliResult(run(process.execPath, [firebase, ...args, '--config', join(bundle, CONFIG_FILE), '--project', PROJECT, '--non-interactive', '--json'], work));
    channels = () => releaseIdentity(liveChannel(cli(['hosting:channel:list', '--site', PROJECT])), payload);
    sitePresent(cli(['hosting:sites:list']));
    last = channels();
    await verifyPublic(payload, last.kind, fetchImpl);
    log(`READ_VERIFIED: ${last.kind}; root, 404, old game path and connection paths checked. Full prior release file inventory was not audited.`);
    if (mode === 'inspect' || last.kind === targetKind) {
      const final = channels(); if (!same(final, last)) stop('Live release changed during read verification.');
      log(`${mode === 'inspect' ? 'INSPECT_COMPLETE' : 'ALREADY_VERIFIED'}: ${ORIGIN}; no deployment performed.`);
      return { origin: ORIGIN, deployed: false, kind: last.kind, version: last.version, fullExistingReleaseInventoryVerified: false };
    }
    if (mode === 'deploy' && last.kind === 'original-connection') stop('Original pre-fix release cannot migrate directly to diagnostics. Inspect or stop only; no write issued.');
    // Narrow the race; Hosting offers no compare-and-swap through this CLI.
    // A simultaneous external publisher cannot be ruled out; this is not a lock.
    checkBundle(bundle, payload, targetKind);
    sitePresent(cli(['hosting:sites:list']));
    const race = channels(); if (!same(last, race)) stop('Live release changed before publication. No write issued.');
    checkBundle(bundle, payload, targetKind);
    if (mode === 'deploy') validateWindow(now());
    const message = targetKind === 'connection' ? connectionMessage(payload) : MAINTENANCE_MESSAGE;
    log(`WRITE_ONCE: exact ${PROJECT} Hosting live ${targetKind} release. No write retry or automatic rollback.`);
    issued = true;
    const result = cli(['deploy', '--only', `hosting:${PROJECT}`, '--message', message]);
    if (typeof result.hosting !== 'string') stop('Deployment result is uncertain.');
    const returnedVersion = canonicalVersionName(result.hosting);
    last = channels();
    if (last.version !== returnedVersion || last.kind !== targetKind) stop('Live release does not match the acknowledged deployment.');
    await verifyPublic(payload, targetKind, fetchImpl);
    const final = channels(); if (!same(last, final)) stop('Live release changed during post-publication verification.');
    log(`VERIFIED: ${ORIGIN}${targetKind === 'connection' ? '/connection-check/' : '/'}; exact public bytes and safety headers match the acknowledged release.`);
    log('LIMIT: expiry is a client guard only; it does not remove files, revoke credentials or change App Check/Auth enforcement. The game seven-day clock was not changed.');
    return { origin: ORIGIN, deployed: true, kind: targetKind, version: returnedVersion, fullExistingReleaseInventoryVerified: false };
  } catch (error) {
    if (issued) {
      log('PARTIAL_STATE: one deployment was attempted; it may have completed. DO_NOT_RETRY. No rollback or second write was attempted.');
      // Even an unknown command result permits only one subsequent metadata read.
      if (channels) try { const observed = channels(); log(`READBACK_ONLY: recognized ${observed.kind} release. Re-run --inspect before any separately authorized action.`); } catch { log('READBACK_ONLY: live release could not be established; stop for human review.'); }
    }
    if (error instanceof SafeStop) throw error;
    stop('Unexpected operation failure. Raw diagnostics suppressed; inspect only before deciding any further action.');
  }
}
export function plan(log = console.log) {
  log(`PLAN_ONLY: ${PROJECT} / ${PROJECT_NUMBER}; ${ORIGIN}/connection-check/. No subprocess, network or local write.`);
  log('Publishes only the connection-check assets; exact maintenance root/404 remain. No game, Firestore, Functions, Rules, Auth configuration, API or IAM changes; no login/token commands.');
  log('Window: 2026-10-03T02:15:00Z to 2026-10-04T03:00:00Z. Client expiry is not security revocation; the game trial clock is unchanged.');
  log('First: --prepare-local-deps --tooling-dir ABSENT_DIRECTORY (official checksum-locked npm; ignore-scripts; local only).');
  log('Then: --inspect --tooling-dir DIRECTORY (read-only); explicitly authorized --deploy-connection-check publishes once; separately authorized --stop-connection-check restores maintenance once.');
  log('Deploy migrates only the exact reviewed fixed-CSP connection release or exact maintenance. Original pre-fix release supports inspect/stop only.');
  log('Existing exact site and a recognized release are required. Unknown state is never overwritten. Writes are never retried. Same recognized release is verified without redeploying.');
}
export async function main(args = process.argv.slice(2)) {
  if (!args.length || same(args, ['--plan'])) { plan(); return; }
  const modes = ['--prepare-local-deps', '--inspect', '--deploy-connection-check', '--stop-connection-check'];
  if (!modes.includes(args[0]) || args.length !== 3 || args[1] !== '--tooling-dir' || !args[2] || !args[2].startsWith('/')) stop('Use --plan, or one explicit mode followed by --tooling-dir ABSOLUTE_DIRECTORY.');
  process.umask(0o077);
  if (args[0] === '--prepare-local-deps') await prepareDependencies({ dir: resolve(args[2]) });
  else await operate({ mode: ({ '--inspect': 'inspect', '--deploy-connection-check': 'deploy', '--stop-connection-check': 'stop' })[args[0]], toolingDir: resolve(args[2]) });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(`STOP: ${error instanceof SafeStop ? error.message : 'Unexpected local failure; raw diagnostics suppressed.'}`); process.exitCode = 1; }
}

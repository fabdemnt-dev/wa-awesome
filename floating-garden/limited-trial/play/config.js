import { isAllowedPublicOrigin, hasExactPublicAuthority } from './public-origins.js';
import { PUBLIC_POLICY } from './public-policy.js';
// This production profile is explicit source, never derived from location, storage,
// injected globals, another Firebase app, or the existing game's resolver.
export const PUBLIC_ROOM_TTL_MILLIS = 24 * 60 * 60 * 1000;
export const PUBLIC_RETENTION_MILLIS = 7 * 24 * 60 * 60 * 1000;
export const TRIAL_REGION = 'asia-northeast1';
export const PRODUCTION_PROJECT_ID = 'wa-awesome';
export const PRODUCTION_PROJECT_NUMBER = '1074804319870';
export const PRODUCTION_ORIGIN = 'https://fabdemnt-dev.github.io';
export const PRODUCTION_AUTH_APP_NAME = 'floating-garden-production-wa-awesome';
// Public Web App identifiers copied from main 40eac3212154ddb3092562634faf17ed4e0dbd50.
// No RTDB endpoint is used: Garden only loads its Auth/Firestore/Functions SDKs.
export const PRODUCTION_FIREBASE_CONFIG = Object.freeze({
  "apiKey": "AIzaSyBtb74uz6clsoc9uA_AkDHi7DdepEWn2dw",
  "authDomain": "wa-awesome.firebaseapp.com",
  "projectId": "wa-awesome",
  "storageBucket": "wa-awesome.firebasestorage.app",
  "messagingSenderId": "1074804319870",
  "appId": "1:1074804319870:web:923f0ec866812f98ae5a2f"
});
export const PRODUCTION_APP_CHECK_SITE_KEY = '6LeU8sstAAAAAOEyP56nWLD633TiAWaLmvcskE6e';
const TOP_KEYS = ['schemaVersion', 'enabled', 'projectId', 'projectNumber', 'origin', 'epochId', 'region', 'maxRooms', 'roomTtlMillis', 'retentionMillis', 'firebase', 'appCheck'];
const FIREBASE_KEYS = Object.keys(PRODUCTION_FIREBASE_CONFIG);
const APP_CHECK_KEYS = ['provider', 'siteKey', 'verified'];
const blocked = (message, code = 'public/config-blocked') => Object.assign(new Error(message), { code });
function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw blocked(`${label}の項目が不足しているか、未対応の設定があります`);
}
// Pure shape/identity check for offline review. This NEVER grants connection.
// The separate immutable source gate below must also pass before any SDK import.
export function validatePublicProfile(input) {
  exactKeys(input, TOP_KEYS, '本番用公開設定');
  if (Object.entries(PUBLIC_POLICY).some(([key, value]) => key !== 'enabled' && input[key] !== value)) throw blocked('本番公開設定の版が一致しません');
  if (typeof input.enabled !== 'boolean' || input.schemaVersion !== 1) throw blocked('公開設定の形式が一致しません');
  if (input.projectId !== PRODUCTION_PROJECT_ID || input.projectNumber !== PRODUCTION_PROJECT_NUMBER) throw blocked('既存本番プロジェクトの識別子が一致しません');
  if (input.region !== TRIAL_REGION || input.origin !== PRODUCTION_ORIGIN || !isAllowedPublicOrigin(input.origin) || input.maxRooms !== 20) throw blocked('本番の配信元・リージョン・部屋数が一致しません');
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(input.epochId || '') || input.roomTtlMillis !== PUBLIC_ROOM_TTL_MILLIS || input.retentionMillis !== PUBLIC_RETENTION_MILLIS) throw blocked('公開回・部屋の利用期間・保持方針が一致しません');
  exactKeys(input.firebase, FIREBASE_KEYS, 'Firebase設定');
  if (Object.entries(PRODUCTION_FIREBASE_CONFIG).some(([key, value]) => input.firebase[key] !== value)) throw blocked('既存本番の正確なFirebase Webアプリ設定が必要です');
  exactKeys(input.appCheck, APP_CHECK_KEYS, 'App Check設定');
  if (input.appCheck.provider !== 'recaptcha-enterprise' || input.appCheck.siteKey !== PRODUCTION_APP_CHECK_SITE_KEY || typeof input.appCheck.verified !== 'boolean') throw blocked('既存本番の正確なApp Check Enterpriseキーが必要です');
  return Object.freeze({ ...input, firebase: Object.freeze({ ...input.firebase }), appCheck: Object.freeze({ ...input.appCheck }) });
}
export function validatePublicConfig(input) {
  const config = validatePublicProfile(input);
  // Both immutable source policy and exact runtime flags must permit this limited trial.
  if (PUBLIC_POLICY.enabled !== true || config.enabled !== true) throw blocked('この公開版用接続は有効になっていません');
  if (config.appCheck.verified !== true) throw blocked('App Checkの許可ドメインと本番トークン発行が未確認です');
  return config;
}
export function assertPublicAccess(config, location, now = Date.now()) {
  const href = typeof location === 'string' ? location : location?.href;
  let current;
  try { current = new URL(href); } catch { throw blocked('このページの配信元を確認できません', 'public/access-blocked'); }
  // Reject even a bare query marker; fragments are mode selection only, never config.
  if (!hasExactPublicAuthority(href) || current.protocol !== 'https:' || !isAllowedPublicOrigin(current.origin) || current.port || current.username || current.password || href.split('#')[0].includes('?')) throw blocked('この公開版は指定されたHTTPS配信元だけで利用できます。URLの追加設定は利用できません', 'public/access-blocked');
  return config;
}
export function resolvePublicEnvironment(input, location, now = Date.now()) {
  return assertPublicAccess(validatePublicConfig(input), location, now);
}
// Retain entry/transport import compatibility without retaining the staging profile.
export const validateTrialConfig = validatePublicConfig;
export const assertTrialAccess = assertPublicAccess;
export const resolveTrialEnvironment = resolvePublicEnvironment;

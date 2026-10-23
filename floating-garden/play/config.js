import { isAllowedPublicOrigin, hasExactPublicAuthority } from './public-origins.js';
import { PUBLIC_POLICY } from './public-policy.js';
// The public client is an opt-in, generated build target. Never derive config from the page,
// query string, saved storage, another Firebase app, or the repository's production config.
export const PUBLIC_ROOM_TTL_MILLIS = 24 * 60 * 60 * 1000;
export const PUBLIC_RETENTION_MILLIS = 7 * 24 * 60 * 60 * 1000;
export const TRIAL_REGION = 'asia-northeast1';
// Fixed Hosting is permitted only for this reviewed garden-only project/site pair.
// The canonical public policy pins the single reviewed origin.
export const FIXED_TRIAL_PROJECT = 'wa-awesome-garden-stg';
export const FIXED_TRIAL_ORIGIN = 'https://wa-awesome-garden-stg.web.app';
const TOP_KEYS = ['schemaVersion', 'enabled', 'projectId', 'origin', 'epochId', 'region', 'maxRooms', 'roomTtlMillis', 'retentionMillis', 'firebase', 'appCheck'];
const FIREBASE_KEYS = ['apiKey', 'authDomain', 'projectId', 'appId'];
const APP_CHECK_KEYS = ['provider', 'siteKey', 'verified'];
// These are PUBLIC Firebase Web App identifiers already shipped by the existing
// games. Auth routes by apiKey, independently of projectId/authDomain, so reject
// accidental copies even when every project label has been changed.
// Do not import the production configuration or reuse its environment resolver.
const EXCLUDED_WEB_CLIENTS = Object.freeze([
  Object.freeze({ apiKey: 'AIzaSyBtb74uz6clsoc9uA_AkDHi7DdepEWn2dw', appId: '1:1074804319870:web:923f0ec866812f98ae5a2f' }),
  Object.freeze({ apiKey: 'AIzaSyB1oIhZWMryuWZV9r2-nO9X4W6LuqXVvlo', appId: '1:481875415725:web:e16ec434ac7cddd117ec24' }),
]);

const blocked = (message, code = 'public/config-blocked') => Object.assign(new Error(message), { code });
function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw blocked(`${label}の項目が不足しているか、未対応の設定があります`);
}
export function validatePublicConfig(input) {
  exactKeys(input, TOP_KEYS, '公開版設定');
  if (Object.entries(PUBLIC_POLICY).some(([key, value]) => input[key] !== value)) throw blocked('公開設定の版が一致しません');
  if (input.schemaVersion !== 1 || input.enabled !== true) throw blocked('この公開版用接続は有効になっていません');
  const project = input.projectId;
  if (typeof project !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project) || ['wa-awesome', 'wa-awesome-mofumofu-stg'].includes(project) || (/^(demo|local)/.test(project) || /(^|[-])(demo|local|localhost)([-]|$)/.test(project))) throw blocked('専用の公開版プロジェクトを明示してください');
  if (input.region !== TRIAL_REGION || input.maxRooms !== 20) throw blocked('公開版のリージョン・部屋数の安全設定が一致しません');
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(input.epochId || '') || input.roomTtlMillis !== PUBLIC_ROOM_TTL_MILLIS || input.retentionMillis !== PUBLIC_RETENTION_MILLIS) throw blocked('公開回・部屋の利用期間・保持方針が一致しません');
  let origin;
  try { origin = new URL(input.origin); } catch { throw blocked('公開版専用の配信URLがありません'); }
  const previewHost = new RegExp(`^${project}--[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-[a-z0-9]{4,20}\\.web\\.app$`);
  if (typeof input.origin !== 'string' || origin.protocol !== 'https:' || input.origin !== origin.origin || origin.port || origin.username || origin.password || !(previewHost.test(origin.hostname) || (project === FIXED_TRIAL_PROJECT && input.origin === FIXED_TRIAL_ORIGIN)) || origin.hostname.split('.')[0].length > 63) throw blocked('専用プロジェクトの正確なHTTPS配信URLだけを指定できます');
  exactKeys(input.firebase, FIREBASE_KEYS, 'Firebase設定');
  if (input.firebase.projectId !== project || input.firebase.authDomain !== `${project}.firebaseapp.com` || typeof input.firebase.apiKey !== 'string' || !/^AIza[A-Za-z0-9_-]{35}$/.test(input.firebase.apiKey) || typeof input.firebase.appId !== 'string' || !/^1:[0-9]+:web:[a-f0-9]+$/.test(input.firebase.appId)) throw blocked('専用プロジェクトの確認済みFirebase Webアプリ設定が必要です');
  if (EXCLUDED_WEB_CLIENTS.some(({ apiKey, appId }) => input.firebase.apiKey === apiKey || input.firebase.appId === appId)) throw blocked('既存サービスのFirebase Webアプリ識別子は公開版に使用できません');
  // Syntax and this denylist cannot prove ownership of another key. Before
  // generating an enabled build, the operator must verify that ALL Web App fields
  // belong to the approved dedicated project in the Firebase console.
  exactKeys(input.appCheck, APP_CHECK_KEYS, 'App Check設定');
  if (input.appCheck.provider !== 'recaptcha-enterprise' || input.appCheck.verified !== true || typeof input.appCheck.siteKey !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(input.appCheck.siteKey) || /placeholder|replace|example|your[_-]?site|test[_-]?key/i.test(input.appCheck.siteKey)) throw blocked('正確な配信URLに登録した確認済みApp Check Enterpriseキーが必要です');
  return Object.freeze({ ...input, firebase: Object.freeze({ ...input.firebase }), appCheck: Object.freeze({ ...input.appCheck }) });
}
export function assertPublicAccess(config, location, now = Date.now()) {
  let current;
  const href = typeof location === 'string' ? location : location?.href;
  try { current = new URL(typeof location === 'string' ? location : location?.href); } catch { throw blocked('このページの配信元を確認できません', 'public/access-blocked'); }
  if (!hasExactPublicAuthority(href) || current.protocol !== 'https:' || !isAllowedPublicOrigin(current.origin) || current.port || current.username || current.password || current.search) throw blocked('この公開版は指定されたHTTPS配信URLだけで利用できます。URLの追加設定は利用できません', 'public/access-blocked');
  return config;
}
export function resolvePublicEnvironment(input, location, now = Date.now()) {
  return assertPublicAccess(validatePublicConfig(input), location, now);
}

// Retained import compatibility; these now validate the public-only schema.
export const validateTrialConfig = validatePublicConfig;
export const assertTrialAccess = assertPublicAccess;
export const resolveTrialEnvironment = resolvePublicEnvironment;

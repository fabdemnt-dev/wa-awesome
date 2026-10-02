// The trial is an opt-in, generated build target. Never derive config from the page,
// query string, saved storage, another Firebase app, or the repository's production config.
export const TRIAL_MAX_DURATION_MILLIS = 7 * 24 * 60 * 60 * 1000;
export const TRIAL_REGION = 'asia-northeast1';
const TOP_KEYS = ['schemaVersion', 'enabled', 'projectId', 'previewOrigin', 'startsAtMillis', 'endsAtMillis', 'region', 'maxTesters', 'maxRooms', 'firebase', 'appCheck'];
const FIREBASE_KEYS = ['apiKey', 'authDomain', 'projectId', 'appId'];
const APP_CHECK_KEYS = ['provider', 'siteKey', 'verified'];
// These are PUBLIC Firebase Web App identifiers already shipped by the existing
// games. Auth routes by apiKey, independently of projectId/authDomain, so reject
// accidental copies even when every project label has been changed to the trial.
// Do not import the production configuration or reuse its environment resolver.
const EXCLUDED_WEB_CLIENTS = Object.freeze([
  Object.freeze({ apiKey: 'AIzaSyBtb74uz6clsoc9uA_AkDHi7DdepEWn2dw', appId: '1:1074804319870:web:923f0ec866812f98ae5a2f' }),
  Object.freeze({ apiKey: 'AIzaSyB1oIhZWMryuWZV9r2-nO9X4W6LuqXVvlo', appId: '1:481875415725:web:e16ec434ac7cddd117ec24' }),
]);

const blocked = (message, code = 'trial/config-blocked') => Object.assign(new Error(message), { code });
function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw blocked(`${label}の項目が不足しているか、未対応の設定があります`);
}
export function validateTrialConfig(input) {
  exactKeys(input, TOP_KEYS, '試験設定');
  if (input.schemaVersion !== 1 || input.enabled !== true) throw blocked('この試験用接続は有効になっていません');
  const project = input.projectId;
  if (typeof project !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project) || ['wa-awesome', 'wa-awesome-mofumofu-stg'].includes(project) || (/^(demo|local)/.test(project) || /(^|[-])(demo|local|localhost)([-]|$)/.test(project))) throw blocked('専用の試験プロジェクトを明示してください');
  if (input.region !== TRIAL_REGION || input.maxTesters !== 2 || input.maxRooms !== 20) throw blocked('試験のリージョン・参加人数・部屋数の安全設定が一致しません');
  if (!Number.isSafeInteger(input.startsAtMillis) || !Number.isSafeInteger(input.endsAtMillis) || input.startsAtMillis <= 0 || input.endsAtMillis <= input.startsAtMillis || input.endsAtMillis - input.startsAtMillis > TRIAL_MAX_DURATION_MILLIS) throw blocked('試験期間は開始・終了を固定した最長7日間にしてください');
  let origin;
  try { origin = new URL(input.previewOrigin); } catch { throw blocked('試験専用の配信URLがありません'); }
  const previewHost = new RegExp(`^${project}--[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-[a-z0-9]{4,20}\\.web\\.app$`);
  if (typeof input.previewOrigin !== 'string' || origin.protocol !== 'https:' || input.previewOrigin !== origin.origin || origin.port || origin.username || origin.password || !previewHost.test(origin.hostname) || origin.hostname.split('.')[0].length > 63) throw blocked('専用プロジェクトの正確なHTTPSプレビューURLだけを指定できます');
  exactKeys(input.firebase, FIREBASE_KEYS, 'Firebase設定');
  if (input.firebase.projectId !== project || input.firebase.authDomain !== `${project}.firebaseapp.com` || typeof input.firebase.apiKey !== 'string' || !/^AIza[A-Za-z0-9_-]{35}$/.test(input.firebase.apiKey) || typeof input.firebase.appId !== 'string' || !/^1:[0-9]+:web:[a-f0-9]+$/.test(input.firebase.appId)) throw blocked('専用プロジェクトの確認済みFirebase Webアプリ設定が必要です');
  if (EXCLUDED_WEB_CLIENTS.some(({ apiKey, appId }) => input.firebase.apiKey === apiKey || input.firebase.appId === appId)) throw blocked('既存サービスのFirebase Webアプリ識別子は試験に使用できません');
  // Syntax and this denylist cannot prove ownership of another key. Before
  // generating an enabled build, the operator must verify that ALL Web App fields
  // belong to the approved NEW dedicated project in the Firebase console.
  exactKeys(input.appCheck, APP_CHECK_KEYS, 'App Check設定');
  if (input.appCheck.provider !== 'recaptcha-enterprise' || input.appCheck.verified !== true || typeof input.appCheck.siteKey !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(input.appCheck.siteKey) || /placeholder|replace|example|your[_-]?site|test[_-]?key/i.test(input.appCheck.siteKey)) throw blocked('正確なプレビューURLに登録した確認済みApp Check Enterpriseキーが必要です');
  return Object.freeze({ ...input, firebase: Object.freeze({ ...input.firebase }), appCheck: Object.freeze({ ...input.appCheck }) });
}
export function assertTrialAccess(config, location, now = Date.now()) {
  let current;
  try { current = new URL(typeof location === 'string' ? location : location?.href); } catch { throw blocked('このページの配信元を確認できません', 'trial/access-blocked'); }
  if (current.protocol !== 'https:' || current.origin !== config.previewOrigin || current.port || current.username || current.password || current.search) throw blocked('この試験は指定されたHTTPSプレビューURLだけで利用できます。URLの追加設定は利用できません', 'trial/access-blocked');
  if (!Number.isSafeInteger(now) || now < config.startsAtMillis || now >= config.endsAtMillis) throw blocked('試験の開始前、または試験期間が終了しています', 'trial/access-blocked');
  return config;
}
export function resolveTrialEnvironment(input, location, now = Date.now()) {
  return assertTrialAccess(validateTrialConfig(input), location, now);
}

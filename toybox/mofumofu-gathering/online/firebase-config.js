const host = globalThis.location?.hostname || '';
const injected = Object.freeze(globalThis.MOFUMOFU_ONLINE_CONFIG || {});
const localHosts = new Set(['localhost', '127.0.0.1']);
const productionHost = 'fabdemnt-dev.github.io';

const productionBase = Object.freeze({
  apiKey: 'AIzaSyBtb74uz6clsoc9uA_AkDHi7DdepEWn2dw',
  authDomain: 'wa-awesome.firebaseapp.com',
  projectId: 'wa-awesome',
  storageBucket: 'wa-awesome.firebasestorage.app',
  messagingSenderId: '1074804319870',
  appId: '1:1074804319870:web:923f0ec866812f98ae5a2f',
});

function required(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}が設定されていません。`);
  return value.trim();
}

export function resolveEnvironment() {
  if (localHosts.has(host)) return {
    name: 'emulator',
    firebase: { apiKey: 'local-only', authDomain: 'localhost', projectId: 'mofumofu-local', databaseURL: 'http://localhost' },
    emulator: { authPort: 9199, firestorePort: 8180, databasePort: 9103, functionsPort: 5101 },
    appCheck: { debug: true },
  };
  if (host === productionHost) return {
    name: 'production',
    firebase: { ...productionBase, databaseURL: required(injected.databaseURL, '本番RTDB URL') },
    appCheck: { siteKey: required(injected.appCheckSiteKey, 'App Check site key') },
  };
  if (injected.environment === 'staging' && Array.isArray(injected.hosts) && injected.hosts.includes(host)) return {
    name: 'staging',
    firebase: injected.firebase,
    appCheck: { siteKey: required(injected.appCheckSiteKey, 'staging App Check site key') },
  };
  throw new Error('このホストではオンライン版を起動できません。');
}

export const REGION = 'asia-northeast1';

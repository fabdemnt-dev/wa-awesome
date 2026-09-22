const host = globalThis.location?.hostname || '';
const injected = Object.freeze(globalThis.MOFUMOFU_ONLINE_CONFIG || {});
const localHosts = new Set(['localhost', '127.0.0.1']);
const productionHost = 'fabdemnt-dev.github.io';
const stagingHost = 'wa-awesome-mofumofu-stg.web.app';

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

function exact(value, expected, label) {
  if (required(value, label) !== expected) throw new Error(`${label}が正しくありません。`);
  return expected;
}

function stagingEnvironment() {
  if (injected.environment !== 'staging' || injected.hostname !== stagingHost) {
    throw new Error('staging runtime configが正しくありません。');
  }
  const firebase = injected.firebase || {};
  return {
    name: 'staging',
    firebase: {
      apiKey: exact(firebase.apiKey, 'AIzaSyB1oIhZWMryuWZV9r2-nO9X4W6LuqXVvlo', 'staging API key'),
      authDomain: exact(firebase.authDomain, 'wa-awesome-mofumofu-stg.firebaseapp.com', 'staging Auth domain'),
      projectId: exact(firebase.projectId, 'wa-awesome-mofumofu-stg', 'staging project ID'),
      storageBucket: exact(firebase.storageBucket, 'wa-awesome-mofumofu-stg.firebasestorage.app', 'staging Storage bucket'),
      messagingSenderId: exact(firebase.messagingSenderId, '481875415725', 'staging messaging sender ID'),
      appId: exact(firebase.appId, '1:481875415725:web:e16ec434ac7cddd117ec24', 'staging Web App ID'),
      databaseURL: exact(firebase.databaseURL, 'https://wa-awesome-mofumofu-stg-default-rtdb.asia-southeast1.firebasedatabase.app', 'staging RTDB URL'),
    },
    appCheck: { siteKey: exact(injected.appCheckSiteKey, '6LfWOsgtAAAAAIuboWvU-f8EEAh2olIFiGDk_f1X', 'staging App Check site key') },
  };
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
  if (host === stagingHost) return stagingEnvironment();
  throw new Error('このホストではオンライン版を起動できません。');
}

export const REGION = 'asia-northeast1';

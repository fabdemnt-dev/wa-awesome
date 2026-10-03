// Repository-owned test support. The adjacent official SDK files stay unchanged.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const SDK_BASE = 'https://www.gstatic.com/firebasejs/10.8.0/';
export const APP_CHECK_ORIGIN = 'https://content-firebaseappcheck.googleapis.com';
export const LEGACY_APP_CHECK_ORIGIN = 'https://firebaseappcheck.googleapis.com';
export const AUTH_ORIGIN = 'https://identitytoolkit.googleapis.com';
export const NOW = Date.parse('2026-10-03T03:00:00Z');
export const UID = 'offline-synthetic-anonymous-uid';
export const APPCHECK_PROOF = 'offline-synthetic-appcheck-proof-not-for-display';
export const RECAPTCHA_PROOF = 'offline-synthetic-recaptcha-proof-not-for-display';
export const REFRESH_TOKEN = 'offline-synthetic-refresh-token-not-for-display';
const seconds = Math.floor(NOW / 1000);
export const ID_TOKEN = [
  { alg: 'none', typ: 'JWT' },
  { iat: seconds, exp: seconds + 3600, auth_time: seconds, sub: UID, firebase: { sign_in_provider: 'anonymous' } },
  '',
].map((part) => typeof part === 'string' ? part : Buffer.from(JSON.stringify(part)).toString('base64url')).join('.');
export const TOKENS = [APPCHECK_PROOF, RECAPTCHA_PROOF, REFRESH_TOKEN, ID_TOKEN];
const PINNED = Object.freeze({
  'firebase-app.js': '039f62b40bec14479291b93e0a35d9ad71cc4e6d64e9abf1285e1d2c6f9d83cb',
  'firebase-app-check.js': 'd74ff19cdc1d627142cc7b0f4f3198130e20af8c2cf1f84faf7cb79433540296',
  'firebase-auth.js': '33b487bc8e0dd6007ea461c6e63374b51c01101a9f5ad5450a580ea40dfc26ae',
});

export async function loadOfficialSdk() {
  const provenance = JSON.parse(await readFile(new URL('./provenance.json', import.meta.url), 'utf8'));
  assert.equal(provenance.version, '10.8.0');
  assert.equal(provenance.license, 'Apache-2.0');
  assert.deepEqual(Object.keys(provenance.files).sort(), Object.keys(PINNED).sort());
  const modules = new Map();
  for (const [name, expectedHash] of Object.entries(PINNED)) {
    const bytes = await readFile(new URL(`./${name}`, import.meta.url));
    const source = provenance.files[name];
    assert.equal(source.url, SDK_BASE + name);
    assert.equal(source.sha256, expectedHash, `${name}: reviewed provenance hash`);
    assert.equal(bytes.length, source.bytes, `${name}: exact original byte length`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedHash, `${name}: unchanged official SDK bytes`);
    modules.set(source.url, bytes.toString('utf8'));
  }
  return modules;
}

// Returns only inert, synthetic data. Unknown requests fail closed at each caller.
export function syntheticResponse(address) {
  const url = new URL(address);
  if (url.origin === APP_CHECK_ORIGIN && url.pathname === '/v1/projects/wa-awesome-garden-stg/apps/1:120030709276:web:015f4e996b7c42a4e801d9:exchangeRecaptchaEnterpriseToken') {
    return { token: APPCHECK_PROOF, ttl: '3600s' };
  }
  if (url.origin === AUTH_ORIGIN && url.pathname === '/v1/accounts:signUp') {
    return { kind: 'identitytoolkit#SignupNewUserResponse', idToken: ID_TOKEN, refreshToken: REFRESH_TOKEN, expiresIn: '3600', localId: UID };
  }
  if (url.origin === AUTH_ORIGIN && url.pathname === '/v1/accounts:lookup') {
    return { users: [{ localId: UID, createdAt: String(NOW), lastLoginAt: String(NOW), providerUserInfo: [] }] };
  }
  return null;
}

export function legacyCsp(correctedCsp) {
  assert.ok(correctedCsp.includes(APP_CHECK_ORIGIN), 'publisher CSP must allow the SDK-selected App Check host');
  assert.ok(!correctedCsp.includes(LEGACY_APP_CHECK_ORIGIN), 'replace the obsolete host rather than widening the allowlist');
  return correctedCsp.replace(APP_CHECK_ORIGIN, LEGACY_APP_CHECK_ORIGIN);
}

// reCAPTCHA alone is stubbed; Firebase provider, exchange, Auth, persistence and
// client state machinery are the unchanged production code and official SDK.
export const RECAPTCHA_SCRIPT = `(() => {
  let success;
  window.grecaptcha = { enterprise: {
    ready: (callback) => callback(),
    render: (container, options) => { success = options.callback; return 'offline-synthetic-widget'; },
    execute: async () => { success(); return ${JSON.stringify(RECAPTCHA_PROOF)}; },
  } };
})();`;

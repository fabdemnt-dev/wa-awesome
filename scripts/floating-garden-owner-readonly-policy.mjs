// Separate owner READ-ONLY brand. Never accepted by the CI authorization policy.
import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, readFileSync, lstatSync, fstatSync, realpathSync, readdirSync } from 'node:fs';
import { isAbsolute, resolve, join, sep } from 'node:path';
import { isDeepStrictEqual, types } from 'node:util';
import { ACTIVE_UPDATE_SCOPE as S } from './floating-garden-active-update.mjs';
export const OWNER_SDK_VERSION = '587.0.0';
export const OWNER_JOURNAL_DIRECTORY = '.garden-trust-renewal-9223b52d/state-recovery-1';
export const OWNER_JOURNAL_FILES = Object.freeze(['after.json', 'before.json', 'plan.json', ...Array.from({ length: 4 }, (_, i) => `status-${String(i).padStart(4, '0')}.json`)].sort());
const policies = new WeakSet();
export const ownerGuard = () => new Error('owner_readonly_guard');
export function ownerNeed(condition) { if (!condition) throw ownerGuard(); }
const need = ownerNeed, present = v => v !== undefined && v !== null && v !== '';
const plain = v => v && typeof v === 'object' && !types.isProxy(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
export const ownerDigest = value => createHash('sha256').update(ownerPacked(value)).digest('hex');
export function ownerPacked(value) {
  const sort = x => Array.isArray(x) ? x.map(sort) : plain(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, sort(x[k])])) : x;
  return JSON.stringify(sort(value)).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
export function assertOwnerEnvironment(env, execArgv = [], now = Date.now()) {
  need((env === process.env || plain(env)) && Object.values(Object.getOwnPropertyDescriptors(env)).every(d => Object.hasOwn(d, 'value')));
  need(Number.isSafeInteger(now) && now >= S.startsAtMillis && now < S.endsAtMillis && Array.isArray(execArgv) && execArgv.length === 0);
  for (const [k, v] of Object.entries(env)) if (present(v)) {
    need(!/^(CI|GITHUB_ACTIONS|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_GHA_CREDS_PATH|GCLOUD_ACCESS_TOKEN|GOOGLE_OAUTH_ACCESS_TOKEN|GOOGLE_API_KEY|GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES|DEBUG|NODE_DEBUG|NODE_DEBUG_NATIVE|NODE_OPTIONS|NODE_V8_COVERAGE|GRPC_TRACE|GRPC_VERBOSITY|GRPC_DEFAULT_SSL_ROOTS_FILE_PATH|GRPC_SSL_CIPHER_SUITES|GOOGLE_SDK_NODE_LOGGING|GCE_METADATA_HOST|GCE_METADATA_IP|GCE_METADATA_ROOT|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|http_proxy|https_proxy|all_proxy|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED)$/.test(k));
    need(!/^GITHUB_|^ACTIONS_|^GOOGLE_(API_USE|CLOUD_UNIVERSE_DOMAIN)|^CLOUDSDK_(AUTH_|PROXY_|API_ENDPOINT_OVERRIDES_)|^FIREBASE_|_EMULATOR_HOST$/.test(k));
    need(!/^npm_config_(proxy|http_proxy|https_proxy|noproxy|cafile|ca|cert|key|strict_ssl|registry|userconfig|globalconfig|node_options|_auth|_authToken)$/i.test(k));
    need(!['CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE', 'CLOUDSDK_CORE_DISABLE_SSL_VALIDATION', 'CLOUDSDK_CORE_LOG_HTTP', 'CLOUDSDK_CORE_VERBOSITY', 'CLOUDSDK_CORE_ACCOUNT', 'CLOUDSDK_CONFIG'].includes(k));
    if (['GOOGLE_CLOUD_PROJECT','GCLOUD_PROJECT','GCP_PROJECT','CLOUDSDK_CORE_PROJECT','GOOGLE_CLOUD_QUOTA_PROJECT','CLOUDSDK_BILLING_QUOTA_PROJECT'].includes(k)) need(v === S.project);
    if (k === 'CLOUDSDK_REGIONAL_ENDPOINT_MODE') need(v === 'global');
    if (k === 'CLOUDSDK_CORE_UNIVERSE_DOMAIN') need(v === 'googleapis.com');
  }
  return true;
}
export function validateOwnerConfiguration(config) {
  need(plain(config));
  for (const key of ['auth','core','storage','proxy','api_endpoint_overrides']) need(config[key] == null || plain(config[key]));
  const auth = config.auth || {}, core = config.core || {};
  need(!Object.values(config.proxy || {}).some(present) && !Object.values(config.api_endpoint_overrides || {}).some(present));
  need(!['credential_file_override','impersonate_service_account','access_token_file','access_token','login_config_file','token_host','auth_host'].some(k => present(auth[k])));
  need(!['gs_xml_access_key_id','gs_xml_secret_access_key'].some(k => present(config.storage?.[k])) && !present(core.custom_ca_certs_file));
  for (const [section, key] of [[core,'log_http'],[core,'disable_ssl_validation'],[auth,'disable_ssl_validation'],[auth,'disable_credentials']]) need(!present(section[key]) || ['false','0',false,0].includes(section[key]));
  need(!present(core.universe_domain) || core.universe_domain === 'googleapis.com');
  need(!present(core.verbosity) || ['none','critical','error','warning'].includes(core.verbosity));
  need(!present(config.regional?.endpoint_mode) || config.regional.endpoint_mode === 'global');
  need(!present(core.project) || core.project === S.project);
  return true;
}
export function createOwnerReadonlyPolicy({ env, ownerHash, now = Date.now, execArgv = [] }) {
  assertOwnerEnvironment(env, execArgv, now()); need(/^[a-f0-9]{64}$/.test(ownerHash || ''));
  const policy = Object.freeze({
    validateEnvironment(e, argv) { need(e === env); return assertOwnerEnvironment(e, argv, now()); },
    validateConfiguration: validateOwnerConfiguration,
    validateIdentity(identity) {
      need(Array.isArray(identity) && identity.length === 1 && identity[0]?.status === 'ACTIVE');
      const account = identity[0].account;
      need(typeof account === 'string' && /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/.test(account) && account.length <= 254 &&
        !account.endsWith('gserviceaccount.com') && ownerDigest(account) === ownerHash);
      return account;
    },
  }); policies.add(policy); return policy;
}
export function isOwnerReadonlyPolicy(value) { return policies.has(value); }
export function requireOwnerReadonlyPolicy(value) { need(isOwnerReadonlyPolicy(value)); return value; }
export function checkedOwnerHome(home) {
  need(typeof home === 'string' && isAbsolute(home) && resolve(home) === home && !/[\x00-\x1f]/.test(home));
  let part = sep;
  for (const segment of home.split(sep).filter(Boolean)) { part = join(part, segment); const s = lstatSync(part); need(s.isDirectory() && !s.isSymbolicLink()); }
  const stat = lstatSync(home); need(stat.uid === process.getuid() && !(stat.mode & 0o022) && realpathSync(home) === home); return home;
}
export function loadOwnerJournal({ home, pins }) {
  checkedOwnerHome(home); need(plain(pins) && isDeepStrictEqual(Object.keys(pins).sort(), OWNER_JOURNAL_FILES));
  pins = Object.freeze({ ...pins });
  const directory = join(home, OWNER_JOURNAL_DIRECTORY);
  for (const p of [join(home, '.garden-trust-renewal-9223b52d'), directory]) { const s = lstatSync(p); need(s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid() && (s.mode & 0o777) === 0o700 && realpathSync(p) === p); }
  const initial = lstatSync(directory), originals = new Map();
  function read(name) {
    need(/^[a-f0-9]{64}$/.test(pins[name] || '')); const path = join(directory, name), before = lstatSync(path);
    need(before.isFile() && !before.isSymbolicLink() && before.uid === process.getuid() && before.nlink === 1 && (before.mode & 0o777) === 0o600 && before.size <= 16 * 1024 * 1024);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); let bytes;
    try { const opened = fstatSync(fd); need(opened.dev === before.dev && opened.ino === before.ino); bytes = readFileSync(fd); const after = fstatSync(fd); need(after.size === bytes.length && after.nlink === 1 && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs); } finally { closeSync(fd); }
    const named = lstatSync(path); need(named.dev === before.dev && named.ino === before.ino && named.nlink === 1 && named.mtimeMs === before.mtimeMs && named.ctimeMs === before.ctimeMs);
    need(createHash('sha256').update(bytes).digest('hex') === pins[name]); if (!originals.has(name)) originals.set(name, bytes); return bytes;
  }
  need(isDeepStrictEqual(readdirSync(directory).sort(), OWNER_JOURNAL_FILES));
  // Every file is checked against independently reviewed bytes before parsing.
  const values = Object.fromEntries(OWNER_JOURNAL_FILES.map(name => [name, JSON.parse(read(name).toString('utf8'))]));
  const before = values['before.json'], after = values['after.json'], plan = values['plan.json'];
  need(plain(before) && plain(after) && /^[a-f0-9]{64}$/.test(after.owner_hash || '') && before.owner_hash === after.owner_hash);
  need(before.project?.projectId === S.project && String(before.project.projectNumber) === S.projectNumber && before.project.lifecycleState === 'ACTIVE');
  const changed = structuredClone(before); need(plain(changed.provider) && plain(after.provider)); changed.provider.attributeCondition = after.provider.attributeCondition;
  need(isDeepStrictEqual(changed, after) && typeof before.provider.attributeCondition === 'string' && typeof after.provider.attributeCondition === 'string');
  const oldSuffix = " && assertion.workflow_sha == '69ef07b9356470fbd3a643638baeec12bdd5680c' && assertion.run_number == '4'";
  const newSuffix = " && assertion.workflow_sha == '9223b52de65a3a393e5aec197ea7190b69c35c83' && assertion.run_number == '5'";
  need(before.provider.attributeCondition.endsWith(oldSuffix) && after.provider.attributeCondition === before.provider.attributeCondition.slice(0, -oldSuffix.length) + newSuffix);
  need(plan.kind === 'garden-run-5-trust-renewal-v1' && plan.project === S.project && plan.number === S.projectNumber && plan.original_expiry === S.endsAtMillis &&
    plan.new_release_sha === '9223b52de65a3a393e5aec197ea7190b69c35c83' && plan.new_run_number === '5' && plan.cloud_writes === 1 &&
    plan.from_condition === before.provider.attributeCondition && plan.to_condition === after.provider.attributeCondition && plan.snapshot_sha256 === ownerDigest(before));
  const token = ownerDigest(plan);
  for (const [i, stage] of ['initial_read','owner_confirmation','renew_provider_condition','trust_metadata_verified'].entries()) {
    const expected = { kind: 'garden-run-5-trust-renewal-v1', project: S.project, original_expiry: S.endsAtMillis, mutation_attempts: i >= 2 ? 1 : 0,
      possibly_applied: i === 2, trust_metadata_verified: i === 3, release_ready: false, stage, ...(i ? { plan_sha256: token } : {}) };
    need(isDeepStrictEqual(values[`status-${String(i).padStart(4,'0')}.json`], expected));
  }
  return Object.freeze({ ownerHash: after.owner_hash, journalFingerprint: ownerDigest(pins), recheck() {
    const s = lstatSync(directory); need(s.dev === initial.dev && s.ino === initial.ino && s.uid === process.getuid() && (s.mode & 0o777) === 0o700 && !s.isSymbolicLink());
    need(isDeepStrictEqual(readdirSync(directory).sort(), OWNER_JOURNAL_FILES));
    for (const name of OWNER_JOURNAL_FILES) need(read(name).equals(originals.get(name)));
  } });
}

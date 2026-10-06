// CLI 14.27.0 compatibility contract. No generic unknown-field normalization.
// Only the generated source-hash label may change; every other configured field
// remains in the existing provider's strict full-object preservation comparison.
import { isDeepStrictEqual } from 'node:util';
import { ACTIVE_UPDATE_SCOPE as S, requireActiveUpdate as need } from './floating-garden-active-update.mjs';
import { FUNCTION_NAMES } from './prepare-floating-garden-trial.mjs';
const HASH = 'firebase-functions-hash';
const hash = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const sorted = object => Object.keys(object || {}).sort();
export function validateCiFunctionConfiguration(proof, firebaseAdminSdk) {
  need(Array.isArray(proof) && proof.length === 5, 'source-proof');
  for (const { function: fn } of proof) {
    const name = fn.buildConfig?.entryPoint;
    need(FUNCTION_NAMES.includes(name) && !fn.eventTrigger, 'source-proof');
    const labels = fn.labels || {};
    need(isDeepStrictEqual(sorted(labels), [HASH, 'deployment-callable', 'deployment-tool', 'firebase-functions-codebase'].sort()) &&
      hash(labels[HASH]) && labels['deployment-callable'] === 'true' && labels['deployment-tool'] === 'cli-firebase' &&
      labels['firebase-functions-codebase'] === 'floating-garden-trial', 'iam-preservation');
    need(isDeepStrictEqual(fn.buildConfig.environmentVariables, { GOOGLE_NODE_RUN_SCRIPTS: '' }), 'iam-preservation');
    const service = fn.serviceConfig, env = service.environmentVariables || {};
    need(isDeepStrictEqual(sorted(env), ['EVENTARC_CLOUD_EVENT_SOURCE', 'FIREBASE_CONFIG', 'FUNCTION_TARGET', 'GCLOUD_PROJECT', 'LOG_EXECUTION_ID']) &&
      env.FUNCTION_TARGET === name && env.GCLOUD_PROJECT === S.project && env.LOG_EXECUTION_ID === 'true' &&
      env.EVENTARC_CLOUD_EVENT_SOURCE === `projects/${S.project}/locations/${S.region}/services/${name}`, 'iam-preservation');
    let config; try { config = JSON.parse(env.FIREBASE_CONFIG); } catch { need(false, 'iam-preservation'); }
    need(config && firebaseAdminSdk && env.FIREBASE_CONFIG === JSON.stringify(firebaseAdminSdk) && config.projectId === S.project && typeof config.storageBucket === 'string' &&
      [S.project + '.appspot.com', S.project + '.firebasestorage.app'].includes(config.storageBucket), 'iam-preservation');
    // Omitted SDK 6.6 options clear VPC/ingress rather than preserving custom
    // values. Stop before CLI when the current setup would be overwritten.
    need(service.ingressSettings === 'ALLOW_ALL' && !service.vpcConnector && !service.vpcConnectorEgressSettings,
      'iam-preservation');
  }
  return true;
}
export function stableCiFunctionConfiguration(proof, stable) {
  need(typeof stable === 'function', 'source-proof');
  const copied = structuredClone(proof);
  for (const item of copied) for (const object of [item.function, item.run, item.run?.template]) {
    if (Object.hasOwn(object?.labels || {}, HASH)) {
      need(hash(object.labels[HASH]), 'iam-preservation');
      // Retain the key: absent versus present is still a mismatch.
      object.labels[HASH] = 'verified-cli-source-hash';
    }
  }
  return stable(copied);
}

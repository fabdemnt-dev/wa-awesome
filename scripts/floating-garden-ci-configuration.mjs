// Existing Firebase configuration accepted by the gcloud 568 update contract.
// No label/configuration normalization: every configured field is preserved.
import { isDeepStrictEqual } from 'node:util';
import { ACTIVE_UPDATE_SCOPE as S, requireActiveUpdate as need } from './floating-garden-active-update.mjs';
import { FUNCTION_NAMES } from './prepare-floating-garden-trial.mjs';
const HASH = 'firebase-functions-hash';
const hash = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const sorted = object => Object.keys(object || {}).sort();
export function validateCiFunctionConfiguration(proof) {
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
    const requiredEnv = ['EVENTARC_CLOUD_EVENT_SOURCE', 'FIREBASE_CONFIG', 'FUNCTION_TARGET', 'GCLOUD_PROJECT', 'LOG_EXECUTION_ID'];
    // HTTP Functions may explicitly select the framework's default signature.
    // Preserve presence/value exactly; no event signature or unknown key is accepted.
    const signaturePresent = Object.hasOwn(env, 'FUNCTION_SIGNATURE_TYPE');
    need((!signaturePresent || env.FUNCTION_SIGNATURE_TYPE === 'http') &&
      isDeepStrictEqual(sorted(env), signaturePresent ? [...requiredEnv, 'FUNCTION_SIGNATURE_TYPE'].sort() : requiredEnv) &&
      env.FUNCTION_TARGET === name && env.GCLOUD_PROJECT === S.project && env.LOG_EXECUTION_ID === 'true' &&
      env.EVENTARC_CLOUD_EVENT_SOURCE === `projects/${S.project}/locations/${S.region}/services/${name}`, 'iam-preservation');
    let config; try { config = JSON.parse(env.FIREBASE_CONFIG); } catch { need(false, 'iam-preservation'); }
    need(config && Object.getPrototypeOf(config) === Object.prototype && config.projectId === S.project && typeof config.storageBucket === 'string' &&
      [S.project + '.appspot.com', S.project + '.firebasestorage.app'].includes(config.storageBucket), 'iam-preservation');
    // Keep the previously reviewed ingress and VPC baseline unchanged.
    need(service.ingressSettings === 'ALLOW_ALL' && !service.vpcConnector && !service.vpcConnectorEgressSettings,
      'iam-preservation');
  }
  return true;
}
export function stableCiFunctionConfiguration(proof, stable) {
  need(typeof stable === 'function', 'source-proof');
  // gcloud omits label flags. Even Firebase's old source-hash label must stay
  // byte-for-byte unchanged; independent source ZIP readback proves new code.
  return stable(proof);
}

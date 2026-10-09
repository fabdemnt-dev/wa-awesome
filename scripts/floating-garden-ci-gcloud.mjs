// Exact official-SDK update surface. Inert until the CI provider issues it.
// No --runtime or --entry-point: a missing function must fail instead of create.
// No --stage-bucket: the Functions API supplies the signed source upload URL.
// No environment/secrets/labels/network/invoker flags: existing values persist.
import { isAbsolute, resolve } from 'node:path';
import { ACTIVE_UPDATE_SCOPE as S, requireActiveUpdate as need } from './floating-garden-active-update.mjs';
import { FUNCTION_NAMES } from './prepare-floating-garden-trial.mjs';
import { RUNTIME_ACCOUNT } from './floating-garden-trial-cloud-adapter.mjs';
export const GCLOUD_FUNCTIONS_VERSION = '568.0.0';
// The SDK tests directories without is_dir=true. Directory-only trailing '/'
// patterns leak empty ZIP entries; '**/.*' would also match the root '.'.
export const GCLOUD_SOURCE_IGNORE = 'node_modules\n**/.[!.]*\n**/..?*\n*-debug.log\n';
export function ciFunctionDeployArguments(fn, sourceDir, ignoreFile) {
  const name = fn?.buildConfig?.entryPoint;
  need(FUNCTION_NAMES.includes(name) && [S.project, S.projectNumber].some(p => fn.name === `projects/${p}/locations/${S.region}/functions/${name}`) &&
    fn.environment === 'GEN_2' && fn.state === 'ACTIVE' && !fn.eventTrigger && fn.buildConfig.runtime === 'nodejs22' &&
    fn.serviceConfig?.serviceAccountEmail === RUNTIME_ACCOUNT, 'source-proof');
  const build = fn.buildConfig.serviceAccount;
  const match = typeof build === 'string' && /^projects\/([^/]+)\/serviceAccounts\/([^/]+)$/.exec(build);
  need(match && [S.project, S.projectNumber].includes(match[1]) &&
    (new RegExp(`^[a-z][a-z0-9-]{4,28}[a-z0-9]@${S.project}\\.iam\\.gserviceaccount\\.com$`).test(match[2]) ||
      [S.projectNumber + '-compute@developer.gserviceaccount.com', S.projectNumber + '@cloudbuild.gserviceaccount.com'].includes(match[2])) &&
    match[2] !== `garden-github-deployer@${S.project}.iam.gserviceaccount.com`, 'iam-preservation');
  for (const path of [sourceDir, ignoreFile]) need(typeof path === 'string' && isAbsolute(path) && resolve(path) === path && !/[\x00-\x1f]/.test(path), 'local-packet');
  return ['functions', 'deploy', name, '--gen2', `--region=${S.region}`, `--project=${S.project}`, `--billing-project=${S.project}`,
    `--source=${sourceDir}`, `--ignore-file=${ignoreFile}`, `--run-service-account=${RUNTIME_ACCOUNT}`, `--build-service-account=${build}`,
    '--quiet', '--format=json', '--verbosity=error'];
}
export function classifyCiFunctionDeploy(raw, fn) {
  if (raw?.exitCode !== 0 || raw.signal || raw.timedOut || typeof raw.stdout !== 'string') return { kind: 'unknown' };
  try {
    const got = JSON.parse(raw.stdout);
    if (![S.project, S.projectNumber].some(p => got.name === `projects/${p}/locations/${S.region}/functions/${fn.buildConfig.entryPoint}`) ||
      got.environment !== 'GEN_2' || got.state !== 'ACTIVE') return { kind: 'unknown' };
    return { kind: 'success' };
  } catch { return { kind: 'unknown' }; }
}

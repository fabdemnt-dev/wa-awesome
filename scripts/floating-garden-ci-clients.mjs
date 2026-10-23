// CI-only client preparation. Importing this module does not load SDKs or read
// credentials. No login, token export, RPC, deployment or gate mutation occurs.
// The separately branded CI policy accepts only checked action-generated ADC.
// Legacy owner guards remain strict; no environment variables are stripped.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { FIRESTORE_CLIENT_CONFIG } from './floating-garden-trial-cloud-adapter.mjs';
import { CI_CLIENT_SCOPE, assertCiClientEnvironment, createCiAuthPolicy, requireCiAuthPolicy } from './floating-garden-ci-auth-policy.mjs';
export { CI_CLIENT_SCOPE, assertCiClientEnvironment } from './floating-garden-ci-auth-policy.mjs';
const S = CI_CLIENT_SCOPE;
const guard = () => new Error('ci_clients_guard');
const need = condition => { if (!condition) throw guard(); };

/** Supply these clients to a separately reviewed CI provider integration.
 * SDK location is explicit so generated packets can use their pinned install.
 * keyFilename is the public SDK option; no custom Firestore auth adapter.
 * Construction/parsing is local. Actual token exchange waits for a later request.
 */
export async function createCiClients({ env = process.env, now = Date.now,
  sdkPackageJson = fileURLToPath(new URL('../functions/floating-garden-trial/package.json', import.meta.url)),
  execArgv = process.execArgv } = {}) {
  try {
    const keyFilename = assertCiClientEnvironment(env, now(), execArgv);
    const environmentPolicy = createCiAuthPolicy({ env, now, execArgv });
    const require = createRequire(sdkPackageJson);
    need(require('@google-cloud/firestore/package.json').version === '7.11.6' &&
      require('google-auth-library/package.json').version === '9.15.1');
    const firestoreRequire = createRequire(require.resolve('@google-cloud/firestore'));
    const gaxRequire = createRequire(firestoreRequire.resolve('google-gax'));
    need(gaxRequire('google-auth-library/package.json').version === '9.15.1');
    const { Firestore } = require('@google-cloud/firestore');
    const { GoogleAuth, IdentityPoolClient } = require('google-auth-library');
    const auth = new GoogleAuth({ keyFilename, projectId: S.project,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      clientOptions: { forceRefreshOnFailure: false, transporterOptions: {
        retry: false, retryConfig: { retry: 0, noResponseRetries: 0 }, maxRedirects: 0, timeout: 30000,
      } } });
    const requestClient = await auth.getClient();
    need(requestClient instanceof IdentityPoolClient && requestClient.getServiceAccountEmail() === S.serviceAccount);
    const db = new Firestore({ keyFilename, projectId: S.project, databaseId: S.databaseId,
      ignoreUndefinedProperties: false, clientConfig: structuredClone(FIRESTORE_CLIENT_CONFIG) });
    requireCiAuthPolicy(environmentPolicy).validateEnvironment(env, execArgv);
    return { db, requestClient, environmentPolicy };
  } catch {
    // Neither parser paths nor SDK errors/credential content cross this boundary.
    throw guard();
  }
}

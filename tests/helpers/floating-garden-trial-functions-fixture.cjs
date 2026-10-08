'use strict';
// EMULATOR-ONLY ENTRY. Never part of prepareTrialBundle or a deployment target.
// Real callable middleware verifies the anonymous Auth emulator token. App Check
// attestation, Hosting TLS, IAM and Secret Manager are deliberately NOT validated.
const assert = require('node:assert/strict');
const { getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { createTrialHandlers, TrialError } = require('./trial-handlers');
const { createHandlers } = require('./online/handlers');
const fixture = require('./emulator-fixture.json');
const { config, projectId } = fixture;
function assertEmulator() {
  // Firebase CLI discovery intentionally filters arbitrary parent-shell envs.
  // Require its own emulator marker plus the generated fixture marker instead;
  // deployment discovery has no emulator marker and must still fail closed.
  assert.equal(fixture.kind, 'floating-garden-trial-browser-emulator-only-v1');
  assert.equal(fixture.browserOrigin, 'http://127.0.0.1:8783');
  assert.equal(process.env.FUNCTIONS_EMULATOR, 'true');
  assert.equal(projectId, 'demo-floating-garden-trial');
  assert.equal(process.env.GCLOUD_PROJECT, projectId);
  for (const name of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']) {
    assert.match(process.env[name] || '', /^127\.0\.0\.1:\d+$/);
  }
}
assertEmulator();
const app = getApps().find((item) => item.name === 'trial-browser-emulator') || initializeApp({ projectId }, 'trial-browser-emulator');
const handlers = createTrialHandlers({ config, db: getFirestore(app), timestampFromMillis: Timestamp.fromMillis,
  trustedHandlersFactory: createHandlers,
  // These fixture values only bridge otherwise incompatible live-project gates.
  // The production validator and all trial transaction authorization are unchanged.
  env: { GCLOUD_PROJECT: config.projectId },
  inviteSecret: () => 'emulator-only-trial-invitation-key-not-a-secret-32',
});
module.exports = Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name,
  onCall({ region: config.region, cors: [fixture.browserOrigin], enforceAppCheck: false }, async (request) => {
    assertEmulator();
    if (!request.auth || request.auth.token.firebase?.sign_in_provider !== 'anonymous') throw new HttpsError('unauthenticated', 'Real anonymous emulator authentication is required');
    if (request.rawRequest.headers.origin !== fixture.browserOrigin) throw new HttpsError('permission-denied', 'Fixture origin mismatch');
    try {
      // Only after verifying the exact actual loopback Origin, adapt the origin
      // inside this test entry to the validated synthetic trial configuration.
      // Production Origin, App Check, Hosting and CORS success remain unvalidated.
      return await handler({ ...request, app: { appId: 'emulator-only-synthetic-attestation' },
        rawRequest: { ...request.rawRequest, ip: request.rawRequest.ip,
          headers: { ...request.rawRequest.headers, origin: config.previewOrigin } } });
    } catch (error) {
      if (error instanceof TrialError || error?.name === 'GardenError') throw new HttpsError(error.code, error.message, error.details);
      throw error;
    }
  }),
]));

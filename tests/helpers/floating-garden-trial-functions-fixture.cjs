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
  assert.equal(process.env.FLOATING_GARDEN_TRIAL_EMULATOR_FIXTURE, '1');
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
  onCall({ region: config.region, cors: [config.previewOrigin], enforceAppCheck: false }, async (request) => {
    assertEmulator();
    if (!request.auth || request.auth.token.firebase?.sign_in_provider !== 'anonymous') throw new HttpsError('unauthenticated', 'Real anonymous emulator authentication is required');
    if (request.rawRequest.headers.origin !== config.previewOrigin) throw new HttpsError('permission-denied', 'Fixture origin mismatch');
    try {
      return await handler({ ...request, app: { appId: 'emulator-only-synthetic-attestation' } });
    } catch (error) {
      if (error instanceof TrialError || error?.name === 'GardenError') throw new HttpsError(error.code, error.message, error.details);
      throw error;
    }
  }),
]));

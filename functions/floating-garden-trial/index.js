'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { REGION, CALLABLE_NAMES, validateTrialConfig } = require('./config');
const { TrialError, assertRequest, createTrialHandlers } = require('./trial-handlers');

// No repository fallback or permissive defaults: only the generated bundle supplies
// this file. An absent/invalid configuration leaves all five exports disabled.
let config = null;
try { config = validateTrialConfig(JSON.parse(fs.readFileSync(path.join(__dirname, 'trial-config.json'), 'utf8'))); }
catch { /* Disabled below; never log configuration or credentials. */ }
const invitationKey = defineSecret('FLOATING_GARDEN_INVITE_HMAC_KEY');
let handlers;
function getHandlers() {
  if (handlers) return handlers;
  const trusted = require('./online/handlers');
  const invite = require('./online/invite-code');
  const appName = 'floating-garden-trial';
  const app = getApps().find((candidate) => candidate.name === appName) || initializeApp({ projectId: config.projectId }, appName);
  if (app.options.projectId !== config.projectId) throw new TrialError('failed-precondition', 'trial-project-mismatch');
  handlers = createTrialHandlers({ config, db: getFirestore(app), trustedHandlersFactory: trusted.createHandlers,
    timestampFromMillis: Timestamp.fromMillis,
    inviteSecret: () => invite.requireInviteHmacKey(() => invitationKey.value(), {}) });
  return handlers;
}
const callableOptions = Object.freeze({
  region: REGION, minInstances: 0, maxInstances: 1, timeoutSeconds: 30, memory: '256MiB', cpu: 1, concurrency: 1,
  cors: config ? [config.previewOrigin] : false, enforceAppCheck: true,
  ...(config ? { serviceAccount: `garden-trial-runtime@${config.projectId}.iam.gserviceaccount.com` } : {}),
});
function callable(name) {
  const needsSecret = ['floatingGardenCreateRoom', 'floatingGardenJoinRoom'].includes(name);
  return onCall({ ...callableOptions, ...(needsSecret ? { secrets: [invitationKey] } : {}) }, async (request) => {
    try {
      if (!config) throw new TrialError('failed-precondition', 'trial-config-missing');
      assertRequest(config, request, Date.now(), process.env);
      return await getHandlers()[name](request);
    } catch (error) {
      if (error instanceof TrialError || error?.name === 'GardenError') throw new HttpsError(error.code, error.message, error.details);
      console.error('Floating Garden trial request failed', { name: error?.name, code: error?.code });
      throw new HttpsError('internal', '処理結果を確認できません。同じ操作を再確認してください。');
    }
  });
}
// Exactly five public callable exports. Test helpers are never deployment targets.
module.exports = Object.fromEntries(CALLABLE_NAMES.map((name) => [name, callable(name)]));

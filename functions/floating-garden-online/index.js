'use strict';

const { getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { createHandlers, loadCore, secureMatch, RATE_LIMITS, GardenError } = require('./handlers');
const contract = require('./contract');
const invite = require('./invite-code');

if (!getApps().length) initializeApp();
const invitationKey = defineSecret(invite.SECRET_NAME);
const handlers = createHandlers({ db: getFirestore(), timestampFromMillis: Timestamp.fromMillis,
  inviteSecret: () => invite.requireInviteHmacKey(() => invitationKey.value()) });
const callableOptions = {
  region: 'asia-northeast1', minInstances: 0, maxInstances: 5,
  cors: ['https://fabdemnt-dev.github.io', /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/],
  enforceAppCheck: false,
};
function callable(handler, needsSecret = false) {
  return onCall({ ...callableOptions, ...(needsSecret && !invite.isDemoEmulator() ? { secrets: [invitationKey] } : {}) }, async (request) => {
    try { return await handler(request); }
    catch (error) {
      if (error instanceof GardenError) throw new HttpsError(error.code, error.message, error.details);
      // Never send database errors, server state or secret configuration values to clients.
      console.error('Floating Garden request failed', { name: error?.name, code: error?.code });
      throw new HttpsError('internal', '処理結果を確認できません。同じ操作を再確認してください。');
    }
  });
}
module.exports = {
  floatingGardenCreateRoom: callable(handlers.floatingGardenCreateRoom, true),
  floatingGardenJoinRoom: callable(handlers.floatingGardenJoinRoom, true),
  floatingGardenStartMatch: callable(handlers.floatingGardenStartMatch),
  floatingGardenGetSnapshot: callable(handlers.floatingGardenGetSnapshot),
  floatingGardenSubmitAction: callable(handlers.floatingGardenSubmitAction),
  _test: { createHandlers, handlers, loadCore, secureMatch, RATE_LIMITS, ...contract, ...invite },
};

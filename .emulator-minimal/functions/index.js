'use strict';
const { onCall } = require('firebase-functions/v2/https');
exports.helloWorld = onCall({ region: 'asia-northeast1' }, request => ({ ok: true, uid: request.auth?.uid || null }));

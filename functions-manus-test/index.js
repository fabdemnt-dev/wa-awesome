const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');

const manusApiKey = defineSecret('MANUS_API_KEY');

const callableOptions = {
  region: 'asia-northeast1',
  cors: ['https://fabdemnt-dev.github.io'],
  secrets: [manusApiKey],
};

function fail(code, message) {
  throw new HttpsError(code, message);
}

function requireAuthenticated(request) {
  if (!request.auth?.uid) {
    fail('unauthenticated', '接続テストにはアプリへのログインが必要です。');
  }
}

exports.testManusConnection = onCall(callableOptions, async (request) => {
  requireAuthenticated(request);

  const apiKey = manusApiKey.value();
  if (!apiKey) fail('failed-precondition', 'Manus接続用のSecretが設定されていません。');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch('https://api.manus.ai/v2/task.list?limit=1&order=desc', {
      method: 'GET',
      headers: {
        'x-manus-api-key': apiKey,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      fail('internal', `Manus接続テストに失敗しました（HTTP ${response.status}）。`);
    }

    const result = await response.json();
    return {
      ok: result.ok === true,
      requestId: result.request_id || null,
      returnedTasks: Array.isArray(result.data) ? result.data.length : 0,
    };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    fail('internal', 'Manus接続テストに失敗しました。');
  } finally {
    clearTimeout(timeout);
  }
});

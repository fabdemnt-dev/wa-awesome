const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');

const openAiApiKey = defineSecret('OPENAI_API_KEY');

const callableOptions = {
  region: 'asia-northeast1',
  cors: ['https://fabdemnt-dev.github.io'],
  secrets: [openAiApiKey],
};

function fail(code, message) {
  throw new HttpsError(code, message);
}

function requireAuthenticated(request) {
  if (!request.auth?.uid) {
    fail('unauthenticated', 'AI会議室を利用するにはアプリへの接続が必要です。ページを再読み込みして、もう一度お試しください。');
  }
}

function requireMessage(value) {
  if (typeof value !== 'string') fail('invalid-argument', '質問を入力してください。');
  const message = value.trim();
  if (!message || message.length > 4000) {
    fail('invalid-argument', '質問は1〜4000文字で入力してください。');
  }
  return message;
}

function extractOutputText(body) {
  if (typeof body?.output_text === 'string' && body.output_text.trim()) {
    return body.output_text.trim();
  }

  const text = Array.isArray(body?.output)
    ? body.output
      .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
      .filter((content) => content?.type === 'output_text' && typeof content.text === 'string')
      .map((content) => content.text)
      .join('\n')
      .trim()
    : '';
  return text;
}

exports.askAiRoomOpenAI = onCall(callableOptions, async (request) => {
  requireAuthenticated(request);
  const message = requireMessage(request.data?.message);

  const apiKey = openAiApiKey.value();
  if (!apiKey) fail('failed-precondition', 'OpenAI接続用のSecretが設定されていません。');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-5.6-luna',
        instructions: 'あなたはAI会議室の参加者です。日本語で、質問に直接答えてください。必要以上に長くせず、会議で読みやすい返答にしてください。',
        input: message,
        reasoning: { effort: 'low' },
        text: { verbosity: 'low' },
        max_output_tokens: 800,
        store: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error('OpenAI AI room request failed', { status: response.status });
      fail('unavailable', 'OpenAIから返答を取得できませんでした。しばらくしてからもう一度お試しください。');
    }

    const body = await response.json();
    const reply = extractOutputText(body);
    if (!reply) {
      console.error('OpenAI AI room response contained no text', { status: body?.status || null });
      fail('unavailable', 'OpenAIから返答を取得できませんでした。しばらくしてからもう一度お試しください。');
    }

    return { ok: true, reply };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    if (error?.name === 'AbortError') {
      fail('deadline-exceeded', 'OpenAIの応答がタイムアウトしました。もう一度お試しください。');
    }
    console.error('OpenAI AI room request error', { name: error?.name || 'Error' });
    fail('unavailable', 'OpenAIとの通信に失敗しました。しばらくしてからもう一度お試しください。');
  } finally {
    clearTimeout(timeout);
  }
});

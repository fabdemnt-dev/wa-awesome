const crypto = require('node:crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');

const openAiApiKey = defineSecret('OPENAI_API_KEY');
const manusApiKey = defineSecret('MANUS_API_KEY');
const AI_ROOM_ACCESS_CODE_SHA256 = 'a4248a853ffadc372dfa4d1b468b76ff8bd744d94c3ae4dadf7e46000e796156';
const MAX_HISTORY_ITEMS = 12;
const MAX_HISTORY_CHARS = 12000;
const MAX_MANUS_MESSAGE_CHARS = 2500;
const MAX_MANUS_CONTEXT_CHARS = 1000;

const commonCallableOptions = {
  region: 'asia-northeast1',
  cors: ['https://fabdemnt-dev.github.io'],
};
const openAiCallableOptions = {
  ...commonCallableOptions,
  secrets: [openAiApiKey],
};
const manusCallableOptions = {
  ...commonCallableOptions,
  secrets: [manusApiKey],
};

function fail(code, message) {
  throw new HttpsError(code, message);
}

function requireAuthenticated(request) {
  if (!request.auth?.uid) {
    fail('unauthenticated', 'AI会議室を利用するにはアプリへの接続が必要です。ページを再読み込みして、もう一度お試しください。');
  }
}

function requireAccessCode(value) {
  if (typeof value !== 'string' || !value) {
    fail('permission-denied', 'AI会議室のアクセスコードを入力してください。');
  }
  const actual = crypto.createHash('sha256').update(value).digest();
  const expected = Buffer.from(AI_ROOM_ACCESS_CODE_SHA256, 'hex');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    fail('permission-denied', 'AI会議室のアクセスコードが正しくありません。');
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

function requireManusMessage(value) {
  if (typeof value !== 'string') fail('invalid-argument', 'Manusへの依頼を入力してください。');
  const message = value.trim();
  if (!message || message.length > MAX_MANUS_MESSAGE_CHARS) {
    fail('invalid-argument', `Manusへの依頼は1〜${MAX_MANUS_MESSAGE_CHARS}文字で入力してください。`);
  }
  return message;
}

function normalizeSpeaker(item) {
  if (item?.speaker === 'user' || item?.speaker === 'chatgpt' || item?.speaker === 'manus') {
    return item.speaker;
  }
  if (item?.role === 'user') return 'user';
  if (item?.role === 'assistant') return 'chatgpt';
  return null;
}

function requireHistory(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_HISTORY_ITEMS) {
    fail('invalid-argument', '会話履歴が長すぎます。');
  }

  let totalChars = 0;
  return value.map((item) => {
    const speaker = normalizeSpeaker(item);
    const content = typeof item?.content === 'string' ? item.content.trim() : '';
    if (!speaker || !content || content.length > 4000) {
      fail('invalid-argument', '会話履歴の形式が正しくありません。');
    }
    totalChars += content.length;
    if (totalChars > MAX_HISTORY_CHARS) {
      fail('invalid-argument', '会話履歴が長すぎます。');
    }
    return { speaker, content };
  });
}

function requireTaskId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9]{22}$/.test(value)) {
    fail('invalid-argument', 'ManusタスクIDの形式が正しくありません。');
  }
  return value;
}

function toOpenAiHistory(history) {
  return history.map((item) => {
    if (item.speaker === 'chatgpt') {
      return { role: 'assistant', content: item.content };
    }
    if (item.speaker === 'manus') {
      return { role: 'user', content: `Manus（別のAI参加者）: ${item.content}` };
    }
    return { role: 'user', content: item.content };
  });
}

function buildManusPrompt(history, message) {
  const labels = {
    user: 'ユーザー',
    chatgpt: 'ChatGPT',
    manus: 'Manus',
  };
  const rawContext = history
    .slice(-6)
    .map((item) => `${labels[item.speaker]}: ${item.content}`)
    .join('\n');
  const context = rawContext.length > MAX_MANUS_CONTEXT_CHARS
    ? rawContext.slice(-MAX_MANUS_CONTEXT_CHARS)
    : rawContext;

  return [
    'あなたはAI会議室のManus参加者です。',
    '必要に応じて調査・整理・分析を行い、会議で読みやすい日本語の回答を返してください。',
    '外部サービスで変更・送信・購入など副作用のある操作は行わず、調査と回答だけを行ってください。',
    '',
    '直前の会議文脈:',
    context || '（なし）',
    '',
    '今回の依頼:',
    message,
  ].join('\n');
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

exports.askAiRoomOpenAI = onCall(openAiCallableOptions, async (request) => {
  requireAuthenticated(request);
  requireAccessCode(request.data?.accessCode);
  const message = requireMessage(request.data?.message);
  const history = requireHistory(request.data?.history);

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
        instructions: 'あなたはAI会議室のChatGPT参加者です。ユーザーとManusという別のAI参加者がいます。日本語で、直前までの会議を踏まえて質問に直接答えてください。必要以上に長くせず、会議で読みやすい返答にしてください。',
        input: [...toOpenAiHistory(history), { role: 'user', content: message }],
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

exports.createAiRoomManusTask = onCall(manusCallableOptions, async (request) => {
  requireAuthenticated(request);
  requireAccessCode(request.data?.accessCode);
  const message = requireManusMessage(request.data?.message);
  const history = requireHistory(request.data?.history);

  const apiKey = manusApiKey.value();
  if (!apiKey) fail('failed-precondition', 'Manus接続用のSecretが設定されていません。');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch('https://api.manus.ai/v2/task.create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-manus-api-key': apiKey,
      },
      body: JSON.stringify({
        message: {
          content: [{ type: 'text', text: buildManusPrompt(history, message) }],
        },
        locale: 'ja',
        interactive_mode: false,
        hide_in_task_list: false,
        share_visibility: 'private',
        agent_profile: 'manus-1.6-lite',
        title: 'AI会議室の相談',
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error('Manus AI room task create failed', { status: response.status });
      fail('unavailable', 'Manusタスクを開始できませんでした。しばらくしてからもう一度お試しください。');
    }

    const body = await response.json();
    if (body?.ok !== true || typeof body?.task_id !== 'string') {
      fail('unavailable', 'Manusタスクを開始できませんでした。しばらくしてからもう一度お試しください。');
    }

    return {
      ok: true,
      taskId: body.task_id,
      taskTitle: typeof body.task_title === 'string' ? body.task_title : 'AI会議室の相談',
      taskUrl: typeof body.task_url === 'string' ? body.task_url : null,
      status: 'running',
    };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    if (error?.name === 'AbortError') {
      fail('deadline-exceeded', 'Manusへの接続がタイムアウトしました。もう一度お試しください。');
    }
    console.error('Manus AI room task create error', { name: error?.name || 'Error' });
    fail('unavailable', 'Manusとの通信に失敗しました。しばらくしてからもう一度お試しください。');
  } finally {
    clearTimeout(timeout);
  }
});

exports.getAiRoomManusTask = onCall(manusCallableOptions, async (request) => {
  requireAuthenticated(request);
  requireAccessCode(request.data?.accessCode);
  const taskId = requireTaskId(request.data?.taskId);

  const apiKey = manusApiKey.value();
  if (!apiKey) fail('failed-precondition', 'Manus接続用のSecretが設定されていません。');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const params = new URLSearchParams({ task_id: taskId, order: 'desc', limit: '20' });
    const response = await fetch(`https://api.manus.ai/v2/task.listMessages?${params}`, {
      method: 'GET',
      headers: {
        'x-manus-api-key': apiKey,
      },
      signal: controller.signal,
    });

    if (response.status === 404) {
      return {
        ok: true,
        status: 'running',
        reply: null,
        waitingDescription: null,
        error: null,
      };
    }

    if (!response.ok) {
      console.error('Manus AI room task poll failed', { status: response.status });
      fail('unavailable', 'Manusの進行状況を取得できませんでした。');
    }

    const body = await response.json();
    if (body?.ok !== true || !Array.isArray(body?.messages)) {
      fail('unavailable', 'Manusの進行状況を取得できませんでした。');
    }

    const events = body.messages;
    const statusEvent = events.find((event) =>
      event?.type === 'status_update' && typeof event?.status_update?.agent_status === 'string');
    const assistantEvent = events.find((event) =>
      event?.type === 'assistant_message' && typeof event?.assistant_message?.content === 'string');
    const errorEvent = events.find((event) =>
      event?.type === 'error_message' && typeof event?.error_message?.content === 'string');

    const status = statusEvent?.status_update?.agent_status || 'running';
    return {
      ok: true,
      status,
      reply: assistantEvent?.assistant_message?.content?.trim() || null,
      waitingDescription: status === 'waiting'
        ? statusEvent?.status_update?.status_detail?.waiting_description || 'Manusが確認を待っています。'
        : null,
      error: status === 'error'
        ? errorEvent?.error_message?.content || 'Manusタスクでエラーが発生しました。'
        : null,
    };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    if (error?.name === 'AbortError') {
      fail('deadline-exceeded', 'Manusの進行状況確認がタイムアウトしました。');
    }
    console.error('Manus AI room task poll error', { name: error?.name || 'Error' });
    fail('unavailable', 'Manusとの通信に失敗しました。');
  } finally {
    clearTimeout(timeout);
  }
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../ai-room.html', import.meta.url), 'utf8');
const backend = await readFile(new URL('../functions-ai-room/index.js', import.meta.url), 'utf8');

test('AI room page sends an access code and bounded history through the callable function', () => {
  assert.match(html, /httpsCallable\(functions, 'askAiRoomOpenAI'\)/);
  assert.match(html, /askOpenAI\(\{ accessCode: code, message, history \}\)/);
  assert.match(html, /selected\.length < 12/);
  assert.match(html, /12000/);
  assert.doesNotMatch(html, /AI_ROOM_ACCESS_CODE_SHA256/);
});

test('AI room backend checks the access code before contacting OpenAI', () => {
  const gateIndex = backend.indexOf('requireAccessCode(request.data?.accessCode)');
  const fetchIndex = backend.indexOf("fetch('https://api.openai.com/v1/responses'");
  assert.ok(gateIndex >= 0, 'access-code check should exist');
  assert.ok(fetchIndex > gateIndex, 'access-code check should happen before the OpenAI request');
  assert.match(backend, /crypto\.timingSafeEqual/);
});

test('AI room backend validates and forwards recent conversation context', () => {
  const historyIndex = backend.indexOf('requireHistory(request.data?.history)');
  const fetchIndex = backend.indexOf("fetch('https://api.openai.com/v1/responses'");
  assert.ok(historyIndex >= 0, 'history validation should exist');
  assert.ok(fetchIndex > historyIndex, 'history validation should happen before the OpenAI request');
  assert.match(backend, /const MAX_HISTORY_ITEMS = 12/);
  assert.match(backend, /const MAX_HISTORY_CHARS = 12000/);
  assert.match(backend, /input: \[\.\.\.history, \{ role: 'user', content: message \}\]/);
});

test('AI room page can clear in-memory conversation state', () => {
  assert.match(html, /id="clearBtn"/);
  assert.match(html, /conversation\.length = 0/);
  assert.match(html, /clearBtn\.onclick = resetConversation/);
});

test('Manus participant backend is prepared behind the same access gate', () => {
  const createStart = backend.indexOf('exports.createAiRoomManusTask');
  const pollStart = backend.indexOf('exports.getAiRoomManusTask');
  assert.ok(createStart >= 0, 'Manus task creation callable should exist');
  assert.ok(pollStart > createStart, 'Manus polling callable should exist');

  const createSection = backend.slice(createStart, pollStart);
  const gateIndex = createSection.indexOf('requireAccessCode(request.data?.accessCode)');
  const createFetchIndex = createSection.indexOf("fetch('https://api.manus.ai/v2/task.create'");
  assert.ok(gateIndex >= 0, 'Manus creation should require the room access code');
  assert.ok(createFetchIndex > gateIndex, 'access-code check should happen before task.create');
  assert.match(createSection, /'x-manus-api-key': apiKey/);
  assert.match(createSection, /agent_profile: 'manus-1\.6-lite'/);
  assert.match(createSection, /interactive_mode: false/);
  assert.match(createSection, /share_visibility: 'private'/);
});

test('Manus task status uses task.listMessages and is not exposed in the page yet', () => {
  const pollStart = backend.indexOf('exports.getAiRoomManusTask');
  const pollSection = backend.slice(pollStart);
  assert.match(pollSection, /task\.listMessages/);
  assert.match(pollSection, /agent_status/);
  assert.match(pollSection, /assistant_message/);
  assert.doesNotMatch(html, /createAiRoomManusTask/);
  assert.doesNotMatch(html, /getAiRoomManusTask/);
});

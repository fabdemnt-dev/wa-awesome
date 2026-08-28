import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../ai-room.html', import.meta.url), 'utf8');
const backend = await readFile(new URL('../functions-ai-room/index.js', import.meta.url), 'utf8');

test('AI room page sends an access code through the callable function', () => {
  assert.match(html, /httpsCallable\(functions, 'askAiRoomOpenAI'\)/);
  assert.match(html, /askOpenAI\(\{ accessCode: code, message \}\)/);
  assert.doesNotMatch(html, /AI_ROOM_ACCESS_CODE_SHA256/);
});

test('AI room backend checks the access code before contacting OpenAI', () => {
  const gateIndex = backend.indexOf('requireAccessCode(request.data?.accessCode)');
  const fetchIndex = backend.indexOf("fetch('https://api.openai.com/v1/responses'");
  assert.ok(gateIndex >= 0, 'access-code check should exist');
  assert.ok(fetchIndex > gateIndex, 'access-code check should happen before the OpenAI request');
  assert.match(backend, /crypto\.timingSafeEqual/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeniedWebChannelConnectivityProbe, abortDeniedBrowserRequest } from './helpers/floating-garden-browser-network.mjs';

test('only the exact denied SDK image probe after an intentional disconnect is diagnostic', () => {
  const probe = { url: 'https://www.google.com/images/cleardot.gif?zx=a9bc12', method: 'GET', resourceType: 'image', offlineExercised: true };
  assert.equal(isDeniedWebChannelConnectivityProbe(probe), true);
  for (const change of [
    { offlineExercised: false }, { method: 'POST' }, { resourceType: 'fetch' }, { resourceType: 'script' },
    { url: 'https://www.google.com/images/cleardot.gif' },
    { url: 'http://www.google.com/images/cleardot.gif?zx=abc' },
    { url: 'https://www.google.com:444/images/cleardot.gif?zx=abc' },
    { url: 'https://google.com/images/cleardot.gif?zx=abc' },
    { url: 'https://www.google.com.evil.invalid/images/cleardot.gif?zx=abc' },
    { url: 'https://www.google.com/other.gif?zx=abc' },
    { url: 'https://www.google.com/images/cleardot.gif?zx=abc&data=payload' },
    { url: 'https://www.google.com/images/cleardot.gif?zx=abc&zx=def' },
    { url: 'https://www.google.com/images/cleardot.gif?zx=' },
    { url: 'https://www.google.com/images/cleardot.gif?zx=payload%2Fvalue' },
    { url: 'https://user@www.google.com/images/cleardot.gif?zx=abc' },
    { url: 'https://www.google.com/images/cleardot.gif?zx=abc#fragment' },
    { url: 'https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel' },
    { url: 'https://identitytoolkit.googleapis.com/v1/accounts:signUp' },
    { url: 'invalid' },
  ]) assert.equal(isDeniedWebChannelConnectivityProbe({ ...probe, ...change }), false, JSON.stringify(change));
});

test('diagnostic and unexpected requests are always aborted, never allowed or mocked', async () => {
  for (const [url, expected] of [
    ['https://www.google.com/images/cleardot.gif?zx=abc123', true],
    ['https://www.google.com/images/cleardot.gif?zx=abc&data=private', false],
    ['https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel', false],
  ]) {
    const aborted = [];
    const route = {
      request: () => ({ url: () => url, method: () => 'GET', resourceType: () => 'image' }),
      abort: async (reason) => { aborted.push(reason); },
      continue: () => assert.fail('outbound request must not continue'),
      fulfill: () => assert.fail('connectivity success must not be mocked'),
    };
    assert.equal(await abortDeniedBrowserRequest(route, { offlineExercised: true }), expected);
    assert.deepEqual(aborted, ['blockedbyclient']);
  }
});

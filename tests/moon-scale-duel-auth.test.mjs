import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthTimeoutError, createAuthAttemptCoordinator, runAnonymousAuth } from '../moon-scale-duel-auth.js';

const never = () => new Promise(() => {});

test('既存ユーザーがいれば匿名サインインを追加実行しない', async () => {
  const existing = { uid: 'existing' };
  let signInCalls = 0;
  const result = await runAnonymousAuth({
    authStateReady: async () => {},
    getCurrentUser: () => existing,
    signIn: async () => { signInCalls += 1; },
    timeoutMs: 20,
  });
  assert.equal(result, existing);
  assert.equal(signInCalls, 0);
});

test('authStateReadyの明示エラーをそのまま判別できる', async () => {
  const expected = new Error('state-ready-rejected');
  await assert.rejects(runAnonymousAuth({
    authStateReady: async () => { throw expected; },
    getCurrentUser: () => null,
    signIn: async () => ({ user: { uid: 'unused' } }),
    timeoutMs: 20,
  }), (error) => error === expected);
});

test('signInAnonymouslyの明示エラーをそのまま判別できる', async () => {
  const expected = new Error('sign-in-rejected');
  await assert.rejects(runAnonymousAuth({
    authStateReady: async () => {},
    getCurrentUser: () => null,
    signIn: async () => { throw expected; },
    timeoutMs: 20,
  }), (error) => error === expected);
});

test('authStateReadyが完了しなければ段階付きtimeoutになる', async () => {
  await assert.rejects(runAnonymousAuth({
    authStateReady: never,
    getCurrentUser: () => null,
    signIn: async () => ({ user: { uid: 'unused' } }),
    timeoutMs: 5,
  }), (error) => error instanceof AuthTimeoutError && error.stage === 'auth-state-ready');
});

test('signInAnonymouslyが完了しなければ段階付きtimeoutになる', async () => {
  await assert.rejects(runAnonymousAuth({
    authStateReady: async () => {},
    getCurrentUser: () => null,
    signIn: never,
    timeoutMs: 5,
  }), (error) => error instanceof AuthTimeoutError && error.stage === 'sign-in-anonymously');
});

test('timeout後に古い認証処理が完了しても結果は成功へ変わらない', async () => {
  let completeOldAttempt;
  const oldAttempt = new Promise((resolve) => { completeOldAttempt = resolve; });
  const result = runAnonymousAuth({
    authStateReady: async () => {},
    getCurrentUser: () => null,
    signIn: () => oldAttempt,
    timeoutMs: 5,
  }).then(() => 'success', (error) => error.stage);
  assert.equal(await result, 'sign-in-anonymously');
  completeOldAttempt({ user: { uid: 'late-user' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(await result, 'sign-in-anonymously');
});

test('timeout後の再試行で成功できる', async () => {
  let calls = 0;
  const events = [];
  const coordinator = createAuthAttemptCoordinator({
    attempt: async () => {
      calls += 1;
      if (calls === 1) throw new AuthTimeoutError('auth-state-ready');
      return { uid: 'retry-user' };
    },
    onStart: () => events.push('start'),
    onSuccess: (user) => events.push(`success:${user.uid}`),
    onFailure: (error) => events.push(`failure:${error.stage}`),
    onSettled: () => events.push('settled'),
  });
  await coordinator.run();
  await coordinator.run();
  assert.equal(calls, 2);
  assert.deepEqual(events, [
    'start', 'failure:auth-state-ready', 'settled',
    'start', 'success:retry-user', 'settled',
  ]);
});

test('認証処理中の再試行連打は同じ試行を共有する', async () => {
  let calls = 0;
  let complete;
  const coordinator = createAuthAttemptCoordinator({
    attempt: () => {
      calls += 1;
      return new Promise((resolve) => { complete = resolve; });
    },
  });
  const first = coordinator.run();
  const second = coordinator.run();
  assert.equal(first, second);
  assert.equal(calls, 1);
  complete({ uid: 'single-user' });
  await first;
});

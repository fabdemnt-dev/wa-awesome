import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const base = (process.env.E2E_BASE_URL || 'https://fabdemnt-dev.github.io/wa-awesome/').replace(/\/?$/, '/');

test('モバイル表示：入室とタップ投稿', async ({ page }, info) => {
  page.on('dialog', dialog => dialog.accept());
  const checkWidth = async () => {
    await expect.poll(() => page.evaluate(() => {
      const root = document.documentElement;
      return root.scrollWidth - root.clientWidth;
    })).toBeLessThanOrEqual(1);
  };
  await page.goto(`${base}poem.html`);
  await expect(page.locator('#join-btn')).toBeVisible();
  await checkWidth();
  await page.locator('#player-name').fill('PW-Mobile');
  await page.locator('#room-id').fill(`pw-mobile-${randomUUID()}`);
  await page.locator('#join-btn').tap();
  await expect(page.locator('#lobby-sec')).toBeVisible();
  for (let i = 0; i < 5; i++) {
    await page.locator('#word-inputs input').nth(i).fill(`スマホ素材${i + 1}`);
  }
  await page.locator('#add-word-btn').tap();
  await expect(page.locator('#material-count')).toHaveText(/素材：\s*5個$/);
  await checkWidth();
  await info.attach('mobile-lobby', {
    body: await page.screenshot({ fullPage: true }), contentType: 'image/png',
  });
});

test('月秤オンライン：本番匿名認証から対戦入口へ進める', async ({ page }, info) => {
  const diagnostics = { consoleErrors: [], pageErrors: [], failedRequests: [] };
  page.on('console', message => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
  });
  page.on('pageerror', error => diagnostics.pageErrors.push(error.message));
  page.on('requestfailed', request => diagnostics.failedRequests.push({
    resourceType: request.resourceType(),
    errorText: request.failure()?.errorText || 'unknown',
  }));
  await page.goto(`${base}moon-scale-duel-online.html`);
  const status = page.locator('#status');
  await expect(status).toBeVisible();
  await expect(status).not.toHaveText('匿名ログイン中…', { timeout: 30000 });
  await expect(page.locator('#create-room')).toBeVisible();
  await expect(page.locator('#join-room')).toBeVisible();
  const horizontalOverflow = await page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(horizontalOverflow).toBeLessThanOrEqual(1);
  await info.attach('moon-scale-auth-diagnostics', {
    body: Buffer.from(JSON.stringify(diagnostics, null, 2)),
    contentType: 'application/json',
  });
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
  expect(diagnostics.failedRequests).toEqual([]);
});

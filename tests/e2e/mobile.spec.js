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

import { test, expect } from '@playwright/test';

const solutions = [
  ['right', 'right', 'right'],
  ['right', 'right', 'down', 'down'],
  ['right', 'down', 'down', 'down', 'down', 'right', 'right', 'right', 'up', 'up', 'up', 'up'],
];

async function openGame(page) {
  const errors = [];
  const external = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:4173') {
      external.push(url.origin);
      return route.abort();
    }
    return route.continue();
  });
  await page.goto('/lab/drunken-cat-puzzle/');
  await expect(page.locator('#board .cell')).toHaveCount(30);
  return () => {
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  };
}

async function solve(page, stage) {
  for (const direction of solutions[stage]) await page.locator(`[data-direction="${direction}"]`).click();
  await expect(page.locator('#cat-status')).toHaveText('落下！');
}

async function stageTwo(page) {
  await solve(page, 0);
  await page.locator('#next-stage').click();
  await expect(page.locator('#stage-number')).toHaveText('2 / 3');
  await page.locator('#board').scrollIntoViewIfNeeded();
}

async function geometry(page) {
  await page.locator('#board').scrollIntoViewIfNeeded();
  // Wait for the next-stage smooth scroll to settle before using coordinates.
  await page.evaluate(() => window.scrollTo({ top: window.scrollY, behavior: 'instant' }));
  const box = await page.locator('#board').boundingBox();
  return { x: box.x + box.width * 0.35, y: box.y + box.height * 0.35, t: Math.max(30, box.width / 6 * 0.82) };
}

test('three stages render without horizontal overflow and clear with one-cell buttons', async ({ page }, testInfo) => {
  const check = await openGame(page);
  for (let stage = 0; stage < 3; stage += 1) {
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
    for (const button of await page.locator('[data-direction]').all()) {
      const box = await button.boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(48);
      expect(box.height).toBeGreaterThanOrEqual(48);
    }
    await page.screenshot({ path: testInfo.outputPath(`stage-${stage + 1}.png`), fullPage: true });
    await solve(page, stage);
    await expect(page.locator('[data-direction]:disabled')).toHaveCount(4);
    await page.locator('#next-stage').click();
  }
  await expect(page.locator('#stage-number')).toHaveText('1 / 3');
  check();
});

test('adjacent pointer tap moves once and reset, undo, and keyboard remain usable', async ({ page }) => {
  const check = await openGame(page);
  await page.locator('.cell[data-x="2"][data-y="2"]').click();
  await expect(page.locator('#move-count')).toHaveText('1');
  await page.locator('#undo').click();
  await expect(page.locator('#move-count')).toHaveText('0');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#move-count')).toHaveText('1');
  await page.locator('#reset').click();
  await expect(page.locator('#move-count')).toHaveText('0');
  check();
});

test('mouse drag stops immediately and the next gesture can change axis', async ({ page }) => {
  const check = await openGame(page);
  await stageTwo(page);
  let { x, y, t } = await geometry(page);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + t * 2.1, y, { steps: 12 });
  await expect(page.locator('#move-count')).toHaveText('2');
  await page.waitForTimeout(300);
  await expect(page.locator('#move-count')).toHaveText('2');
  await page.mouse.up();
  ({ x, y, t } = await geometry(page));
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + t * 2.1, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator('#cat-status')).toHaveText('落下！');
  await page.locator('#undo').click();
  await expect(page.locator('#move-count')).toHaveText('2');
  await page.locator('#undo').click();
  await expect(page.locator('#move-count')).toHaveText('0');
  check();
});

test('narrow 320px viewport retains board, instructions and one-cell controls', async ({ page }, testInfo) => {
  const check = await openGame(page);
  await page.setViewportSize({ width: 320, height: 740 });
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(320);
  await expect(page.locator('.direction-pad')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('narrow-320.png'), fullPage: true });
  await solve(page, 0);
  check();
});

test('Chromium touch turns, stops, cancels and taps without double movement', async ({ page, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium' || !testInfo.project.use.hasTouch, 'CDP touch is available only on the mobile Chromium project');
  const check = await openGame(page);
  await page.locator('.cell[data-x="2"][data-y="2"]').tap();
  await expect(page.locator('#move-count')).toHaveText('1');
  await page.locator('#reset').tap();
  await stageTwo(page);
  const client = await page.context().newCDPSession(page);
  let { x, y, t } = await geometry(page);
  const touch = (type, px = x, py = y) => client.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x: px, y: py, id: 1 }],
  });
  await touch('touchStart');
  await touch('touchMove', x + t * 2.1, y);
  await expect(page.locator('#move-count')).toHaveText('2');
  await page.waitForTimeout(300);
  await expect(page.locator('#move-count')).toHaveText('2');
  await touch('touchMove', x + t * 2.1, y + t * 2.1);
  await touch('touchEnd');
  await expect(page.locator('#cat-status')).toHaveText('落下！');
  await page.locator('#undo').tap();
  await expect(page.locator('#move-count')).toHaveText('0');
  ({ x, y, t } = await geometry(page));
  await touch('touchStart');
  await touch('touchMove', x + t * 1.1, y);
  await touch('touchCancel');
  await expect(page.locator('#move-count')).toHaveText('1');
  await touch('touchStart');
  await touch('touchMove', x, y + t * 1.1);
  await touch('touchEnd');
  await expect(page.locator('#move-count')).toHaveText('2');
  await client.detach();
  check();
});

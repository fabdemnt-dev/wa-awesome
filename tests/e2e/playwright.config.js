import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: '*.spec.js', timeout: 240000,
  expect: { timeout: 30000 }, retries: 0, workers: 1,
  reporter: [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'results.json' }]],
  use: { browserName: 'chromium', headless: true, actionTimeout: 15000 },
});

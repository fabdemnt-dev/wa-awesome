import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: '*.spec.js', timeout: 240000,
  expect: { timeout: 30000 }, retries: 0, workers: 1,
  reporter: [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'results.json' }]],
  use: { browserName: 'chromium', headless: true, actionTimeout: 15000 },
  projects: [
    { name: 'multiplayer', testMatch: 'multiplayer.spec.js' },
    {
      name: 'Pixel 7', testMatch: 'mobile.spec.js',
      use: { ...devices['Pixel 7'], browserName: 'chromium', locale: 'ja-JP',
        screenshot: 'only-on-failure', trace: 'retain-on-failure', video: 'retain-on-failure' },
    },
    {
      name: 'iPhone 13', testMatch: 'mobile.spec.js',
      use: { ...devices['iPhone 13'], browserName: 'webkit', locale: 'ja-JP',
        screenshot: 'only-on-failure', trace: 'retain-on-failure', video: 'retain-on-failure' },
    },
  ],
});

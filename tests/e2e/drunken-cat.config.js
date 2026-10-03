import { defineConfig, devices } from '@playwright/test';

// Separate from the existing production E2E config. This serves only this CI
// checkout, needs no credentials and cannot be pointed at a production URL.
export default defineConfig({
  testDir: '.',
  testMatch: 'drunken-cat.spec.js',
  timeout: 30000,
  expect: { timeout: 5000 },
  retries: 0,
  workers: 1,
  outputDir: 'drunken-cat-results',
  reporter: [['list'], ['html', { outputFolder: 'drunken-cat-report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    locale: 'ja-JP',
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'python3 -m http.server 4173 --bind 127.0.0.1 --directory ../..',
    url: 'http://127.0.0.1:4173/lab/drunken-cat-puzzle/',
    reuseExistingServer: false,
  },
  projects: [
    { name: 'Desktop Chromium', use: { browserName: 'chromium', viewport: { width: 1000, height: 900 } } },
    { name: 'Pixel 7 Chromium', use: { ...devices['Pixel 7'], browserName: 'chromium' } },
    { name: 'iPhone 13 WebKit', use: { ...devices['iPhone 13'], browserName: 'webkit' } },
  ],
});

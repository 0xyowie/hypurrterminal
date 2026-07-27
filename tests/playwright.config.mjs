import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = process.env.TARGET || 'local';          // local | live
const PORT = Number(process.env.PORT || 4173);
const LIVE_URL = process.env.LIVE_URL || 'https://hypurrterminal.xyz';
const baseURL = TARGET === 'live' ? LIVE_URL : `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: path.join(HERE, 'specs'),
  outputDir: path.join(HERE, '..', 'test-results', TARGET),
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: TARGET === 'live' ? 3 : 5,
  retries: TARGET === 'live' ? 1 : 0,
  forbidOnly: true,
  reporter: [
    ['list'],
    ['json', { outputFile: path.join(HERE, '..', 'test-results', `${TARGET}.json`) }],
    ['html', { open: 'never', outputFolder: path.join(HERE, '..', 'test-results', `${TARGET}-html`) }],
  ],
  use: {
    baseURL,
    ...devices['Desktop Chrome'],
    // Pin the engine: the phone specs borrow the iPhone 13 descriptor for its
    // viewport/touch profile, and that descriptor would otherwise pull in WebKit.
    // Run `npx playwright install webkit` and set BROWSER=webkit for a real Safari pass.
    browserName: process.env.BROWSER || 'chromium',
    viewport: { width: 1440, height: 900 },
    // Escape hatch for environments that ship their own Chromium (CI images,
    // sandboxes) instead of the one this Playwright version downloads.
    launchOptions: process.env.PW_CHROMIUM
      ? { executablePath: process.env.PW_CHROMIUM, args: ['--no-sandbox'] }
      : undefined,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
  },
  webServer: TARGET === 'live' ? undefined : {
    command: `node ${JSON.stringify(path.join(HERE, 'helpers', 'serve.mjs'))}`,
    port: PORT,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});

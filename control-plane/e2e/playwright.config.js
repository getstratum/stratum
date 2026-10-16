// Functional tests of a running Stratum installation: the console in a real
// browser, and a gateway synced with it. See README.md.
import { defineConfig } from '@playwright/test'

const consoleUrl = process.env.STRATUM_E2E_CONSOLE_URL
if (!consoleUrl) throw new Error('Set STRATUM_E2E_CONSOLE_URL (see README.md)')

export default defineConfig({
  testDir: './tests',
  // One installation, one owner session: the steps build on each other.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'report' }]],
  outputDir: 'results',
  use: {
    baseURL: consoleUrl,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    ignoreHTTPSErrors: process.env.STRATUM_E2E_INSECURE_TLS === 'true',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    locale: 'es-UY',
    launchOptions: process.env.STRATUM_E2E_CHROMIUM ? { executablePath: process.env.STRATUM_E2E_CHROMIUM } : {},
  },
})

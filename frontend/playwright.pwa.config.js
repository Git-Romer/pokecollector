import { defineConfig, devices } from '@playwright/test'

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH

export default defineConfig({
  testDir: './tests/pwa',
  outputDir: './test-results-pwa',
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4175',
    launchOptions: executablePath ? { executablePath } : undefined,
  },
  webServer: {
    command: 'node scripts/serve-pwa-test.mjs',
    url: 'http://127.0.0.1:4175',
    reuseExistingServer: !process.env.CI,
    timeout: 240000,
  },
  projects: [
    {
      name: 'chromium-sw',
      use: { ...devices['Desktop Chrome'], serviceWorkers: 'allow' },
      testMatch: /(service-worker|push|large-image|collection-download)\.spec\.js/,
    },
    {
      name: 'chromium-page',
      use: { ...devices['Desktop Chrome'], serviceWorkers: 'block' },
      testIgnore: /(service-worker|push|large-image|collection-download)\.spec\.js/,
    },
    {
      name: 'webkit-page',
      use: { ...devices['Desktop Safari'], serviceWorkers: 'block' },
      testIgnore: /(service-worker|push|large-image|collection-download)\.spec\.js/,
    },
  ],
})

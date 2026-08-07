import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/visual',
  testMatch: 'card-system-webkit.spec.js',
  outputDir: './test-results-webkit',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4174',
    browserName: 'webkit',
    colorScheme: 'dark',
    viewport: { width: 1280, height: 1000 },
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4174',
    url: 'http://127.0.0.1:4174/__card-system',
    reuseExistingServer: !process.env.CI,
  },
})

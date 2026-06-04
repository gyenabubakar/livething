import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  timeout: 30_000,
  workers: 2,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:4180',
  },
  webServer: [
    {
      command: 'pnpm run dev:ui',
      port: 4180,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: 'pnpm run dev:ws',
      port: 8788,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});

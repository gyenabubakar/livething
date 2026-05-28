import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  timeout: 30_000,
  workers: 6,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:4173',
  },
  webServer: [
    {
      command: 'pnpm run dev:ui',
      port: 4173,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: 'wrangler dev --ip 127.0.0.1 --port 8787 --persist-to .wrangler/state-8787',
      port: 8787,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});

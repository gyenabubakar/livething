import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:8787',
  },
  webServer: {
    command: 'pnpm run dev',
    port: 8787,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});

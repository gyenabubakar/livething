import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  timeout: 30_000,
  // Cap worker count to keep load on the local Wrangler dev server
  // manageable. Higher parallelism causes `Network connection lost` errors
  // and test-pollution flakes. One retry covers residual transient issues
  // (real logic bugs fail both attempts).
  workers: 4,
  retries: 1,
  use: {
    baseURL: 'http://127.0.0.1:4173',
  },
  webServer: [
    {
      command: 'pnpm run dev:worker',
      port: 8787,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: 'pnpm run dev:ui',
      port: 4173,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});

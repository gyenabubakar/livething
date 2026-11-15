import { defineConfig } from '@playwright/test';

// The lane script (scripts/run.mjs) starts the server and one compose profile at a time.
export default defineConfig({
  testDir: 'tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: [['list']],
});

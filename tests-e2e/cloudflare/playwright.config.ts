import { defineConfig } from '@playwright/test';
import { SHARDS } from './shards.ts';

export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  timeout: 30_000,
  // Each shard handles a small subset of routes, so each Wrangler stays
  // lightly loaded. Two workers per shard keeps concurrency balanced.
  workers: SHARDS.length * 2,
  retries: 1,
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
    ...SHARDS.map(({ port }) => ({
      command: `wrangler dev --ip 127.0.0.1 --port ${port} --persist-to .wrangler/state-${port}`,
      port,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    })),
  ],
});

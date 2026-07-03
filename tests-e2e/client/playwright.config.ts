import { defineConfig } from '@playwright/test';

// Two run modes share one config, switched by env:
//  - puppet (default): the local controllable ws server drives adversarial
//    client behaviour the real protocol can't — forced drops, silence, offline.
//    Specs live in tests/puppet/.
//  - adapter: the conformance specs in tests/ run @wskit/client against a real
//    wskit server reached over the vite /ws proxy. WHICH server boots is
//    injected by the owning script through WSKIT_E2E_SERVER_COMMAND, so the
//    specs and pages never name an adapter — the same suite runs against
//    cloudflare, node, bun, and so on.
const serverCommand = process.env.WSKIT_E2E_SERVER_COMMAND;
const serverPort = Number(process.env.WSKIT_E2E_SERVER_PORT ?? 8787);
const adapter = Boolean(serverCommand);

export default defineConfig({
  testDir: 'tests',
  ...(adapter ? { testIgnore: '**/puppet/**' } : { testMatch: '**/puppet/**/*.spec.ts' }),
  fullyParallel: true,
  timeout: 30_000,
  workers: adapter ? 1 : 2,
  retries: 0,
  failOnFlakyTests: !!process.env.CI,
  use: {
    baseURL: 'http://127.0.0.1:4180',
  },
  webServer: [
    adapter
      ? {
          command: serverCommand!,
          port: serverPort,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        }
      : {
          command: 'pnpm run dev:ws',
          port: 8788,
          reuseExistingServer: !process.env.CI,
          timeout: 30_000,
        },
    {
      command: 'pnpm run dev:ui',
      port: 4180,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});

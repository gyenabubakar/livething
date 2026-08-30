import { defineConfig } from '@playwright/test';

// client-raw is adapter-agnostic: it serves the UI and talks to a WebSocket
// server over the vite `/ws` proxy. It never names Cloudflare or any other
// implementation. WHICH server to boot is injected by whoever drives the suite
// (an adapter's `test:e2e` script) through these env vars. Playwright starts
// the server entry first and waits for both ports before any test runs.
const serverCommand = process.env.WSKIT_E2E_SERVER_COMMAND;
const serverCwd = process.env.WSKIT_E2E_SERVER_CWD;
const serverPort = Number(process.env.WSKIT_E2E_SERVER_PORT ?? 8787);

export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  timeout: 30_000,
  // All tests share one dev server (wrangler dev / miniflare). Running tests
  // in parallel makes them fight over that server's WebSocket connections,
  // which causes random failures. One test at a time avoids the fight.
  workers: 1,
  retries: 0,
  failOnFlakyTests: !!process.env.CI,
  use: {
    baseURL: 'http://127.0.0.1:4173',
  },
  webServer: [
    ...(serverCommand
      ? [
          {
            command: serverCommand,
            cwd: serverCwd,
            port: serverPort,
            reuseExistingServer: false,
            timeout: 60_000,
          },
        ]
      : []),
    {
      command: 'pnpm run dev:ui',
      port: 4173,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});

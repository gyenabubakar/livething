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
  // One shared dev stack serves every feature, so heavy parallelism can drop a
  // request ("Network connection lost"). Fewer workers eases contention.
  // retries stays at 0 so a flake fails loudly — we fix the test or the bug
  // instead of letting a retry hide it.
  workers: 4,
  retries: 0,
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
            reuseExistingServer: !process.env.CI,
            timeout: 30_000,
          },
        ]
      : []),
    {
      command: 'pnpm run dev:ui',
      port: 4173,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});

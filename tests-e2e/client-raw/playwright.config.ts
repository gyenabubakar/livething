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
  // One shared dev stack serves every feature, so under load the local worker
  // (wrangler dev / miniflare) occasionally drops a socket ("Network connection
  // lost"), and a test waiting on a frame from that socket fails — the frame is
  // gone, not slow, so a longer timeout can't help.
  // `retries: 1` reopens the page with a FRESH connection, which is what a
  // dropped socket needs. It only fires on failure (no cost to green runs) and
  // can't mask a real bug — a deterministic failure fails the retry too.
  workers: 3,
  retries: 1,
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
            timeout: 60_000,
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

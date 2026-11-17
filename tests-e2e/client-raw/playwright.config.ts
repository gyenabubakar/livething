import { defineConfig } from '@playwright/test';

// client-raw is adapter-agnostic: it serves the UI and talks to a WebSocket
// server over the vite `/ws` proxy. It never names Cloudflare or any other
// implementation. WHICH server to boot is injected by whoever drives the suite
// (an adapter's `test:e2e` script) through these env vars. Playwright starts
// the server entry first and waits for both ports before any test runs.
const serverCommand = process.env.LIVETHING_E2E_SERVER_COMMAND;
const serverCwd = process.env.LIVETHING_E2E_SERVER_CWD;
const serverPort = Number(process.env.LIVETHING_E2E_SERVER_PORT ?? 8787);

// `@drop`: a connection dropped with no close, which a server sees only when its runtime
// reports the aborted stream. Local wrangler dev does not report it for an idle stream,
// so its http script sets LIVETHING_E2E_NO_STREAM_ABORT.
const skipDrops =
  process.env.LIVETHING_E2E_TRANSPORT === 'http' && !!process.env.LIVETHING_E2E_NO_STREAM_ABORT;

export default defineConfig({
  testDir: 'tests',
  ...(skipDrops ? { grepInvert: /@drop/ } : {}),
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
            // Two wrangler dev servers starting at once (pnpm test:e2e runs
            // the raw and packaged lanes side by side) can take over a minute.
            timeout: 180_000,
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

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

const sseClient = fileURLToPath(new URL('tests/_sse-client.ts', import.meta.url));

// The SSE run: every page's `@livething/client` import gets the client that connects over SSE.
function connectOverSse(): Plugin {
  return {
    name: 'livething-connect-over-sse',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === '@livething/client' && importer !== sseClient) return sseClient;

      return null;
    },
  };
}

// Serves the test pages and proxies WebSocket paths to whichever server a run
// needs, so the browser always talks to a same-origin socket:
//  - /wsx → the local puppet ws server (adversarial specs).
//  - /ws  → the adapter under test; its port is injected and defaults to the
//    cloudflare worker's 8787. The target is just a URL — the page never knows
//    which adapter is behind it.
export default defineConfig({
  plugins: process.env.LIVETHING_E2E_TRANSPORT === 'sse' ? [connectOverSse()] : [],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.LIVETHING_E2E_CLIENT_PORT ?? 4180),
    proxy: {
      '/wsx': { target: 'http://127.0.0.1:8788', ws: true, changeOrigin: true },
      // Keep the browser's Host, like a same-origin reverse proxy, so the server's Origin check passes.
      '/ws': {
        target: `http://127.0.0.1:${process.env.LIVETHING_E2E_SERVER_PORT ?? 8787}`,
        ws: true,
        changeOrigin: false,
      },
    },
  },
});

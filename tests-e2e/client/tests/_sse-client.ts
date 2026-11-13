// `@livething/client` for the SSE run: the same package, with `connect()` opening over
// server-sent events unless a page lists its own transports. vite.config.ts points the
// pages' `@livething/client` imports here when LIVETHING_E2E_TRANSPORT is `sse`.
import { connect as connectOverWebSocket, sse } from '@livething/client';

export * from '@livething/client';

export function connect(...[url, options]: Parameters<typeof connectOverWebSocket>) {
  return connectOverWebSocket(url, { transports: [sse()], ...options });
}

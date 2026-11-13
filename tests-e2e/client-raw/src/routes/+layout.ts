import { RawSseSocket } from '$lib/raw-sse-socket';

export const prerender = true;
export const ssr = false;

// The SSE run: every `new WebSocket(...)` in the pages and specs talks over SSE instead.
// A spec that put in its own `WebSocket` drives the page by hand, so it keeps it.
if (
  import.meta.env.VITE_LIVETHING_TRANSPORT === 'sse' &&
  globalThis.WebSocket.name === 'WebSocket'
) {
  globalThis.WebSocket = RawSseSocket as unknown as typeof WebSocket;
}

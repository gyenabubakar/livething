import { RawHttpSocket } from '$lib/raw-http-socket';

export const prerender = true;
export const ssr = false;

// The http run: every `new WebSocket(...)` in the pages and specs talks over the http transport instead.
// A spec that put in its own `WebSocket` drives the page by hand, so it keeps it.
if (
  import.meta.env.VITE_LIVETHING_TRANSPORT === 'http' &&
  globalThis.WebSocket.name === 'WebSocket'
) {
  globalThis.WebSocket = RawHttpSocket as unknown as typeof WebSocket;
}

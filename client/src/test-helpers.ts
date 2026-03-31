/**
 * Shared test utilities for runtime tests that use MSW WebSocket mocking.
 *
 * Provides a pre-configured MSW server, a typed socket factory, and
 * promise-based helpers for waiting on socket lifecycle events.
 */

/* oxlint-disable @typescript-eslint/no-explicit-any -- test helper file */
import { Socket } from '~/socket/socket.ts';
import { ws } from 'msw';
import { setupServer } from 'msw/node';
import type { FullSocketOptions } from '~/options.ts';
import type { Plugin } from '~/plugins/base.ts';
import type { CloseEvent } from '~/socket/socket.ts';
import type { SocketContract } from '~/types.ts';
import type { SetupServerApi } from 'msw/node';

// ---------------------------------------------------------------------------
// Test contract — broad enough for most runtime tests
// ---------------------------------------------------------------------------

export interface TestContract {
  incoming: { greeting: { text: string }; notification: { id: string } };
  outgoing: { chat: { text: string }; ping: {} };
}

// ---------------------------------------------------------------------------
// MSW setup
// ---------------------------------------------------------------------------

export const WS_URL = 'ws://localhost:9876';
export const link = ws.link(WS_URL);

let _server: SetupServerApi | null = null;

/** Lazily create and return the shared MSW server. */
export function getMswServer(): SetupServerApi {
  if (!_server) {
    _server = setupServer();
  }
  return _server;
}

// ---------------------------------------------------------------------------
// Socket factory
// ---------------------------------------------------------------------------

/**
 * Create a Socket with sensible test defaults (keepalive disabled).
 * Pass overrides for any option. Optionally pass plugins.
 */
export function createTestSocket<TContract extends SocketContract = TestContract>(
  overrides: Partial<FullSocketOptions<TContract>> = {},
  plugins: readonly Plugin<any, any>[] = [],
) {
  const opts: FullSocketOptions<TContract> = {
    pingInterval: 0,
    ...overrides,
  } as FullSocketOptions<TContract>;
  return new Socket<TContract>(WS_URL, opts, plugins);
}

// ---------------------------------------------------------------------------
// Lifecycle promises
// ---------------------------------------------------------------------------

/** Resolves the next time the socket fires `onOpen`. */
export function onceOpen<T extends SocketContract>(socket: Socket<T>): Promise<void> {
  return new Promise((resolve) => {
    const unsub = socket.onOpen(() => {
      unsub();
      resolve();
    });
  });
}

/** Resolves the next time the socket fires `onClose`. */
export function onceClose<T extends SocketContract>(socket: Socket<T>): Promise<CloseEvent> {
  return new Promise((resolve) => {
    const unsub = socket.onClose((event) => {
      unsub();
      resolve(event);
    });
  });
}

/** Resolves the next time the socket fires `onReconnect`. */
export function onceReconnect<T extends SocketContract>(socket: Socket<T>): Promise<void> {
  return new Promise((resolve) => {
    const unsub = socket.onReconnect(() => {
      unsub();
      resolve();
    });
  });
}

/** Resolves the next time the socket fires `onError`. */
export function onceError<T extends SocketContract>(socket: Socket<T>): Promise<Event> {
  return new Promise((resolve) => {
    const unsub = socket.onError((error) => {
      unsub();
      resolve(error);
    });
  });
}

// ---------------------------------------------------------------------------
// General utilities
// ---------------------------------------------------------------------------

/** Wait for a given number of milliseconds (real time, not fake). */
export function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Collect all messages a server receives from a client. Returns the array
 * (mutated in place as messages arrive).
 *
 * Usage inside a `link.addEventListener('connection', ({ client }) => { ... })`:
 * ```ts
 * const received = collectServerMessages(client);
 * ```
 */
export function collectServerMessages(client: {
  addEventListener: (type: 'message', cb: (event: { data: unknown }) => void) => void;
}): string[] {
  const messages: string[] = [];
  client.addEventListener('message', (event) => {
    messages.push(event.data as string);
  });
  return messages;
}

/**
 * Parse a serialized message (default `{ event, payload }` JSON format).
 */
export function parseMessage(raw: string): { event: string; payload: unknown } {
  return JSON.parse(raw) as { event: string; payload: unknown };
}

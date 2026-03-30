/**
 * Thrown when a pending `request()` or `send.withAck()` is rejected
 * because the socket disconnected before a response arrived.
 *
 * ```ts
 * import { DisconnectedError } from '@better-websocket/client';
 *
 * try {
 *   await socket.request('get-balance', { userId });
 * } catch (err) {
 *   if (err instanceof DisconnectedError) {
 *     // handle disconnect — retry, show offline UI, etc.
 *   }
 * }
 * ```
 */
export class DisconnectedError extends Error {
  constructor() {
    super('Disconnected');
    this.name = 'DisconnectedError';
  }
}

/**
 * Thrown when a `request()` or `send.withAck()` does not receive a
 * response within the configured timeout.
 *
 * ```ts
 * import { TimeoutError } from '@better-websocket/client';
 *
 * try {
 *   await socket.request('slow-query', data, { timeout: 5000 });
 * } catch (err) {
 *   if (err instanceof TimeoutError) {
 *     // handle timeout — show retry prompt, etc.
 *   }
 * }
 * ```
 */
export class TimeoutError extends Error {
  constructor(operation: string, ms: number) {
    super(`${operation} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

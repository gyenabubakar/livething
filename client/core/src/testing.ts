/**
 * Testing utilities for `@better-websocket/client`.
 *
 * Import from `@better-websocket/client/testing` in test files only.
 * These utilities are never needed in production.
 *
 * ```ts
 * import { inject } from '@better-websocket/client/testing';
 *
 * inject(socket, 'notification', { id: '123', title: 'Test' });
 * ```
 */

import type { Socket } from '@/socket/socket.ts';
import type { IncomingOf, SocketContract } from '@/types.ts';

/**
 * Inject a fake message into the socket as if the server sent it.
 * The message runs through middleware and plugin `onIncoming` hooks,
 * then dispatches to `.on()` handlers — exactly like a real message.
 *
 * Works even when the socket is disconnected. Useful for:
 * - Testing event handlers without a real server
 * - Manual testing ("what does my UI look like when X arrives?")
 * - Load testing ("what happens when 50 messages arrive at once?")
 *
 * ```ts
 * inject(socket, 'notification', { id: 'test-1', title: 'Test' });
 * ```
 */
export function inject<
  TContract extends SocketContract,
  K extends keyof IncomingOf<TContract> & string,
>(socket: Socket<TContract>, event: K, payload: IncomingOf<TContract>[K]): void {
  // Run through middleware chain
  let msg: { event: string; payload: unknown } | null = { event, payload };
  for (const mw of socket._middleware) {
    const result = mw(msg!);
    if (result === null) return;
    if (result !== undefined) msg = result;
  }

  // Run through plugin onIncoming hooks
  let pluginMsg: { event: string; payload: unknown } | null = msg;
  for (const plugin of socket._plugins) {
    if (!plugin.onIncoming) continue;
    pluginMsg = plugin.onIncoming(pluginMsg!);
    if (pluginMsg === null) return;
  }

  // Dispatch to on() handlers
  socket._emitter.emit('message', pluginMsg!.event, pluginMsg!.payload);
}

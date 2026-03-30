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
import type { ChannelsOf, IncomingOf, SocketContract } from '@/types.ts';

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
  dispatchMessage(socket, event, payload);
}

/**
 * Inject a fake message into a channel as if the server sent it.
 * Tags the payload with `_channel` and runs it through the full
 * pipeline — middleware, plugin `onIncoming` hooks (including the
 * Channels plugin which routes it to `channel().on()` handlers).
 *
 * Works even when the socket is disconnected.
 *
 * ```ts
 * injectChannel(socket, 'chat', 'message', { text: 'hello' });
 * ```
 */
export function injectChannel<
  TContract extends SocketContract,
  TChannel extends keyof ChannelsOf<TContract> & string,
  K extends keyof IncomingOf<ChannelsOf<TContract>[TChannel]> & string,
>(
  socket: Socket<TContract>,
  channel: TChannel,
  event: K,
  payload: IncomingOf<ChannelsOf<TContract>[TChannel]>[K],
): void {
  // Tag the payload with _channel so the Channels plugin routes it
  const tagged = { ...(payload as Record<string, unknown>), _channel: channel };
  dispatchMessage(socket, event, tagged);
}

/**
 * Shared dispatch logic: runs a message through middleware → plugin
 * onIncoming hooks → emitter. Used by both inject() and injectChannel().
 */
function dispatchMessage<TContract extends SocketContract>(
  socket: Socket<TContract>,
  event: string,
  payload: unknown,
): void {
  let msg: { event: string; payload: unknown } | null = { event, payload };
  for (const mw of socket._middleware) {
    const result = mw(msg!);
    if (result === null) return;
    if (result !== undefined) msg = result;
  }

  let pluginMsg: { event: string; payload: unknown } | null = msg;
  for (const plugin of socket._plugins) {
    if (!plugin.onIncoming) continue;
    pluginMsg = plugin.onIncoming(pluginMsg!);
    if (pluginMsg === null) return;
  }

  socket._emitter.emit('message', pluginMsg!.event, pluginMsg!.payload);
}

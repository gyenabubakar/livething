import type { Message } from '~/internal/runtime.ts';
import type { Socket } from '~/socket/api.ts';
import type { LiveThingSocket } from '~/socket/socket.ts';
import type { ChannelsOf, IncomingOf, SocketContract } from '~/types.ts';

/** Push a message object through the real incoming pipeline, even if the socket is disconnected. */
function deliver(socket: object, message: Message): void {
  (socket as unknown as LiveThingSocket)._processIncoming(message);
}

/**
 * Inject a fake message as if the server sent it. It runs through intercept
 * hooks and primitive `onIncoming` hooks, then dispatches to `.on()` handlers —
 * exactly like a real message. Works even when the socket is disconnected.
 *
 * ```ts
 * inject(socket, 'notification', { id: '123', title: 'Test' });
 * ```
 */
export function inject<
  TContract extends SocketContract,
  K extends keyof IncomingOf<TContract> & string,
>(socket: Socket<TContract>, event: K, payload: IncomingOf<TContract>[K]): void {
  deliver(socket, { event, payload, metadata: null });
}

// oxlint-disable max-params -- the scoped injectors need (socket, scope, event, payload)

/**
 * Inject a fake message into a channel. Tags the frame with channel metadata.
 * so the `channels` primitive routes it to that channel's handlers.
 *
 * ```ts
 * injectChannel(socket, 'general', 'message', { text: 'hello', from: 'test-user' });
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
  deliver(socket, { event, payload, metadata: { channel: { name: channel } } });
}

// oxlint-enable max-params

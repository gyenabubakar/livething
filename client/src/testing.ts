/**
 * Testing utilities for `@wskit/client`.
 *
 * Import from `@wskit/client/testing` — in test files only, or behind an
 * `import.meta.env.DEV` check. Never needed in production; build tools drop the
 * dev-only import so this entry point isn't bundled.
 */

import type { WireMessage } from '~/internal/runtime.ts';
import type { Socket } from '~/socket/api.ts';
import type { WSKitSocket } from '~/socket/socket.ts';
import type { ChannelsOf, IncomingOf, NamespacesOf, SocketContract } from '~/types.ts';

/** Feed a built frame through the real incoming pipeline, with or without a live socket. */
function deliver(socket: object, message: WireMessage): void {
  (socket as unknown as WSKitSocket)._processIncoming(message);
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
  deliver(socket, { event, payload });
}

// oxlint-disable max-params -- the scoped injectors need (socket, scope, event, payload)

/**
 * Inject a fake message into a channel. Tags the frame with `__wskit.channel`
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
  deliver(socket, { event, payload, __wskit: { channel } });
}

/**
 * Inject a fake message into a namespace. Tags the frame with
 * `__wskit.namespace` so the `namespaces` primitive routes it to that
 * namespace's handlers.
 *
 * ```ts
 * injectNamespace(socket, 'alerts', 'new-alert', { level: 'critical', text: 'Server down' });
 * ```
 */
export function injectNamespace<
  TContract extends SocketContract,
  TNamespace extends keyof NamespacesOf<TContract> & string,
  K extends keyof IncomingOf<NamespacesOf<TContract>[TNamespace]> & string,
>(
  socket: Socket<TContract>,
  namespace: TNamespace,
  event: K,
  payload: IncomingOf<NamespacesOf<TContract>[TNamespace]>[K],
): void {
  deliver(socket, { event, payload, __wskit: { namespace } });
}

// oxlint-enable max-params

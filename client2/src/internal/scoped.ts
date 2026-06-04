/**
 * How namespaces and channels let other primitives add methods to their
 * messaging objects.
 *
 * A scoped messaging (what `socket.namespace('x')` or `socket.channel('y')`
 * returns) starts with `on` and `send`. Primitives like requestResponse and ack
 * want to add `request` and `sendWithAck` to it too. They can't know the scope
 * names ahead of time, so instead they register an "augmenter": a function that
 * decorates an messaging once it's built. The scope tells the augmenter which
 * `__wskit` markers to stamp on outgoing frames (e.g. `{ namespace: 'x' }`).
 */

import type { WSKitEnvelope } from '~/internal/runtime.ts';
import type { WSKitSocket } from '~/socket/socket.ts';

/** The `__wskit` fields that identify a scope — what an messaging stamps on its frames. */
export type ScopeMarkers = Pick<WSKitEnvelope, 'namespace' | 'channel' | 'channelScope'>;

/**
 * The runtime shape of a scoped messaging (what `socket.namespace('x')` returns).
 * `on` and `send` are always there; augmenters (requestResponse, ack, stream)
 * add their methods through the index signature. The precise, contract-typed
 * view a developer sees is `ScopedMessaging` — this is just the loose object the
 * library builds and extends at runtime.
 */
export interface MessagingObject {
  on(event: string, handler: (data: unknown) => void): () => void;
  send(event: string, payload: unknown, options?: { ttl?: number }): boolean;
  [key: string]: unknown;
}

/** Tells an augmenter about the scope it's decorating. */
export interface ScopeInfo {
  /** The `__wskit` markers that identify this scope. Never throws. */
  markers(): ScopeMarkers;

  /**
   * Throw if the scope can't send yet — a channel guards against sending before
   * it's subscribed. Sending methods (send, request, sendWithAck, stream) call
   * this; listen-only ones (on, onStream) don't. Absent means "always ready."
   */
  assertReady?(): void;
}

/** Adds methods to a freshly built scoped messaging. */
export type Augmenter = (messaging: MessagingObject, scope: ScopeInfo) => void;

/**
 * The shared list of augmenters, kept on the socket. This mechanism owns the
 * `_augmenters` field, so it's the one place that reaches past the socket's
 * declared members.
 */
export function getAugmenters(socket: WSKitSocket): Augmenter[] {
  // @ts-expect-error — `_augmenters` is this mechanism's own stash on the socket
  return (socket._augmenters ??= []) as Augmenter[];
}

/** Run every registered augmenter over an messaging. */
export function applyAugmenters(
  socket: WSKitSocket,
  messaging: MessagingObject,
  scope: ScopeInfo,
): void {
  for (const augment of getAugmenters(socket)) augment(messaging, scope);
}

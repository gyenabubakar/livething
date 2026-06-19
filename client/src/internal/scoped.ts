import type { WSKitEnvelope } from '~/internal/runtime.ts';
import type { WSKitSocket } from '~/socket/socket.ts';

/** The `__wskit` fields that identify which scope a frame belongs to. */
export type ScopeMarkers = Pick<WSKitEnvelope, 'channel' | 'channelScope'>;

/**
 * The runtime shape of a scoped messaging (what `socket.channel('x')` returns).
 * `on` and `send` are always present; augmenters (requestResponse, stream)
 * add extra methods via the index signature. The typed view exposed to developers
 * is `ScopedMessaging` — this is the loose internal object the library builds
 * and extends at runtime.
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
   * Throw if the scope isn't ready to send yet — a channel uses this to block
   * sends before it's subscribed. Send methods (send, request, stream)
   * call this; listen-only ones (on, onStream) don't. Omitting it means "always ready."
   */
  assertReady?(): void;
}

/** Adds methods to a freshly built scoped messaging. */
export type Augmenter = (messaging: MessagingObject, scope: ScopeInfo) => void;

/**
 * Get the shared list of augmenters stored on the socket. This function owns
 * the `_augmenters` field, so it's the only place that accesses it directly.
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

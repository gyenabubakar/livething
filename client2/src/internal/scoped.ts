// How namespaces and channels let other primitives add methods to their
// endpoint objects.
//
// A scoped endpoint (what `socket.namespace('x')` or `socket.channel('y')`
// returns) starts with `on` and `send`. Primitives like requestResponse and ack
// want to add `request` and `sendWithAck` to it too. They can't know the scope
// names ahead of time, so instead they register an "augmenter": a function that
// decorates an endpoint once it's built. The scope tells the augmenter which
// `__wskit` markers to stamp on outgoing frames (e.g. `{ namespace: 'x' }`).

import type { WSKitEnvelope } from '~/internal/runtime.ts';
import type { WSKitSocket } from '~/socket/socket.ts';

/** The `__wskit` fields that identify a scope — what an endpoint stamps on its frames. */
export type ScopeMarkers = Pick<WSKitEnvelope, 'namespace' | 'channel' | 'channelScope'>;

/**
 * The runtime shape of a scoped endpoint (what `socket.namespace('x')` returns).
 * `on` and `send` are always there; augmenters (requestResponse, ack, stream)
 * add their methods through the index signature. The precise, contract-typed
 * view a developer sees is `ScopedEndpoint` — this is just the loose object the
 * library builds and extends at runtime.
 */
export interface EndpointObject {
  on(event: string, handler: (data: unknown) => void): () => void;
  send(event: string, payload: unknown, options?: { ttl?: number }): boolean;
  [key: string]: unknown;
}

/** Tells an augmenter how to tag frames for the scope it's decorating. */
export interface ScopeInfo {
  markers(): ScopeMarkers;
}

/** Adds methods to a freshly built scoped endpoint. */
export type Augmenter = (endpoint: EndpointObject, scope: ScopeInfo) => void;

/**
 * The shared list of augmenters, kept on the socket. This mechanism owns the
 * `_augmenters` field, so it's the one place that reaches past the socket's
 * declared members.
 */
export function getAugmenters(socket: WSKitSocket): Augmenter[] {
  // @ts-expect-error — `_augmenters` is this mechanism's own stash on the socket
  return (socket._augmenters ??= []) as Augmenter[];
}

/** Run every registered augmenter over an endpoint. */
export function applyAugmenters(
  socket: WSKitSocket,
  endpoint: EndpointObject,
  scope: ScopeInfo,
): void {
  for (const augment of getAugmenters(socket)) augment(endpoint, scope);
}

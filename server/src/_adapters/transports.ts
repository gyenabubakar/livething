import { LiveThingConfigError } from '@livething/core';

/** The name of a transport a server endpoint offers. */
export type ServerTransportName = 'websocket';

/**
 * A transport a server endpoint offers, listed in the `transports` option of the
 * adapter's `bind()`. Each adapter package exports the functions that make one.
 */
export interface ServerTransport {
  readonly name: ServerTransportName;
}

const TRANSPORT_NAMES: ReadonlySet<string> = new Set<ServerTransportName>(['websocket']);

/** The WebSocket transport, and the default one. */
export function websocket(): ServerTransport {
  return { name: 'websocket' };
}

/**
 * Check a `transports` option at startup, and return the names it offers. Leaving the
 * option out offers WebSocket only. The order of the list does not matter.
 */
export function resolveTransports(
  transports: readonly ServerTransport[] | undefined,
): ReadonlySet<ServerTransportName> {
  if (transports === undefined) return new Set(['websocket']);

  const names = transports.map((transport) => (transport as ServerTransport | null)?.name);
  if (names.length === 0) {
    throw new LiveThingConfigError(
      'bind() transports must list at least one transport, such as [websocket()].',
    );
  }

  const badIndex = names.findIndex(
    (name) => typeof name !== 'string' || !TRANSPORT_NAMES.has(name),
  );
  if (badIndex !== -1) {
    throw new LiveThingConfigError(
      `bind() transports lists something that is not a transport: ${String(names[badIndex])}. Use the functions the adapter exports, such as websocket().`,
    );
  }

  const offered = new Set(names as ServerTransportName[]);
  if (offered.size !== names.length) {
    throw new LiveThingConfigError(
      `bind() transports lists the same transport twice: ${names.join(', ')}.`,
    );
  }

  return offered;
}

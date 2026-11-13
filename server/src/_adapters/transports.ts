import { LiveThingConfigError } from '@livething/core';
import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import type { ServerDefinition } from '~/server-definition.ts';

/** The name of a transport a server endpoint offers. */
export type ServerTransportName = 'websocket' | 'sse';

/**
 * A transport a server endpoint offers, listed in the `transports` option of the
 * adapter's `bind()`. Each adapter package exports the functions that make one.
 */
export interface ServerTransport {
  readonly name: ServerTransportName;
}

/** Options of the server-sent events transport. */
export interface SseOptions {
  /**
   * The largest POST body a client may send, in bytes. A client sends a bigger message
   * over uploads. At most half of `maxMessageBytes`. Default: 512 KiB.
   */
  maxPostBytes?: number;
}

interface SseTransport extends ServerTransport {
  readonly name: 'sse';
  readonly maxPostBytes: number;
}

/** The transports an endpoint offers, after the startup checks. */
export interface ResolvedTransports {
  readonly websocket: boolean;
  /** The server-sent events settings, or `null` when the endpoint does not offer it. */
  readonly sse: { readonly maxPostBytes: number } | null;
}

const TRANSPORT_NAMES: ReadonlySet<string> = new Set<ServerTransportName>(['websocket', 'sse']);

/** The default `maxPostBytes`: under nginx's 1 MB body limit, above the 256 KiB upload piece. */
const DEFAULT_MAX_POST_BYTES = 512 * 1024;

/** The WebSocket transport, and the default one. */
export function websocket(): ServerTransport {
  return { name: 'websocket' };
}

/**
 * Server-sent events from the server, and POST requests from the client. A fallback for
 * networks that block WebSocket. It needs `keepalive()` in the server definition.
 */
export function sse(options: SseOptions = {}): ServerTransport {
  const maxPostBytes = options.maxPostBytes ?? DEFAULT_MAX_POST_BYTES;
  if (!Number.isSafeInteger(maxPostBytes) || maxPostBytes < 1) {
    throw new LiveThingConfigError(
      `sse() maxPostBytes must be a whole number of bytes from 1, got ${String(maxPostBytes)}.`,
    );
  }

  const transport: SseTransport = { name: 'sse', maxPostBytes };
  return transport;
}

/**
 * Whether a server definition has a capability, such as `'keepalive'`. A transport reads
 * this to check its needs at startup, without reading the definition's internal tags.
 */
export function hasCapability(
  definition: ServerDefinition,
  capability: keyof typeof CAPABILITY_KIND,
): boolean {
  return definition.__capabilityKinds?.has(CAPABILITY_KIND[capability]) === true;
}

/**
 * Check a `transports` option at startup, and return what it offers. Leaving the option
 * out offers WebSocket only. The order of the list does not matter.
 */
export function resolveTransports(
  transports: readonly ServerTransport[] | undefined,
  definition: ServerDefinition,
): ResolvedTransports {
  if (transports === undefined) return { websocket: true, sse: null };

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

  if (new Set(names).size !== names.length) {
    throw new LiveThingConfigError(
      `bind() transports lists the same transport twice: ${names.join(', ')}.`,
    );
  }

  const sseTransport = transports.find((transport): transport is SseTransport => {
    return transport.name === 'sse';
  });
  // A stream can go quiet behind a proxy that never closes it, and only pings find that out.
  if (sseTransport && !hasCapability(definition, 'keepalive')) {
    throw new LiveThingConfigError(
      'bind() transports lists sse(), which needs keepalive() in the server definition. Add keepalive() to server({ capabilities: [...] }).',
    );
  }

  return {
    websocket: names.includes('websocket'),
    sse: sseTransport ? { maxPostBytes: sseTransport.maxPostBytes } : null,
  };
}

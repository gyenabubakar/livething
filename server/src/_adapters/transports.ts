import { LiveThingConfigError } from '@livething/core';
import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import type { AuthDecision, ConnectionHandle, SocketDescriptor, TransportFrame } from './types.ts';

/** The name of a transport a server endpoint offers: a built-in one, or a custom one. */
export type ServerTransportName = 'websocket' | 'sse' | (string & {});

/** A connection a custom transport hands to the engine with `endpoint.accept()`. */
export interface TransportConnection extends Omit<
  SocketDescriptor,
  'send' | 'backpressureSupported'
> {
  /**
   * Returns `false` when the frame was not sent, for example because the connection is
   * closing. Only a synchronous `false` counts, so `send` must not return a Promise.
   */
  send(frame: TransportFrame): boolean | void;
  /** `true` only when `bufferedAmount()` reports the real bytes waiting to be sent. */
  backpressureSupported: boolean;
  /**
   * A secret the client sends with each request to name this connection, or none. The
   * engine puts it in the `__connected__` frame, so the client reads it from there.
   */
  secret?: string;
  /** The largest request body this connection accepts, for the `__connected__` frame. */
  maxPostBytes?: number;
}

/** What an endpoint gives a custom transport for each request. */
export interface TransportEndpoint {
  /**
   * Runs the endpoint's origin check, then the app's `authenticate`. A bad origin gives
   * `{ reject: true, code: 403 }`. Pass the request `handle()` got, so the client IP is kept.
   */
  authenticate(request: Request): Promise<AuthDecision>;
  /** Hands an accepted connection to the engine. Report its messages and its close to the handle. */
  accept(connection: TransportConnection, decision: AuthDecision): ConnectionHandle;
}

/**
 * A transport a server endpoint offers, listed in the `transports` option of the
 * adapter's `bind()`. Each adapter package exports the built-in ones. A custom transport
 * has its own `name` and a `handle()`.
 */
export interface ServerTransport {
  readonly name: ServerTransportName;
  /** Checks the server definition when `bind()` runs. Throw to stop a startup that cannot work. */
  check?(definition: ServerDefinition): void;
  /**
   * Serves a request to the endpoint that is not a WebSocket upgrade. Return `null` when
   * the request is not for this transport, and the endpoint tries the next one.
   */
  handle?(request: Request, endpoint: TransportEndpoint): Promise<Response | null>;
}

/** A custom transport, after the startup checks. */
export interface CustomServerTransport extends ServerTransport {
  handle(request: Request, endpoint: TransportEndpoint): Promise<Response | null>;
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
  /** The custom transports, in list order. Each gets a request before server-sent events do. */
  readonly custom: readonly CustomServerTransport[];
}

const BUILT_IN_NAMES: ReadonlySet<string> = new Set(['websocket', 'sse']);

/** The default `maxPostBytes`: under nginx's 1 MB body limit, above the 256 KiB upload piece. */
const DEFAULT_MAX_POST_BYTES = 512 * 1024;

/** The WebSocket transport, and the default one. */
export function websocket(): ServerTransport {
  return { name: 'websocket' };
}

/**
 * Server-sent events from the server, and POST requests from the client: a full transport
 * that works over plain HTTP. List it alone, or after `websocket()` so a client on a network
 * that blocks WebSocket moves to it. It needs `keepalive()` in the server definition.
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
  if (transports === undefined) return { websocket: true, sse: null, custom: [] };

  const names = transports.map((transport) => (transport as ServerTransport | null)?.name);
  if (names.length === 0) {
    throw new LiveThingConfigError(
      'bind() transports must list at least one transport, such as [websocket()].',
    );
  }

  for (const transport of transports) checkShape(transport);

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

  for (const transport of transports) transport.check?.(definition);

  return {
    websocket: names.includes('websocket'),
    sse: sseTransport ? { maxPostBytes: sseTransport.maxPostBytes } : null,
    custom: transports.filter(isCustom),
  };
}

function isCustom(transport: ServerTransport): transport is CustomServerTransport {
  return typeof transport.handle === 'function';
}

function checkShape(transport: ServerTransport | null): void {
  const name = transport?.name;
  if (typeof name !== 'string' || name === '') {
    throw new LiveThingConfigError(
      `bind() transports lists something that is not a transport: ${String(name)}. Use the functions the adapter exports, such as websocket(), or a custom transport with a name and a handle().`,
    );
  }

  if (BUILT_IN_NAMES.has(name) && isCustom(transport!)) {
    throw new LiveThingConfigError(
      `bind() transports lists a custom transport named '${name}'. '${name}' is the name of a built-in transport, so give it another name.`,
    );
  }

  if (!BUILT_IN_NAMES.has(name) && !isCustom(transport!)) {
    throw new LiveThingConfigError(
      `bind() transports lists something that is not a transport: ${name}. A custom transport needs a handle() function.`,
    );
  }
}

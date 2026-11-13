import { LiveThingConfigError } from '@livething/core';
import type { EmptyTypeFn, Primitive } from '~/primitives/types.ts';
import type { TransportFactory } from '~/transports/transport.ts';

function assertValidTransports(transports: readonly TransportFactory[]): void {
  const names = transports.map((transport) => transport?.name);
  if (names.length === 0 || names.some((name) => typeof name !== 'string')) {
    throw new LiveThingConfigError(
      'connect() transports must list at least one transport, such as [websocket()].',
    );
  }

  if (new Set(names).size !== names.length) {
    throw new LiveThingConfigError(
      `connect() transports lists the same transport twice: ${names.join(', ')}.`,
    );
  }
}

/** Options for `connect()`. */
export interface ConnectOptions {
  /** Don't open the socket until something actually needs it. Default: `false`. */
  lazy?: boolean;
  /** In lazy mode, close after this many ms of no use. `0` means never. Default: `10_000`. */
  lazyIdleTimeoutMs?: number;
  /** Subprotocols to pass to the WebSocket (e.g. `['graphql-ws']`). */
  protocols?: string[];
  /**
   * Returns the login token, or `null` for none. It runs on every connect and reconnect,
   * so a refreshed token is used. The server's `authenticate` reads it from the
   * `Authorization` header as `Bearer <token>`.
   */
  token?: () => string | null | undefined | Promise<string | null | undefined>;
  /** The transports to connect with, such as `[websocket()]`. Default: WebSocket only. */
  transports?: readonly TransportFactory[];
}

/** What `connect()` returns. */
export interface ConnectDescriptor extends Primitive<EmptyTypeFn> {
  readonly _tag: 'connect';
}

/**
 * The one required piece of every client: where to connect. `url` can be a
 * string, or a function that runs on every connect and reconnect — handy for
 * failover or load balancing, where the address can change.
 *
 * ```ts
 * connect('wss://example.com/ws');
 * connect(() => getRegionalUrl(), { lazy: true });
 * ```
 */
export function connect(
  url: string | (() => string | Promise<string>),
  options?: ConnectOptions,
): ConnectDescriptor {
  return {
    _tag: 'connect',
    applyConfig(config) {
      config.url = url;
      if (options?.lazy !== undefined) config.lazy = options.lazy;
      if (options?.lazyIdleTimeoutMs !== undefined) {
        config.lazyIdleTimeoutMs = options.lazyIdleTimeoutMs;
      }

      if (options?.protocols !== undefined) config.protocols = options.protocols;
      if (options?.token !== undefined) config.token = options.token;
      if (options?.transports !== undefined) {
        assertValidTransports(options.transports);
        config.transports = options.transports;
      }
    },
  };
}

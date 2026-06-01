import type { EmptyTypeFn, Primitive } from '~/primitives/types.ts';

/** Options for `connect()`. */
export interface ConnectOptions {
  /** Don't open the socket until something actually needs it. Default: `false`. */
  lazy?: boolean;
  /** In lazy mode, close after this many ms of no use. `0` means never. Default: `10_000`. */
  idleTimeout?: number;
  /** Subprotocols to pass to the WebSocket (e.g. `['graphql-ws']`). */
  protocols?: string[];
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
 * connect(() => getRegionalEndpoint(), { lazy: true });
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
      if (options?.idleTimeout !== undefined) config.idleTimeout = options.idleTimeout;
      if (options?.protocols !== undefined) config.protocols = options.protocols;
    },
  };
}

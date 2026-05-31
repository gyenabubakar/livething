import type { EmptyTypeFn, PrimitiveSpec } from '~/primitives/types.ts';

/** Options for the `connect` capability. */
export interface ConnectOptions {
  /**
   * Don't connect until something needs the connection (first `on()`, `send()`,
   * or a primitive operation that requires a connection). Default: `false`.
   */
  lazy?: boolean;
  /**
   * How long to wait with no activity before disconnecting in lazy mode (ms).
   * `0` disables idle disconnect. Default: `10_000`.
   */
  idleTimeout?: number;
  /** Subprotocols passed to the WebSocket constructor (e.g. `['graphql-ws']`). */
  protocols?: string[];
}

/** The descriptor produced by `connect()`. */
export interface ConnectDescriptor extends PrimitiveSpec<EmptyTypeFn> {
  readonly _tag: 'connect';
}

/**
 * The required connection capability. `url` is a string or a sync/async
 * function called on **every** connect and reconnect — useful for failover,
 * load balancing, or Durable Object migration.
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

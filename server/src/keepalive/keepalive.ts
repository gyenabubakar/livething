import { ENGINE_INTERNAL_CONNECTION } from '~/_engine/contexts/contexts.ts';
import { assertPositiveInteger } from '~/_engine/validation.ts';
import { createKeepaliveMonitor } from '~/keepalive/runtime.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { Primitive } from '~/primitive.ts';

/** Options accepted by the keepalive primitive factory. Both are required. */
export interface KeepaliveOptions {
  /**
   * How often the server sends a keepalive `ping` text frame, in milliseconds.
   * The client answers with `pong`; that reply (like any inbound frame) proves
   * the connection is alive and resets the idle timer. Must be strictly less
   * than `idleTimeoutMs` so a quiet-but-alive client always answers in time.
   */
  readonly pingIntervalMs: number;

  /**
   * How long a connection may go without sending ANY frame before the engine
   * closes it, in milliseconds. Every inbound frame — an app message or the
   * automatic `pong` reply to the keepalive ping — resets this window. A
   * connection that has truly gone away sends nothing (not even a pong), so the
   * window elapses and it is closed.
   */
  readonly idleTimeoutMs: number;
}

/** The primitive type tag for the keepalive feature. */
export interface KeepalivePrimitive extends Primitive<'keepalive'> {
  /** How often the keepalive ping fires, in milliseconds. */
  readonly pingIntervalMs: number;
  /** Idle window before the connection is closed, in milliseconds. */
  readonly idleTimeoutMs: number;
}

/** Unique symbol used to enforce one keepalive registration per handler scope. */
const KEEPALIVE_KEY = Symbol('keepalive');

/** Read the connection id off a lifecycle context, or `''` when it has none. */
function connectionIdOf(ctx: unknown): string {
  const connection = (ctx as Record<PropertyKey, unknown>).connection as
    | { id?: unknown }
    | undefined;
  return String(connection?.id ?? '');
}

/**
 * Liveness check for a connection. The server sends a `ping` every
 * `pingIntervalMs`; a live client answers with `pong`. Any inbound frame (app
 * message or pong) resets an idle timer; when that timer reaches
 * `idleTimeoutMs` with nothing inbound, the engine closes the socket. The ping
 * exists so a quiet-but-alive client still produces a frame in time — so only a
 * connection that has actually gone away is closed.
 *
 * Sending pings is what this capability owns. Answering a client's ping is not:
 * the engine always replies `pong` on its own, so a server that never lists
 * `keepalive()` still lets a client measure it.
 *
 * Both options are required and there are no defaults: `pingIntervalMs` must be
 * strictly less than `idleTimeoutMs`, or the ping could not land before the
 * idle window closes and live clients would be dropped. Enable this via
 * `keepalive: { pingIntervalMs, idleTimeoutMs }` on the contract config instead
 * of calling this primitive directly.
 */
export function keepalive(options: KeepaliveOptions): KeepalivePrimitive {
  assertPositiveInteger(options.pingIntervalMs, 'pingIntervalMs', 'keepalive()');
  assertPositiveInteger(options.idleTimeoutMs, 'idleTimeoutMs', 'keepalive()');
  if (options.pingIntervalMs >= options.idleTimeoutMs) {
    throw new Error(
      `[wskit] keepalive pingIntervalMs (${options.pingIntervalMs}) must be less than idleTimeoutMs ` +
        `(${options.idleTimeoutMs}): the keepalive ping has to fire before the idle window closes, ` +
        `or a live client would be dropped.`,
    );
  }

  return {
    __wskit: 'keepalive',
    __kind: 'infrastructure',
    __identity: [KEEPALIVE_KEY],
    __requires: {},
    pingIntervalMs: options.pingIntervalMs,
    idleTimeoutMs: options.idleTimeoutMs,
    __setup(engine) {
      engine.installOnce(KEEPALIVE_KEY, () => {
        // Under hibernation the runtime answers a client's ping at the edge, so
        // a server ping would only wake the instance and could never be timed.
        const monitor = createKeepaliveMonitor(engine, options, !engine.getHibernationEnabled());

        engine.extendContext((baseCtx) => buildLatencySurface(engine, baseCtx));

        engine.onConnect((ctx) => {
          const connectionId = connectionIdOf(ctx);
          if (connectionId) monitor.watch(connectionId);
        });

        engine.onConnectionActivity((connectionId) => monitor.touch(connectionId));
        engine.onPong((connectionId) => monitor.recordPong(connectionId));

        // Cleanup, not `onDisconnect`: a user disconnect hook that throws must
        // not be able to strand this connection's ping timer.
        engine.onConnectionCleanup((connectionId) => monitor.forget(connectionId));
      });
    },
  };
}

/**
 * Build the `ctx.latency` / `ctx.quality` surface for a connection context.
 * Both stay live getters off the raw connection so a context reused across a
 * dispatch's intercepts and handler always reflects the current measurement.
 */
function buildLatencySurface(engine: EngineAccess, baseCtx: unknown): Record<string, unknown> {
  const connection = (baseCtx as Record<PropertyKey, unknown>)[
    ENGINE_INTERNAL_CONNECTION
  ] as RuntimeConnection;
  return {
    get latency() {
      return connection.latency;
    },
    get quality() {
      if (engine.getHibernationEnabled() || connection.latency === null) return null;
      return connection.quality;
    },
  };
}

/**
 * Symbol key used to reference this primitive in dependency declarations.
 */
keepalive.__key = KEEPALIVE_KEY;

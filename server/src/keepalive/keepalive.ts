import { LiveThingConfigError } from '@livething/core';
import { ENGINE_INTERNAL_CONNECTION } from '~/_engine/contexts/contexts.ts';
import { assertTimerDelay } from '~/_engine/validation.ts';
import { createKeepaliveMonitor } from '~/keepalive/runtime.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { Primitive } from '~/primitive.ts';

/** Options accepted by the keepalive primitive factory. */
export interface KeepaliveOptions {
  /**
   * How often the server sends a keepalive `ping` text frame, in milliseconds.
   * The client answers with `pong`; that reply (like any inbound frame) proves
   * the connection is alive and resets the idle timer. Must be strictly less
   * than `idleTimeoutMs` so a quiet-but-alive client always answers in time.
   * Default: `30_000`.
   */
  readonly pingIntervalMs?: number;

  /**
   * How long a connection may go without sending ANY frame before the engine
   * closes it, in milliseconds. Every inbound frame — an app message or the
   * automatic `pong` reply to the keepalive ping — resets this window. A
   * connection that has truly gone away sends nothing (not even a pong), so the
   * window elapses and it is closed.
   *
   * For a WebSocket the platform holds while the server sleeps (Cloudflare under
   * hibernation), this window does not run: there is no in-memory timer to
   * enforce it, and the underlying platform can answer a client's ping without
   * waking the instance, so the instance never even sees that traffic. See
   * hibernation in the server docs for what to do instead if an idle policy is
   * required. Default: `60_000`.
   */
  readonly idleTimeoutMs?: number;
}

const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

/** The primitive type tag for the keepalive feature. */
export interface KeepalivePrimitive extends Primitive<'keepalive'> {}

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
 * Both options default (`pingIntervalMs` 30 s, `idleTimeoutMs` 60 s), and both
 * must be whole numbers no larger than `2 ** 31 - 1`, the longest a timer can
 * hold. `pingIntervalMs` must be strictly less than `idleTimeoutMs`, or the ping
 * could not land before the idle window closes and live clients would be
 * dropped. Enable this by listing the `keepalive()` capability from
 * `@livething/server/keepalive` in `server({ capabilities: [...] })` instead of
 * calling this primitive directly.
 */
export function keepalive(options: KeepaliveOptions = {}): KeepalivePrimitive {
  const pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  assertTimerDelay(pingIntervalMs, 'pingIntervalMs', 'keepalive()');
  assertTimerDelay(idleTimeoutMs, 'idleTimeoutMs', 'keepalive()');
  if (pingIntervalMs >= idleTimeoutMs) {
    throw new LiveThingConfigError(
      `keepalive pingIntervalMs (${pingIntervalMs}) must be less than idleTimeoutMs ` +
        `(${idleTimeoutMs}): the keepalive ping has to fire before the idle window closes, ` +
        `or a live client would be dropped.`,
    );
  }

  const timings = { pingIntervalMs, idleTimeoutMs };

  return {
    __livething: 'keepalive',
    __identity: [KEEPALIVE_KEY],
    __requires: {},
    __setup(engine) {
      engine.installOnce(KEEPALIVE_KEY, () => {
        engine.setKeepaliveTimings(timings);
        // A connection the platform holds while the server sleeps is not supervised:
        // the runtime answers a client's ping at the edge, so a server ping would only
        // wake the instance, and a `setTimeout` idle timer would itself hold the
        // instance in memory — defeating hibernation while closing quiet-but-alive
        // clients whose traffic never reaches it to refresh the timer. Every other
        // connection, such as one over server-sent events, is supervised as usual.
        const monitor = createKeepaliveMonitor(
          engine,
          timings,
          (connectionId) => !engine.connectionSurvivesHibernation(connectionId),
        );

        engine.extendContext((baseCtx) => buildLatencySurface(baseCtx));

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
function buildLatencySurface(baseCtx: unknown): Record<string, unknown> {
  const connection = (baseCtx as Record<PropertyKey, unknown>)[
    ENGINE_INTERNAL_CONNECTION
  ] as RuntimeConnection;
  return {
    get latency() {
      return connection.latency;
    },
    get quality() {
      if (connection.survivesHibernation || connection.latency === null) return null;

      return connection.quality;
    },
  };
}

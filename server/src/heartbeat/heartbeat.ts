import { assertPositiveInteger } from '~/_engine/validation.ts';
import type { Primitive } from '~/primitive.ts';

/** Lower/upper bounds for the derived keepalive ping interval, in ms. */
const MIN_PING_INTERVAL_MS = 1_000;
const MAX_PING_INTERVAL_MS = 30_000;

/** Options accepted by the heartbeat primitive factory. */
export interface HeartbeatOptions {
  /**
   * How long a connection may go without sending ANY frame before the engine
   * closes it, in milliseconds. Every inbound frame — an app message or the
   * automatic `pong` reply to the engine's keepalive ping — counts as "still
   * alive" and resets this window.
   *
   * To keep a quiet-but-alive connection from being closed, the engine fires a
   * keepalive ping at about half this value (clamped to 1s–30s), so the client
   * always answers within the window. A connection that has truly gone away
   * sends nothing — not even the pong — so the window elapses and it is closed.
   */
  readonly timeout: number;
}

/** The primitive type tag for the heartbeat feature. */
export interface HeartbeatPrimitive extends Primitive<'heartbeat'> {
  /** The configured idle timeout in milliseconds. */
  readonly timeout: number;
}

/** Unique symbol used to enforce one heartbeat registration per handler scope. */
const HEARTBEAT_KEY = Symbol('heartbeat');

/**
 * Arms an idle timer per connection. The timer resets on every inbound
 * message. When it expires — meaning the connection has been silent for
 * longer than `options.timeout` milliseconds — the engine closes the socket.
 *
 * Enable this via `heartbeat: true` (or `heartbeat: { timeoutMs }`) on the
 * contract config instead of calling this primitive directly.
 *
 */
export function heartbeat(options: HeartbeatOptions): HeartbeatPrimitive {
  assertPositiveInteger(options.timeout, 'timeout', 'heartbeat()');

  // Fire the keepalive ping at half the timeout so a quiet-but-alive client
  // always answers within the close window. Clamp it: a tiny timeout must not
  // ping absurdly fast, and a large one must not leave the ping (and the
  // latency sample it drives) too stale. The ceiling stays well below any
  // timeout above 60s, so clamping never causes a false close.
  const pingIntervalMs = Math.min(
    MAX_PING_INTERVAL_MS,
    Math.max(MIN_PING_INTERVAL_MS, Math.floor(options.timeout / 2)),
  );

  return {
    __wskit: 'heartbeat',
    __kind: 'infrastructure',
    __identity: [HEARTBEAT_KEY],
    __requires: {},
    timeout: options.timeout,
    __setup(engine) {
      // `installOnce` ensures the timer logic is set up only once even if the
      // heartbeat primitive is included in multiple groups or scopes.
      engine.installOnce(HEARTBEAT_KEY, () => {
        engine.setHeartbeatPingInterval(pingIntervalMs);

        engine.onConnect((ctx) => {
          const connectionId = String((ctx as Record<PropertyKey, unknown>).id ?? '');
          if (!connectionId) return;
          engine.refreshConnectionIdleTimeout(connectionId, options.timeout);
        });

        engine.onConnectionActivity((connectionId) => {
          engine.refreshConnectionIdleTimeout(connectionId, options.timeout);
        });
      });
    },
  };
}

/**
 * Symbol key used to reference this primitive in dependency declarations.
 */
heartbeat.__key = HEARTBEAT_KEY;

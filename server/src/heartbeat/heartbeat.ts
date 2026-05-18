import type { Primitive } from '~/primitive.ts';

/** Options accepted by the heartbeat primitive factory. */
export interface HeartbeatOptions {
  /**
   * How long a connection can stay silent before the engine closes it,
   * in milliseconds.
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
 * Requires the `timers` platform capability.
 */
export function heartbeat(options: HeartbeatOptions): HeartbeatPrimitive {
  return {
    __wskit: 'heartbeat',
    __kind: 'infrastructure',
    __identity: [HEARTBEAT_KEY],
    __requires: { timers: true },
    timeout: options.timeout,
    __setup(engine) {
      // `installOnce` ensures the timer logic is set up only once even if the
      // heartbeat primitive is included in multiple groups or scopes.
      engine.installOnce(HEARTBEAT_KEY, () => {
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

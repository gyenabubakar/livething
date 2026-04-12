import { definePrimitive } from '~/primitive.ts';
import type { Primitive } from '~/primitive.ts';

export interface HeartbeatOptions {
  readonly timeout: number;
}

/**
 * The primitive instance returned by `heartbeat()`.
 *
 * It tells the engine to watch for silent connections and close them after
 * the configured timeout.
 */
export interface HeartbeatPrimitive extends Primitive<'heartbeat'> {
  readonly timeout: number;
}

const HEARTBEAT_KEY = Symbol('heartbeat');

const _heartbeat = definePrimitive<'heartbeat', [options: HeartbeatOptions], { timeout: number }>({
  tag: 'heartbeat' as const,
  key: HEARTBEAT_KEY,
  kind: 'infrastructure' as const,
  requires: {
    timers: true,
  },
  create(options: HeartbeatOptions) {
    return {
      timeout: options.timeout,
    };
  },
  setup(engine, data) {
    engine.installOnce(HEARTBEAT_KEY, () => {
      engine.onConnect((ctx) => {
        const connectionId = String((ctx as Record<PropertyKey, unknown>).id ?? '');
        if (!connectionId) return;

        engine.refreshConnectionIdleTimeout(connectionId, data.timeout);
      });

      engine.onConnectionActivity((connectionId) => {
        engine.refreshConnectionIdleTimeout(connectionId, data.timeout);
      });
    });
  },
});

/**
 * Close dead connections after they stay silent for too long.
 *
 * This does not add new handler methods. It only tells the runtime to use
 * timers to detect connections that stopped responding.
 */
export function heartbeat(options: HeartbeatOptions): HeartbeatPrimitive {
  return _heartbeat(options) as HeartbeatPrimitive;
}

/** Dependency ref — use in `dependencies: [heartbeat]` to assert it's registered. */
heartbeat.__key = HEARTBEAT_KEY;

import type { Primitive } from '~/primitive.ts';

export interface HeartbeatOptions {
  readonly timeout: number;
}

export interface HeartbeatPrimitive extends Primitive<'heartbeat'> {
  readonly timeout: number;
}

const HEARTBEAT_KEY = Symbol('heartbeat');

export function heartbeat(options: HeartbeatOptions): HeartbeatPrimitive {
  return {
    __wskit: 'heartbeat',
    __kind: 'infrastructure',
    __identity: [HEARTBEAT_KEY],
    __dependencies: [],
    __requires: { timers: true },
    timeout: options.timeout,
    __setup(engine) {
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

heartbeat.__key = HEARTBEAT_KEY;

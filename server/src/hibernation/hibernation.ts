import type { Primitive } from '~/primitive.ts';

/** The primitive type tag for the hibernation feature. */
export interface HibernationPrimitive extends Primitive<'hibernation'> {
  /** Whether hibernation is enabled. */
  readonly enabled: boolean;
}

/** Unique symbol used to enforce one hibernation registration per handler scope. */
const HIBERNATION_KEY = Symbol('hibernation');

/**
 * Creates the hibernation primitive. When registered and `enabled` is `true`,
 * this primitive tells the engine to opt the handler into the platform's
 * WebSocket hibernation support.
 *
 * On platforms that support hibernation (e.g. Cloudflare Durable Objects), the
 * worker process can be paused between messages and woken up only when a new
 * message arrives. This saves CPU and memory cost for connections that are
 * mostly idle. Without this primitive, the connection is kept alive in memory
 * at all times.
 *
 * Requires the `hibernation` platform capability.
 *
 * @example
 * ```ts
 * import { server } from '@wskit/server';
 * import { withHibernation } from '@wskit/server/hibernation';
 *
 * withHibernation(server('chat')).hibernation(); // opt in with default enabled = true
 * ```
 */
export function hibernation(enabled = true): HibernationPrimitive {
  return {
    __wskit: 'hibernation',
    __kind: 'infrastructure',
    __identity: [HIBERNATION_KEY],
    __dependencies: [],
    __requires: { hibernation: true },
    enabled,
    __setup(engine) {
      engine.setHibernationEnabled(enabled);
    },
  };
}

/**
 * Symbol key used to reference this primitive in dependency declarations.
 */
hibernation.__key = HIBERNATION_KEY;

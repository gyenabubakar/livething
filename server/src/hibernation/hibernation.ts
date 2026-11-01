import { ensureConnectionSchema } from '~/_engine/runtime/connection-store.ts';
import type { Primitive } from '~/primitive.ts';

/** The primitive type tag for the hibernation feature. */
export interface HibernationPrimitive extends Primitive<'hibernation'> {}

/** Unique symbol used to enforce one hibernation registration per handler scope. */
const HIBERNATION_KEY = Symbol('hibernation');

/**
 * Opts the server into the platform's WebSocket hibernation support. When
 * enabled, the worker process can pause between messages and wake only when
 * a new frame arrives — saving CPU and memory for mostly-idle connections.
 *
 * Enable this via `hibernation: true` in `server()` instead of
 * calling this primitive directly.
 *
 * Requires the `hibernation` platform capability (e.g. Cloudflare Durable
 * Objects).
 */
export function hibernation(): HibernationPrimitive {
  return {
    __livething: 'hibernation',
    __identity: [HIBERNATION_KEY],
    __requires: { hibernation: true },
    __setup(engine) {
      engine.enableHibernation();
      engine.onBootSchema(() => {
        ensureConnectionSchema(engine.storage.sql);
      });
    },
  };
}

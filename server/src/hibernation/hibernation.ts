import { ensureConnectionSchema } from '~/_engine/runtime/connection-store.ts';
import type { Primitive } from '~/primitive.ts';

/** The primitive type tag for the hibernation feature. */
export interface HibernationPrimitive extends Primitive<'hibernation'> {
  /** Whether hibernation is enabled. */
  readonly enabled: boolean;
}

/** Unique symbol used to enforce one hibernation registration per handler scope. */
const HIBERNATION_KEY = Symbol('hibernation');

/**
 * Opts the server into the platform's WebSocket hibernation support. When
 * enabled, the worker process can pause between messages and wake only when
 * a new frame arrives — saving CPU and memory for mostly-idle connections.
 *
 * Enable this via `hibernation: true` on the contract config instead of
 * calling this primitive directly.
 *
 * Requires the `hibernation` platform capability (e.g. Cloudflare Durable
 * Objects).
 */
export function hibernation(enabled = true): HibernationPrimitive {
  return {
    __wskit: 'hibernation',
    __kind: 'infrastructure',
    __identity: [HIBERNATION_KEY],
    __requires: enabled ? { hibernation: true, storage: true } : {},
    enabled,
    __setup(engine) {
      engine.setHibernationEnabled(enabled);
      if (!enabled) return;
      engine.onBootSchema(() => {
        ensureConnectionSchema(engine.requireStorage().sql);
      });
    },
  };
}

/**
 * Symbol key used to reference this primitive in dependency declarations.
 */
hibernation.__key = HIBERNATION_KEY;

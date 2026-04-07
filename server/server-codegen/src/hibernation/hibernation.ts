import { definePrimitive } from '~/primitive.ts';
import type { Primitive } from '~/primitive.ts';

/**
 * The primitive instance returned by `hibernation()`.
 *
 * It tells the runtime whether this server expects platform hibernation to be
 * used when the adapter supports it.
 */
export interface HibernationPrimitive extends Primitive<'hibernation'> {
  readonly enabled: boolean;
}

const HIBERNATION_KEY = Symbol('hibernation');

const _hibernation = definePrimitive<'hibernation', [enabled?: boolean], { enabled: boolean }>({
  tag: 'hibernation' as const,
  key: HIBERNATION_KEY,
  kind: 'infrastructure' as const,
  requires: {
    hibernation: true,
  },
  create(enabled = true) {
    return {
      enabled,
    };
  },
});

/**
 * Hint to the runtime that this server should use connection hibernation when
 * the platform supports it.
 */
export function hibernation(enabled = true): HibernationPrimitive {
  return _hibernation(enabled) as HibernationPrimitive;
}

/** Dependency ref — use in `dependencies: [hibernation]` to assert it's registered. */
hibernation.__key = HIBERNATION_KEY;

import { definePrimitive } from '~/primitives/define.ts';
import type { Primitive } from '~/primitives/define.ts';

/**
 * The primitive instance returned by `ack()`.
 *
 * `defineServer()` uses this to decide whether `ctx.ack()` exists in the
 * same scope.
 */
export interface AckPrimitive extends Primitive<'ack'> {}

const ACK_KEY = Symbol('ack');

const _ack = definePrimitive({
  tag: 'ack' as const,
  key: ACK_KEY,
  kind: 'infrastructure' as const,
  create() {
    return {};
  },
});

/**
 * Turn on ack support for the current scope.
 */
export function ack(): AckPrimitive {
  return _ack() as AckPrimitive;
}

/** Dependency ref — use in `dependencies: [ack]` to assert it's registered. */
ack.__key = ACK_KEY;

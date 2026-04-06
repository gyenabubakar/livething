import { definePrimitive } from '~/primitives/define.ts';
import type { Primitive } from '~/primitives/define.ts';

/**
 * The primitive instance returned by `sequence()`.
 *
 * It marks the server so the engine injects `_seq` on outgoing messages.
 */
export interface SequencePrimitive extends Primitive<'sequence'> {}

const SEQUENCE_KEY = Symbol('sequence');

const _sequence = definePrimitive({
  tag: 'sequence' as const,
  key: SEQUENCE_KEY,
  kind: 'infrastructure' as const,
  create() {
    return {};
  },
});

/**
 * Turn on automatic `_seq` injection for outgoing messages.
 */
export function sequence(): SequencePrimitive {
  return _sequence() as SequencePrimitive;
}

/** Dependency ref — use in `dependencies: [sequence]` to assert it's registered. */
sequence.__key = SEQUENCE_KEY;

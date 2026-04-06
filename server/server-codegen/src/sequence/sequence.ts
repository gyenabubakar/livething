import { definePrimitive } from '~/primitive.ts';
import type { Primitive } from '~/primitive.ts';

/**
 * The primitive instance returned by `sequence()`.
 *
 * It marks the scope so outgoing app messages get an ever-increasing `_seq`
 * number.
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
 * Add an ever-increasing `_seq` number to each normal outgoing message.
 *
 * This gives replay a clear order. After reconnecting, the client can say
 * "send me everything after seq N", and the server can fetch those
 * messages in the same order they were originally sent.
 */
export function sequence(): SequencePrimitive {
  return _sequence() as SequencePrimitive;
}

/** Dependency ref — use in `dependencies: [sequence]` to assert it's registered. */
sequence.__key = SEQUENCE_KEY;

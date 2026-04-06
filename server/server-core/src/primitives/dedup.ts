import { definePrimitive } from '~/primitives/define.ts';
import type { Primitive } from '~/primitives/define.ts';

/**
 * The primitive instance returned by `dedup()`.
 *
 * It marks the server so the engine injects `_messageId` on outgoing messages.
 */
export interface DedupPrimitive extends Primitive<'dedup'> {}

const DEDUP_KEY = Symbol('dedup');

const _dedup = definePrimitive({
  tag: 'dedup' as const,
  key: DEDUP_KEY,
  kind: 'infrastructure' as const,
  create() {
    return {};
  },
});

/**
 * Turn on automatic `_messageId` injection for outgoing messages.
 */
export function dedup(): DedupPrimitive {
  return _dedup() as DedupPrimitive;
}

/** Dependency ref — use in `dependencies: [dedup]` to assert it's registered. */
dedup.__key = DEDUP_KEY;

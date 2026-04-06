import { definePrimitive } from '~/primitives/define.ts';
import type { Primitive } from '~/primitives/define.ts';

/**
 * The primitive instance returned by `dedup()`.
 *
 * It marks the scope so outgoing app messages get a unique `_messageId`.
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
 * Add a unique `_messageId` to each normal outgoing message.
 *
 * This helps the client ignore duplicates, which matters most during
 * reconnect and replay when the same logical message might be seen twice.
 */
export function dedup(): DedupPrimitive {
  return _dedup() as DedupPrimitive;
}

/** Dependency ref — use in `dependencies: [dedup]` to assert it's registered. */
dedup.__key = DEDUP_KEY;

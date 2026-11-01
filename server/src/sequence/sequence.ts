import { assertOptionalPositiveInteger } from '~/_engine/validation.ts';
import {
  createPersistentSequenceAllocator,
  DEFAULT_SEQUENCE_BATCH_SIZE,
  ensureSequenceSchema,
} from '~/sequence/runtime.ts';
import type { Primitive } from '~/primitive.ts';

/** The TypeScript type returned by `sequence()`. */
export interface SequencePrimitive extends Primitive<'sequence'> {
  /** Whether the sequence counter persists across server restarts. */
  readonly persist: boolean;
}

/** Options accepted by `sequence()`. */
export interface SequenceOptions {
  /**
   * When `true`, the counter is persisted and survives server restarts, so
   * sequence numbers never repeat across reconnections.
   *
   * When `false` (the default), the counter resets each time the server
   * starts. This is fine for most use cases — clients use sequence numbers
   * to detect gaps, not as globally unique IDs.
   *
   * Requires the `storage` platform capability when `true`.
   */
  readonly persist?: boolean;

  /**
   * Number of seq values reserved per SQL write when `persist: true`. The
   * allocator hands out values from memory until the batch is exhausted, then
   * reserves the next range with one SQL transaction. Default is `100`, which
   * gives a ~100× write reduction over the per-send allocator.
   *
   * A larger value reduces SQL traffic further but widens the worst-case gap
   * left in the wire when the server crashes mid-batch. Gaps are harmless
   * (the client treats them as "ask the server what's missing"), but very
   * large jumps can look surprising in logs.
   *
   * Ignored when `persist` is `false` — the in-memory counter is already
   * write-free.
   */
  readonly batchSize?: number;
}

/** @internal */
const SEQUENCE_KEY = Symbol('sequence');

/**
 * Stamps every outgoing message with a monotonically increasing number so
 * clients can detect gaps and request a replay of what they missed.
 *
 * Enable this by listing the `sequence()` (or `sequence({ persist: true })`)
 * capability in `server({ capabilities: [...] })` instead of calling this
 * primitive directly.
 */
export function sequence(options?: SequenceOptions): SequencePrimitive {
  assertOptionalPositiveInteger(options?.batchSize, 'batchSize', 'sequence()');
  const persist = options?.persist ?? false;
  const batchSize = options?.batchSize ?? DEFAULT_SEQUENCE_BATCH_SIZE;

  return {
    __livething: 'sequence',
    __identity: [SEQUENCE_KEY],
    __requires: {},
    persist,
    __setup(engine) {
      engine.setSequencePersistent(persist);

      engine.installOnce(SEQUENCE_KEY, () => {
        let current = 0;
        let persistentAllocator: ReturnType<typeof createPersistentSequenceAllocator> | null = null;

        if (persist) {
          engine.onBootSchema(() => {
            ensureSequenceSchema(engine.storage.sql);
          });
        }

        function allocate(): number {
          if (persist) {
            persistentAllocator ??= createPersistentSequenceAllocator(
              engine.storage.sql,
              batchSize,
            );
            return persistentAllocator.next();
          }

          return (current += 1);
        }

        engine.setDeliverySeqAllocator(allocate);

        // Stamp `deliverySeq` into every outgoing user frame's `__livething`. The pipeline
        // already skips protocol frames before calling stampers.
        engine.onLiveThingStamp(() => ({ deliverySeq: allocate() }));
      });
    },
  };
}

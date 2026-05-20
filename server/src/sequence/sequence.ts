import { allocatePersistentSequence, ensureSequenceSchema } from '~/sequence/runtime.ts';
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
}

/** @internal */
const SEQUENCE_KEY = Symbol('sequence');

/**
 * Stamps every outgoing message with a monotonically increasing number so
 * clients can detect gaps and request a replay of what they missed.
 *
 * Enable this via `sequence: true` (or `sequence: { persist: true }`) on the
 * contract config instead of calling this primitive directly.
 */
export function sequence(options?: SequenceOptions): SequencePrimitive {
  const persist = options?.persist ?? false;

  return {
    __wskit: 'sequence',
    __kind: 'infrastructure',
    __identity: [SEQUENCE_KEY],
    __requires: persist ? { storage: true } : {},
    persist,
    __setup(engine) {
      engine.setSequencePersistent(persist);

      engine.installOnce(SEQUENCE_KEY, () => {
        let current = 0;

        if (persist) {
          engine.onBoot(() => {
            ensureSequenceSchema(engine.requireStorage().sql);
          });
        }

        // Stamp `seq` into every outgoing user frame's `__wskit`. The pipeline
        // already skips protocol frames before calling stampers.
        engine.onWskitStamp(() => {
          const nextSeq = persist
            ? allocatePersistentSequence(engine.requireStorage().sql)
            : (current += 1);
          return { seq: nextSeq };
        });
      });
    },
  };
}

/**
 * The identity of the `sequence` primitive. Pass `sequence` itself in a
 * module's `dependencies` array to declare that it must be registered.
 */
sequence.__key = SEQUENCE_KEY;

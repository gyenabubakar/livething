import { isProtocolEvent } from '~/_engine/compile/utils.ts';
import { allocatePersistentSequence, ensureSequenceSchema } from '~/sequence/runtime.ts';
import type { Primitive } from '~/primitive.ts';

/** The primitive type tag for the sequence feature. */
export interface SequencePrimitive extends Primitive<'sequence'> {
  /** Whether the sequence counter persists across server restarts. */
  readonly persist: boolean;
}

/** Options accepted by the sequence primitive factory. */
export interface SequenceOptions {
  /**
   * When `true`, the counter is stored in SQLite and survives server restarts
   * so sequence numbers never repeat across sessions.
   *
   * When `false` (the default), the counter starts at `1` each time the
   * server starts. This is fine for most use cases — the client uses the
   * counter to detect gaps, not as a global unique ID.
   *
   * Requires the `storage` platform capability when `true`.
   */
  readonly persist?: boolean;
}

/** Unique symbol used to enforce one sequence registration per handler scope. */
const SEQUENCE_KEY = Symbol('sequence');

/**
 * Creates the sequence primitive. When registered, this primitive intercepts
 * every outgoing message and stamps it with a monotonically increasing `_seq`
 * number. Clients use this number to detect gaps (missed messages) and request
 * a replay.
 *
 * Internal protocol events (events whose names start with `_`) are not stamped
 * — sequence numbers are for application events only.
 *
 * @example
 * ```ts
 * import '@wskit/server/sequence';
 *
 * server('chat').sequence(); // outgoing messages get { ..., _seq: 1, 2, 3, … }
 * ```
 */
export function sequence(options?: SequenceOptions): SequencePrimitive {
  const persist = options?.persist ?? false;

  return {
    __wskit: 'sequence',
    __kind: 'infrastructure',
    __identity: [SEQUENCE_KEY],
    __dependencies: [],
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

        engine.onOutgoing((message) => {
          // Skip internal protocol events (e.g. `_ack`, `_replay`).
          if (isProtocolEvent(message.event)) return;

          const nextSeq = persist
            ? allocatePersistentSequence(engine.requireStorage().sql)
            : (current += 1);

          return {
            event: message.event,
            payload: {
              ...(message.payload as Record<string, unknown>),
              _seq: nextSeq,
            },
          };
        });
      });
    },
  };
}

/**
 * Symbol key used to reference this primitive in dependency declarations.
 */
sequence.__key = SEQUENCE_KEY;

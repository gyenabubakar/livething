import { isProtocolEvent } from '~/_engine/compile/utils.ts';
import { definePrimitive } from '~/primitive.ts';
import { allocatePersistentSequence, ensureSequenceSchema } from '~/sequence/runtime.ts';
import type { Primitive } from '~/primitive.ts';

/**
 * The primitive instance returned by `sequence()`.
 *
 * It marks the scope so outgoing app messages get an ever-increasing `_seq`
 * number.
 */
export interface SequencePrimitive extends Primitive<'sequence'> {
  /**
   * Whether wskit should store the next `_seq` number in SQLite.
   *
   * This keeps replay ordering correct even after a restart.
   */
  readonly persist: boolean;
}

/**
 * Configure how `sequence()` should keep track of `_seq`.
 */
export interface SequenceOptions {
  /**
   * Persist the next sequence number in SQLite.
   *
   * Leave this off for lightweight in-memory ordering. Turn it on when
   * reconnect replay must survive crashes or fresh boots.
   */
  readonly persist?: boolean;
}

const SEQUENCE_KEY = Symbol('sequence');

const _sequence = definePrimitive<
  'sequence',
  [options?: SequenceOptions],
  {
    persist: boolean;
  }
>({
  tag: 'sequence' as const,
  key: SEQUENCE_KEY,
  kind: 'infrastructure' as const,
  requires(options) {
    return options?.persist ? { storage: true } : {};
  },
  create(options?: SequenceOptions) {
    return {
      persist: options?.persist ?? false,
    };
  },
  setup(engine, data) {
    engine.installOnce(SEQUENCE_KEY, () => {
      let current = 0;

      if (data.persist) {
        engine.onBoot(() => {
          ensureSequenceSchema(engine.requireStorage().sql);
        });
      }

      engine.onOutgoing((message) => {
        if (isProtocolEvent(message.event)) return;

        const nextSeq = data.persist
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
});

/**
 * Add an ever-increasing `_seq` number to each normal outgoing message.
 *
 * This gives replay a clear order. After reconnecting, the client can say
 * "send me everything after seq N", and the server can fetch those
 * messages in the same order they were originally sent.
 */
export function sequence(options?: SequenceOptions): SequencePrimitive {
  return _sequence(options) as SequencePrimitive;
}

/** Dependency ref — use in `dependencies: [sequence]` to assert it's registered. */
sequence.__key = SEQUENCE_KEY;

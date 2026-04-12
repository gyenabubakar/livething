import { isProtocolEvent } from '~/_engine/compile/utils.ts';
import type { Primitive } from '~/primitive.ts';
import { allocatePersistentSequence, ensureSequenceSchema } from '~/sequence/runtime.ts';

export interface SequencePrimitive extends Primitive<'sequence'> {
  readonly persist: boolean;
}

export interface SequenceOptions {
  readonly persist?: boolean;
}

const SEQUENCE_KEY = Symbol('sequence');

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

sequence.__key = SEQUENCE_KEY;

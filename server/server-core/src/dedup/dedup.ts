import { isProtocolEvent } from '~/_engine/compile/utils.ts';
import type { Primitive } from '~/primitive.ts';

export interface DedupPrimitive extends Primitive<'dedup'> {}

const DEDUP_KEY = Symbol('dedup');

export function dedup(): DedupPrimitive {
  return {
    __wskit: 'dedup',
    __kind: 'infrastructure',
    __identity: [DEDUP_KEY],
    __dependencies: [],
    __requires: {},
    __setup(engine) {
      engine.installOnce(DEDUP_KEY, () => {
        engine.onOutgoing((message) => {
          if (isProtocolEvent(message.event)) return;

          return {
            event: message.event,
            payload: {
              ...(message.payload as Record<string, unknown>),
              _messageId: engine.generateId('msg'),
            },
          };
        });
      });
    },
  };
}

dedup.__key = DEDUP_KEY;

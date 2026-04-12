import { ENGINE_SCOPE_META } from '~/_engine/contexts/types.ts';
import type { Primitive } from '~/primitive.ts';

export interface AckPrimitive extends Primitive<'ack'> {}

const ACK_KEY = Symbol('ack');

export function ack(): AckPrimitive {
  return {
    __wskit: 'ack',
    __kind: 'infrastructure',
    __identity: [ACK_KEY],
    __dependencies: [],
    __requires: {},
    __setup(engine) {
      engine.extendContext((ctx) => {
        const base = ctx as Record<PropertyKey, unknown> & { id?: string; ack?: () => void };
        const scope =
          (base[ENGINE_SCOPE_META] as
            | { namespaceName?: string; channelName?: string }
            | undefined) ?? {};

        if (scope.namespaceName || scope.channelName || !base.id) {
          return {};
        }

        return {
          ack() {
            engine.sendAck(String(base.id));
          },
        };
      });
    },
  };
}

ack.__key = ACK_KEY;

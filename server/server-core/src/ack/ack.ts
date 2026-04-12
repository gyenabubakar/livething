import { ENGINE_SCOPE_META } from '~/_engine/contexts/types.ts';
import { definePrimitive } from '~/primitive.ts';
import type { Primitive } from '~/primitive.ts';

/**
 * The primitive instance returned by `ack()`.
 *
 * Registering this lets handlers confirm that they received a client
 * message. When this primitive is present, handlers in the same scope get
 * `ctx.ack()`.
 */
export interface AckPrimitive extends Primitive<'ack'> {}

const ACK_KEY = Symbol('ack');

const _ack = definePrimitive({
  tag: 'ack' as const,
  key: ACK_KEY,
  kind: 'infrastructure' as const,
  create() {
    return {};
  },
  setup(engine) {
    engine.extendContext((ctx) => {
      const base = ctx as Record<PropertyKey, unknown> & { id?: string; ack?: () => void };
      const scope =
        (base[ENGINE_SCOPE_META] as
          | {
              namespaceName?: string;
              channelName?: string;
            }
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
});

/**
 * Let handlers confirm receipt of client messages with `ctx.ack()`.
 *
 * This is useful when the client sends with `send.withAck(...)` and needs a
 * clear "the server got it" signal back.
 */
export function ack(): AckPrimitive {
  return _ack() as AckPrimitive;
}

/** Dependency ref — use in `dependencies: [ack]` to assert it's registered. */
ack.__key = ACK_KEY;

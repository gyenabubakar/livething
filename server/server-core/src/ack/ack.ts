import { ENGINE_SCOPE_META } from '~/_engine/contexts/types.ts';
import type { Primitive } from '~/primitive.ts';

/** The TypeScript type returned by `ack()`. */
export interface AckPrimitive extends Primitive<'ack'> {}

/** @internal */
const ACK_KEY = Symbol('ack');

/**
 * Enables `ctx.ack()` inside your top-level `incoming` handlers. Call
 * `ctx.ack()` to confirm a message was received and processed — the client's
 * `send.withAck()` promise resolves when the ack arrives.
 *
 * Only available at the top-level connection scope; namespace and channel
 * handlers do not receive `ctx.ack()`.
 *
 * @example
 * ```ts
 * server('chat')
 *   .ack()
 *   .incoming(sendMessage, async (ctx, payload) => {
 *     await saveMessage(payload);
 *     ctx.ack();
 *   });
 * ```
 */
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

        // Read the internal scope metadata the engine attaches to every context.
        // If this context belongs to a namespace or channel, skip adding ack —
        // those scopes do not represent a single connection and cannot ack.
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

/**
 * The identity of the `ack` primitive. Pass `ack` itself in a module's
 * `dependencies` array to declare that ack must be registered alongside it.
 *
 * ```ts
 * defineModule({
 *   id: 'acme:delivery',
 *   key: Symbol('acme:delivery'),
 *   dependencies: [ack],
 *   setup(args, hooks) { ... },
 * });
 * ```
 */
ack.__key = ACK_KEY;

import { ENGINE_SCOPE_META } from '~/_engine/contexts/types.ts';
import type { Primitive } from '~/primitive.ts';

/** The primitive type tag for the ack feature. */
export interface AckPrimitive extends Primitive<'ack'> {}

/** Unique symbol used to enforce one ack registration per handler scope. */
const ACK_KEY = Symbol('ack');

/**
 * Creates the acknowledgement primitive. When registered, this primitive adds
 * an `ack()` method to every connection handler context. Calling `ctx.ack()`
 * sends a protocol-level acknowledgement back to the client for the connection
 * identified by `ctx.id`.
 *
 * The `ack()` method is only added at the top-level connection scope. It is
 * intentionally absent from namespace and channel contexts — those scopes do
 * not have a connection ID in scope and cannot send an ack directly.
 *
 * @example
 * ```ts
 * import '@wskit/server/ack';
 *
 * server('chat')
 *   .ack()
 *   .incoming(sendMessage, (ctx, payload) => {
 *     await saveMessage(payload);
 *     ctx.ack(); // tell the client the message was processed
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
 * Symbol key used to reference this primitive in dependency declarations.
 *
 * Other primitives that require ack to be registered can list `ack` in their
 * `__dependencies` array to get a build-time error when it is missing.
 */
ack.__key = ACK_KEY;

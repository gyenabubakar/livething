import { ENGINE_ACK_ID, ENGINE_SCOPE_META } from '~/_engine/contexts/types.ts';
import type { Primitive } from '~/primitive.ts';

/** The TypeScript type returned by `ack()`. */
export interface AckPrimitive extends Primitive<'ack'> {}

/** @internal */
const ACK_KEY = Symbol('ack');

/**
 * Internal factory for the ack primitive. Enable ack on a contract by setting
 * `ack: true` in the contract config; the implementer compiles that flag into
 * this primitive and the engine extends every top-level connection context
 * with `ctx.ack()`. Namespace and channel contexts do not receive `ctx.ack()`.
 *
 * Calling `ctx.ack()` confirms a message was received and processed; the
 * client's `send.withAck()` promise resolves when the ack frame arrives.
 *
 * @example
 * ```ts
 * import { contract, incoming, implement } from '@wskit/server';
 *
 * const c = contract<Env>('chat')({
 *   ack: true,
 *   definitions: [incoming('send-message', SendMessage)],
 * });
 *
 * implement(c).on('send-message', async (ctx, payload) => {
 *   await saveMessage(payload);
 *   ctx.ack();
 * });
 * ```
 */
export function ack(): AckPrimitive {
  return {
    __wskit: 'ack',
    __kind: 'infrastructure',
    __identity: [ACK_KEY],
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
            engine.sendAck(String(base.id), base[ENGINE_ACK_ID] as string | undefined);
          },
        };
      });
    },
  };
}

/**
 * The identity of the `ack` primitive. Pass `ack` itself in a plugin's
 * `dependencies` array to declare that ack must be registered alongside it.
 *
 * ```ts
 * definePlugin({
 *   id: 'acme:delivery',
 *   key: Symbol('acme:delivery'),
 *   dependencies: [ack],
 *   setup(args, hooks) { ... },
 * });
 * ```
 */
ack.__key = ACK_KEY;

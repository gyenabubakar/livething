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
 * with `ctx.ack()`. Channel contexts do not receive `ctx.ack()`.
 *
 * Calling `ctx.ack()` confirms a message was received and processed; the
 * client's `send.withAck()` promise resolves when the ack frame arrives.
 *
 * @example
 * ```ts
 * import { define, t } from '@wskit/server';
 * import { ack } from '@wskit/server/ack';
 *
 * const base = define({
 *   env: t<Env>(),
 *   capabilities: [ack()],
 * });
 *
 * const handleSend = base.on('send-message', {
 *   input: SendMessage,
 *   async run(ctx, input) {
 *     await saveMessage(input);
 *     ctx.ack();
 *   },
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
        // If this context belongs to a channel, skip adding ack — that scope
        // does not represent a single connection and cannot ack.
        const scope = (base[ENGINE_SCOPE_META] as { channelName?: string } | undefined) ?? {};

        if (scope.channelName || !base.id) {
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
 * The identity of the `ack` primitive. A plugin declares that the host must
 * enable acks by listing the `ack` capability in its `dependsOn` array.
 *
 * ```ts
 * import { ack } from '@wskit/server/ack';
 *
 * plugin('acme:delivery', {
 *   handler: h.assemble(...),
 *   dependsOn: [ack],
 * });
 * ```
 */
ack.__key = ACK_KEY;

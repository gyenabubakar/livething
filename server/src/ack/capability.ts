import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { hostCapability, stampKind, withCapabilityKind } from '~/_define/capability.ts';
import { ack as ackFactory } from '~/ack/ack.ts';
import { makeOutgoingAckPrimitive } from '~/ack/outgoing-runtime.ts';
import type { HostCapability } from '~/_define/capability.ts';

/** Options for the `ack()` capability. */
export interface AckOptions {
  /**
   * Default timeout (ms) for a server→client `sendWithAck(...)` — how long the
   * server waits for the client's receipt before rejecting with `timeout`. A
   * per-send `{ timeout }` overrides it; if neither is set, the built-in 10s
   * applies. Does not affect the client→server `ctx.ack()` direction.
   */
  readonly timeout?: number;
}

/**
 * Enable acknowledgements (both directions). With this listed, a handler can
 * call `ctx.ack()` to confirm it received a client message that was sent with an
 * ack; the client's `withAck` send resolves when that confirmation arrives.
 *
 * It also enables the reverse: `ctx.sendWithAck(event, payload, { timeout? })`
 * (and `ctx.connection(ref).sendWithAck(...)` / `ctx.channel.sendWithAck(...)`)
 * sends an event to one connection and awaits the client's automatic receipt,
 * resolving when it arrives or rejecting with `timeout` / `disconnected`. The
 * optional `{ timeout }` here sets the default wait for that direction.
 *
 * @example
 * ```ts
 * import { define, t } from '@wskit/server';
 * import { ack } from '@wskit/server/ack';
 * import * as v from 'valibot';
 *
 * const base = define({ env: t<Env>(), capabilities: [ack({ timeout: 5_000 })] });
 *
 * export const handleSave = base.on('save', {
 *   input: v.object({ doc: v.string() }),
 *   async run(ctx, input) {
 *     persist(input.doc);
 *     ctx.ack();                                       // confirm the client's send
 *     await ctx.sendWithAck('saved', { id: input.doc }); // await the client's receipt
 *   },
 * });
 * ```
 */
export const ack = withCapabilityKind(function ack(
  options: AckOptions = {},
): HostCapability<{}, 'ack'> {
  return stampKind(
    hostCapability<{}, 'ack'>([ackFactory(), makeOutgoingAckPrimitive(options.timeout)], ['ack']),
    CAPABILITY_KIND.ack,
  );
}, CAPABILITY_KIND.ack);

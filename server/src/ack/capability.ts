import { hostCapability } from '~/_define/capability.ts';
import { ack as ackFactory } from '~/ack/ack.ts';
import type { HostCapability } from '~/_define/capability.ts';

/**
 * Enable acknowledgements. With this listed, a handler can call `ctx.ack()` to
 * confirm it received and accepted a message; the client's `withAck` send
 * resolves when that confirmation arrives. If the handler throws before calling
 * `ctx.ack()`, no confirmation is sent and the client's send rejects.
 *
 * @example
 * ```ts
 * import { define, t } from '@wskit/server';
 * import { ack } from '@wskit/server/ack';
 * import * as v from 'valibot';
 *
 * const base = define({ env: t<Env>(), capabilities: [ack()] });
 *
 * export const handleSave = base.on('save', {
 *   input: v.object({ doc: v.string() }),
 *   run(ctx, input) {
 *     persist(input.doc);
 *     ctx.ack();
 *   },
 * });
 * ```
 */
export function ack(): HostCapability<{}, 'ack'> {
  return hostCapability<{}, 'ack'>([ackFactory()], ['ack']);
}

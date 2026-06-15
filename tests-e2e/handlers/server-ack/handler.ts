import { define, emits, t } from '@wskit/server';
import { ack } from '@wskit/server/ack';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

/**
 * Phase 4 (server→client two-way ack) e2e handler. On an incoming `trigger`, the
 * server sends an event to the calling connection with `ctx.connection(ref)
 * .sendWithAck(...)` and reports whether the client's automatic receipt arrived
 * (or the wait timed out) — so the full round-trip and the timeout path are both
 * observable over the real wire.
 */
export const serverAckContract = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [
    ack({ timeout: 5_000 }),
    emits({
      'settings-updated': t<{ theme: string }>(),
      'ack-outcome': t<{ ok: boolean }>(),
      'ack-error': t<{ code: string }>(),
    }),
  ],
});

function describeError(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : 'unknown';
}

const handleTrigger = serverAckContract.on('trigger', {
  input: v.object({}),
  async run(ctx) {
    try {
      await ctx.connection(ctx.self).sendWithAck('settings-updated', { theme: 'dark' });
      ctx.send('ack-outcome', { ok: true });
    } catch (error) {
      ctx.send('ack-error', { code: describeError(error) });
    }
  },
});

const handleTriggerTimeout = serverAckContract.on('trigger-timeout', {
  input: v.object({}),
  async run(ctx) {
    try {
      await ctx.sendWithAck('settings-updated', { theme: 'dark' }, { timeout: 500 });
      ctx.send('ack-outcome', { ok: true });
    } catch (error) {
      ctx.send('ack-error', { code: describeError(error) });
    }
  },
});

export const serverAckHandler = serverAckContract.assemble(handleTrigger, handleTriggerTimeout);

export type ServerAckClient = InferClient<typeof serverAckHandler>;

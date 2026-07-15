import { define, emits, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { requests } from '@wskit/server/requests';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

/**
 * Phase 3 (broadcast request — first answer wins) e2e handler. Clients join the
 * `lobby` channel; on a `trigger` the server fans a broadcast request out to
 * every member and reports the winner's identity so the test can assert which
 * connection answered first over the real wire. A `trigger-timeout` exercises
 * the "nobody volunteered" path.
 */
export const broadcastRequestContract = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [
    channels(),
    requests(),
    emits({
      outcome: t<{ from: string; ready: boolean }>(),
      'error-outcome': t<{ code: string }>(),
    }),
  ],
});

function describeError(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : 'unknown';
}

const lobby = broadcastRequestContract.channel('lobby', {
  outgoing: {
    emits: {},
    requests: {
      volunteer: { out: t<{ turn: number }>(), in: v.object({ ready: v.boolean() }) },
    },
  },
});

const handleTrigger = broadcastRequestContract.on('trigger', {
  input: v.object({ turn: v.number() }),
  async run(ctx, input) {
    try {
      const { response, from } = await ctx.channels
        .get(lobby)
        .broadcastRequest('volunteer', { turn: input.turn });
      ctx.send('outcome', { from: from.identity, ready: response.ready });
    } catch (error) {
      ctx.send('error-outcome', { code: describeError(error) });
    }
  },
});

const handleTriggerTimeout = broadcastRequestContract.on('trigger-timeout', {
  input: v.object({ turn: v.number() }),
  async run(ctx, input) {
    try {
      const { response, from } = await ctx.channels
        .get(lobby)
        .broadcastRequest('volunteer', { turn: input.turn }, { timeout: 500 });
      ctx.send('outcome', { from: from.identity, ready: response.ready });
    } catch (error) {
      ctx.send('error-outcome', { code: describeError(error) });
    }
  },
});

export const broadcastRequestHandler = broadcastRequestContract.assemble({
  handlers: [lobby, handleTrigger, handleTriggerTimeout],
});

export type BroadcastRequestClient = InferClient<typeof broadcastRequestHandler>;

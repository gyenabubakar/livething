import { define, emits, t } from '@wskit/server';
import { requests } from '@wskit/server/requests';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

/**
 * Phase 2 (server→client targeted requests) e2e handler. On an incoming
 * `trigger`, the server asks the calling connection a declared server→client
 * request and reports the outcome back so the test can observe the full
 * round-trip, an invalid-response rejection, and a timeout — all over the real
 * wire.
 */
export const serverRequestContract = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [
    requests({
      'ask-permission': [t<{ action: string }>(), v.object({ allowed: v.boolean() })],
    }),
    emits({
      outcome: t<{ allowed: boolean }>(),
      'error-outcome': t<{ code: string }>(),
    }),
  ],
});

function describeError(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : 'unknown';
}

const handleTrigger = serverRequestContract.on('trigger', {
  input: v.object({ action: v.string() }),
  async run(ctx, input) {
    try {
      const answer = await ctx.request('ask-permission', { action: input.action });
      ctx.send('outcome', { allowed: answer.allowed });
    } catch (error) {
      ctx.send('error-outcome', { code: describeError(error) });
    }
  },
});

const handleTriggerTimeout = serverRequestContract.on('trigger-timeout', {
  input: v.object({}),
  async run(ctx) {
    try {
      await ctx.request('ask-permission', { action: 'slow' }, { timeout: 500 });
      ctx.send('outcome', { allowed: true });
    } catch (error) {
      ctx.send('error-outcome', { code: describeError(error) });
    }
  },
});

export const serverRequestHandler = serverRequestContract.assemble(
  handleTrigger,
  handleTriggerTimeout,
);

export type ServerRequestClient = InferClient<typeof serverRequestHandler>;

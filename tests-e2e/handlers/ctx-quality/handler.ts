import { emits, server, t } from '@wskit/server';
import { keepalive } from '@wskit/server/keepalive';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const base = server({
  upgrade: (request) => requireUsername(request),
  capabilities: [
    // Ping fast so a pong round-trip completes inside the test window — quality
    // and latency stay null until the first measurement, so the e2e needs a real
    // ping/pong to see them populated.
    keepalive({ pingIntervalMs: 1_000, idleTimeoutMs: 10_000 }),
    emits({
      'quality-result': t<{
        quality: string | null;
        latency: number | null;
        bufferedAmount: number;
      }>(),
    }),
  ],
});

const handleGetQuality = base.on('get-quality', {
  input: v.object({}),
  run(ctx) {
    ctx.send('quality-result', {
      quality: ctx.quality,
      latency: ctx.latency,
      bufferedAmount: ctx.bufferedAmount ?? 0,
    });
  },
});

export const ctxQualityDefinition = base.assemble({ handlers: [handleGetQuality] });

export type CtxQualityClient = InferClient<typeof ctxQualityDefinition>;

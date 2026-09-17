import { server, t } from '@wskit/server';
import { stream } from '@wskit/server/streams';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const Tick = t<{ index: number }>();

const base = server({
  upgrade: (request) => requireUsername(request),
  capabilities: [stream()],
});

/**
 * Phase 6 — a stream that calls `await ctx.stream.drain()` between every yield.
 *
 * On a healthy client drain resolves the moment the buffer is under the mark, so
 * the stream runs to completion at full speed. On Cloudflare the platform does
 * not expose buffer fullness, so drain is a no-op (resolves immediately) — the
 * stream must still complete and deliver every chunk. The override
 * `highWaterMark` proves the option threads through server → compile → runtime.
 */
const handleDrainFeed = base.stream('drain-feed', {
  input: v.object({ count: v.number() }),
  chunk: Tick,
  highWaterMark: 64 * 1024,
  async *run(ctx, input) {
    for (let i = 0; i < input.count; i += 1) {
      yield { index: i };
      // Backpressure pause between chunks. A no-op on Cloudflare; on a buffer-
      // aware adapter it would pause until the outbound buffer drains.
      await ctx.stream.drain();
    }
  },
});

export const streamBackpressureDefinition = base.assemble({ handlers: [handleDrainFeed] });

export type StreamBackpressureClient = InferClient<typeof streamBackpressureDefinition>;

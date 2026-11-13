import { server } from '@livething/server';
import { keepalive } from '@livething/server/keepalive';
import { stream } from '@livething/server/streams';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import { requireUsername } from '../_shared/authenticate.ts';

const base = server({
  authenticate: (request) => requireUsername(request),
  capabilities: [keepalive(), stream()],
});

/**
 * Phase 6 — a stream that calls `await ctx.stream.drain()` between every yield.
 *
 * On a healthy client drain resolves the moment the buffer is under 256 KB, so
 * the stream runs to completion at full speed. On Cloudflare the platform does
 * not expose buffer fullness, so drain is a no-op (resolves immediately) — the
 * stream must still complete and deliver every chunk.
 */
const handleDrainFeed = base.stream('drain-feed', {
  input: v.object({ count: v.number() }),
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

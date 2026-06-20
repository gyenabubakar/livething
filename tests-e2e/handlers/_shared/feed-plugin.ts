import { define, t } from '@wskit/server';
import { plugin } from '@wskit/server/plugin';
import { resumableStream } from '@wskit/server/streams';
import * as v from 'valibot';

// A pure-wskit plugin (no DO adapter) that OWNS a durable (resumable) stream.
// It lists no persistence and no dependsOn: the persistence requirement is
// auto-derived from the durable stream it owns, and the host must provide
// persistence(). Before the capability-requirement model this was impossible —
// a plugin declaring a durable stream threw at its own scoped assemble.
const h = define({
  scoped: true,
  capabilities: [resumableStream()],
});

const feed = h.resumableStream('feed', {
  input: v.object({ from: v.number() }),
  chunk: t<{ row: number }>(),
  maxAgeMs: 60_000,
  retentionAfterEndMs: 30_000,
  async *run(ctx, payload) {
    const start = (ctx.stream.cursor as { row: number } | null)?.row ?? payload.from;
    for (let i = start + 1; i <= start + 5; i += 1) {
      yield ctx.stream.withCursor({ row: i }, { row: i });
      await new Promise((r) => setTimeout(r, 5));
    }
  },
});

export const Feed = plugin('e2e:feed', {
  handler: h.assemble(feed),
});

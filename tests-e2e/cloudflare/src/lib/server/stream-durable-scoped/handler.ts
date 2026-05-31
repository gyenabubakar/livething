import {
  channel,
  contract,
  implement,
  namespace,
  nudge,
  recordedStream,
  resumableStream,
  stream,
  t,
} from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const Empty = v.object({});
const RowChunk = v.object({ row: v.number() });
const IdxChunk = v.object({ idx: v.number() });
const LineChunk = v.object({ line: v.string() });
const PausePayload = v.object({ at: v.number() });
const TokenChunk = v.object({ token: v.string() });
const StopPayload = v.object({});

export const streamDurableScopedContract = contract('stream-durable-scoped', {
  env: t<Env>(),
  persistence: true,
  meta: t<{ username: string }>(),
  definitions: [
    channel('rooms', {
      definitions: [
        resumableStream('paginate', {
          payload: Empty,
          chunk: RowChunk,
          maxAgeMs: 60_000,
          retentionAfterEndMs: 30_000,
        }),
        recordedStream('history', {
          payload: Empty,
          chunk: IdxChunk,
          maxChunks: 100,
          maxAgeMs: 60_000,
          retentionAfterEndMs: 30_000,
        }),
        resumableStream('paused-feed', {
          payload: Empty,
          chunk: RowChunk,
          nudges: [nudge('pause', PausePayload)],
          maxAgeMs: 60_000,
          retentionAfterEndMs: 30_000,
        }),
        stream('channel-tokens', {
          payload: Empty,
          chunk: TokenChunk,
          nudges: [nudge('stop', StopPayload)],
        }),
        recordedStream('history-nudged', {
          payload: Empty,
          chunk: IdxChunk,
          nudges: [nudge('stop', StopPayload)],
          maxChunks: 100,
          maxAgeMs: 60_000,
          retentionAfterEndMs: 30_000,
        }),
      ],
    }),

    stream('start-concurrent', {
      payload: Empty,
      chunk: TokenChunk,
      allowConcurrent: true,
    }),
    recordedStream('boom-mid', {
      payload: Empty,
      chunk: IdxChunk,
      maxChunks: 20,
      maxAgeMs: 60_000,
      retentionAfterEndMs: 30_000,
    }),
    resumableStream('short-window', {
      payload: Empty,
      chunk: RowChunk,
      maxAgeMs: 300,
      retentionAfterEndMs: 30_000,
    }),
    recordedStream('short-retention', {
      payload: Empty,
      chunk: IdxChunk,
      maxChunks: 10,
      maxAgeMs: 60_000,
      retentionAfterEndMs: 300,
    }),
    recordedStream('keep-running-feed', {
      payload: Empty,
      chunk: IdxChunk,
      maxChunks: 50,
      maxAgeMs: 60_000,
      retentionAfterEndMs: 30_000,
      onDisconnect: 'keep-running',
    }),

    namespace('v1', {
      definitions: [
        recordedStream('logs', {
          payload: Empty,
          chunk: LineChunk,
          maxChunks: 100,
          maxAgeMs: 60_000,
          retentionAfterEndMs: 30_000,
        }),
        resumableStream('audit-export', {
          payload: Empty,
          chunk: RowChunk,
          maxAgeMs: 60_000,
          retentionAfterEndMs: 30_000,
        }),
        stream('ns-tokens', {
          payload: Empty,
          chunk: TokenChunk,
          nudges: [nudge('stop', StopPayload)],
        }),
        resumableStream('audit-nudged', {
          payload: Empty,
          chunk: RowChunk,
          nudges: [nudge('stop', StopPayload)],
          maxAgeMs: 60_000,
          retentionAfterEndMs: 30_000,
        }),
        recordedStream('logs-nudged', {
          payload: Empty,
          chunk: LineChunk,
          nudges: [nudge('stop', StopPayload)],
          maxChunks: 100,
          maxAgeMs: 60_000,
          retentionAfterEndMs: 30_000,
        }),
      ],
    }),
  ],
});

export const streamDurableScopedHandler = implement(streamDurableScopedContract)
  .onUpgrade((request) => requireUsername(request))

  .stream('start-concurrent', async function* () {
    for (let i = 1; i <= 3; i += 1) {
      yield { token: `c${i}` };
      await new Promise((r) => setTimeout(r, 100));
    }
  })

  .resumableStream('short-window', async function* (ctx) {
    const startAt = (ctx.stream.cursor as { idx: number } | null)?.idx ?? 0;
    for (let i = startAt + 1; i <= 5; i += 1) {
      yield ctx.stream.withCursor({ row: i }, { idx: i });
      await new Promise((r) => setTimeout(r, 80));
    }
  })

  .recordedStream('short-retention', async function* () {
    for (let i = 1; i <= 3; i += 1) {
      yield { idx: i };
      await new Promise((r) => setTimeout(r, 60));
    }
  })

  .recordedStream('boom-mid', async function* () {
    yield { idx: 1 };
    yield { idx: 2 };
    throw new Error('mid-stream boom');
  })

  .recordedStream('keep-running-feed', async function* () {
    for (let i = 1; i <= 20; i += 1) {
      yield { idx: i };
      await new Promise((r) => setTimeout(r, 80));
    }
  })

  .channel('rooms', (ch) =>
    ch
      .resumableStream('paginate', async function* (ctx) {
        const startAt = (ctx.stream.cursor as { idx: number } | null)?.idx ?? 0;
        for (let i = startAt + 1; i <= 10; i += 1) {
          yield ctx.stream.withCursor({ row: i }, { idx: i });
          await new Promise((r) => setTimeout(r, 200));
        }
      })
      .recordedStream('history', async function* () {
        for (let i = 1; i <= 5; i += 1) {
          yield { idx: i };
          await new Promise((r) => setTimeout(r, 200));
        }
      })
      .resumableStream('paused-feed', async function* (ctx) {
        const startAt = (ctx.stream.cursor as { idx: number } | null)?.idx ?? 0;
        for (let i = startAt + 1; i <= 20; i += 1) {
          const nudges = ctx.nudges(yield ctx.stream.withCursor({ row: i }, { idx: i }));
          if (nudges.some((n: { event: string }) => n.event === 'pause')) return;
          await new Promise((r) => setTimeout(r, 150));
        }
      })
      .stream('channel-tokens', async function* (ctx) {
        for (let i = 1; i <= 20; i += 1) {
          const nudges = ctx.nudges(yield { token: `t${i}` });
          if (nudges.some((n: { event: string }) => n.event === 'stop')) return;
          await new Promise((r) => setTimeout(r, 100));
        }
      })
      .recordedStream('history-nudged', async function* (ctx) {
        for (let i = 1; i <= 20; i += 1) {
          const nudges = ctx.nudges(yield { idx: i });
          if (nudges.some((n: { event: string }) => n.event === 'stop')) return;
          await new Promise((r) => setTimeout(r, 100));
        }
      }),
  )

  .namespace('v1', (ns) =>
    ns
      .recordedStream('logs', async function* () {
        for (let i = 1; i <= 5; i += 1) {
          yield { line: `line-${i}` };
          await new Promise((r) => setTimeout(r, 150));
        }
      })
      .resumableStream('audit-export', async function* (ctx) {
        const startAt = (ctx.stream.cursor as { idx: number } | null)?.idx ?? 0;
        for (let i = startAt + 1; i <= 10; i += 1) {
          yield ctx.stream.withCursor({ row: i }, { idx: i });
          await new Promise((r) => setTimeout(r, 150));
        }
      })
      .stream('ns-tokens', async function* (ctx) {
        for (let i = 1; i <= 20; i += 1) {
          const nudges = ctx.nudges(yield { token: `t${i}` });
          if (nudges.some((n: { event: string }) => n.event === 'stop')) return;
          await new Promise((r) => setTimeout(r, 100));
        }
      })
      .resumableStream('audit-nudged', async function* (ctx) {
        const startAt = (ctx.stream.cursor as { idx: number } | null)?.idx ?? 0;
        for (let i = startAt + 1; i <= 20; i += 1) {
          const nudges = ctx.nudges(yield ctx.stream.withCursor({ row: i }, { idx: i }));
          if (nudges.some((n: { event: string }) => n.event === 'stop')) return;
          await new Promise((r) => setTimeout(r, 100));
        }
      })
      .recordedStream('logs-nudged', async function* (ctx) {
        for (let i = 1; i <= 20; i += 1) {
          const nudges = ctx.nudges(yield { line: `line-${i}` });
          if (nudges.some((n: { event: string }) => n.event === 'stop')) return;
          await new Promise((r) => setTimeout(r, 100));
        }
      }),
  )

  .build();

export type StreamDurableScopedClient = InferClient<typeof streamDurableScopedHandler>;

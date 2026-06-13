import {
  contract,
  implement,
  incoming,
  nudge,
  recordedStream,
  resumableStream,
  t,
} from '@wskit/server';
import { Disconnect, StreamAborted } from '@wskit/server/errors';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const CountTokensPayload = v.object({});
const TokenChunk = v.object({ idx: v.number() });
const PaginatePayload = v.object({});
const RowChunk = v.object({ row: v.number() });
const AttemptPayload = v.object({});
const AttemptChunk = v.object({ attempt: v.number() });
const BufferFullPayload = v.object({});
const BufferChunk = v.object({ n: v.number() });
const StopPayload = v.object({});

export const streamDurableContract = contract('stream-durable', {
  env: t<Env>(),
  persistence: true,
  meta: t<{ username: string }>(),
  definitions: [
    recordedStream('count-tokens', {
      payload: CountTokensPayload,
      chunk: TokenChunk,
      maxChunks: 100,
      maxAgeMs: 60_000,
      retentionAfterEndMs: 30_000,
    }),

    resumableStream('paginate', {
      payload: PaginatePayload,
      chunk: RowChunk,
      maxAgeMs: 60_000,
      retentionAfterEndMs: 30_000,
    }),

    resumableStream('attempt-stream', {
      payload: AttemptPayload,
      chunk: AttemptChunk,
      maxAgeMs: 60_000,
      retentionAfterEndMs: 30_000,
    }),

    recordedStream('buffer-full-demo', {
      payload: BufferFullPayload,
      chunk: BufferChunk,
      maxChunks: 2,
      maxAgeMs: 60_000,
      retentionAfterEndMs: 30_000,
    }),

    recordedStream('count-tokens-nudged', {
      payload: CountTokensPayload,
      chunk: TokenChunk,
      nudges: [nudge('stop', StopPayload)],
      maxChunks: 100,
      maxAgeMs: 60_000,
      retentionAfterEndMs: 30_000,
    }),

    resumableStream('paginate-nudged', {
      payload: PaginatePayload,
      chunk: RowChunk,
      nudges: [nudge('stop', StopPayload)],
      maxAgeMs: 60_000,
      retentionAfterEndMs: 30_000,
    }),

    // Test support: a client triggers a server-initiated close with a retryable
    // code so it reconnects in-session and a durable stream auto-resumes.
    incoming('server-drop', v.object({})),
  ],
});

export const streamDurableHandler = implement(streamDurableContract)
  .onUpgrade((request) => requireUsername(request))

  .recordedStream('count-tokens', async function* () {
    for (let i = 1; i <= 5; i += 1) {
      yield { idx: i };
      await new Promise((r) => setTimeout(r, 400));
    }
  })

  .resumableStream('paginate', async function* (ctx) {
    const startAt = (ctx.stream.cursor as { idx: number } | null)?.idx ?? 0;
    for (let i = startAt + 1; i <= 10; i += 1) {
      yield ctx.stream.withCursor({ row: i }, { idx: i });
      await new Promise((r) => setTimeout(r, 400));
    }
  })

  .resumableStream('attempt-stream', async function* (ctx) {
    yield ctx.stream.withCursor({ attempt: ctx.stream.attempt }, { idx: 1 });
    await new Promise((r) => setTimeout(r, 60_000));
  })

  .recordedStream('buffer-full-demo', async function* () {
    for (let n = 1; n <= 5; n += 1) {
      try {
        yield { n };
      } catch (err) {
        if (StreamAborted.matches(err) && err.detail.reason === 'buffer-full') {
          return;
        }
        throw err;
      }
    }
  })

  .recordedStream('count-tokens-nudged', async function* (ctx) {
    for (let i = 1; i <= 20; i += 1) {
      const nudges = ctx.nudges(yield { idx: i });
      if (nudges.some((n: { event: string }) => n.event === 'stop')) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  })

  .resumableStream('paginate-nudged', async function* (ctx) {
    const startAt = (ctx.stream.cursor as { idx: number } | null)?.idx ?? 0;
    for (let i = startAt + 1; i <= 20; i += 1) {
      const nudges = ctx.nudges(yield ctx.stream.withCursor({ row: i }, { idx: i }));
      if (nudges.some((n: { event: string }) => n.event === 'stop')) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  })

  .on('server-drop', () => {
    throw Disconnect(4500, 'test drop');
  })

  .build();

export type StreamDurableClient = InferClient<typeof streamDurableHandler>;

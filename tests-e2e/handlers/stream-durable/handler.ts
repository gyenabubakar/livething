import { define, t } from '@wskit/server';
import { Disconnect, StreamAborted } from '@wskit/server/errors';
import { recordedStream, resumableStream } from '@wskit/server/streams';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const CountTokensPayload = v.object({ hold: v.optional(v.boolean()) });
const TokenChunk = t<{ idx: number }>();
const PaginatePayload = v.object({});
const RowChunk = t<{ row: number }>();
const AttemptPayload = v.object({});
const AttemptChunk = t<{ attempt: number }>();
const BufferFullPayload = v.object({});
const BufferChunk = t<{ n: number }>();
const NumberChunk = t<number>();
const StopPayload = v.object({});
const overflowGates = new Map<string, () => void>();

const base = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [recordedStream(), resumableStream()],
});

const handleReleaseOverflow = base.on('release-overflow', {
  input: v.object({}),
  run(ctx) {
    overflowGates.get(ctx.connection.id)?.();
  },
});

const handleCountTokens = base.recordedStream('count-tokens', {
  input: CountTokensPayload,
  chunk: TokenChunk,
  maxChunks: 100,
  maxAgeMs: 60_000,
  retentionAfterEndMs: 30_000,
  async *run() {
    for (let i = 1; i <= 5; i += 1) {
      yield { idx: i };
      await new Promise((r) => setTimeout(r, 400));
    }
  },
});

const handlePaginate = base.resumableStream('paginate', {
  input: PaginatePayload,
  chunk: RowChunk,
  maxAgeMs: 60_000,
  retentionAfterEndMs: 30_000,
  async *run(ctx) {
    const startAt = (ctx.stream.cursor as { idx: number } | null)?.idx ?? 0;
    for (let i = startAt + 1; i <= 10; i += 1) {
      yield ctx.stream.withCursor({ row: i }, { idx: i });
      await new Promise((r) => setTimeout(r, 400));
    }
  },
});

const handlePaginateBare = base.resumableStream('paginate-bare', {
  input: PaginatePayload,
  chunk: RowChunk,
  maxAgeMs: 60_000,
  retentionAfterEndMs: 30_000,
  async *run(ctx) {
    const offset = ctx.stream.cursor === null ? 0 : 100;
    for (let i = 1; i <= 4; i += 1) {
      yield { row: offset + i };
      await new Promise((r) => setTimeout(r, 400));
    }
  },
});

const handleAttemptStream = base.resumableStream('attempt-stream', {
  input: AttemptPayload,
  chunk: AttemptChunk,
  maxAgeMs: 60_000,
  retentionAfterEndMs: 30_000,
  async *run(ctx) {
    yield ctx.stream.withCursor({ attempt: ctx.stream.attempt }, { idx: 1 });
    await new Promise((r) => setTimeout(r, 60_000));
  },
});

const handleBufferFullDemo = base.recordedStream('buffer-full-demo', {
  input: BufferFullPayload,
  chunk: BufferChunk,
  maxChunks: 2,
  maxAgeMs: 60_000,
  retentionAfterEndMs: 30_000,
  async *run() {
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
  },
});

const handlePrimitiveRecorded = base.recordedStream('primitive-recorded', {
  input: v.object({}),
  chunk: NumberChunk,
  maxChunks: 10,
  maxAgeMs: 60_000,
  retentionAfterEndMs: 30_000,
  async *run() {
    yield 1;
    yield 2;
  },
});

const handleCountTokensNudged = base.recordedStream('count-tokens-nudged', {
  input: CountTokensPayload,
  chunk: TokenChunk,
  nudges: { stop: StopPayload },
  maxChunks: 100,
  maxAgeMs: 60_000,
  retentionAfterEndMs: 30_000,
  async *run(ctx, input) {
    if (input.hold) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      overflowGates.set(ctx.connection.id, release);
      try {
        await gate;
      } finally {
        overflowGates.delete(ctx.connection.id);
      }
    }

    for (let i = 1; i <= 20; i += 1) {
      const nudges = ctx.stream.nudges(yield { idx: i });
      if (nudges.some((n) => n.event === 'stop')) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  },
});

const handlePaginateNudged = base.resumableStream('paginate-nudged', {
  input: PaginatePayload,
  chunk: RowChunk,
  nudges: { stop: StopPayload },
  maxAgeMs: 60_000,
  retentionAfterEndMs: 30_000,
  async *run(ctx) {
    const startAt = (ctx.stream.cursor as { idx: number } | null)?.idx ?? 0;
    for (let i = startAt + 1; i <= 20; i += 1) {
      const nudges = ctx.stream.nudges(yield ctx.stream.withCursor({ row: i }, { idx: i }));
      if (nudges.some((n) => n.event === 'stop')) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  },
});

// Test support: a client triggers a server-initiated close with a retryable
// code so it reconnects in-session and a durable stream auto-resumes.
const handleServerDrop = base.on('server-drop', {
  input: v.object({}),
  run() {
    throw Disconnect(4500, 'test drop');
  },
});

export const streamDurableHandler = base.assemble({
  handlers: [
    handleCountTokens,
    handlePaginate,
    handlePaginateBare,
    handleAttemptStream,
    handleBufferFullDemo,
    handlePrimitiveRecorded,
    handleCountTokensNudged,
    handlePaginateNudged,
    handleServerDrop,
    handleReleaseOverflow,
  ],
});

export type StreamDurableClient = InferClient<typeof streamDurableHandler>;

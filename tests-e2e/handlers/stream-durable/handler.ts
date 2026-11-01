import { server, t } from '@livething/server';
import { Disconnect, StreamAborted } from '@livething/server/errors';
import { recordedStream } from '@livething/server/streams';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import { requireUsername } from '../_shared/upgrade.ts';

const CountTokensPayload = v.object({ hold: v.optional(v.boolean()) });
const TokenChunk = t<{ idx: number }>();
const PaginatePayload = v.object({});
const RowChunk = t<{ row: number }>();
const BufferFullPayload = v.object({});
const BufferChunk = t<{ n: number }>();
const NumberChunk = t<number>();
const StopPayload = v.object({});
const overflowGates = new Map<string, () => void>();

const base = server({
  upgrade: (request) => requireUsername(request),
  capabilities: [recordedStream()],
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

const handlePaginate = base.recordedStream('paginate', {
  input: PaginatePayload,
  chunk: RowChunk,
  maxChunks: 100,
  maxAgeMs: 60_000,
  retentionAfterEndMs: 30_000,
  async *run() {
    for (let i = 1; i <= 10; i += 1) {
      yield { row: i };
      await new Promise((r) => setTimeout(r, 400));
    }
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

// Test support: a client triggers a server-initiated close with a retryable
// code so it reconnects in-session and a durable stream auto-reconnects.
const handleServerDrop = base.on('server-drop', {
  input: v.object({}),
  run() {
    throw Disconnect(4500, 'test drop');
  },
});

export const streamDurableDefinition = base.assemble({
  handlers: [
    handleCountTokens,
    handlePaginate,
    handleBufferFullDemo,
    handlePrimitiveRecorded,
    handleCountTokensNudged,
    handleServerDrop,
    handleReleaseOverflow,
  ],
});

export type StreamDurableClient = InferClient<typeof streamDurableDefinition>;

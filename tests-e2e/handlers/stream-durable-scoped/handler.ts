import { define, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { persistence } from '@wskit/server/persistence';
import { recordedStream, resumableStream, stream } from '@wskit/server/streams';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const Empty = v.object({});
const RowChunk = t<{ row: number }>();
const IdxChunk = t<{ idx: number }>();
const PausePayload = v.object({ at: v.number() });
const TokenChunk = t<{ token: string }>();
const StopPayload = v.object({});

const base = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [persistence(), channels(), stream(), resumableStream(), recordedStream()],
});

const handleStartConcurrent = base.stream('start-concurrent', {
  input: Empty,
  chunk: TokenChunk,
  allowConcurrent: true,
  async *run() {
    for (let i = 1; i <= 3; i += 1) {
      yield { token: `c${i}` };
      await new Promise((r) => setTimeout(r, 100));
    }
  },
});

const handleShortWindow = base.resumableStream('short-window', {
  input: Empty,
  chunk: RowChunk,
  maxAgeMs: 300,
  retentionAfterEndMs: 30_000,
  async *run(ctx) {
    const startAt = (ctx.stream.cursor as { idx: number } | null)?.idx ?? 0;
    for (let i = startAt + 1; i <= 5; i += 1) {
      yield ctx.stream.withCursor({ row: i }, { idx: i });
      await new Promise((r) => setTimeout(r, 80));
    }
  },
});

const handleShortRetention = base.recordedStream('short-retention', {
  input: Empty,
  chunk: IdxChunk,
  maxChunks: 10,
  maxAgeMs: 60_000,
  retentionAfterEndMs: 300,
  async *run() {
    for (let i = 1; i <= 3; i += 1) {
      yield { idx: i };
      await new Promise((r) => setTimeout(r, 60));
    }
  },
});

const handleBoomMid = base.recordedStream('boom-mid', {
  input: Empty,
  chunk: IdxChunk,
  maxChunks: 20,
  maxAgeMs: 60_000,
  retentionAfterEndMs: 30_000,
  async *run() {
    yield { idx: 1 };
    yield { idx: 2 };
    throw new Error('mid-stream boom');
  },
});

const handleKeepRunningFeed = base.recordedStream('keep-running-feed', {
  input: Empty,
  chunk: IdxChunk,
  maxChunks: 50,
  maxAgeMs: 60_000,
  retentionAfterEndMs: 30_000,
  onDisconnect: 'keep-running',
  async *run() {
    for (let i = 1; i <= 20; i += 1) {
      yield { idx: i };
      await new Promise((r) => setTimeout(r, 80));
    }
  },
});

const rooms = base.channel('rooms', {});

const handlePaginate = rooms.resumableStream('paginate', {
  input: Empty,
  chunk: RowChunk,
  maxAgeMs: 60_000,
  retentionAfterEndMs: 30_000,
  async *run(ctx) {
    const startAt = (ctx.stream.cursor as { idx: number } | null)?.idx ?? 0;
    for (let i = startAt + 1; i <= 10; i += 1) {
      yield ctx.stream.withCursor({ row: i }, { idx: i });
      await new Promise((r) => setTimeout(r, 200));
    }
  },
});

const handleHistory = rooms.recordedStream('history', {
  input: Empty,
  chunk: IdxChunk,
  maxChunks: 100,
  maxAgeMs: 60_000,
  retentionAfterEndMs: 30_000,
  async *run() {
    for (let i = 1; i <= 5; i += 1) {
      yield { idx: i };
      await new Promise((r) => setTimeout(r, 200));
    }
  },
});

const handlePausedFeed = rooms.resumableStream('paused-feed', {
  input: Empty,
  chunk: RowChunk,
  nudges: { pause: PausePayload },
  maxAgeMs: 60_000,
  retentionAfterEndMs: 30_000,
  async *run(ctx) {
    const startAt = (ctx.stream.cursor as { idx: number } | null)?.idx ?? 0;
    for (let i = startAt + 1; i <= 20; i += 1) {
      const nudges = ctx.stream.nudges(yield ctx.stream.withCursor({ row: i }, { idx: i }));
      if (nudges.some((n) => n.event === 'pause')) return;
      await new Promise((r) => setTimeout(r, 150));
    }
  },
});

const handleChannelTokens = rooms.stream('channel-tokens', {
  input: Empty,
  chunk: TokenChunk,
  nudges: { stop: StopPayload },
  async *run(ctx) {
    for (let i = 1; i <= 20; i += 1) {
      const nudges = ctx.stream.nudges(yield { token: `t${i}` });
      if (nudges.some((n) => n.event === 'stop')) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  },
});

const handleHistoryNudged = rooms.recordedStream('history-nudged', {
  input: Empty,
  chunk: IdxChunk,
  nudges: { stop: StopPayload },
  maxChunks: 100,
  maxAgeMs: 60_000,
  retentionAfterEndMs: 30_000,
  async *run(ctx) {
    for (let i = 1; i <= 20; i += 1) {
      const nudges = ctx.stream.nudges(yield { idx: i });
      if (nudges.some((n) => n.event === 'stop')) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  },
});

export const streamDurableScopedHandler = base.assemble({
  handlers: [
    handleStartConcurrent,
    handleShortWindow,
    handleShortRetention,
    handleBoomMid,
    handleKeepRunningFeed,
    handlePaginate,
    handleHistory,
    handlePausedFeed,
    handleChannelTokens,
    handleHistoryNudged,
  ],
});

export type StreamDurableScopedClient = InferClient<typeof streamDurableScopedHandler>;

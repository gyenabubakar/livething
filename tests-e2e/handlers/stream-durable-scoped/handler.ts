import { server } from '@livething/server';
import { channels } from '@livething/server/channels';
import { recordedStream, stream } from '@livething/server/streams';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import { requireUsername } from '../_shared/upgrade.ts';

const Empty = v.object({});
const StopPayload = v.object({});

const base = server({
  upgrade: (request) => requireUsername(request),
  capabilities: [channels(), stream(), recordedStream()],
});

const handleStartConcurrent = base.stream('start-concurrent', {
  input: Empty,
  allowConcurrent: true,
  async *run() {
    for (let i = 1; i <= 3; i += 1) {
      yield { token: `c${i}` };
      await new Promise((r) => setTimeout(r, 100));
    }
  },
});

const handleShortRetention = base.recordedStream('short-retention', {
  input: Empty,
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
  maxChunks: 20,
  maxAgeMs: 60_000,
  retentionAfterEndMs: 30_000,
  async *run() {
    yield { idx: 1 };
    yield { idx: 2 };
    throw new Error('mid-stream boom');
  },
});

const handleBackgroundFeed = base.recordedStream('background-feed', {
  input: Empty,
  maxChunks: 50,
  maxAgeMs: 60_000,
  retentionAfterEndMs: 30_000,
  async *run() {
    for (let i = 1; i <= 20; i += 1) {
      yield { idx: i };
      await new Promise((r) => setTimeout(r, 80));
    }
  },
});

const rooms = base.channel('rooms', { membership: 'persistent' });

const handlePaginate = rooms.recordedStream('paginate', {
  input: Empty,
  maxChunks: 100,
  maxAgeMs: 60_000,
  retentionAfterEndMs: 30_000,
  async *run() {
    for (let i = 1; i <= 10; i += 1) {
      yield { row: i };
      await new Promise((r) => setTimeout(r, 200));
    }
  },
});

const handleHistory = rooms.recordedStream('history', {
  input: Empty,
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

const handleChannelTokens = rooms.stream('channel-tokens', {
  input: Empty,
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

export const streamDurableScopedDefinition = base.assemble({
  handlers: [
    handleStartConcurrent,
    handleShortRetention,
    handleBoomMid,
    handleBackgroundFeed,
    handlePaginate,
    handleHistory,
    handleChannelTokens,
    handleHistoryNudged,
  ],
});

export type StreamDurableScopedClient = InferClient<typeof streamDurableScopedDefinition>;

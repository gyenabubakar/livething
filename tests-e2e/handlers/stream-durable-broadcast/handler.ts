import { define, t } from '@wskit/server';
import { persistence } from '@wskit/server/persistence';
import { channels } from '@wskit/server/channels';
import { recordedStream, resumableStream } from '@wskit/server/streams';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const Empty = v.object({});
const TokenChunk = v.object({ token: v.string() });
const RowChunk = v.object({ row: v.number() });
const AttemptChunk = v.object({ attempt: v.number() });

const base = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [persistence(), channels(), recordedStream(), resumableStream()],
});

const rooms = base.channel('rooms', {});

const handleFeed = rooms.recordedStream('feed', {
  input: Empty,
  chunk: TokenChunk,
  broadcast: true,
  maxChunks: 100,
  maxAgeMs: 60_000,
  retentionAfterEndMs: 30_000,
  async *run() {
    for (let i = 1; i <= 5; i += 1) {
      yield { token: `t${i}` };
      await new Promise((r) => setTimeout(r, 250));
    }
  },
});

const handlePaginate = rooms.resumableStream('paginate', {
  input: Empty,
  chunk: RowChunk,
  broadcast: true,
  maxChunks: 100,
  maxAgeMs: 60_000,
  retentionAfterEndMs: 30_000,
  async *run(ctx) {
    const startAt = (ctx.stream.cursor as { idx: number } | null)?.idx ?? 0;
    for (let i = startAt + 1; i <= 10; i += 1) {
      yield ctx.stream.withCursor({ row: i }, { idx: i });
      await new Promise((r) => setTimeout(r, 250));
    }
  },
});

const handleAttemptBroadcast = rooms.resumableStream('attempt-broadcast', {
  input: Empty,
  chunk: AttemptChunk,
  broadcast: true,
  maxChunks: 100,
  maxAgeMs: 60_000,
  retentionAfterEndMs: 30_000,
  async *run(ctx) {
    yield ctx.stream.withCursor({ attempt: ctx.stream.attempt }, { idx: 1 });
    await new Promise((r) => setTimeout(r, 60_000));
  },
});

const handleFeedNudged = rooms.recordedStream('feed-nudged', {
  input: Empty,
  chunk: TokenChunk,
  broadcast: true,
  maxChunks: 100,
  maxAgeMs: 60_000,
  retentionAfterEndMs: 30_000,
  nudges: { stop: Empty },
  // A broadcast stream the creator can steer with a 'stop' nudge — the
  // generator runs on the creator's connection, so its nudge ends the
  // fan-out for every subscribed peer, not just the creator.
  async *run(ctx) {
    for (let i = 1; i <= 20; i += 1) {
      const nudges = ctx.stream.nudges(yield { token: `t${i}` });
      if (nudges.some((n) => n.event === 'stop')) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  },
});

export const streamDurableBroadcastHandler = base.assemble(
  handleFeed,
  handlePaginate,
  handleAttemptBroadcast,
  handleFeedNudged,
);

export type StreamDurableBroadcastClient = InferClient<typeof streamDurableBroadcastHandler>;

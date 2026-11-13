import { server } from '@livething/server';
import { channels } from '@livething/server/channels';
import { recordedStream } from '@livething/server/streams';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import { requireUsername } from '../_shared/authenticate.ts';

const Empty = v.object({});

const base = server({
  authenticate: (request) => requireUsername(request),
  capabilities: [channels(), recordedStream()],
});

const rooms = base.channel('rooms', { membership: 'persistent' });

const handleFeed = rooms.recordedStream('feed', {
  input: Empty,
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

const handleFeedNudged = rooms.recordedStream('feed-nudged', {
  input: Empty,
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

export const streamDurableBroadcastDefinition = base.assemble({
  handlers: [handleFeed, handleFeedNudged],
});

export type StreamDurableBroadcastClient = InferClient<typeof streamDurableBroadcastDefinition>;

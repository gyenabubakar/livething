import {
  channel,
  contract,
  implement,
  nudge,
  recordedStream,
  resumableStream,
  t,
} from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const Empty = v.object({});
const TokenChunk = v.object({ token: v.string() });
const RowChunk = v.object({ row: v.number() });
const AttemptChunk = v.object({ attempt: v.number() });

export const streamDurableBroadcastContract = contract('stream-durable-broadcast', {
  env: t<Env>(),
  persistence: true,
  meta: t<{ username: string }>(),
  definitions: [
    channel('rooms', {
      definitions: [
        recordedStream('feed', {
          payload: Empty,
          chunk: TokenChunk,
          broadcast: true,
          maxChunks: 100,
          maxAgeMs: 60_000,
          retentionAfterEndMs: 30_000,
        }),
        resumableStream('paginate', {
          payload: Empty,
          chunk: RowChunk,
          broadcast: true,
          maxChunks: 100,
          maxAgeMs: 60_000,
          retentionAfterEndMs: 30_000,
        }),
        resumableStream('attempt-broadcast', {
          payload: Empty,
          chunk: AttemptChunk,
          broadcast: true,
          maxChunks: 100,
          maxAgeMs: 60_000,
          retentionAfterEndMs: 30_000,
        }),
        recordedStream('feed-nudged', {
          payload: Empty,
          chunk: TokenChunk,
          broadcast: true,
          maxChunks: 100,
          maxAgeMs: 60_000,
          retentionAfterEndMs: 30_000,
          nudges: [nudge('stop', Empty)],
        }),
      ],
    }),
  ],
});

export const streamDurableBroadcastHandler = implement(streamDurableBroadcastContract)
  .onUpgrade((request) => requireUsername(request))

  .channel('rooms', (ch) =>
    ch
      .recordedStream('feed', async function* () {
        for (let i = 1; i <= 5; i += 1) {
          yield { token: `t${i}` };
          await new Promise((r) => setTimeout(r, 250));
        }
      })
      .resumableStream('paginate', async function* (ctx) {
        const startAt = (ctx.stream.cursor as { idx: number } | null)?.idx ?? 0;
        for (let i = startAt + 1; i <= 10; i += 1) {
          yield ctx.stream.withCursor({ row: i }, { idx: i });
          await new Promise((r) => setTimeout(r, 250));
        }
      })
      .resumableStream('attempt-broadcast', async function* (ctx) {
        yield ctx.stream.withCursor({ attempt: ctx.stream.attempt }, { idx: 1 });
        await new Promise((r) => setTimeout(r, 60_000));
      })
      .recordedStream('feed-nudged', async function* (ctx) {
        // A broadcast stream the creator can steer with a 'stop' nudge — the
        // generator runs on the creator's connection, so its nudge ends the
        // fan-out for every subscribed peer, not just the creator.
        for (let i = 1; i <= 20; i += 1) {
          const nudges = ctx.nudges(yield { token: `t${i}` });
          if (nudges.some((n: { event: string }) => n.event === 'stop')) return;
          await new Promise((r) => setTimeout(r, 100));
        }
      }),
  )

  .build();

export type StreamDurableBroadcastClient = InferClient<typeof streamDurableBroadcastHandler>;

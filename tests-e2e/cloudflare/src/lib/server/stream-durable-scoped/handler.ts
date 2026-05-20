import {
  channel,
  contract,
  implement,
  namespace,
  nudge,
  recordedStream,
  resumableStream,
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

export const streamDurableScopedContract = contract<Env>('stream-durable-scoped')({
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
      ],
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
      ],
    }),
  ],
});

export const streamDurableScopedHandler = implement(streamDurableScopedContract)
  .onUpgrade((request) => requireUsername(request))

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
      }),
  )

  .namespace('v1', (ns) =>
    ns.recordedStream('logs', async function* () {
      for (let i = 1; i <= 5; i += 1) {
        yield { line: `line-${i}` };
        await new Promise((r) => setTimeout(r, 150));
      }
    }),
  )

  .build();

export type StreamDurableScopedClient = InferClient<typeof streamDurableScopedHandler>;

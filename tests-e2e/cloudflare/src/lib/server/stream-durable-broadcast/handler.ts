import { channel, contract, implement, recordedStream, resumableStream, t } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const Empty = v.object({});
const TokenChunk = v.object({ token: v.string() });
const RowChunk = v.object({ row: v.number() });

export const streamDurableBroadcastContract = contract<Env>('stream-durable-broadcast')({
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
      }),
  )

  .build();

export type StreamDurableBroadcastClient = InferClient<typeof streamDurableBroadcastHandler>;

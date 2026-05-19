import { contract, implement, recordedStream, resumableStream, t } from '@wskit/server';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const CountTokensPayload = v.object({});
const TokenChunk = v.object({ idx: v.number() });
const PaginatePayload = v.object({});
const RowChunk = v.object({ row: v.number() });

export const durableStreamContract = contract<Env>('durable-stream')({
  persistence: true,
  meta: t<{ username: string }>(),
  definitions: [
    // Recorded: framework buffers each chunk. On reconnect, replay missed
    // chunks then send _streamEnd. Models an LLM token stream.
    recordedStream('count-tokens', {
      payload: CountTokensPayload,
      chunk: TokenChunk,
      maxChunks: 100,
      maxAgeMs: 60_000,
      retentionAfterEndMs: 30_000,
    }),

    // Resumable: framework re-invokes the generator on resume, passing the
    // stored cursor. Models DB pagination.
    resumableStream('paginate', {
      payload: PaginatePayload,
      chunk: RowChunk,
      maxAgeMs: 60_000,
      retentionAfterEndMs: 30_000,
    }),
  ],
});

export const durableStreamHandler = implement(durableStreamContract)
  .onUpgrade((request) => requireUsername(request))

  // Emit 5 chunks slowly enough that an e2e test can drop the socket
  // mid-flight after one or two chunks arrive.
  .recordedStream('count-tokens', async function* () {
    for (let i = 1; i <= 5; i += 1) {
      yield { idx: i };
      await new Promise((r) => setTimeout(r, 400));
    }
  })

  // Yield rows 1..10 with a cursor on each so resume re-runs from the
  // saved cursor. The slow gap makes mid-stream drop possible.
  .resumableStream('paginate', async function* (ctx) {
    const startAt = (ctx.stream.cursor as { idx: number } | null)?.idx ?? 0;
    for (let i = startAt + 1; i <= 10; i += 1) {
      yield ctx.stream.withCursor({ row: i }, { idx: i });
      await new Promise((r) => setTimeout(r, 400));
    }
  })

  .build();

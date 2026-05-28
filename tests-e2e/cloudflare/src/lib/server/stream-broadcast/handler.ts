import { channel, contract, implement, scope, stream, t } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const BroadcastChunkSchema = v.object({ index: v.number() });
const RoomBroadcastChunkSchema = v.object({ index: v.number() });

export const streamBroadcastContract = contract('stream-broadcast', {
  env: t<Env>(),
  meta: t<{ username: string }>(),
  definitions: [
    stream('start-broadcast', {
      payload: v.object({ count: v.number() }),
      chunk: BroadcastChunkSchema,
      broadcast: true,
    }),
    channel(scope('rooms', /^room:.+$/), {
      definitions: [
        stream('start-room-broadcast', {
          payload: v.object({ count: v.number() }),
          chunk: RoomBroadcastChunkSchema,
          broadcast: true,
        }),
        stream('start-room-stream', {
          payload: v.object({ count: v.number() }),
          chunk: RoomBroadcastChunkSchema,
        }),
      ],
    }),
  ],
});

export const streamBroadcastHandler = implement(streamBroadcastContract)
  .onUpgrade((req) => requireUsername(req))
  .stream('start-broadcast', async function* (_ctx, payload) {
    for (let i = 0; i < payload.count; i++) {
      yield { index: i };
      await new Promise((r) => setTimeout(r, 10));
    }
  })
  .channel('rooms', (ch) =>
    ch
      .stream('start-room-broadcast', async function* (_ctx, payload) {
        for (let i = 0; i < payload.count; i++) {
          yield { index: i };
          await new Promise((r) => setTimeout(r, 10));
        }
      })
      .stream('start-room-stream', async function* (_ctx, payload) {
        for (let i = 0; i < payload.count; i++) {
          yield { index: i };
          await new Promise((r) => setTimeout(r, 100));
        }
      }),
  )
  .build();

export type StreamBroadcastClient = InferClient<typeof streamBroadcastHandler>;

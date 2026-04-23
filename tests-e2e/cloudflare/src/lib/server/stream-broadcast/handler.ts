import { event, server } from '@wskit/server';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withStreams } from '@wskit/server/streams';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const StartBroadcast = event('start-broadcast', v.object({ count: v.number() }));
const BroadcastChunkSchema = v.object({ index: v.number() });

export const streamBroadcastHandler = withStreams(withLifecycle(server<Env>('stream-broadcast')))
  .onUpgrade((request) => requireUsername(request))
  .stream(StartBroadcast, (s) =>
    s
      .chunk(BroadcastChunkSchema)
      .broadcast()
      .generate(async function* (_ctx, payload) {
        for (let i = 0; i < payload.count; i++) {
          yield { index: i };
          await new Promise((r) => setTimeout(r, 10));
        }
      }),
  )
  .build();

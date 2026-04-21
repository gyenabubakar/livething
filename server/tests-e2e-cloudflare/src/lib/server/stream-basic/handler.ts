import { event, server } from '@wskit/server';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withStreams } from '@wskit/server/streams';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const StartStream = event('start-stream', v.object({ count: v.number() }));
const StreamChunkSchema = v.object({ index: v.number() });

export const streamBasicHandler = withStreams(withLifecycle(server<Env>('stream-basic')))
  .onUpgrade((request) => requireUsername(request))
  .stream(StartStream, StreamChunkSchema, (s) =>
    s.generate(async function* (_ctx, payload) {
      for (let i = 0; i < payload.count; i++) {
        yield { index: i };
        await new Promise((r) => setTimeout(r, 10));
      }
    }),
  )
  .build();

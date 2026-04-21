import { event, server } from '@wskit/server';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withStreams } from '@wskit/server/streams';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const StartStream = event('start-stream', v.object({ count: v.number() }));
const StreamChunkSchema = v.object({ index: v.number() });
const Stop = event('stop', v.object({}));

export const streamNudgesHandler = withStreams(withLifecycle(server<Env>('stream-nudges')))
  .onUpgrade((request) => requireUsername(request))
  .stream(StartStream, StreamChunkSchema, (s) =>
    s.nudge(Stop).generate(async function* (ctx, payload) {
      for (let i = 0; i < payload.count; i++) {
        const nudges = ctx.nudges(yield { index: i });
        if (nudges.some((n) => n.event === 'stop')) break;
        await new Promise((r) => setTimeout(r, 10));
      }
    }),
  )
  .build();

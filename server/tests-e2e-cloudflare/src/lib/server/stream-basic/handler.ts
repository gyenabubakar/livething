import { event, server } from '@wskit/server';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withStreams } from '@wskit/server/streams';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const StartTokens = event('start-tokens', v.object({ count: v.number() }));
const StartBoom = event('start-boom', v.object({}));
const Token = v.object({ index: v.number() });

export const streamBasicHandler = withStreams(withLifecycle(server<Env>('stream-basic')))
  .onUpgrade((request) => requireUsername(request))
  .stream(StartTokens, Token, (s) =>
    s.generate(async function* (_ctx, payload) {
      for (let i = 0; i < payload.count; i++) {
        yield { index: i };
        // 75ms pacing so a count=10 stream takes ~750ms; plenty of window
        // for a client _streamCancel to land before completion even under
        // parallel load.
        await new Promise((r) => setTimeout(r, 75));
      }
    }),
  )
  .stream(StartBoom, Token, (s) =>
    s.generate(async function* () {
      yield { index: 0 };
      await new Promise((r) => setTimeout(r, 20));
      throw new Error('boom');
    }),
  )
  .build();

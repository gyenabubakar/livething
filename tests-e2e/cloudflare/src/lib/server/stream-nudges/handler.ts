import { contract, implement, incoming, nudge, outgoing, stream, t } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const Token = v.object({ token: v.string() });

export const streamNudgesContract = contract<Env>('stream-nudges')({
  dedup: true,
  meta: t<{ username: string }>(),
  definitions: [
    incoming('pause', v.object({ leak: v.optional(v.string()) })),
    outgoing('pause-top-level-fired', v.object({ leak: v.string() })),
    outgoing('nudge-saw', v.object({ events: v.array(v.string()) })),

    stream('start-nudge-stream', {
      payload: v.object({ prompt: v.string() }),
      chunk: Token,
      nudges: [
        nudge('pause', v.strictObject({})),
        nudge('speed-up', v.object({ factor: v.number() })),
      ],
    }),
  ],
});

export const streamNudgesHandler = implement(streamNudgesContract)
  .onUpgrade((req) => requireUsername(req))
  .on('pause', (ctx, payload) => {
    ctx.send('pause-top-level-fired', { leak: payload.leak ?? '<empty>' });
  })
  .stream('start-nudge-stream', async function* (ctx, payload) {
    const words = payload.prompt.split(' ');
    let delay = 50;
    for (const word of words) {
      const nudges = ctx.nudges(yield { token: word + ' ' });
      if (nudges.length > 0) {
        ctx.send('nudge-saw', { events: nudges.map((n) => n.event) });
      }
      if (nudges.some((n) => n.event === 'pause')) return;
      const speedUp = nudges.find((n) => n.event === 'speed-up');
      if (
        speedUp &&
        typeof speedUp.payload === 'object' &&
        speedUp.payload &&
        'factor' in speedUp.payload
      ) {
        delay = Math.max(1, delay / (speedUp.payload as { factor: number }).factor);
      }
      await new Promise((r) => setTimeout(r, delay));
    }
  })
  .build();

export type StreamNudgesClient = InferClient<typeof streamNudgesHandler>;

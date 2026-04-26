import { event, server } from '@wskit/server';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withStreams } from '@wskit/server/streams';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const StartNudgeStream = event('start-nudge-stream', v.object({ prompt: v.string() }));
const Token = v.object({ token: v.string() });
const PauseNudge = event('pause', v.object({}));
const SpeedUpNudge = event('speed-up', v.object({ factor: v.number() }));

const base = withStreams(withLifecycle(server<Env>('stream-nudges'))).onUpgrade((request) =>
  requireUsername(request),
);

const nudgeStream = base.stream(StartNudgeStream, (s) =>
  s
    .chunk(Token)
    .nudge(PauseNudge)
    .nudge(SpeedUpNudge)
    .generate(async function* (ctx, payload) {
      const words = payload.prompt.split(' ');
      let delay = 50;
      for (const word of words) {
        const nudges = ctx.nudges(yield { token: word + ' ' });
        if (nudges.some((n) => n.event === 'pause')) return;
        const speedUp = nudges.find((n) => n.event === 'speed-up');
        if (speedUp && 'factor' in speedUp.payload) {
          delay = Math.max(1, delay / speedUp.payload.factor);
        }
        await new Promise((r) => setTimeout(r, delay));
      }
    }),
);

export const streamNudgesHandler = base.use(nudgeStream).build();

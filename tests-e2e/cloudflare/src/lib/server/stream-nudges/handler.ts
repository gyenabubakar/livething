import { event, server } from '@wskit/server';
import { withDedup } from '@wskit/server/dedup';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withStreams } from '@wskit/server/streams';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const StartNudgeStream = event('start-nudge-stream', v.object({ prompt: v.string() }));
const Token = v.object({ token: v.string() });
// Strict schema so a payload with extra keys (besides the stripped
// `_streamId`) fails nudge validation. Used by the e2e test that pins
// "malformed nudges do not fall through to top-level dispatch".
const PauseNudge = event('pause', v.strictObject({}));
const SpeedUpNudge = event('speed-up', v.object({ factor: v.number() }));

// Top-level handler with the SAME event name as the nudge. Pre-fix, a
// malformed pause nudge fell through to dispatchIncoming and would have
// fired this handler with the malformed payload. Post-fix the nudge path
// returns "handled (with error)" and dispatch is skipped.
const PauseTopLevel = event('pause', v.object({ leak: v.optional(v.string()) }));
const PauseTopLevelFired = event('pause-top-level-fired', v.object({ leak: v.string() }));

// Server reports how many nudges were drained per generator iteration.
// Used by the dedup pin: duplicate-_messageId nudges must be coalesced
// before they reach the active stream buffer, so the count is one even
// if the client sent the frame twice.
const NudgeSaw = event('nudge-saw', v.object({ events: v.array(v.string()) }));

const base = withStreams(withLifecycle(withDedup(server<Env>('stream-nudges'))))
  .dedup()
  .onUpgrade((request) => requireUsername(request))
  .outgoing(PauseTopLevelFired)
  .outgoing(NudgeSaw)
  .incoming(PauseTopLevel, (ctx, payload) => {
    ctx.send('pause-top-level-fired', { leak: payload.leak ?? '<empty>' });
  });

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
        if (nudges.length > 0) {
          ctx.send('nudge-saw', { events: nudges.map((n) => n.event) });
        }
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

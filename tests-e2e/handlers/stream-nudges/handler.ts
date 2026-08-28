import { define, emits, errors, t } from '@wskit/server';
import { dedup } from '@wskit/server/dedup';
import { error } from '@wskit/server/errors';
import { intercepts } from '@wskit/server/intercepts';
import { stream } from '@wskit/server/streams';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const Token = t<{ token: string }>();
const overflowGates = new Map<string, () => void>();

// A typed error a nudge intercept can throw. The client must see nudge() reject
// with this code while the stream keeps running (regression: a thrown nudge
// intercept used to terminate the stream and hang the nudge() Promise).
export const NudgeRejected = error('nudge-rejected');

const base = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [
    dedup(),
    errors([NudgeRejected]),
    emits({
      'pause-top-level-fired': t<{ leak: string }>(),
      'nudge-saw': t<{ events: string[] }>(),
    }),
    stream(),
    intercepts(),
  ],
});

// A speed-up nudge with factor 0 is rejected by the intercept with a typed
// error. Everything else passes through untouched, so the other nudge tests
// are unaffected.
base.intercept((ctx, frame) => {
  if (frame.kind === 'nudge' && frame.event === 'speed-up') {
    const p = frame.payload as { factor?: number };
    if (p.factor === 0) throw NudgeRejected();
  }
});

const handlePause = base.on('pause', {
  input: v.object({ leak: v.optional(v.string()) }),
  run(ctx, input) {
    ctx.send('pause-top-level-fired', { leak: input.leak ?? '<empty>' });
  },
});

const handleReleaseOverflow = base.on('release-overflow', {
  input: v.object({}),
  run(ctx) {
    overflowGates.get(ctx.connection.id)?.();
  },
});

const handleStartNudgeStream = base.stream('start-nudge-stream', {
  input: v.object({ prompt: v.string() }),
  chunk: Token,
  nudges: {
    pause: v.strictObject({}),
    'speed-up': v.object({ factor: v.number() }),
  },
  async *run(ctx, input) {
    if (input.prompt === '__hold-overflow__') {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      overflowGates.set(ctx.connection.id, release);
      try {
        await gate;
      } finally {
        overflowGates.delete(ctx.connection.id);
      }
    }

    const words = input.prompt.split(' ');
    let delay = 50;
    for (const word of words) {
      const nudges = ctx.stream.nudges(yield { token: word + ' ' });
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
  },
});

export const streamNudgesHandler = base.assemble({
  handlers: [handlePause, handleReleaseOverflow, handleStartNudgeStream],
});

export type StreamNudgesClient = InferClient<typeof streamNudgesHandler>;

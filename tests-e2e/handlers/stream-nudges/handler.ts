import { emits, errors, server, t } from '@livething/server';
import { dedup } from '@livething/server/dedup';
import { error } from '@livething/server/errors';
import { stream } from '@livething/server/streams';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import { requireUsername } from '../_shared/authenticate.ts';

const overflowGates = new Map<string, () => void>();

// A typed error a nudge intercept can throw. The client must see nudge() reject
// with this code while the stream keeps running.
export const NudgeRejected = error('nudge-rejected');

const base = server({
  authenticate: (request) => requireUsername(request),
  capabilities: [
    dedup(),
    errors([NudgeRejected]),
    emits({
      'held-stream-released': t<{}>(),
      'pause-top-level-fired': t<{ leak: string }>(),
      'nudge-saw': t<{ events: string[] }>(),
    }),
    stream(),
  ],
  // A speed-up nudge with factor 0 is rejected by the intercept with a typed
  // error. Everything else passes through untouched, so the other nudge tests
  // are unaffected.
  intercept(ctx, frame) {
    if (frame.kind === 'nudge' && frame.event === 'speed-up') {
      const p = frame.payload as { factor?: number };
      if (p.factor === 0) throw NudgeRejected();
    }
  },
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
  nudges: {
    pause: v.strictObject({}),
    'speed-up': v.object({ factor: v.number() }),
  },
  async *run(ctx, input) {
    if (input.prompt === '__hold-overflow__') {
      const signal = ctx.stream.signal;
      const gate = new Promise<void>((resolve) => {
        function complete(): void {
          signal.removeEventListener('abort', complete);
          resolve();
        }

        overflowGates.set(ctx.connection.id, complete);
        if (signal.aborted) {
          complete();
        } else {
          signal.addEventListener('abort', complete, { once: true });
        }
      });
      try {
        await gate;
      } finally {
        overflowGates.delete(ctx.connection.id);
        ctx.send('held-stream-released', {});
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

export const streamNudgesDefinition = base.assemble({
  handlers: [handlePause, handleReleaseOverflow, handleStartNudgeStream],
});

export type StreamNudgesClient = InferClient<typeof streamNudgesDefinition>;

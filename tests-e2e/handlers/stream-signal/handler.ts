import { emits, server, t } from '@wskit/server';
import { stream } from '@wskit/server/streams';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const Tick = t<{ index: number }>();

const base = server({
  upgrade: (request) => requireUsername(request),
  capabilities: [
    stream(),
    emits({
      // Sent from the stream's abort path so a client can prove ctx.stream.signal
      // fired (and the slow awaited work was interrupted, not run to completion).
      'signal-fired': t<{ aborted: boolean; reason: string; ranToCompletion: boolean }>(),
    }),
  ],
});

/**
 * Yields one tick, then awaits a long timer wired to `ctx.stream.signal`. When
 * the signal fires (client cancel), the await rejects early, the timer is
 * cleared, and the abort path emits `signal-fired` proving the signal worked.
 */
const handleSlowSignal = base.stream('slow-signal', {
  input: v.object({}),
  chunk: Tick,
  async *run(ctx) {
    const signal = ctx.stream.signal;
    let ranToCompletion = false;

    yield { index: 0 };

    try {
      // A 60s timer that the signal aborts. If the signal never fired this would
      // hold the stream open far beyond the test — proving abort interrupts it.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          ranToCompletion = true;
          resolve();
        }, 60_000);
        if (signal.aborted) {
          clearTimeout(timer);
          reject(new Error('aborted'));
          return;
        }

        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });
    } catch {
      // Swallow the abort rejection — the finally reports the outcome.
    } finally {
      // The connection is still open on a client cancel, so this emit lands.
      ctx.send('signal-fired', {
        aborted: signal.aborted,
        reason: typeof signal.reason === 'string' ? signal.reason : String(signal.reason),
        ranToCompletion,
      });
    }
  },
});

export const streamSignalDefinition = base.assemble({ handlers: [handleSlowSignal] });

export type StreamSignalClient = InferClient<typeof streamSignalDefinition>;

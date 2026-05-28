import {
  channel,
  contract,
  implement,
  incoming,
  matches,
  namespace,
  nudge,
  outgoing,
  scope,
  stream,
  t,
} from '@wskit/server';
import { Block } from '@wskit/server/errors';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const EchoPayload = v.object({ text: v.string() });
const EchoedPayload = v.object({ text: v.string() });
const InterceptedStreamPayload = v.object({ text: v.string() });
const InterceptedStreamChunk = v.object({ text: v.string() });
const NudgeStreamChunk = v.object({ saw: v.string() });
const HintNudgePayload = v.object({ text: v.string() });

export const interceptContract = contract('intercept', {
  env: t<Env>(),
  meta: t<{ username: string }>(),
  definitions: [
    incoming('echo', EchoPayload),
    outgoing('echoed', EchoedPayload),

    // Top-level stream with a nudge — used to verify the intercept pipeline
    // runs for nudge frames before they land in the generator's nudge buffer.
    stream('nudge-stream', {
      payload: v.object({}),
      chunk: NudgeStreamChunk,
      nudges: [nudge('hint', HintNudgePayload)],
    }),

    namespace('ns', {
      definitions: [
        incoming('echo', EchoPayload),
        outgoing('echoed', EchoedPayload),
        stream('intercepted-stream', {
          payload: InterceptedStreamPayload,
          chunk: InterceptedStreamChunk,
        }),
        stream('ns-nudge-stream', {
          payload: v.object({}),
          chunk: NudgeStreamChunk,
          nudges: [nudge('ns-hint', HintNudgePayload)],
        }),
      ],
    }),

    channel('room', {
      definitions: [
        incoming('echo', EchoPayload),
        outgoing('echoed', EchoedPayload),
        stream('ch-nudge-stream', {
          payload: v.object({}),
          chunk: NudgeStreamChunk,
          nudges: [nudge('ch-hint', HintNudgePayload)],
        }),
      ],
    }),

    channel(scope('rooms', /^room:.+$/), {
      definitions: [incoming('echo', EchoPayload), outgoing('echoed', EchoedPayload)],
    }),
  ],
});

export const interceptHandler = implement(interceptContract)
  .onUpgrade((request) => requireUsername(request))
  // Top-level intercept — narrow with matches() so frame.payload is typed.
  .intercept((_ctx, frame) => {
    if (matches(interceptContract, 'echo', frame)) {
      // payload is { text: string } here; no `as` casts needed.
      if (frame.payload.text === 'top-pre') return { text: 'top-pre-rewritten' };
      if (frame.payload.text === 'top-passthrough') return;
    }
    // Nudge frames arrive with kind === 'nudge'. Transform the hint payload so
    // the generator can prove the intercept ran before nudges were buffered.
    if (frame.kind === 'nudge' && frame.event === 'hint') {
      const p = frame.payload as { text: string };
      if (p.text === 'hint-block') throw Block;
      return { text: `${p.text}-intercepted` };
    }
  })
  .stream('nudge-stream', async function* (ctx) {
    // Yield 'started' first so the page knows the stream is live and can send
    // a nudge. Then poll in a short loop so the nudge has time to travel from
    // client to server before the generator drains nudges. Give up after 10
    // iterations so the Block test (where no hint ever arrives) can settle.
    let nudges = ctx.nudges(yield { saw: 'started' });
    let loops = 0;
    while (!nudges.some((n) => n.event === 'hint') && loops < 10) {
      loops++;
      await new Promise((r) => setTimeout(r, 50));
      nudges = ctx.nudges(yield { saw: 'waiting' });
    }
    const hint = nudges.find((n) => n.event === 'hint');
    yield { saw: hint ? (hint.payload as { text: string }).text : 'no-hint' };
  })
  .on('echo', (ctx, payload) => {
    ctx.send('echoed', { text: `top:${payload.text}` });
  })
  .namespace('ns', (ns) =>
    ns
      .intercept((_ctx, frame) => {
        if (matches(interceptContract, '#ns::echo', frame)) {
          if (frame.payload.text === 'ns-pre') return { text: 'ns-pre-rewritten' };
          if (frame.payload.text === 'ns-pre-block') throw Block;
        }
        if (matches(interceptContract, '#ns::intercepted-stream', frame)) {
          return { text: `${frame.payload.text}-rewritten` };
        }
        if (frame.kind === 'nudge' && frame.event === 'ns-hint') {
          const p = frame.payload as { text: string };
          if (p.text === 'ns-hint-block') throw Block;
          return { text: `${p.text}-ns-intercepted` };
        }
      })
      .on('echo', (ctx, payload) => {
        ctx.namespace.send('echoed', { text: `ns:${payload.text}` });
      })
      .stream('intercepted-stream', async function* (_ctx, payload) {
        yield { text: payload.text };
      })
      .stream('ns-nudge-stream', async function* (ctx) {
        let nudges = ctx.nudges(yield { saw: 'started' });
        let loops = 0;
        while (!nudges.some((n: { event: string }) => n.event === 'ns-hint') && loops < 10) {
          loops++;
          await new Promise((r) => setTimeout(r, 50));
          nudges = ctx.nudges(yield { saw: 'waiting' });
        }
        const hint = nudges.find((n: { event: string }) => n.event === 'ns-hint');
        yield { saw: hint ? (hint.payload as { text: string }).text : 'no-hint' };
      }),
  )
  .channel('room', (ch) =>
    ch
      .intercept((_ctx, frame) => {
        if (matches(interceptContract, '@room::echo', frame)) {
          if (frame.payload.text === 'ch-pre') return { text: 'ch-pre-rewritten' };
          if (frame.payload.text === 'ch-pre-block') throw Block;
        }
        if (frame.kind === 'nudge' && frame.event === 'ch-hint') {
          const p = frame.payload as { text: string };
          if (p.text === 'ch-hint-block') throw Block;
          return { text: `${p.text}-ch-intercepted` };
        }
      })
      .on('echo', (ctx, payload) => {
        ctx.channel.send('echoed', { text: `ch:${payload.text}` });
      })
      .stream('ch-nudge-stream', async function* (ctx) {
        let nudges = ctx.nudges(yield { saw: 'started' });
        let loops = 0;
        while (!nudges.some((n) => n.event === 'ch-hint') && loops < 10) {
          loops++;
          await new Promise((r) => setTimeout(r, 50));
          nudges = ctx.nudges(yield { saw: 'waiting' });
        }
        const hint = nudges.find((n) => n.event === 'ch-hint');
        yield { saw: hint ? (hint.payload as { text: string }).text : 'no-hint' };
      }),
  )
  .channel('rooms', (ch) =>
    ch
      .intercept((_ctx, frame) => {
        if (matches(interceptContract, '@rooms::echo', frame)) {
          if (frame.payload.text === 'dyn-pre') return { text: 'dyn-pre-rewritten' };
          if (frame.payload.text === 'dyn-pre-block') throw Block;
        }
      })
      .on('echo', (ctx, payload) => {
        ctx.channel.send('echoed', { text: `dyn:${payload.text}` });
      }),
  )
  .build();

export type InterceptClient = InferClient<typeof interceptHandler>;

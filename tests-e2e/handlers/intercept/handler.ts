import {
  channel,
  contract,
  implement,
  incoming,
  matches,
  nudge,
  outgoing,
  request,
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
const NudgeStreamChunk = v.object({ saw: v.string() });
const HintNudgePayload = v.object({ text: v.string() });
const ReqPayload = v.object({ text: v.string() });
const ReqResponse = v.object({ text: v.string() });

export const interceptContract = contract('intercept', {
  env: t<Env>(),
  meta: t<{ username: string }>(),
  definitions: [
    incoming('echo', EchoPayload),
    outgoing('echoed', EchoedPayload),

    // Top-level request — used to verify the intercept pipeline runs for
    // frame.kind === 'request' and can rewrite the payload before the request
    // handler (and validator) see it.
    request('intercept-req', { payload: ReqPayload, response: ReqResponse }),

    // Top-level stream with a nudge — used to verify the intercept pipeline
    // runs for nudge frames before they land in the generator's nudge buffer.
    stream('nudge-stream', {
      payload: v.object({}),
      chunk: NudgeStreamChunk,
      nudges: [nudge('hint', HintNudgePayload)],
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

    channel(scope('rooms', 'room:{id}'), {
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
    // Request frames arrive with kind === 'request'. matches() narrows the
    // payload so the rewrite is typed; the handler echoes the rewritten value.
    if (matches(interceptContract, 'intercept-req', frame)) {
      if (frame.payload.text === 'req-pre') return { text: 'req-pre-rewritten' };
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
  .request('intercept-req', (ctx, payload) => {
    // The response reflects whatever payload the intercept left behind, so the
    // test can prove the intercept ran by reading the request reply.
    ctx.respond({ text: payload.text });
  })
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

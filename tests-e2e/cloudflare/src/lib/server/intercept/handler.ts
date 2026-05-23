import {
  channel,
  contract,
  implement,
  incoming,
  matches,
  namespace,
  outgoing,
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

export const interceptContract = contract<Env>('intercept')({
  meta: t<{ username: string }>(),
  definitions: [
    incoming('echo', EchoPayload),
    outgoing('echoed', EchoedPayload),

    namespace('ns', {
      definitions: [
        incoming('echo', EchoPayload),
        outgoing('echoed', EchoedPayload),
        stream('intercepted-stream', {
          payload: InterceptedStreamPayload,
          chunk: InterceptedStreamChunk,
        }),
      ],
    }),

    channel('room', {
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
      })
      .on('echo', (ctx, payload) => {
        ctx.namespace.send('echoed', { text: `ns:${payload.text}` });
      })
      .stream('intercepted-stream', async function* (_ctx, payload) {
        yield { text: payload.text };
      }),
  )
  .channel('room', (ch) =>
    ch
      .intercept((_ctx, frame) => {
        if (matches(interceptContract, '@room::echo', frame)) {
          if (frame.payload.text === 'ch-pre') return { text: 'ch-pre-rewritten' };
          if (frame.payload.text === 'ch-pre-block') throw Block;
        }
      })
      .on('echo', (ctx, payload) => {
        ctx.channel.send('echoed', { text: `ch:${payload.text}` });
      }),
  )
  .build();

export type InterceptClient = InferClient<typeof interceptHandler>;

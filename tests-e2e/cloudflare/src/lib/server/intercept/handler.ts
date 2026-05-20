import {
  channel,
  contract,
  implement,
  incoming,
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
  .intercept((_ctx, message) => {
    if (message.event === 'echo' && message.payload && typeof message.payload === 'object') {
      const text = (message.payload as { text?: string }).text;
      if (text === 'top-pre') return { text: 'top-pre-rewritten' };
      if (text === 'top-passthrough') return;
    }
  })
  .intercept('echo', (_ctx, payload) => {
    if (payload.text === 'top-post') return { text: 'top-post-rewritten' };
    if (payload.text === 'top-post-passthrough') return undefined;
    if (payload.text === 'top-post-block') throw Block;
    return payload;
  })
  .on('echo', (ctx, payload) => {
    ctx.send('echoed', { text: `top:${payload.text}` });
  })
  .namespace('ns', (ns) =>
    ns
      .intercept((_ctx, message) => {
        if (message.event === 'echo' && message.payload && typeof message.payload === 'object') {
          const text = (message.payload as { text?: string }).text;
          if (text === 'ns-pre') return { text: 'ns-pre-rewritten' };
          if (text === 'ns-pre-block') throw Block;
        }
      })
      .intercept('echo', (_ctx, payload) => {
        if (payload.text === 'ns-post') return { text: 'ns-post-rewritten' };
        return payload;
      })
      .intercept('intercepted-stream', (_ctx, payload) => {
        return { text: `${payload.text}-rewritten` };
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
      .intercept((_ctx, message) => {
        if (message.event === 'echo' && message.payload && typeof message.payload === 'object') {
          const text = (message.payload as { text?: string }).text;
          if (text === 'ch-pre') return { text: 'ch-pre-rewritten' };
          if (text === 'ch-pre-block') throw Block;
        }
      })
      .intercept('echo', (_ctx, payload) => {
        if (payload.text === 'ch-post') return { text: 'ch-post-rewritten' };
        return payload;
      })
      .on('echo', (ctx, payload) => {
        ctx.channel.send('echoed', { text: `ch:${payload.text}` });
      }),
  )
  .build();

export type InterceptClient = InferClient<typeof interceptHandler>;

import {
  channel,
  contract,
  implement,
  incoming,
  localKey,
  namespace,
  outgoing,
  t,
} from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const EchoPayload = v.object({ text: v.string() });
const EchoedPayload = v.object({ text: v.string() });

export const TopKey = localKey<{ tag: string }>('top');
export const NsKey = localKey<{ tag: string }>('ns');
export const ChannelKey = localKey<{ tag: string }>('channel');

export const ctxLocalsContract = contract<Env>('ctx-locals')({
  meta: t<{ username: string }>(),
  definitions: [
    incoming('echo', EchoPayload),
    outgoing('echoed', EchoedPayload),
    namespace('ns', {
      definitions: [incoming('echo', EchoPayload), outgoing('echoed', EchoedPayload)],
    }),
    channel('room', {
      definitions: [incoming('echo', EchoPayload), outgoing('echoed', EchoedPayload)],
    }),
  ],
});

export const ctxLocalsHandler = implement(ctxLocalsContract)
  .onUpgrade((request) => requireUsername(request))
  .intercept((ctx) => {
    ctx.provide(TopKey, { tag: 'top' });
  })
  .on('echo', (ctx, payload) => {
    const top = ctx.inject(TopKey);
    const ns = ctx.inject(NsKey);
    ctx.send('echoed', { text: `${payload.text}:${top?.tag ?? 'none'}:${ns?.tag ?? 'none'}` });
  })
  .namespace('ns', (ns) =>
    ns
      .intercept((ctx) => {
        ctx.provide(NsKey, { tag: 'ns' });
      })
      .on('echo', (ctx, payload) => {
        const top = ctx.inject(TopKey);
        const nsk = ctx.inject(NsKey);
        ctx.namespace.send('echoed', {
          text: `${payload.text}:${top?.tag ?? 'none'}:${nsk?.tag ?? 'none'}`,
        });
      }),
  )
  .channel('room', (ch) =>
    ch
      .intercept((ctx) => {
        ctx.provide(ChannelKey, { tag: 'channel' });
      })
      .on('echo', (ctx, payload) => {
        const top = ctx.inject(TopKey);
        const chk = ctx.inject(ChannelKey);
        ctx.channel.send('echoed', {
          text: `${payload.text}:${top?.tag ?? 'none'}:${chk?.tag ?? 'none'}`,
        });
      }),
  )
  .build();

export type CtxLocalsClient = InferClient<typeof ctxLocalsHandler>;

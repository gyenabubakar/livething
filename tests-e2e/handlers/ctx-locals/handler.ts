import {
  channel,
  contract,
  implement,
  incoming,
  localKey,
  outgoing,
  request,
  t,
} from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const EchoPayload = v.object({ text: v.string() });
const EchoedPayload = v.object({ text: v.string() });
const LookupPayload = v.object({ text: v.string() });
const LookupResponse = v.object({ text: v.string() });

export const TopKey = localKey<{ tag: string }>('top');
export const NsKey = localKey<{ tag: string }>('ns');
export const ChannelKey = localKey<{ tag: string }>('channel');

export const ctxLocalsContract = contract('ctx-locals', {
  env: t<Env>(),
  meta: t<{ username: string }>(),
  definitions: [
    incoming('echo', EchoPayload),
    outgoing('echoed', EchoedPayload),
    request('lookup', { payload: LookupPayload, response: LookupResponse }),
    channel('room', {
      definitions: [
        incoming('echo', EchoPayload),
        outgoing('echoed', EchoedPayload),
        request('lookup', { payload: LookupPayload, response: LookupResponse }),
      ],
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
  .request('lookup', (ctx, payload) => {
    const top = ctx.inject(TopKey);
    const ns = ctx.inject(NsKey);
    ctx.respond({ text: `${payload.text}:${top?.tag ?? 'none'}:${ns?.tag ?? 'none'}` });
  })
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
      })
      .request('lookup', (ctx, payload) => {
        const top = ctx.inject(TopKey);
        const chk = ctx.inject(ChannelKey);
        ctx.respond({ text: `${payload.text}:${top?.tag ?? 'none'}:${chk?.tag ?? 'none'}` });
      }),
  )
  .build();

export type CtxLocalsClient = InferClient<typeof ctxLocalsHandler>;

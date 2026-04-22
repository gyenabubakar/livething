import { event, server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { Block } from '@wskit/server/errors';
import { withIntercept } from '@wskit/server/intercept';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withNamespaces } from '@wskit/server/namespaces';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const Echo = event('echo', v.object({ text: v.string() }));
const Echoed = event('echoed', v.object({ text: v.string() }));

const base = withChannels(withNamespaces(withIntercept(withLifecycle(server<Env>('intercept')))))
  .outgoing(Echoed)
  .onUpgrade((request) => requireUsername(request))
  // Top-level pre-intercept: runs before validation. wskit allows at most ONE
  // pre-intercept per scope — all text-based rewrites are dispatched here.
  .intercept((_ctx, message) => {
    if (message.event === 'echo' && message.payload && typeof message.payload === 'object') {
      const text = (message.payload as { text?: string }).text;
      if (text === 'top-pre') return { ...message, payload: { text: 'top-pre-rewritten' } };
      if (text === 'top-passthrough') return; // void → pass through unchanged
    }
    return message;
  })
  // Top-level post-intercept: typed, runs after validation on `echo` only.
  // wskit allows at most ONE post-intercept per event per scope — all Echo
  // rewrites + Block branch are dispatched here.
  .intercept(Echo, (_ctx, payload) => {
    if (payload.text === 'top-post') return { text: 'top-post-rewritten' };
    if (payload.text === 'top-post-passthrough') return undefined;
    if (payload.text === 'top-post-block') throw Block;
    return payload;
  })
  .incoming(Echo, (ctx, payload) => {
    ctx.send('echoed', { text: `top:${payload.text}` });
  });

const nsIntercept = base.namespace('ns', (n) =>
  n
    .outgoing(Echoed)
    .intercept((_ctx, message) => {
      if (
        message.event === 'echo' &&
        message.payload &&
        typeof message.payload === 'object' &&
        (message.payload as { text?: string }).text === 'ns-pre'
      ) {
        return { ...message, payload: { text: 'ns-pre-rewritten' } };
      }
      return message;
    })
    .intercept(Echo, (_ctx, payload) => {
      if (payload.text === 'ns-post') return { text: 'ns-post-rewritten' };
      return payload;
    })
    .incoming(Echo, (ctx, payload) => {
      ctx.namespace.send('echoed', { text: `ns:${payload.text}` });
    }),
);

const chIntercept = base.channel('room', (c) =>
  c
    .outgoing(Echoed)
    .intercept((_ctx, message) => {
      if (
        message.event === 'echo' &&
        message.payload &&
        typeof message.payload === 'object' &&
        (message.payload as { text?: string }).text === 'ch-pre'
      ) {
        return { ...message, payload: { text: 'ch-pre-rewritten' } };
      }
      return message;
    })
    .intercept(Echo, (_ctx, payload) => {
      if (payload.text === 'ch-post') return { text: 'ch-post-rewritten' };
      return payload;
    })
    .incoming(Echo, (ctx, payload) => {
      ctx.channel.send('echoed', { text: `ch:${payload.text}` });
    }),
);

export const interceptHandler = base.use(nsIntercept).use(chIntercept).build();

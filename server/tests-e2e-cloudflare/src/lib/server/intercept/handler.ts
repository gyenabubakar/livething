import { event, server } from '@wskit/server';
import { Block, Skip } from '@wskit/server/errors';
import { withIntercept } from '@wskit/server/intercept';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const Echo = event('echo', v.object({ text: v.string() }));
const Echoed = event('echoed', v.object({ text: v.string() }));
const BlockMe = event('block-me', v.object({}));
const SkipMe = event('skip-me', v.object({}));
const Leaked = event('leaked', v.object({}));

export const interceptHandler = withIntercept(withLifecycle(server<Env>('intercept')))
  .outgoing(Echoed)
  .outgoing(Leaked)
  .onUpgrade((request) => requireUsername(request))
  .intercept((_ctx, message) => {
    if (message.event === 'block-me') throw Block;
    if (message.event === 'skip-me') throw Skip;
    return message;
  })
  .intercept(Echo, (_ctx, payload) => {
    if (payload.text === 'rewrite-me') return { ...payload, text: 'rewritten' };
    return payload;
  })
  .incoming(Echo, (ctx, payload) => {
    ctx.send('echoed', { text: payload.text });
  })
  .incoming(BlockMe, (ctx) => {
    ctx.send('leaked', {});
  })
  .incoming(SkipMe, (ctx) => {
    ctx.send('leaked', {});
  })
  .build();

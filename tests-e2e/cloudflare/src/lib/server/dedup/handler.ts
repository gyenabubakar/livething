import { event, server } from '@wskit/server';
import { withDedup } from '@wskit/server/dedup';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const DoEcho = event('do-echo', v.object({ text: v.string() }));
const Echoed = event('echoed', v.object({ text: v.string() }));

export const dedupHandler = withDedup(withLifecycle(server<Env>('dedup')))
  .dedup()
  .outgoing(Echoed)
  .onUpgrade((request) => requireUsername(request))
  .incoming(DoEcho, (ctx, payload) => {
    ctx.send('echoed', { text: payload.text });
  })
  .build();

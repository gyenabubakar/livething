import { event, server } from '@wskit/server';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const WhoAmI = event('who-am-i', v.object({}));
const WhoAmIResult = event('who-am-i-result', v.object({ username: v.string() }));

export const ctxMetaHandler = withLifecycle(server<Env>('ctx-meta'))
  .outgoing(WhoAmIResult)
  .onUpgrade((request) => requireUsername(request))
  .incoming(WhoAmI, (ctx) => {
    ctx.send('who-am-i-result', { username: ctx.meta.username });
  })
  .build();

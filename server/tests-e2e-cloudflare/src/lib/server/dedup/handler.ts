import { event, server } from '@wskit/server';
import { withDedup } from '@wskit/server/dedup';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const Increment = event('increment', v.object({}));
const Count = event('count', v.object({ value: v.number() }));

let counter = 0;

export const dedupHandler = withDedup(withLifecycle(server<Env>('dedup')))
  .dedup()
  .outgoing(Count)
  .onUpgrade((request) => requireUsername(request))
  .incoming(Increment, (ctx) => {
    counter++;
    ctx.send('count', { value: counter });
  })
  .build();

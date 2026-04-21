import { event, server } from '@wskit/server';
import { withHibernation } from '@wskit/server/hibernation';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const Ping = event('ping', v.object({}));
const Pong = event('pong', v.object({}));

export const hibernationHandler = withHibernation(withLifecycle(server<Env>('hibernation')))
  .hibernation()
  .outgoing(Pong)
  .onUpgrade((request) => requireUsername(request))
  .incoming(Ping, (ctx) => {
    ctx.send('pong', {});
  })
  .build();

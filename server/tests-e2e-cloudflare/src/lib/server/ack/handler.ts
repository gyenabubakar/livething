import { event, server } from '@wskit/server';
import { withAck } from '@wskit/server/ack';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const Ping = event('ping', v.object({ n: v.number() }));
const Pong = event('pong', v.object({ n: v.number() }));

export const ackHandler = withLifecycle(withAck(server<Env>('ack')))
  .ack()
  .outgoing(Pong)
  .onUpgrade((request) => requireUsername(request))
  .incoming(Ping, (ctx, payload) => {
    ctx.send('pong', { n: payload.n });
  })
  .build();

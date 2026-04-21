import { event, server } from '@wskit/server';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withSequence } from '@wskit/server/sequence';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const Ping = event('ping', v.object({}));
const Pong = event('pong', v.object({ n: v.number() }));

let counter = 0;

export const sequenceHandler = withSequence(withLifecycle(server<Env>('sequence')))
  .sequence()
  .outgoing(Pong)
  .onUpgrade((request) => requireUsername(request))
  .incoming(Ping, (ctx) => {
    counter++;
    ctx.send('pong', { n: counter });
  })
  .build();

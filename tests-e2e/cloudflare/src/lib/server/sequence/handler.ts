import { event, server } from '@wskit/server';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withSequence } from '@wskit/server/sequence';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const Tick = event('tick', v.object({}));
const Tock = event('tock', v.object({}));

export const sequenceHandler = withSequence(withLifecycle(server<Env>('sequence')))
  .sequence()
  .outgoing(Tock)
  .onUpgrade((request) => requireUsername(request))
  .incoming(Tick, (ctx) => {
    ctx.send('tock', {});
  })
  .build();

import { contract, implement, incoming, outgoing, t } from '@wskit/server';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

export const sequenceContract = contract<Env>('sequence')({
  sequence: true,
  meta: t<{ username: string }>(),
  definitions: [incoming('tick', v.object({})), outgoing('tock', v.object({}))],
});

export const sequenceHandler = implement(sequenceContract)
  .onUpgrade((request) => requireUsername(request))
  .on('tick', (ctx) => {
    ctx.send('tock', {});
  })
  .build();

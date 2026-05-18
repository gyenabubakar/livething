import { channel, contract, implement, incoming, outgoing, t } from '@wskit/server';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

export const dedupContract = contract<Env>('dedup')({
  dedup: true,
  meta: t<{ username: string }>(),
  definitions: [
    incoming('do-echo', v.object({ text: v.string() })),
    outgoing('echoed', v.object({ text: v.string() })),

    channel('room', { definitions: [] }),
  ],
});

export const dedupHandler = implement(dedupContract)
  .onUpgrade((request) => requireUsername(request))
  .on('do-echo', (ctx, payload) => {
    ctx.send('echoed', { text: payload.text });
  })
  .channel('room', (ch) => ch)
  .build();

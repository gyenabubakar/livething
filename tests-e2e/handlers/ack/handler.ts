import { contract, implement, incoming, outgoing, t } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

export const ackContract = contract('ack', {
  env: t<Env>(),
  ack: true,
  meta: t<{ username: string }>(),
  definitions: [
    incoming('ack-check', v.object({})),
    incoming('throw-me', v.object({})),
    outgoing('ack-check-ok', v.object({})),
  ],
});

export const ackHandler = implement(ackContract)
  .onUpgrade((request) => requireUsername(request))
  .on('ack-check', (ctx) => {
    ctx.send('ack-check-ok', {});
    ctx.ack();
  })
  .on('throw-me', () => {
    throw new Error('intentional failure to prove ack is not emitted on throw');
  })
  .build();

export type AckClient = InferClient<typeof ackHandler>;

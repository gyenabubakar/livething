import { contract, implement, incoming, outgoing, t } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

export const ctxMetaContract = contract('ctx-meta', {
  env: t<Env>(),
  meta: t<{ username: string }>(),
  definitions: [
    incoming('who-am-i', v.object({})),
    incoming('list-members', v.object({})),
    incoming('broadcast-identity', v.object({})),

    outgoing('who-am-i-result', v.object({ username: v.string() })),
    outgoing('members-list-result', v.object({ members: v.array(v.string()) })),
    outgoing('broadcast-identity-received', v.object({ from: v.string() })),
  ],
});

export const ctxMetaHandler = implement(ctxMetaContract)
  .onUpgrade((request) => requireUsername(request))
  .on('who-am-i', (ctx) => {
    ctx.send('who-am-i-result', { username: ctx.meta.username });
  })
  .on('list-members', (ctx) => {
    const peers = ctx.getConnections();
    const usernames = peers.map((p) => (p.meta.username as string) ?? 'unknown');
    ctx.send('members-list-result', { members: usernames });
  })
  .on('broadcast-identity', (ctx) => {
    ctx.broadcast('broadcast-identity-received', { from: ctx.meta.username });
  })
  .build();

export type CtxMetaClient = InferClient<typeof ctxMetaHandler>;

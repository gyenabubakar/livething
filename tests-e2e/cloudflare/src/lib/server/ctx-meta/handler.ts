import { event, server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const WhoAmI = event('who-am-i', v.object({}));
const WhoAmIResult = event('who-am-i-result', v.object({ username: v.string() }));
const ListMembers = event('list-members', v.object({}));
const MembersListResult = event('members-list-result', v.object({ members: v.array(v.string()) }));
const BroadcastIdentity = event('broadcast-identity', v.object({}));
const BroadcastIdentityReceived = event(
  'broadcast-identity-received',
  v.object({ from: v.string() }),
);

export const ctxMetaHandler = withChannels(withLifecycle(server<Env>('ctx-meta')))
  .outgoing(WhoAmIResult)
  .outgoing(MembersListResult)
  .outgoing(BroadcastIdentityReceived)
  .onUpgrade((request) => requireUsername(request))
  .incoming(WhoAmI, (ctx) => {
    ctx.send('who-am-i-result', { username: ctx.meta.username });
  })
  .incoming(ListMembers, (ctx) => {
    const peers = ctx.getConnections();
    const usernames = peers.map((p) => (p.meta.username as string) ?? 'unknown');
    ctx.send('members-list-result', { members: usernames });
  })
  .incoming(BroadcastIdentity, (ctx) => {
    ctx.broadcast('broadcast-identity-received', { from: ctx.meta.username as string });
  })
  .build();

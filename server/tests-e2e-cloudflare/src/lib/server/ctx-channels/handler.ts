import { event, server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const GetMembers = event('get-members', v.object({ channel: v.string() }));
const MembersResult = event('members-result', v.object({ channel: v.string(), count: v.number() }));
const Kick = event('kick', v.object({ channel: v.string(), tag: v.string() }));

const base = withChannels(withLifecycle(server<Env>('ctx-channels')))
  .outgoing(MembersResult)
  .onUpgrade((request) => requireUsername(request))
  .incoming(GetMembers, (ctx, payload) => {
    const members = ctx.channels.members(payload.channel);
    ctx.send('members-result', { channel: payload.channel, count: members.length });
  })
  .incoming(Kick, (ctx, payload) => {
    ctx.channels.kick(payload.channel, payload.tag, 'kicked');
  });

const roomChannel = base.channel('room', (c) => c);

export const ctxChannelsHandler = base.use(roomChannel).build();

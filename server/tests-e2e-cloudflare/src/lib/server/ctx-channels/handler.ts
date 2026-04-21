import { event, server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const GetMembers = event('get-members', v.object({ channel: v.string() }));
const MembersResult = event('members-result', v.object({ channel: v.string(), count: v.number() }));
const KickInChannel = event(
  'kick-in-channel',
  v.object({ channel: v.string(), tag: v.string(), reason: v.string() }),
);
const RoomMessage = event('room-message', v.object({ text: v.string(), from: v.string() }));
const SendRoomMessage = event('send-room-message', v.object({ text: v.string() }));

const base = withChannels(withLifecycle(server<Env>('ctx-channels')))
  .outgoing(MembersResult)
  .onUpgrade((request) => requireUsername(request))
  .incoming(GetMembers, (ctx, payload) => {
    ctx.send('members-result', {
      channel: payload.channel,
      count: ctx.channels.members(payload.channel).length,
    });
  })
  .incoming(KickInChannel, (ctx, payload) => {
    ctx.channels.kick(payload.channel, payload.tag, payload.reason);
  });

const roomChannel = base.channel('room', (c) =>
  c.outgoing(RoomMessage).incoming(SendRoomMessage, (ctx, payload) => {
    ctx.channel.broadcast('room-message', { text: payload.text, from: ctx.meta.username });
  }),
);

export const ctxChannelsHandler = base.use(roomChannel).build();

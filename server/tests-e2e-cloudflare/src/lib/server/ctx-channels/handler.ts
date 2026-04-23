import { event, server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const GetMembers = event('get-members', v.object({ channel: v.string() }));
const MembersResult = event('members-result', v.object({ channel: v.string(), count: v.number() }));
const GetMemberId = event('get-member-id', v.object({ channel: v.string() }));
const MemberIdResult = event('member-id-result', v.object({ id: v.string() }));
const KickInChannel = event(
  'kick-in-channel',
  v.object({ channel: v.string(), tag: v.string(), reason: v.string() }),
);
const RoomMessage = event('room-message', v.object({ text: v.string(), from: v.string() }));
const SendRoomMessage = event('send-room-message', v.object({ text: v.string() }));

const base = withChannels(withLifecycle(server<Env>('ctx-channels')))
  .outgoing(MembersResult)
  .outgoing(MemberIdResult)
  .onUpgrade((request) => requireUsername(request))
  .incoming(GetMembers, (ctx, payload) => {
    ctx.send('members-result', {
      channel: payload.channel,
      count: ctx.channels.members(payload.channel).length,
    });
  })
  .incoming(GetMemberId, (ctx, payload) => {
    const members = ctx.channels.members(payload.channel);
    const first = members[0];
    ctx.send('member-id-result', { id: first ? first.id : '' });
  })
  .incoming(KickInChannel, (ctx, payload) => {
    ctx.channels.kick(payload.channel, payload.tag, payload.reason);
  })
  .incoming(event('kick-nonmember', v.object({})), (ctx) => {
    // Attempt to kick a tag that never existed
    ctx.channels.kick('room', 'user3', 'Non-existent user');
  });

const roomChannel = base.channel('room', (c) =>
  c.outgoing(RoomMessage).incoming(SendRoomMessage, (ctx, payload) => {
    ctx.channel.broadcast('room-message', { text: payload.text, from: ctx.meta.username });
  }),
);

export const ctxChannelsHandler = base.use(roomChannel).build();

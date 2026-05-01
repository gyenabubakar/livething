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
  .onUpgrade((request) => requireUsername(request));

const roomChannel = base.channel('room', (c) =>
  c.outgoing(RoomMessage).incoming(SendRoomMessage, (ctx, payload) => {
    ctx.channel.broadcast('room-message', { text: payload.text, from: ctx.meta.username });
  }),
);

export const ctxChannelsHandler = base
  .use(roomChannel)
  .incoming(GetMembers, (ctx, payload) => {
    void payload;
    ctx.send('members-result', {
      channel: 'room',
      count: ctx.channels.get('room').members().length,
    });
  })
  .incoming(GetMemberId, (ctx, payload) => {
    void payload;
    const members = ctx.channels.get('room').members();
    const first = members[0];
    ctx.send('member-id-result', { id: first ? first.id : '' });
  })
  .incoming(KickInChannel, async (ctx, payload) => {
    void payload.channel;
    await ctx.channels.get('room').kick(payload.tag, payload.reason);
  })
  .incoming(event('kick-nonmember', v.object({})), async (ctx) => {
    await ctx.channels.get('room').kick('user3', 'Non-existent user');
  })
  .build();

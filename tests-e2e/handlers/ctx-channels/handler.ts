import { define, emits, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { tags } from '@wskit/server/tags';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsernameWithUserTag } from '../_shared/upgrade.ts';

const base = define({
  env: t<Env>(),
  upgrade: (request) => requireUsernameWithUserTag(request),
  capabilities: [
    emits({
      'members-result': t<{ channel: string; count: number }>(),
      'member-id-result': t<{ id: string }>(),
    }),
    tags((ephemeral) => [ephemeral('user', t<string>())]),
    channels(),
  ],
});

const room = base.channel('room', {
  outgoing: {
    emits: {
      'room-message': t<{ text: string; from: string }>(),
    },
  },
});

const handleGetMembers = base.on('get-members', {
  input: v.object({ channel: v.string() }),
  run(ctx) {
    ctx.send('members-result', {
      channel: 'room',
      count: ctx.channels.get('room').members().length,
    });
  },
});

const handleGetMemberId = base.on('get-member-id', {
  input: v.object({ channel: v.string() }),
  run(ctx) {
    const members = ctx.channels.get('room').members();
    const first = members[0];
    ctx.send('member-id-result', { id: first ? first.id : '' });
  },
});

const handleKickInChannel = base.on('kick-in-channel', {
  input: v.object({ channel: v.string(), tag: v.string(), reason: v.string() }),
  async run(ctx, input) {
    await ctx.channels.get('room').kick(ctx.tags.ephemeral('user').ref(input.tag), input.reason);
  },
});

const handleKickNonmember = base.on('kick-nonmember', {
  input: v.object({}),
  async run(ctx) {
    await ctx.channels
      .get('room')
      .kick(ctx.tags.ephemeral('user').ref('user3'), 'Non-existent user');
  },
});

const handleKickSelfByRef = base.on('kick-self-by-ref', {
  input: v.object({}),
  async run(ctx) {
    await ctx.channels.get('room').kick(ctx.self, 'self kick by ref');
  },
});

const handleSendRoomMessage = room.on('send-room-message', {
  input: v.object({ text: v.string() }),
  run(ctx, input) {
    ctx.channel.broadcast('room-message', { text: input.text, from: ctx.meta.username });
  },
});

export const ctxChannelsHandler = base.assemble({
  handlers: [
    handleGetMembers,
    handleGetMemberId,
    handleKickInChannel,
    handleKickNonmember,
    handleKickSelfByRef,
    handleSendRoomMessage,
  ],
});

export type CtxChannelsClient = InferClient<typeof ctxChannelsHandler>;

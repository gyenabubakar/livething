import { emits, server, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { tags } from '@wskit/server/tags';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsernameWithUserTag } from '../_shared/upgrade.ts';

const base = server({
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
  capabilities: [
    emits({
      'room-message': t<{ text: string; from: string }>(),
    }),
  ],
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
    await ctx.channels
      .get('room')
      .kick(ctx.tags.ephemeral('user').ref(input.tag), { reason: input.reason });
  },
});

const handleKickNonmember = base.on('kick-nonmember', {
  input: v.object({}),
  async run(ctx) {
    await ctx.channels
      .get('room')
      .kick(ctx.tags.ephemeral('user').ref('user3'), { reason: 'Non-existent user' });
  },
});

const handleKickSelfByRef = base.on('kick-self-by-ref', {
  input: v.object({}),
  async run(ctx) {
    await ctx.channels
      .get('room')
      .kick(ctx.tags.ephemeral('user').ref(ctx.meta.username), { reason: 'self kick by ref' });
  },
});

const handleSendRoomMessage = room.on('send-room-message', {
  input: v.object({ text: v.string() }),
  run(ctx, input) {
    ctx.channel.broadcast('room-message', { text: input.text, from: ctx.meta.username });
  },
});

// Exercises `ctx.channel.broadcastTo(to, event, payload)`: `to` is a channel
// member's tag, so only sockets that are BOTH a member AND hold the tag
// receive the frame. A tag with no matching member delivers to 0. The
// delivered count comes back so the test can assert the intersection.
const handleSendToTaggedMember = room.on('send-to-tagged-member', {
  input: v.object({ tag: v.string(), text: v.string() }),
  run(ctx, input) {
    const delivered = ctx.channel.broadcastTo(
      ctx.tags.ephemeral('user').ref(input.tag),
      'room-message',
      { text: input.text, from: ctx.meta.username },
    );
    ctx.send('members-result', { channel: 'room', count: delivered });
  },
});

export const ctxChannelsDefinition = base.assemble({
  handlers: [
    handleGetMembers,
    handleGetMemberId,
    handleKickInChannel,
    handleKickNonmember,
    handleKickSelfByRef,
    handleSendRoomMessage,
    handleSendToTaggedMember,
  ],
});

export type CtxChannelsClient = InferClient<typeof ctxChannelsDefinition>;

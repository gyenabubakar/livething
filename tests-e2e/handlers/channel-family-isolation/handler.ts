import { emits, server, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { dedup } from '@wskit/server/dedup';
import { replay } from '@wskit/server/replay';
import { sequence } from '@wskit/server/sequence';
import { tags } from '@wskit/server/tags';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsernameWithUserTag } from '../_shared/upgrade.ts';

const SendInPublicPayload = v.object({ name: v.string(), text: v.string() });
const SendInPrivatePayload = v.object({ name: v.string(), text: v.string() });

const PublicMembersPayload = v.object({ name: v.string() });
const PrivateMembersPayload = v.object({ name: v.string() });

const KickInPublicPayload = v.object({
  name: v.string(),
  tag: v.string(),
  reason: v.string(),
});
const KickInPrivatePayload = v.object({
  name: v.string(),
  tag: v.string(),
  reason: v.string(),
});

const PublicBroadcastFromTopPayload = v.object({ name: v.string(), text: v.string() });
const PublicSendDirectPayload = v.object({ name: v.string(), text: v.string() });
const PrivateSendDirectPayload = v.object({ name: v.string(), text: v.string() });

const base = server({
  upgrade: (request) => requireUsernameWithUserTag(request),
  capabilities: [
    emits({
      'public-members-result': t<{ name: string; count: number; ids: string[] }>(),
      'private-members-result': t<{ name: string; count: number; ids: string[] }>(),
      'kick-acknowledged': t<{ where: string }>(),
    }),
    tags((ephemeral) => [ephemeral('user', t<string>()), ephemeral('label', t<string>())]),
    dedup(),
    sequence({ persist: true }),
    replay.history(),
    channels(),
  ],
});

const publicRooms = base.channel(['publicRooms', 'room:{id}'], {
  capabilities: [emits({ 'room-message': t<{ family: string; name: string; text: string }>() })],
});

const privateRooms = base.channel(['privateRooms', 'room:{id}'], {
  capabilities: [emits({ 'private-message': t<{ family: string; name: string; text: string }>() })],
});

const handlePublicMembers = base.on('public-members', {
  input: PublicMembersPayload,
  run(ctx, payload) {
    const handle = ctx.channels.get('publicRooms', payload.name);
    const ids = handle.members().map((m) => m.id);
    ctx.send('public-members-result', { name: payload.name, count: ids.length, ids });
  },
});

const handlePrivateMembers = base.on('private-members', {
  input: PrivateMembersPayload,
  run(ctx, payload) {
    const handle = ctx.channels.get('privateRooms', payload.name);
    const ids = handle.members().map((m) => m.id);
    ctx.send('private-members-result', { name: payload.name, count: ids.length, ids });
  },
});

const handleKickInPublic = base.on('kick-in-public', {
  input: KickInPublicPayload,
  async run(ctx, payload) {
    await ctx.channels
      .get('publicRooms', payload.name)
      .kick(ctx.tags.ephemeral('user').ref(payload.tag), { reason: payload.reason });
    ctx.send('kick-acknowledged', { where: 'publicRooms' });
  },
});

const handleKickInPrivate = base.on('kick-in-private', {
  input: KickInPrivatePayload,
  async run(ctx, payload) {
    await ctx.channels
      .get('privateRooms', payload.name)
      .kick(ctx.tags.ephemeral('user').ref(payload.tag), { reason: payload.reason });
    ctx.send('kick-acknowledged', { where: 'privateRooms' });
  },
});

const handlePublicBroadcastFromTop = base.on('public-broadcast-from-top', {
  input: PublicBroadcastFromTopPayload,
  run(ctx, payload) {
    ctx.channels.get('publicRooms', payload.name).broadcast('room-message', {
      family: 'publicRooms',
      name: payload.name,
      text: payload.text,
    });
  },
});

const handlePublicSendDirect = base.on('public-send-direct', {
  input: PublicSendDirectPayload,
  run(ctx, payload) {
    ctx.channels.get('publicRooms', payload.name).send('room-message', {
      family: 'publicRooms',
      name: payload.name,
      text: payload.text,
    });
  },
});

const handlePrivateSendDirect = base.on('private-send-direct', {
  input: PrivateSendDirectPayload,
  run(ctx, payload) {
    ctx.channels.get('privateRooms', payload.name).send('private-message', {
      family: 'privateRooms',
      name: payload.name,
      text: payload.text,
    });
  },
});

const handleSendInPublic = publicRooms.on('send-in-public', {
  input: SendInPublicPayload,
  run(ctx, payload) {
    ctx.channel.broadcast('room-message', {
      family: 'publicRooms',
      name: payload.name,
      text: payload.text,
    });
  },
});

const handleSendInPrivate = privateRooms.on('send-in-private', {
  input: SendInPrivatePayload,
  run(ctx, payload) {
    ctx.channel.broadcast('private-message', {
      family: 'privateRooms',
      name: payload.name,
      text: payload.text,
    });
  },
});

export const channelFamilyIsolationDefinition = base.assemble({
  handlers: [
    handlePublicMembers,
    handlePrivateMembers,
    handleKickInPublic,
    handleKickInPrivate,
    handlePublicBroadcastFromTop,
    handlePublicSendDirect,
    handlePrivateSendDirect,
    handleSendInPublic,
    handleSendInPrivate,
  ],
});

export type ChannelFamilyIsolationClient = InferClient<typeof channelFamilyIsolationDefinition>;

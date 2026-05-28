import { channel, contract, implement, incoming, outgoing, scope, t } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const RoomMessagePayload = v.object({
  family: v.string(),
  name: v.string(),
  text: v.string(),
});
const PrivateMessagePayload = v.object({
  family: v.string(),
  name: v.string(),
  text: v.string(),
});

const SendInPublicPayload = v.object({ name: v.string(), text: v.string() });
const SendInPrivatePayload = v.object({ name: v.string(), text: v.string() });

const PublicMembersPayload = v.object({ name: v.string() });
const PublicMembersResultPayload = v.object({
  name: v.string(),
  count: v.number(),
  ids: v.array(v.string()),
});
const PrivateMembersPayload = v.object({ name: v.string() });
const PrivateMembersResultPayload = v.object({
  name: v.string(),
  count: v.number(),
  ids: v.array(v.string()),
});

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
const KickAcknowledgedPayload = v.object({ where: v.string() });

const PublicBroadcastFromTopPayload = v.object({ name: v.string(), text: v.string() });
const PublicSendDirectPayload = v.object({ name: v.string(), text: v.string() });
const PrivateSendDirectPayload = v.object({ name: v.string(), text: v.string() });

export const channelScopeIsolationContract = contract('channel-scope-isolation', {
  env: t<Env>(),
  dedup: true,
  sequence: { persist: true },
  replay: true,
  meta: t<{ username: string }>(),
  tagGroups: {
    ephemeral: ['user', 'label'],
  },
  definitions: [
    incoming('public-members', PublicMembersPayload),
    incoming('private-members', PrivateMembersPayload),
    incoming('kick-in-public', KickInPublicPayload),
    incoming('kick-in-private', KickInPrivatePayload),
    incoming('public-broadcast-from-top', PublicBroadcastFromTopPayload),
    incoming('public-send-direct', PublicSendDirectPayload),
    incoming('private-send-direct', PrivateSendDirectPayload),

    outgoing('public-members-result', PublicMembersResultPayload),
    outgoing('private-members-result', PrivateMembersResultPayload),
    outgoing('kick-acknowledged', KickAcknowledgedPayload),

    channel(scope('publicRooms', /^room:.+$/), {
      definitions: [
        incoming('send-in-public', SendInPublicPayload),
        outgoing('room-message', RoomMessagePayload),
      ],
    }),
    channel(scope('privateRooms', /^room:.+$/), {
      definitions: [
        incoming('send-in-private', SendInPrivatePayload),
        outgoing('private-message', PrivateMessagePayload),
      ],
    }),
  ],
});

export const channelScopeIsolationHandler = implement(channelScopeIsolationContract)
  .onUpgrade((request, helpers) => requireUsername(request, helpers))

  .on('public-members', (ctx, payload) => {
    const handle = ctx.channels.get('publicRooms', payload.name);
    const ids = handle.members().map((m) => m.id);
    ctx.send('public-members-result', { name: payload.name, count: ids.length, ids });
  })
  .on('private-members', (ctx, payload) => {
    const handle = ctx.channels.get('privateRooms', payload.name);
    const ids = handle.members().map((m) => m.id);
    ctx.send('private-members-result', { name: payload.name, count: ids.length, ids });
  })
  .on('kick-in-public', async (ctx, payload) => {
    await ctx.channels
      .get('publicRooms', payload.name)
      .kick(ctx.tags.ephemeral('user').ref(payload.tag), payload.reason);
    ctx.send('kick-acknowledged', { where: 'publicRooms' });
  })
  .on('kick-in-private', async (ctx, payload) => {
    await ctx.channels
      .get('privateRooms', payload.name)
      .kick(ctx.tags.ephemeral('user').ref(payload.tag), payload.reason);
    ctx.send('kick-acknowledged', { where: 'privateRooms' });
  })
  .on('public-broadcast-from-top', (ctx, payload) => {
    ctx.channels.get('publicRooms', payload.name).broadcast('room-message', {
      family: 'publicRooms',
      name: payload.name,
      text: payload.text,
    });
  })
  .on('public-send-direct', (ctx, payload) => {
    ctx.channels.get('publicRooms', payload.name).send('room-message', {
      family: 'publicRooms',
      name: payload.name,
      text: payload.text,
    });
  })
  .on('private-send-direct', (ctx, payload) => {
    ctx.channels.get('privateRooms', payload.name).send('private-message', {
      family: 'privateRooms',
      name: payload.name,
      text: payload.text,
    });
  })

  .channel('publicRooms', (ch) =>
    ch.on('send-in-public', (ctx, payload) => {
      ctx.channel.broadcast('room-message', {
        family: 'publicRooms',
        name: payload.name,
        text: payload.text,
      });
    }),
  )

  .channel('privateRooms', (ch) =>
    ch.on('send-in-private', (ctx, payload) => {
      ctx.channel.broadcast('private-message', {
        family: 'privateRooms',
        name: payload.name,
        text: payload.text,
      });
    }),
  )

  .build();

export type ChannelScopeIsolationClient = InferClient<typeof channelScopeIsolationHandler>;
